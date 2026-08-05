// One-off backfill: suggests partner/openintro_partner/products_partner for
// candidates that were classified before classify.js started asking for
// suggested_category. Only touches rows whose status is still one of the
// untouched defaults (never 'important', never an already-set category,
// never a resolved/closed outcome, never anything a human picked by hand).
//
// Usage: node discovery/categorize-existing-leads.js

import { sql } from './lib/db.js';

const BATCH_SIZE = 15;
const VALID_CATEGORIES = new Set(['partner', 'openintro_partner', 'products_partner']);
const UNTOUCHED_STATUSES = ['discovered', 'emailed', 'followed_up_1', 'followed_up_2'];

async function categorizeBatch(rows) {
  const list = rows.map((r, i) =>
    `${i + 1}. domain: ${r.domain} | lead_type: ${r.lead_type || 'unclear'} | service_keyword: ${r.service_keyword || 'none'} | title: "${(r.title || '').slice(0, 150)}" | snippet: "${(r.snippet || '').slice(0, 200)}"`
  ).join('\n');

  const prompt = `For each business website below, assess whether it fits one of three special outreach categories for IntroLinq (a platform that lets blog readers book 1:1 calls with startup/business experts). Each site already has a lead_type from an earlier classification pass, given below as context.

- "partner": the company's core product is an expert/advisor marketplace connecting people with MULTIPLE outside experts they can book, in any field (Clarity.fm, GrowthMentor, MentorCruise-style). IntroLinq could list their experts too, on a commission or pay-per-click basis. A lead with lead_type "competitor" is very often also "partner" here.
- "openintro_partner": an ORGANIZATION - not necessarily a software product - that represents or aggregates MULTIPLE experts/speakers as part of its identity: a large event/conference (web-summit style), a community, an incubator, an accelerator, or a speaking agency. These would benefit from a branded booking page (OpenIntro already runs pages like this for existing partners, e.g. open-intro.com/partner/pomona-partners) where people book that organization's people directly.
- "products_partner": the company sells a specific PRODUCT (CRM, SaaS tool, office space, software - not a service/agency). No fit for IntroLinq's expert-matching model today, but a plausible future pay-per-click or monthly-fee partner for product recommendations embedded in blog content ("You need an office space" -> their site). Dropbox is a good example of the type. A lead with lead_type "vendor" is very often also "products_partner" here.

Sites:
${list}

Give "suggested_category": one of "partner", "openintro_partner", "products_partner", or null. Only pick one of the three when you have real, specific evidence in the title/snippet/lead_type/service_keyword that it fits - if unsure, use null rather than guessing.

Return ONLY valid JSON, no other text, in the same order as listed:
{"results":[{"domain":"...","suggested_category":"partner|openintro_partner|products_partner"|null}]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{"results":[]}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { results: [] };
  }
  return parsed.results || [];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to discovery/.env.local');
  }

  const rows = await sql`
    SELECT id, domain, title, snippet, lead_type, service_keyword
    FROM candidate_publishers
    WHERE status = ANY(${UNTOUCHED_STATUSES})
    ORDER BY id ASC
  `;
  console.log(`Assessing ${rows.length} candidate(s) for special categories, in batches of ${BATCH_SIZE}...`);

  if (rows.length === 0) {
    console.log('Nothing to categorize.');
    return;
  }

  let flagged = { partner: 0, openintro_partner: 0, products_partner: 0 };
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const byDomain = Object.fromEntries(batch.map((r) => [r.domain, r]));

    try {
      const results = await categorizeBatch(batch);
      for (const res of results) {
        const row = byDomain[res.domain];
        if (!row) continue;
        const category = VALID_CATEGORIES.has(res.suggested_category) ? res.suggested_category : null;
        if (!category) continue;
        await sql`UPDATE candidate_publishers SET status = ${category} WHERE id = ${row.id}`;
        flagged[category]++;
        console.log(`  [${row.domain}] -> ${category}`);
      }
      done += batch.length;
      console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: processed ${batch.length}`);
    } catch (err) {
      console.error(`  batch ${Math.floor(i / BATCH_SIZE) + 1} FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${done}/${rows.length} assessed.`);
  console.log(`Flagged: ${flagged.partner} partner, ${flagged.openintro_partner} openintro_partner, ${flagged.products_partner} products_partner.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
