// Re-classify every apollo_import lead still sitting in 'discovered' without
// a category. Same judgment logic as the current reject-unfit-todo.js
// (fit_small/fit_large/partner/reject). Naturally scopes to whatever's
// newly pending regardless of which CSV batch it came from.
//
// Usage: node classify-pending.mjs [--limit N] [--dry-run]

import { sql } from './lib/db.js';
import { CATEGORIES } from './lib/categories.js';

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
    return { verdict: 'unsure', confidence: 'low', reason: 'could not fetch homepage' };
  }

  const prompt = `Judge whether this lead is worth outreach for IntroLinq - a widget that scans a blog's articles and inserts links to bookable, vetted experts (any field: business, finance, health, music, art, real estate, etc.), splitting the booking commission 50/50 with the site. The site needs to be willing and able to embed a third-party widget on its own pages.

Four possible verdicts:

"fit_small" - a genuinely independent blog/publication (solo or small team) that publishes real articles for readers, where the content itself is the product. This is who we actually reach out to.

"fit_large" - ALSO a genuine blog/publication with real articles for readers, but a large, recognizable, or well-known outfit (big media company, large editorial team, a brand whose blog exists alongside serious other business). Still real content, just not a plausible near-term outreach target - don't lump this in with "reject" below, it's a different thing entirely from junk.

"partner" - NOT a blog at all, but a marketplace/platform whose core product connects people with MULTIPLE outside experts/professionals they can book (e.g. a Clarity.fm/GrowthMentor-style advisor marketplace, a booking platform for yoga teachers, a wedding vendor marketplace). This is a potential business partner, not a competitor or junk - IntroLinq could list their experts too, on commission - so it must NOT be rejected. Only use this when the site itself is the marketplace/aggregator of multiple bookable providers, not a single person/company selling their own services.

"reject" - not actually a fit at all, for reasons that have nothing to do with size, and not a multi-expert marketplace either:
- A company selling a specific product/service (SaaS, agency, consultancy, e-commerce) where any blog content exists to market that product - "our platform", pricing, a product demo, a company "about us" rather than a person/small collective.
- A single person or company's own service/coaching/consulting business (even if they call themselves a "partnership" or take bookings) - this is a solo provider marketing themselves, not a marketplace of multiple providers, so it's "reject" not "partner".
- Not actually a blog/publication at all: directory, job board, forum, e-commerce store, SaaS landing page with no articles, parked/expired domain, or a page that's broken/unreachable/redirects somewhere unrelated.
- Not in a language or region where this would plausibly work (adult content, spam, unrelated to any legitimate niche).

Domain: ${row.domain}
Homepage text: "${pageText}"

Respond with ONLY valid JSON, no other text:
{"verdict": "fit_small"|"fit_large"|"partner"|"reject"|"unsure", "confidence": "high"|"low", "category": "one of: ${CATEGORIES.map((c) => `"${c}"`).join(', ')}"|null, "reason": "one short sentence"}

Use "reject" only when you have real, specific evidence from the homepage text. Use "fit_small"/"fit_large" only when you have real, specific evidence this is a genuine publication, and pick "category" (best single guess, required whenever verdict is fit_small or fit_large, otherwise null) based on what the content is actually about. Use "partner" only when the site is clearly a marketplace of multiple bookable providers, not a single business. Otherwise "unsure" - a lead left alone costs nothing, a good lead wrongly closed or a bad one wrongly contacted both cost real time.`;

  async function callOnce() {
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
        console.error(`API error ${response.status} for ${row.domain}: ${body.slice(0, 300)}`);
        return null;
      }
      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
      }
      return parsed && parsed.verdict ? parsed : null;
    } catch (err) {
      console.error(`fetch failed for ${row.domain}: ${err.message}`);
      return null;
    }
  }

  let parsed = await callOnce();
  if (!parsed) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    parsed = await callOnce();
  }
  if (!parsed) {
    return { verdict: 'unsure', confidence: 'low', reason: 'empty/unparseable model response after retry' };
  }
  const verdict = ['fit_small', 'fit_large', 'partner', 'reject', 'unsure'].includes(parsed.verdict) ? parsed.verdict : 'unsure';
  const confidence = ['high', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : null;
  return { verdict, confidence, category, reason: parsed.reason || '' };
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
    SELECT id, domain, homepage_url
    FROM candidate_publishers
    WHERE status = 'discovered' AND category IS NULL
    ORDER BY id ASC
  `;
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Reviewing ${rows.length} still-uncategorized apollo_import lead(s), concurrency ${CONCURRENCY}${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  let rejected = 0, confirmedSmall = 0, confirmedLarge = 0, confirmedPartner = 0, unsure = 0, processedCount = 0;

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
    } else if (result.verdict === 'partner' && actOnIt) {
      confirmedPartner++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: PARTNER - ${result.reason}`);
      if (!DRY_RUN) {
        await sql`
          UPDATE candidate_publishers
          SET status = 'partner', outreach_notes = COALESCE(NULLIF(outreach_notes, ''), ${'Auto-reviewed: ' + result.reason})
          WHERE id = ${row.id}
        `;
      }
    } else if (result.verdict === 'fit_large' && actOnIt) {
      confirmedLarge++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: LARGE PUBLISHER - ${result.reason}`);
      if (!DRY_RUN) {
        await sql`UPDATE candidate_publishers SET status = 'large_publisher', category = COALESCE(${result.category}, category) WHERE id = ${row.id}`;
      }
    } else if (result.verdict === 'fit_small' && actOnIt) {
      confirmedSmall++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: fit (small) - ${result.reason}`);
      if (!DRY_RUN && result.category) {
        await sql`UPDATE candidate_publishers SET category = ${result.category} WHERE id = ${row.id}`;
      }
    } else {
      unsure++;
      console.log(`[${processedCount}/${rows.length}] ${row.domain}: unsure - ${result.reason}`);
    }
  }, CONCURRENCY);

  console.log(`\nDone. ${rejected} rejected as not a fit, ${confirmedSmall} confirmed small/independent fits (left in Untouched), ${confirmedLarge} confirmed genuine but large (-> Larger publishers), ${confirmedPartner} confirmed multi-expert marketplaces (-> IntroLinq partners), ${unsure} left as-is (unsure/unreachable).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
