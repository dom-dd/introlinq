import { neon } from '@neondatabase/serverless';
import { isBotUserAgent, isNonBrowserRequest } from './_botDetect.js';

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
  await sql`ALTER TABLE outreach_clicks ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
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
      const automated = isBotUserAgent(req) || isNonBrowserRequest(req);
      await sql`INSERT INTO outreach_clicks (candidate_id, is_bot) VALUES (${candidateId}, ${automated})`;

      // Awaited (not fire-and-forget) - a serverless function can be frozen
      // the instant the response is sent, same reasoning as the /brief and
      // login notifications elsewhere in the codebase.
      // Mail scanners are the whole reason this guard exists: a cold email
      // sent to a work address is routinely opened by SafeLinks/Proofpoint/
      // Mimecast-style link checking before the recipient ever sees it, and
      // that fetch is indistinguishable from a click here - it hits this URL
      // with a scanner User-Agent (or a spoofed browser one and no Sec-Fetch
      // navigation headers), logs a row, and used to fire a Slack ping saying
      // the prospect had clicked. The row is still recorded, flagged, so the
      // historical counts stay intact and can be filtered later; only the
      // notification is suppressed, because a ping is a claim that a person
      // did something (2026-10-04).
      if (candidate && !automated && process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL) {
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
