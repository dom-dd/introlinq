// Daily cron: finds up to DAILY_TARGET new candidate publisher domains via
// SerpAPI and stores them in candidate_publishers, same tables/logic as
// discovery/discover.js (run manually), but as a Vercel Cron job so it runs
// once a day regardless of whether anyone's machine is on.
//
// Does NOT run classify.js or enrich.js - those cost Anthropic/Apollo
// credits per lead and stay manual (see discovery/README.md) so spend stays
// a deliberate choice, not an automatic daily cost.
//
// Once every query in the pool has run at least once, new leads per day
// will drop toward zero - extend TOPICS/GUEST_POST_INTENTS/etc. in
// discovery/lib/queries.js to keep the pool from running dry.

import { neon } from '@neondatabase/serverless';
import { generateQueries } from '../../discovery/lib/queries.js';
import { serpSearch, extractCandidates } from '../../discovery/lib/serpapi.js';

const DAILY_TARGET = 50;
// Vercel kills the function past its configured maxDuration (see
// vercel.json) - stop well before that so we always finish cleanly and
// leave a clear stopReason instead of getting hard-killed mid-query.
const TIME_BUDGET_MS = 45000;

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const started = Date.now();

  await sql`CREATE TABLE IF NOT EXISTS candidate_publishers (
    id SERIAL PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    homepage_url TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    discovery_query TEXT,
    discovery_source TEXT NOT NULL DEFAULT 'serpapi',
    status TEXT NOT NULL DEFAULT 'discovered',
    priority_score NUMERIC,
    estimated_monthly_visits BIGINT,
    country TEXT,
    language TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS discovery_queries (
    id SERIAL PRIMARY KEY,
    query TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    results_count INT,
    new_domains_count INT,
    error TEXT,
    run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;

  // Only seed on the first-ever run (or if the query list has grown since) -
  // re-inserting all ~450 queries with ON CONFLICT DO NOTHING every single
  // day would burn a meaningful chunk of the time budget for no reason once
  // the pool is already seeded.
  const queries = generateQueries();
  const [{ count: seededCount }] = await sql`SELECT COUNT(*)::int AS count FROM discovery_queries`;
  if (seededCount < queries.length) {
    for (const q of queries) {
      await sql`INSERT INTO discovery_queries (query) VALUES (${q}) ON CONFLICT (query) DO NOTHING`;
    }
  }

  let added = 0;
  let queriesRun = 0;
  let stopReason = 'daily target reached';

  while (added < DAILY_TARGET) {
    if (Date.now() - started > TIME_BUDGET_MS) { stopReason = 'time budget reached'; break; }

    const [query] = await sql`
      SELECT id, query FROM discovery_queries
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `;
    if (!query) { stopReason = 'query pool exhausted'; break; }

    try {
      const results = await serpSearch(query.query);
      const candidates = extractCandidates(results);
      let newCount = 0;
      for (const c of candidates) {
        const result = await sql`
          INSERT INTO candidate_publishers (domain, homepage_url, title, snippet, discovery_query)
          VALUES (${c.domain}, ${c.homepage_url}, ${c.title}, ${c.snippet}, ${query.query})
          ON CONFLICT (domain) DO NOTHING
          RETURNING id
        `;
        if (result.length > 0) newCount++;
      }
      await sql`
        UPDATE discovery_queries
        SET status = 'done', results_count = ${results.length}, new_domains_count = ${newCount}, run_at = NOW()
        WHERE id = ${query.id}
      `;
      added += newCount;
    } catch (err) {
      await sql`
        UPDATE discovery_queries
        SET status = 'failed', error = ${String(err.message || err).slice(0, 500)}, run_at = NOW()
        WHERE id = ${query.id}
      `;
    }
    queriesRun++;

    // Be gentle with SerpAPI - same courtesy delay as the manual CLI script.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return res.status(200).json({ ok: true, added, queriesRun, stopReason, elapsedMs: Date.now() - started });
}
