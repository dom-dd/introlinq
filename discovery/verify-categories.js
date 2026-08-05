// Verification pass over leads already flagged partner/openintro_partner/
// products_partner by classify.js or categorize-existing-leads.js. Those
// were judged from a domain + one search-result title/snippet on Haiku -
// thin signal for what's ultimately a nuanced business-model call. This
// re-checks each one on Sonnet, using the real homepage text instead of a
// stale snippet, and explicitly excludes VC/investment-platform companies
// from "partner" (mirroring the exclusion classify.js's lead_type prompt
// already applies to "competitor", which this script's prompt hadn't
// inherited). Anything that doesn't hold up gets reverted to 'discovered'
// rather than left sitting in a section it doesn't belong in.
//
// Usage: node discovery/verify-categories.js

import { sql } from './lib/db.js';

const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 8000;
const VALID_CATEGORIES = new Set(['partner', 'openintro_partner', 'products_partner']);

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
    return { ...row, verdict: null, reason: 'could not fetch homepage', skipped: true };
  }

  const prompt = `A lead was flagged as "${row.status}" for IntroLinq's outreach categories, based on limited info (just a domain and a search snippet). Here is the lead's actual homepage text - verify whether the category genuinely fits.

Category definitions:
- "partner": the company's core product is an expert/advisor marketplace connecting people with MULTIPLE outside experts they can book, in any field (Clarity.fm, GrowthMentor, MentorCruise-style). Does NOT include venture capital firms, angel investment platforms, equity crowdfunding, or startup funding/investment matching of any kind - those are investment products, not expert-booking marketplaces, even if they talk about "connecting" people.
- "openintro_partner": an ORGANIZATION - not necessarily a software product - that represents or aggregates MULTIPLE experts/speakers as part of its identity: a large event/conference, a community, an incubator, an accelerator, or a speaking agency, that would benefit from a branded booking page for its people.
- "products_partner": the company sells a specific PRODUCT (CRM, SaaS tool, office space, software - not a service/agency, not an investment product).

Domain: ${row.domain}
Currently flagged as: ${row.status}
Homepage text: "${pageText}"

Does this lead genuinely fit "${row.status}"? Respond with ONLY valid JSON, no other text:
{"fits": true|false, "correct_category": "partner"|"openintro_partner"|"products_partner"|null, "reason": "one short sentence"}

If it fits as originally flagged, set correct_category to the same value. If it fits a DIFFERENT one of the three, say so. If it fits none of them, set correct_category to null.`;

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
    const correctCategory = VALID_CATEGORIES.has(parsed.correct_category) ? parsed.correct_category : null;
    return { ...row, verdict: correctCategory, reason: parsed.reason || '', skipped: false };
  } catch (err) {
    return { ...row, verdict: null, reason: `verification failed: ${err.message}`, skipped: true };
  }
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to discovery/.env.local');
  }

  const rows = await sql`
    SELECT id, domain, homepage_url, status
    FROM candidate_publishers
    WHERE status IN ('partner', 'openintro_partner', 'products_partner')
    ORDER BY id ASC
  `;
  console.log(`Verifying ${rows.length} flagged lead(s), concurrency ${CONCURRENCY}...`);

  let confirmed = 0, recategorized = 0, reverted = 0, skipped = 0, processedCount = 0;

  await runPool(rows, async (row) => {
    const result = await verifyOne(row);
    processedCount++;
    if (result.skipped) {
      skipped++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: SKIPPED (${result.reason})`);
      return result;
    }
    if (result.verdict === row.status) {
      confirmed++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: confirmed ${row.status} - ${result.reason}`);
    } else if (result.verdict) {
      recategorized++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: ${row.status} -> ${result.verdict} - ${result.reason}`);
      await sql`UPDATE candidate_publishers SET status = ${result.verdict} WHERE id = ${row.id}`;
    } else {
      reverted++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: ${row.status} -> REVERTED (doesn't fit) - ${result.reason}`);
      await sql`UPDATE candidate_publishers SET status = 'discovered' WHERE id = ${row.id}`;
    }
    return result;
  }, CONCURRENCY);

  console.log(`\nDone. ${confirmed} confirmed, ${recategorized} recategorized, ${reverted} reverted (didn't hold up), ${skipped} skipped (couldn't fetch/verify).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
