// Cleans up the "Not yet contacted" outreach bucket (status='discovered'),
// which - unlike confirmed_fit above it - has never had a rejection pass:
// classify.js only ever tags lead_type from a title/snippet, it never moves
// anything OUT of 'discovered', so vendors, competitors, and large-brand
// sites that were never a real outreach fit just accumulate there forever
// alongside genuine publisher leads.
//
// Same real-homepage-content approach as verify-publisher-fit.js (a
// domain/snippet alone isn't enough to judge this reliably), but this pass
// runs across ALL discovered leads regardless of lead_type/team_size, and -
// unlike that script - acts in both directions: confident non-fits get
// status='not_a_fit' (out of the todo bucket, into "Not a fit"), confident
// fits get 'confirmed_fit'. Anything the model isn't confident about is left
// exactly where it was, since a wrongly-closed lead is worse than one that
// just sits in the todo list a while longer.
//
// Usage: node discovery/reject-unfit-todo.js [--limit N] [--dry-run]

import { sql } from './lib/db.js';

const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 8000;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : null;

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHomepageText(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntroLinqBot/1.0)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return stripHtmlToText(html).slice(0, 3000);
  } catch {
    return null;
  }
}

async function judgeOne(row) {
  const pageText = await fetchHomepageText(row.homepage_url);
  if (!pageText || pageText.length < 50) {
    return { verdict: 'unsure', reason: 'could not fetch homepage', confidence: 'low' };
  }

  const prompt = `Judge whether this lead is worth outreach for IntroLinq - a widget that scans a blog's articles and inserts links to bookable, vetted experts (any field: business, finance, health, music, art, real estate, etc.), splitting the booking commission 50/50 with the site. The site needs to be willing and able to embed a third-party widget on its own pages.

A GOOD FIT: a genuinely independent blog/publication (solo or small team) that publishes real articles for readers, where the content itself is the product.

NOT a fit - reject with confidence when the homepage shows clear evidence of any of these:
- A company selling a specific product/service (SaaS, agency, consultancy, e-commerce) where any blog content exists to market that product - "our platform", pricing, a product demo, a company "about us" rather than a person/small collective.
- A large or recognizable brand/media company/large editorial team - these would essentially never add a third-party widget promoting outside experts, regardless of how one article reads.
- A competing expert/advisor marketplace or booking product (e.g. a Clarity.fm/GrowthMentor-style site).
- Not actually a blog/publication at all: directory, job board, forum, e-commerce store, SaaS landing page with no articles, parked/expired domain, or a page that's broken/unreachable/redirects somewhere unrelated.
- Not in a language or region where this would plausibly work (adult content, spam, unrelated to any legitimate niche).

Existing lead_type guess from a prior pass (title/snippet only, may be wrong): ${row.lead_type || 'unknown'}

Domain: ${row.domain}
Homepage text: "${pageText}"

Respond with ONLY valid JSON, no other text:
{"verdict": "fit"|"reject"|"unsure", "confidence": "high"|"low", "reason": "one short sentence"}

Use "reject" only when you have real, specific evidence from the homepage text. Use "fit" only when you have real, specific evidence this is a genuine small/independent publication. Otherwise "unsure" - a lead left alone costs nothing, a good lead wrongly closed or a bad one wrongly contacted both cost real time.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }
    const verdict = ['fit', 'reject', 'unsure'].includes(parsed.verdict) ? parsed.verdict : 'unsure';
    const confidence = ['high', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
    return { verdict, confidence, reason: parsed.reason || '' };
  } catch (err) {
    return { verdict: 'unsure', confidence: 'low', reason: `judgment failed: ${err.message}` };
  }
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to discovery/.env.local');
  }

  let rows = await sql`
    SELECT id, domain, homepage_url, lead_type, team_size, outreach_notes
    FROM candidate_publishers
    WHERE status = 'discovered'
    ORDER BY id ASC
  `;
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Reviewing ${rows.length} "Not yet contacted" lead(s), concurrency ${CONCURRENCY}${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  let rejected = 0, confirmed = 0, unsure = 0, processedCount = 0;

  await runPool(rows, async (row) => {
    const result = await judgeOne(row);
    processedCount++;
    const actOnIt = result.confidence === 'high' && result.verdict !== 'unsure';

    if (result.verdict === 'reject' && actOnIt) {
      rejected++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: REJECT - ${result.reason}`);
      if (!DRY_RUN) {
        await sql`
          UPDATE candidate_publishers
          SET status = 'not_a_fit', outreach_notes = COALESCE(NULLIF(outreach_notes, ''), ${'Auto-reviewed: ' + result.reason})
          WHERE id = ${row.id}
        `;
      }
    } else if (result.verdict === 'fit' && actOnIt) {
      confirmed++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: FIT - ${result.reason}`);
      if (!DRY_RUN) {
        await sql`UPDATE candidate_publishers SET status = 'confirmed_fit' WHERE id = ${row.id}`;
      }
    } else {
      unsure++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: unsure - ${result.reason}`);
    }
  }, CONCURRENCY);

  console.log(`\nDone. ${rejected} rejected as not a fit, ${confirmed} confirmed fit, ${unsure} left as-is (unsure/unreachable).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
