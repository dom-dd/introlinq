// Business publisher discovery: generates search queries, runs them through
// SerpAPI, dedupes discovered domains, and stores them in Postgres.
//
// Usage:
//   node discovery/discover.js --target 500
//
// Resumable: progress lives entirely in the database (discovery_queries +
// candidate_publishers), so re-running the same command picks up where the
// last run left off - already-run queries are skipped, already-seen domains
// are never duplicated.

import { sql, ensureSchema } from './lib/db.js';
import { serpSearch, extractCandidates } from './lib/serpapi.js';
import { generateQueries } from './lib/queries.js';

function parseArgs(argv) {
  const args = { target: 500 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') args.target = parseInt(argv[i + 1], 10) || args.target;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedQueryPool() {
  const queries = generateQueries();
  let inserted = 0;
  for (const query of queries) {
    const result = await sql`
      INSERT INTO discovery_queries (query) VALUES (${query})
      ON CONFLICT (query) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) inserted++;
  }
  return { total: queries.length, inserted };
}

async function nextPendingQuery() {
  const [row] = await sql`
    SELECT id, query FROM discovery_queries
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `;
  return row || null;
}

async function markQueryDone(id, { resultsCount, newDomainsCount }) {
  await sql`
    UPDATE discovery_queries
    SET status = 'done', results_count = ${resultsCount}, new_domains_count = ${newDomainsCount}, run_at = NOW()
    WHERE id = ${id}
  `;
}

async function markQueryFailed(id, error) {
  await sql`
    UPDATE discovery_queries
    SET status = 'failed', error = ${String(error).slice(0, 500)}, run_at = NOW()
    WHERE id = ${id}
  `;
}

async function insertCandidates(candidates, discoveryQuery) {
  let newCount = 0;
  for (const c of candidates) {
    const result = await sql`
      INSERT INTO candidate_publishers (domain, homepage_url, title, snippet, discovery_query)
      VALUES (${c.domain}, ${c.homepage_url}, ${c.title}, ${c.snippet}, ${discoveryQuery})
      ON CONFLICT (domain) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) newCount++;
  }
  return newCount;
}

async function currentDomainCount() {
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM candidate_publishers`;
  return row.count;
}

async function main() {
  const { target } = parseArgs(process.argv.slice(2));

  console.log('Ensuring schema...');
  await ensureSchema();

  console.log('Seeding query pool...');
  const seed = await seedQueryPool();
  console.log(`  ${seed.total} queries generated, ${seed.inserted} new`);

  let domainCount = await currentDomainCount();
  console.log(`Starting. Domains so far: ${domainCount} / target ${target}`);

  let stopReason = 'target reached';
  while (domainCount < target) {
    const query = await nextPendingQuery();
    if (!query) {
      stopReason = 'query pool exhausted';
      break;
    }

    try {
      const results = await serpSearch(query.query);
      const candidates = extractCandidates(results);
      const newDomains = await insertCandidates(candidates, query.query);
      await markQueryDone(query.id, { resultsCount: results.length, newDomainsCount: newDomains });
      domainCount += newDomains;
      console.log(`[${query.query}] +${newDomains} new domains (total: ${domainCount}/${target})`);
    } catch (err) {
      await markQueryFailed(query.id, err.message);
      console.error(`[${query.query}] FAILED: ${err.message}`);
    }

    // Be gentle with the API - avoid hammering it in a tight loop.
    await sleep(500);
  }

  console.log(`\nDone. ${domainCount} candidate domains stored. Stopped: ${stopReason}`);
}

process.on('SIGINT', () => {
  console.log('\nInterrupted - progress is saved. Re-run the same command to resume.');
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
