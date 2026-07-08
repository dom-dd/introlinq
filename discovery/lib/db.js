import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy discovery/.env.local.example to discovery/.env.local and fill it in.');
}

export const sql = neon(process.env.DATABASE_URL);

export async function ensureSchema() {
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
  await sql`CREATE INDEX IF NOT EXISTS idx_candidate_publishers_status ON candidate_publishers(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_discovery_queries_status ON discovery_queries(status)`;
}
