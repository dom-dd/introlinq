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
      const candidateId = parseInt(id, 10);
      const sql = neon(process.env.DATABASE_URL);
      await ensureTable(sql);
      const [candidate] = await sql`SELECT domain, company_name FROM candidate_publishers WHERE id = ${candidateId}`;
      await sql`INSERT INTO outreach_clicks (candidate_id) VALUES (${candidateId})`;

      // Awaited (not fire-and-forget) - a serverless function can be frozen
      // the instant the response is sent, same reasoning as the /brief and
      // login notifications elsewhere in the codebase.
      if (candidate && process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL) {
        const label = candidate.company_name || candidate.domain;
        await fetch(process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `🔗 *${label}* clicked the link in your outreach email` }),
        }).catch(() => {});
      }
    } catch {}
  }

  res.writeHead(302, { Location: 'https://www.introlinq.com/' });
  res.end();
}
