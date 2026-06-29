import { neon } from '@neondatabase/serverless';

let tableReady = false;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { article } = req.body;
  if (!article || article.trim().length < 50) {
    return res.status(400).json({ error: 'Article text is too short' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Look up publisher settings if a publisher slug was provided
    const { publisher } = req.body;
    let maxMatches = 4;
    let sensitivityInstruction = 'The match must be genuinely strong. A weak or vague match is worse than no match.';

    let pubConfig = { color: '#e6a820', accent: '#e6a820', size: 'medium' };

    if (publisher) {
      const [pub] = await sql`SELECT match_power, match_sensitivity, widget_color, accent_color, widget_size FROM publishers WHERE slug = ${publisher} AND active = true LIMIT 1`;
      if (pub) {
        const powerMap = { light: 2, moderate: 4, heavy: 10, unlimited: 15 };
        maxMatches = powerMap[pub.match_power] ?? 4;
        const sensitivityMap = {
          strict: 'The match must be very specific and actionable. Only match if the expert\'s expertise directly addresses the exact challenge described. A weak match is worse than no match.',
          balanced: 'Match when there is clear value to the reader. The connection should be meaningful but does not need to be hyper-specific.',
          open: 'Match on broader topic overlap. If the expert\'s field is relevant to the section, include them. Prefer more matches over fewer.',
        };
        sensitivityInstruction = sensitivityMap[pub.match_sensitivity] ?? sensitivityMap.balanced;
        pubConfig = { color: pub.widget_color || '#e6a820', accent: pub.accent_color || '#e6a820', size: pub.widget_size || 'medium' };
      }
    }

    const experts = await sql`
      SELECT id, name, bio, description_long, photo_url, position, company,
             topics, services, languages, price_from, price_currency,
             booking_url, location_country
      FROM experts
      WHERE active = true
      ORDER BY id
    `;

    if (experts.length === 0) {
      return res.status(200).json({ matches: [] });
    }

    const expertsList = experts.map(e => {
      const role = [e.position, e.company].filter(Boolean).join(' at ');
      const langs = (e.languages || []).join(', ');
      const desc = e.description_long || e.bio || '';
      const services = (e.services || []).slice(0, 3).join('; ');
      return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''} | Languages: ${langs} | From £${e.price_from}/session | About: ${desc.slice(0, 150)} | Services: ${services}`;
    }).join('\n\n');

    const prompt = `You are the matching engine for IntroLinq, a platform that connects blog READERS with experts they can book a 1:1 call with.

Your job: identify moments in the article where a reader — someone trying to learn, make a decision, or solve a problem — would benefit from a personal consultation with a specific expert. ${sensitivityInstruction}

Criteria for a valid match:
1. The reader faces a specific, actionable challenge or decision — not just reading about a topic
2. The expert's expertise is a clear fit for that challenge (not just the same broad field)
3. A 1:1 call with this expert would genuinely help the reader take action

Return up to ${maxMatches} matches for how-to articles, guides, and educational content where the reader is actively trying to do something. Return 0 for pure news, press releases, or company announcements where the reader is passively informed.

NEVER match:
- News articles, press releases, or company announcements
- CEO or executive quotes about their own strategy
- Funding rounds, valuations, or investor names
- Statistics being reported, not explained
- Phrases where a company describes what it is doing (not what the reader needs to do)
- Vague keyword overlap where the expert's services don't clearly fit the specific moment

Detect the article language. If not English, strongly prioritise experts who speak that language.

Available experts:
${expertsList}

Article:
${article.slice(0, 4000)}

Return only valid JSON, no other text:
{"matches":[{"phrase":"exact substring from article","expert_id":1,"reason":"One sentence speaking directly to the reader in second person — e.g. 'If you want to raise your first round without giving away too much equity, Phil has backed 200+ startups and can walk you through the process.'"}]}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI matching failed', detail: err, status: response.status, hasKey: !!process.env.ANTHROPIC_API_KEY });
    }

    const aiResult = await response.json();
    const text = aiResult.content?.[0]?.text || '{"matches":[]}';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { matches: [] };
    }

    const expertMap = Object.fromEntries(experts.map(e => [e.id, e]));
    const enriched = (parsed.matches || [])
      .filter(m => m.phrase && expertMap[m.expert_id])
      .map(m => ({
        phrase: m.phrase,
        reason: m.reason,
        expert: expertMap[m.expert_id]
      }));

    // Send response immediately — don't make user wait for logging
    res.status(200).json({ matches: enriched, config: pubConfig });

    // Log in background after response is sent
    const preview = article.slice(0, 120).replace(/\s+/g, ' ');
    const phrases = enriched.map(m => m.phrase);
    const expertNames = enriched.map(m => m.expert.name);

    await Promise.allSettled([
      // Log to DB
      (async () => {
        if (!tableReady) {
          await sql`
            CREATE TABLE IF NOT EXISTS match_logs (
              id SERIAL PRIMARY KEY,
              publisher TEXT,
              article_preview TEXT,
              phrases TEXT[],
              expert_names TEXT[],
              match_count INT,
              created_at TIMESTAMPTZ DEFAULT NOW()
            )
          `;
          tableReady = true;
        }
        await sql`
          INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, match_count)
          VALUES (${publisher}, ${preview}, ${phrases}, ${expertNames}, ${enriched.length})
        `;
      })(),

      // Slack notification
      (async () => {
        if (!process.env.SLACK_WEBHOOK_URL) return;
        const src = publisher ? `*${publisher}*` : '`/app`';
        let msg;
        if (enriched.length === 0) {
          msg = `🔍 Match on ${src} — *no experts found*\n> ${preview}`;
        } else {
          const pairs = enriched.map(m => `"${m.phrase}"\n    → ${m.expert.name}`).join('\n\n');
          msg = `🔍 Match on ${src} — *${enriched.length} result${enriched.length > 1 ? 's' : ''}*\n\n${pairs}`;
        }
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: msg })
        });
      })()
    ]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
