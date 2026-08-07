// Verification pass for the Apollo-imported lead batch (see import-apollo.js).
// These arrived as people (a blogger's name + email + LinkedIn), not vetted
// leads - the CSV's Title/Keywords columns are Apollo's own guesses, not real
// page content, so this pass fetches the actual homepage before judging, same
// approach as reject-unfit-todo.js. Unlike that script, this one also checks
// for the two special outreach categories classify.js defines elsewhere
// (openintro_partner, products_partner) plus the expert-marketplace "partner"
// category, since a chunk of an Apollo people-search will be vendors/agencies/
// competitors rather than plain publishers.
//
// Usage: node discovery/classify-apollo.js [--limit N] [--dry-run]

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

const VALID_VERDICTS = ['fit', 'openintro_partner', 'products_partner', 'partner', 'reject', 'unsure'];

async function judgeOne(row) {
  const pageText = await fetchHomepageText(row.homepage_url);
  if (!pageText || pageText.length < 50) {
    return { verdict: 'unsure', confidence: 'low', reason: 'could not fetch homepage' };
  }

  const prompt = `Classify this lead for IntroLinq, a widget that scans a blog's articles and inserts links to bookable, vetted experts (business, finance, health, music, art, real estate, etc.), splitting the booking commission 50/50 with the site.

Pick exactly ONE verdict:

- "fit": a genuinely independent blog/publication (solo or small team) that publishes real articles for readers, where the content itself is the product - would plausibly embed a third-party widget on its pages.
- "openintro_partner": an ORGANIZATION (not necessarily software) that represents or aggregates MULTIPLE experts/speakers as part of its identity - a large event/conference, a community, an incubator, an accelerator, or a speaking agency. Good fit for a branded booking page listing that org's people, not the widget.
- "products_partner": a company selling a specific PRODUCT (SaaS tool, physical product, office space) - no fit for expert-matching today, but a plausible future pay-per-click/monthly-fee partner for product recommendations embedded in blog content.
- "partner": the company's core PRODUCT is an expert/advisor marketplace connecting people with MULTIPLE outside experts they can book (Clarity.fm/GrowthMentor/MentorCruise-style). IntroLinq could list their experts too, on commission.
- "reject": none of the above - a large/recognizable brand or big editorial team, a directory/job board/forum/e-commerce store, an agency selling services (not a product), a dead/unreachable/irrelevant page, or spam.
- "unsure": genuinely can't tell from the homepage text.

Existing guess from title/keywords only (may be wrong, Apollo-generated): title="${row.title || ''}", keywords="${(row.snippet || '').slice(0, 200)}"

Domain: ${row.domain}
Homepage text: "${pageText}"

Respond with ONLY valid JSON, no other text:
{"verdict": "fit"|"openintro_partner"|"products_partner"|"partner"|"reject"|"unsure", "confidence": "high"|"low", "reason": "one short sentence"}

Only pick a verdict other than "unsure" when you have real, specific evidence from the homepage text - a lead left unsure costs nothing, a wrongly-sorted one costs real time later.`;

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
    const verdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'unsure';
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

const VERDICT_TO_STATUS = {
  fit: 'confirmed_fit',
  openintro_partner: 'openintro_partner',
  products_partner: 'products_partner',
  partner: 'partner',
  reject: 'not_a_fit',
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to discovery/.env.local');
  }

  let rows = await sql`
    SELECT id, domain, homepage_url, title, snippet
    FROM candidate_publishers
    WHERE discovery_source = 'apollo_import' AND status = 'discovered'
    ORDER BY id ASC
  `;
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Classifying ${rows.length} Apollo-imported lead(s), concurrency ${CONCURRENCY}${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  const counts = { fit: 0, openintro_partner: 0, products_partner: 0, partner: 0, reject: 0, unsure: 0 };
  let processedCount = 0;

  await runPool(rows, async (row) => {
    const result = await judgeOne(row);
    processedCount++;
    const actOnIt = result.confidence === 'high' && result.verdict !== 'unsure';
    const bucket = actOnIt ? result.verdict : 'unsure';
    counts[bucket]++;
    console.log(`[${processedCount}/${rows.length}] ${row.domain}: ${bucket.toUpperCase()} - ${result.reason}`);

    if (!DRY_RUN && actOnIt) {
      const newStatus = VERDICT_TO_STATUS[result.verdict];
      const notesReason = result.verdict === 'reject' ? 'Auto-reviewed: ' + result.reason : null;
      await sql`
        UPDATE candidate_publishers
        SET status = ${newStatus},
            outreach_notes = COALESCE(NULLIF(outreach_notes, ''), ${notesReason})
        WHERE id = ${row.id}
      `;
    }
  }, CONCURRENCY);

  console.log(`\nDone. fit=${counts.fit} openintro_partner=${counts.openintro_partner} products_partner=${counts.products_partner} partner=${counts.partner} reject=${counts.reject} unsure=${counts.unsure}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
