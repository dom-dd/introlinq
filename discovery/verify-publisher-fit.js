// Verification pass that produces the "Blog & Publishers" high-confidence
// list: candidates already classified lead_type='publisher' with a small
// team, re-checked against their REAL homepage content on Sonnet (not just
// a search snippet) for the actual question that matters - "is this a
// genuine independent blog/publication that would plausibly embed a
// third-party widget promoting external bookable experts", not "is this
// technically publishing articles" (a large company's blog/insights
// section clears that bar too, but would never add this kind of widget).
// Same two-stage reasoning as verify-categories.js, which caught a large
// false-positive rate doing this the same way for the partner categories.
//
// Only sets status='confirmed_fit' when genuinely confident - everything
// else is left exactly where it already was, never downgraded, since this
// is additive curation on top of the normal pipeline, not a replacement
// for it.
//
// Usage: node discovery/verify-publisher-fit.js

import { sql } from './lib/db.js';
import { CATEGORIES } from './lib/categories.js';

const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 8000;
const UNTOUCHED_STATUSES = ['discovered', 'emailed', 'followed_up_1', 'followed_up_2'];

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

async function verifyOne(row) {
  const pageText = await fetchHomepageText(row.homepage_url);
  if (!pageText || pageText.length < 50) {
    return { ...row, confidentFit: false, category: null, reason: 'could not fetch homepage', skipped: true };
  }

  const prompt = `A lead was tentatively classified as an independent blog/publisher for IntroLinq (a widget that matches blog readers with bookable experts, in exchange for a revenue share - the publisher needs to actually be willing to embed a third-party widget on their pages). That first pass only saw a domain and a search snippet - here is the lead's real homepage text, verify properly.

The bar to clear: this needs to be a genuinely independent blog or publication - solo or small-team, real regularly-published articles for readers, not a large or well-known company's blog/insights/resources section that exists to build authority or SEO for their own separate product or brand. A large or recognizable company would essentially never add a third-party widget promoting outside experts to their pages, no matter how independent any single article reads - if the homepage reads as a company site (product pitches, "our platform", pricing, a team/about section describing a company rather than a person or small collective, a polished corporate design), this does NOT qualify, even if there's a blog section.

Domain: ${row.domain}
Homepage text: "${pageText}"

Respond with ONLY valid JSON, no other text:
{"confident_fit": true|false, "category": "one of: ${CATEGORIES.map((c) => `"${c}"`).join(', ')}", "reason": "one short sentence"}

Only set confident_fit to true if you have real, specific evidence this is a genuine small/independent publication. If genuinely unsure either way, use false - a missed genuine lead costs far less than the time wasted chasing one that was never going to say yes.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
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
    const category = CATEGORIES.includes(parsed.category) ? parsed.category : null;
    return { ...row, confidentFit: !!parsed.confident_fit, category, reason: parsed.reason || '', skipped: false };
  } catch (err) {
    return { ...row, confidentFit: false, category: null, reason: `verification failed: ${err.message}`, skipped: true };
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

  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS category TEXT`;

  const rows = await sql`
    SELECT id, domain, homepage_url, category
    FROM candidate_publishers
    WHERE lead_type = 'publisher'
      AND team_size IN ('solo', 'small-team')
      AND status = ANY(${UNTOUCHED_STATUSES})
    ORDER BY id ASC
  `;
  console.log(`Verifying ${rows.length} candidate publisher(s) for the confirmed-fit list, concurrency ${CONCURRENCY}...`);

  let confirmed = 0, rejected = 0, skipped = 0, processedCount = 0;

  await runPool(rows, async (row) => {
    const result = await verifyOne(row);
    processedCount++;
    if (result.skipped) {
      skipped++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: SKIPPED (${result.reason})`);
      return;
    }
    if (result.confidentFit) {
      confirmed++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: CONFIRMED (${result.category}) - ${result.reason}`);
      await sql`UPDATE candidate_publishers SET status = 'confirmed_fit', category = COALESCE(${result.category}, category) WHERE id = ${row.id}`;
    } else {
      rejected++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: not confident - ${result.reason}`);
      // Left exactly where it was - still refine category if we got a
      // better read from real page content than the original snippet gave.
      if (result.category) {
        await sql`UPDATE candidate_publishers SET category = ${result.category} WHERE id = ${row.id}`;
      }
    }
  }, CONCURRENCY);

  console.log(`\nDone. ${confirmed} confirmed as strong publisher fits, ${rejected} not confident enough, ${skipped} skipped (couldn't fetch/verify).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
