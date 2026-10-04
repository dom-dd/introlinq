import { neon } from '@neondatabase/serverless';
import { isBotUserAgent, isNonBrowserRequest } from './_botDetect.js';

// Click-tracking redirect for links embedded in manually-sent cold outreach
// emails to AFFILIATE prospects (SaaS tools, retailers, expert marketplaces
// - see admin/index.html's Affiliate outreach tab). Mirrors api/r.js exactly
// but points at affiliate_leads/affiliate_outreach_clicks instead of
// candidate_publishers/outreach_clicks - kept as a separate small endpoint
// rather than branching r.js by type, since the two lead pipelines are
// conceptually distinct (recruiting publishers to install the widget vs.
// pitching companies to become an affiliate partner).
// /api/ar?id=<affiliate_leads.id> logs a click, then always redirects
// regardless of whether logging succeeded - a tracking failure should never
// be visible to the person who just clicked a link in an email.
let tableReady = false;
async function ensureTable(sql) {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS affiliate_outreach_clicks (
    id SERIAL PRIMARY KEY,
    lead_id INT NOT NULL REFERENCES affiliate_leads(id),
    clicked_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE affiliate_outreach_clicks ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
  tableReady = true;
}

export default async function handler(req, res) {
  const { id } = req.query;

  if (id && /^\d+$/.test(id)) {
    try {
      const leadId = parseInt(id, 10);
      const sql = neon(process.env.DATABASE_URL);
      await ensureTable(sql);
      const [lead] = await sql`SELECT domain, company_name FROM affiliate_leads WHERE id = ${leadId}`;
      const automated = isBotUserAgent(req) || isNonBrowserRequest(req);
      await sql`INSERT INTO affiliate_outreach_clicks (lead_id, is_bot) VALUES (${leadId}, ${automated})`;

      // Awaited (not fire-and-forget) - a serverless function can be frozen
      // the instant the response is sent, same reasoning as api/r.js.
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
      if (lead && !automated && process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL) {
        const label = lead.company_name || lead.domain;
        await fetch(process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `🔗 *${label}* clicked the link in your affiliate outreach email` }),
        }).catch(() => {});
      }
    } catch {}
  }

  res.writeHead(302, { Location: 'https://www.introlinq.com/' });
  res.end();
}
