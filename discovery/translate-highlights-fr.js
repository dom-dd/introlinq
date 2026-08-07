// One-off translation of every expert's curated `highlights` (English,
// hand-written on their profile - see api/match.js's slice(0,2) use as the
// no-rescan-needed source for the widget's punchy facts line) into French,
// stored in a new `highlights_fr` column. Lets tryServeFromCache swap in
// the French version for pages whose match_cache row has lang_code='fr'
// (see api/match.js), fixing the facts line on every already-cached French
// page instantly - no rescan, no per-page AI cost, translated once here
// instead. Real facts only: translate, never invent or embellish.
//
// Usage: node discovery/translate-highlights-fr.js [--limit N] [--dry-run]

import { sql } from './lib/db.js';

const CONCURRENCY = 6;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : null;

async function ensureColumn() {
  await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS highlights_fr TEXT[]`;
}

async function translateOne(expert) {
  const prompt = `Translate this list of short professional highlight facts into French. Keep numbers, currency amounts, and company/product names exactly as they are - translate only the surrounding language. Keep the same short, punchy, resume-headline style (do not turn them into full sentences).

Facts (JSON array):
${JSON.stringify(expert.highlights)}

Respond with ONLY a valid JSON array of the same length, no other text, e.g.:
["fait traduit un","fait traduit deux"]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : [];
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  } catch (err) {
    console.error(`[error] ${expert.name}: ${err.message}`);
    return null;
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

  await ensureColumn();

  let experts = await sql`
    SELECT id, name, highlights
    FROM experts
    WHERE active = true AND highlights IS NOT NULL AND array_length(highlights, 1) > 0
      AND highlights_fr IS NULL
    ORDER BY id ASC
  `;
  if (LIMIT) experts = experts.slice(0, LIMIT);
  console.log(`Translating highlights for ${experts.length} expert(s) into French, concurrency ${CONCURRENCY}${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  let done = 0, failed = 0, processedCount = 0;

  await runPool(experts, async (expert) => {
    const translated = await translateOne(expert);
    processedCount++;
    if (!translated) {
      failed++;
      console.log(`[${processedCount}/${experts.length}] ${expert.name}: FAILED`);
      return;
    }
    done++;
    console.log(`[${processedCount}/${experts.length}] ${expert.name}: ${translated.join(' | ')}`);
    if (!DRY_RUN) {
      await sql`UPDATE experts SET highlights_fr = ${translated} WHERE id = ${expert.id}`;
    }
  }, CONCURRENCY);

  console.log(`\nDone. ${done} translated, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
