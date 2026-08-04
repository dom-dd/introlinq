import { neon } from '@neondatabase/serverless';

// Click-tracking redirect for links embedded in manually-sent cold outreach
// emails (Gmail, not through Resend - see admin/index.html's outreach tab).
// /api/r?id=<candidate_publishers.id> logs a click, then always redirects
// regardless of whether logging succeeded - a tracking failure should never
// be visible to the person who just clicked a link in an email.
let tableReady = false;
async function ensureTable(sql) {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS outreach_clicks (
    id SERIAL PRIMARY KEY,
    candidate_id INT NOT NULL REFERENCES candidate_publishers(id),
    clicked_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  tableReady = true;
}

export default async function handler(req, res) {
  const { id } = req.query;

  if (id && /^\d+$/.test(id)) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      await ensureTable(sql);
      await sql`INSERT INTO outreach_clicks (candidate_id) VALUES (${parseInt(id, 10)})`;
    } catch {}
  }

  res.writeHead(302, { Location: 'https://www.introlinq.com/' });
  res.end();
}
