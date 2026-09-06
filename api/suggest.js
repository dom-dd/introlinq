import { neon } from '@neondatabase/serverless';

// POST /api/suggest  { pub, text }
//
// Powers the "paste your article, get expert suggestions" panel in the
// dashboard's Manual Entry tab. Synchronous (the publisher is waiting) - runs
// one Claude call over the pasted text against the publisher's own expert
// roster and returns:
//   - placements: sentences/phrases in the text where an expert link fits,
//     each with 1-2 suggested experts and a one-line reason
//   - overall: a few experts that fit the whole piece
//
// This is deliberately separate from api/match.js: that endpoint is a
// URL-driven background scanner with its own caching/locking built for the
// live widget. Here the input is raw pasted text, there's no page identity to
// cache against, and the caller blocks on the result.

const MAX_TEXT = 40000;         // chars of article sent to the model
const DAILY_LIMIT_PER_PUB = 40; // suggest calls per publisher per rolling 24h
const MODEL = 'claude-haiku-4-5-20251001';

function getSessionToken(req) {
  const m = (req.headers.cookie || '').match(/il_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function truncateAtSentence(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sql = neon(process.env.DATABASE_URL);
  const { pub, text } = req.body || {};
  if (!pub || typeof text !== 'string') return res.status(400).json({ error: 'pub and text required' });

  const article = text.trim().slice(0, MAX_TEXT);
  if (article.length < 200) return res.status(400).json({ error: 'Paste a bit more text - at least a paragraph or two.' });

  // Auth: must be the logged-in publisher for this pub (same gate as the
  // dashboard's own GET).
  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const [session] = await sql`
    SELECT publisher_slug FROM sessions WHERE token = ${token} AND expires_at > NOW()
  `.catch(() => [null]);
  if (!session || session.publisher_slug !== pub) return res.status(401).json({ error: 'Unauthorized' });

  // Soft per-publisher rate limit - reuses ai_call_logs (also written by
  // match.js). Keeps a stuck "Suggest" button or a script from running up the
  // Anthropic bill.
  await sql`CREATE TABLE IF NOT EXISTS ai_call_logs (
    id SERIAL PRIMARY KEY, publisher TEXT, page_url TEXT, call_type TEXT,
    input_tokens INT, output_tokens INT, cache_creation_input_tokens INT,
    cache_read_input_tokens INT, cost_usd NUMERIC, created_at TIMESTAMPTZ DEFAULT NOW()
  )`.catch(() => {});
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM ai_call_logs
    WHERE publisher = ${pub} AND call_type = 'suggest' AND created_at > NOW() - INTERVAL '24 hours'
  `.catch(() => [{ n: 0 }]);
  if (n >= DAILY_LIMIT_PER_PUB) {
    return res.status(429).json({ error: "You've hit today's limit for article suggestions. Try again tomorrow, or use the expert search below." });
  }

  // Publisher's enabled experts (mirrors api/board.js).
  const [publisher] = await sql`
    SELECT COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners
    FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
  `.catch(() => [null]);
  if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

  const experts = await sql`
    SELECT e.id, e.name, e.position, e.company, e.bio, e.description_long, e.photo_url, e.booking_url,
           e.price_from, e.price_currency, e.topics, e.languages, e.location_country,
           COALESCE(e.headlines, '{}'::jsonb) AS headlines,
           COALESCE(e.highlights, '{}') AS highlights,
           COALESCE(e.services, '{}') AS services,
           COALESCE(e.notable_categories, '{}') AS notable_categories
    FROM experts e
    JOIN providers p ON p.id = e.provider_id
    WHERE e.active = true AND p.is_demo IS NOT TRUE AND p.slug = ANY(${publisher.enabled_partners})
    ORDER BY e.id ASC
  `.catch(() => []);
  if (!experts.length) return res.status(200).json({ placements: [], overall: [] });

  const expertsList = experts.map(e => {
    const role = [e.position, e.company].filter(Boolean).join(' at ');
    const langs = (e.languages || []).join(', ');
    const about = [e.bio, truncateAtSentence(e.description_long || '', 220)].filter(Boolean).join(' - ');
    const highlights = (e.highlights || []).slice(0, 4).join('; ');
    const services = (e.services || []).slice(0, 3).join('; ');
    return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''}${langs ? ` | Languages: ${langs}` : ''} | About: ${about}${highlights ? ` | Highlights: ${highlights}` : ''}${services ? ` | Services: ${services}` : ''}`;
  }).join('\n\n');

  // Static block (expert list + rules) is stable per publisher, so Anthropic
  // prompt caching applies across repeated analyses.
  const staticPrompt = `You help a publisher decide where to add links to bookable experts inside an article or newsletter they are about to publish. Readers who click a link can book a 1:1 call with that expert.

Return two things:
1. PLACEMENTS: specific moments in the text where a reader faces an actionable challenge or decision that a 1:1 call with one of the available experts would genuinely help with. For each, quote the exact sentence (or a shorter exact phrase within it) from the text, give a one-line reason aimed at the reader, and list 1-2 expert IDs that fit - best first.
2. OVERALL: 2-4 expert IDs whose expertise fits the article's overall subject, for a "recommended experts" box or author note.

Rules:
- Only suggest an expert whose own field of work covers the reader's specific problem. Never connect a generalist to a specialist topic through a chain of reasoning. If no available expert genuinely fits a moment, leave it out.
- 3 to 8 placements for a typical article; fewer (or zero) is correct when the piece is news, an announcement, or has no actionable reader challenge.
- Every "quote" MUST be an exact substring of the text provided, copied character-for-character (so the publisher can find it). Prefer a whole sentence; a phrase is fine if it's still an exact substring.
- No em dashes or en dashes in "reason" - use a plain hyphen with spaces.
- Never repeat the same expert across more than 2 placements. Spread suggestions across the roster where the fit is real.

Available experts:
${expertsList}`;

  const dynamicPrompt = `Article / newsletter text:
${article}

Return ONLY valid JSON, no other text:
{"placements":[{"quote":"exact substring from the text","reason":"one sentence to the reader, plain hyphens only","expert_ids":[1,2]}],"overall_expert_ids":[3,4]}`;

  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(50000),
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: dynamicPrompt },
          ],
        }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('suggest: Anthropic error', r.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'The suggestion service is busy - try again in a minute.' });
    }
    data = await r.json();
  } catch (e) {
    console.error('suggest: fetch failed', e);
    return res.status(504).json({ error: 'That took too long - try again with a shorter excerpt.' });
  }

  // Log the call (fire-and-forget-ish; cost left null - not computed here).
  const u = data.usage || {};
  sql`INSERT INTO ai_call_logs (publisher, page_url, call_type, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
      VALUES (${pub}, NULL, 'suggest', ${u.input_tokens || null}, ${u.output_tokens || null}, ${u.cache_creation_input_tokens || null}, ${u.cache_read_input_tokens || null}, NULL)`.catch(() => {});

  let parsed;
  try {
    const raw = (data.content && data.content[0] && data.content[0].text) || '';
    const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('suggest: JSON parse failed');
    return res.status(502).json({ error: 'Could not read the suggestions - try again.' });
  }

  const byId = new Map(experts.map(e => [e.id, e]));
  const slim = e => e && ({
    id: e.id, name: e.name, position: e.position, company: e.company,
    photo_url: e.photo_url, booking_url: e.booking_url,
    headline: (e.headlines || {}).en || e.bio || '',
    location_country: e.location_country,
    languages: e.languages || [],
    price_from: e.price_from, price_currency: e.price_currency,
  });

  const placements = (Array.isArray(parsed.placements) ? parsed.placements : [])
    .map(p => {
      const quote = typeof p.quote === 'string' ? p.quote.trim() : '';
      // Keep only quotes the model actually lifted from the text.
      if (!quote || !article.includes(quote)) return null;
      const ex = (Array.isArray(p.expert_ids) ? p.expert_ids : [])
        .map(id => slim(byId.get(Number(id)))).filter(Boolean).slice(0, 2);
      if (!ex.length) return null;
      return { quote, reason: typeof p.reason === 'string' ? p.reason.trim() : '', experts: ex };
    })
    .filter(Boolean)
    .slice(0, 10);

  const overall = (Array.isArray(parsed.overall_expert_ids) ? parsed.overall_expert_ids : [])
    .map(id => slim(byId.get(Number(id)))).filter(Boolean).slice(0, 4);

  return res.status(200).json({ placements, overall });
}
