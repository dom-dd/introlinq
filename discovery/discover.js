// Blog/publisher discovery across every category (see lib/categories.js),
// not just business: generates search queries, runs them through SerpAPI,
// dedupes discovered domains, and stores them in Postgres.
//
// Usage:
//   node discovery/discover.js --target 500
//
// Resumable: progress lives entirely in the database (discovery_queries +
// candidate_publishers), so re-running the same command picks up where the
// last run left off - already-run queries are skipped, already-seen domains
// are never duplicated.

import { sql, ensureSchema } from './lib/db.js';
import { serpSearch, extractCandidates, serpPlanSearchesLeft, SEARCHES_PER_DAY, PLAN_SAFETY_FLOOR } from './lib/serpapi.js';
import { generateQueriesByCategory, categoryForQuery, PRIORITY_CATEGORY } from './lib/queries.js';

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
  // Round-robin across categories (not just interleaved guest-post/direct-blog
  // within Business) so even a small --target run samples breadth - see
  // lib/queries.js's generateQueriesByCategory.
  const queries = generateQueriesByCategory();
  let inserted = 0;
  for (const query of queries) {
    const result = await sql`
      INSERT INTO discovery_queries (query, category) VALUES (${query}, ${categoryForQuery(query)})
      ON CONFLICT (query) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) inserted++;
  }
  return { total: queries.length, inserted };
}

// PRIORITY_CATEGORY's pending queries are pulled first (see lib/queries.js
// for why - it ran out of query volume entirely before any other category
// made a dent in theirs), then plain id order as before for everything
// else/once it's exhausted again.
async function nextPendingQuery() {
  const [row] = await sql`
    SELECT id, query FROM discovery_queries
    WHERE status = 'pending'
    ORDER BY (category = ${PRIORITY_CATEGORY}) DESC, id ASC
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

  // SerpAPI is a SHARED key, so budget by our OWN usage today (searches run
  // since UTC midnight, counted from discovery_queries) - a big --target run
  // stops once we've hit SEARCHES_PER_DAY rather than eating into the shared
  // plan. See discovery/lib/serpapi.js for the knobs.
  const [{ count: usedToday }] = await sql`
    SELECT COUNT(*)::int AS count FROM discovery_queries WHERE run_at >= date_trunc('day', NOW())`;
  let searchBudget = SEARCHES_PER_DAY - usedToday;
  try {
    const planLeft = await serpPlanSearchesLeft();
    searchBudget = Math.min(searchBudget, planLeft - PLAN_SAFETY_FLOOR);
  } catch { /* account endpoint unreachable - daily budget still applies */ }
  console.log(`SerpAPI: ${usedToday}/${SEARCHES_PER_DAY} searches used today; this run may make up to ${Math.max(0, searchBudget)} more`);
  if (searchBudget <= 0) {
    console.log('Daily SerpAPI budget is spent - stopping. Try again after UTC midnight, or raise SEARCHES_PER_DAY in lib/serpapi.js.');
    return;
  }

  let domainCount = await currentDomainCount();
  console.log(`Starting. Domains so far: ${domainCount} / target ${target}`);

  let searchesMade = 0;
  let stopReason = 'target reached';
  while (domainCount < target) {
    if (searchesMade >= searchBudget) {
      stopReason = `daily SerpAPI budget reached (${searchesMade} searches this run)`;
      break;
    }
    const query = await nextPendingQuery();
    if (!query) {
      stopReason = 'query pool exhausted';
      break;
    }

    try {
      const results = await serpSearch(query.query);
      searchesMade++;
      const candidates = extractCandidates(results);
      const newDomains = await insertCandidates(candidates, query.query);
      await markQueryDone(query.id, { resultsCount: results.length, newDomainsCount: newDomains });
      domainCount += newDomains;
      console.log(`[${query.query}] +${newDomains} new domains (total: ${domainCount}/${target}, ${searchesMade}/${searchBudget} searches)`);
    } catch (err) {
      searchesMade++; // a failed attempt may still have counted against the quota
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
