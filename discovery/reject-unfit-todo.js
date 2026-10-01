// Cleans up the "Untouched" outreach bucket (status='discovered'), which
// classify.js's title/snippet-only pass never rejects anything out of - so
// vendors, directories, and dead sites accumulate there forever alongside
// genuine publisher leads. Runs across ALL discovered leads regardless of
// lead_type/team_size, checking real homepage content (a domain/snippet
// alone isn't enough to judge this reliably), and acts in four directions:
//
//   - Not a publication at all (vendor, directory, dead/parked, wrong
//     language) -> status='not_a_fit'.
//   - A genuine blog/publication, but a large or well-known outfit that
//     would never embed a third-party widget today -> status=
//     'large_publisher'. Previously these were rejected into 'not_a_fit'
//     alongside actual junk, which just lost them - splitting this out
//     keeps them visible in their own "Larger publishers" section instead,
//     in case that ever changes. (2026-08-25)
//   - Not a blog at all, but a marketplace/platform booking MULTIPLE
//     outside experts (a Clarity.fm/GrowthMentor-style advisor marketplace,
//     a yoga-teacher booking platform, a wedding vendor marketplace) ->
//     status='partner' ("IntroLinq partners"). Originally lumped in with
//     'not_a_fit' as a "competing marketplace" - but these aren't
//     competitors to reject, they're potential commission partners whose
//     experts IntroLinq could list too. (2026-08-26, after wedmegood.com
//     and liveyogateachers.com were caught misclassified as rejects)
//   - A genuine small/solo publication -> left in 'discovered' ("Untouched"),
//     same as before, just with category refined from real page content
//     instead of the original search snippet.
//
// Anything the model isn't confident about is left exactly where it was -
// a wrongly-closed lead is worse than one that just sits a while longer.
//
// Usage: node discovery/reject-unfit-todo.js [--limit N] [--dry-run]

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
    return { verdict: 'unsure', reason: 'could not fetch homepage', confidence: 'low' };
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

Existing lead_type guess from a prior pass (title/snippet only, may be wrong): ${row.lead_type || 'unknown'}

Domain: ${row.domain}
Homepage text: "${pageText}"

Respond with ONLY valid JSON, no other text:
{"verdict": "fit_small"|"fit_large"|"partner"|"reject"|"unsure", "confidence": "high"|"low", "category": "one of: ${CATEGORIES.map((c) => `"${c}"`).join(', ')}"|null, "reason": "one short sentence"}

Use "reject" only when you have real, specific evidence from the homepage text. Use "fit_small"/"fit_large" only when you have real, specific evidence this is a genuine publication, and pick "category" (best single guess, required whenever verdict is fit_small or fit_large, otherwise null) based on what the content is actually about. Use "partner" only when the site is clearly a marketplace of multiple bookable providers, not a single business. Otherwise "unsure" - a lead left alone costs nothing, a good lead wrongly closed or a bad one wrongly contacted both cost real time.`;

  // Root-caused during dry-run testing 2026-08-25: some leads (avc.com,
  // paulgraham.com, etc.) deterministically came back with content=[{type:
  // "thinking", thinking: ""}] and stop_reason="max_tokens" - the three-
  // verdict reasoning here is enough to trigger extended thinking on some
  // inputs, and the old max_tokens:300 (sized for a simpler fit/reject/
  // unsure prompt) left zero tokens free for the actual JSON answer once
  // thinking ate the whole budget. Not flakiness - the same prompt fails
  // the same way every time, so retrying alone doesn't fix it; max_tokens
  // needed real headroom. The retry below is kept as a backstop for
  // genuine transient empty responses, not the primary fix.
  async function callOnce() {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    // Extended thinking means content[0] may be a {type:"thinking"} block
    // rather than the text answer - find the actual text block instead of
    // assuming index 0.
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const text = textBlock?.text || '';
    if (!text) return null; // empty response - caller retries or gives up
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    return parsed && parsed.verdict ? parsed : null;
  }

  try {
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
      // Left in 'discovered' on purpose - stays exactly where a real
      // outreach target belongs. verified_fit_at is what actually moves it
      // from "To be classified" into "Find email" in the CRM (see
      // outreachBucket in outreach/index.html) - category also gets
      // refined from real page content instead of the original snippet.
      if (!DRY_RUN) {
        await sql`UPDATE candidate_publishers SET verified_fit_at = NOW(), category = COALESCE(${result.category}, category) WHERE id = ${row.id}`;
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
