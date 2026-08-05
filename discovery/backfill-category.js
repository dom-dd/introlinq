// One-off backfill for candidates classified before classify.js started
// asking for a content-topic category (Music, Finance, Health, etc. - see
// lib/categories.js). Re-uses the title/snippet already stored, same
// batched-Haiku pattern as the other backfills.
//
// Usage: node discovery/backfill-category.js

import { sql } from './lib/db.js';
import { CATEGORIES } from './lib/categories.js';

const BATCH_SIZE = 15;

async function categorizeBatch(rows) {
  const list = rows.map((r, i) =>
    `${i + 1}. domain: ${r.domain} | title: "${(r.title || '').slice(0, 150)}" | snippet: "${(r.snippet || '').slice(0, 200)}"`
  ).join('\n');

  const prompt = `For each website below, give a "category": which ONE of these topic categories the site's content is actually about: ${CATEGORIES.map((c) => `"${c}"`).join(', ')}. Pick "Other" if it doesn't fit any of the rest, and your best single guess if it spans more than one - never null, always pick one.

Sites:
${list}

Return ONLY valid JSON, no other text, in the same order as listed:
{"results":[{"domain":"...","category":"..."}]}`;

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

  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS category TEXT`;

  const rows = await sql`SELECT id, domain, title, snippet FROM candidate_publishers WHERE category IS NULL ORDER BY id ASC`;
  console.log(`Backfilling category for ${rows.length} candidate(s) in batches of ${BATCH_SIZE}...`);

  if (rows.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const byDomain = Object.fromEntries(batch.map((r) => [r.domain, r]));

    try {
      const results = await categorizeBatch(batch);
      for (const res of results) {
        const row = byDomain[res.domain];
        if (!row) continue;
        const category = CATEGORIES.includes(res.category) ? res.category : 'Other';
        await sql`UPDATE candidate_publishers SET category = ${category} WHERE id = ${row.id}`;
        done++;
      }
      console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: backfilled ${results.length}/${batch.length}`);
    } catch (err) {
      console.error(`  batch ${Math.floor(i / BATCH_SIZE) + 1} FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${done}/${rows.length} candidates backfilled.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
