// Classifies each candidate as a "publisher" (independent blog/content site -
// good widget partner) or "vendor" (company selling a product/service whose
// blog is marketing content - potentially a better fit as a listed expert
// than a publisher partner), plus a one-word service keyword for vendors.
//
// Uses only the title/snippet already stored from discovery (no extra
// crawling), batched across many candidates per API call to keep cost low.
//
// Usage: node discovery/classify.js

import { sql } from './lib/db.js';

const BATCH_SIZE = 15;

async function ensureColumns() {
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS lead_type TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS service_keyword TEXT`;
}

async function classifyBatch(rows) {
  const list = rows.map((r, i) =>
    `${i + 1}. domain: ${r.domain} | title: "${(r.title || '').slice(0, 150)}" | snippet: "${(r.snippet || '').slice(0, 200)}"`
  ).join('\n');

  const prompt = `You are classifying leads for a blog outreach campaign for IntroLinq, a platform that lets blog readers book 1:1 calls with experts.

For each business website below, classify it as a lead:
- "publisher": an independent blog, magazine, or content site whose main purpose is publishing articles for readers. Good candidate to embed IntroLinq's widget as a publisher partner.
- "vendor": a company selling a specific product or service (SaaS tool, agency, consultancy, software) where the blog exists primarily to market that product/service. Not a great publisher partner, but the company's founder/team could be a good EXPERT to list on IntroLinq instead.
- "unclear": genuinely can't tell from the title/snippet given.

If "vendor", also give a "service_keyword": ONE short word or hyphenated term for what they sell (e.g. SEO, CRM, automation, accounting-software, marketing-agency, web-hosting, recruiting, legal-services, insurance, email-marketing). Use null for "publisher" or "unclear".

Sites:
${list}

Return ONLY valid JSON, no other text, in the same order as listed:
{"results":[{"domain":"...","lead_type":"publisher|vendor|unclear","service_keyword":"..."|null}]}`;

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

  await ensureColumns();

  const rows = await sql`
    SELECT id, domain, title, snippet FROM candidate_publishers
    WHERE lead_type IS NULL
    ORDER BY id ASC
  `;
  console.log(`Classifying ${rows.length} candidates in batches of ${BATCH_SIZE}...`);

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const byDomain = Object.fromEntries(batch.map((r) => [r.domain, r]));

    try {
      const results = await classifyBatch(batch);
      for (const res of results) {
        const row = byDomain[res.domain];
        if (!row) continue;
        await sql`
          UPDATE candidate_publishers
          SET lead_type = ${res.lead_type || 'unclear'}, service_keyword = ${res.service_keyword || null}
          WHERE id = ${row.id}
        `;
        done++;
      }
      console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: classified ${results.length}/${batch.length}`);
    } catch (err) {
      console.error(`  batch ${Math.floor(i / BATCH_SIZE) + 1} FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${done}/${rows.length} candidates classified.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
