import { neon } from '@neondatabase/serverless';

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
      await sql`INSERT INTO affiliate_outreach_clicks (lead_id) VALUES (${leadId})`;

      // Awaited (not fire-and-forget) - a serverless function can be frozen
      // the instant the response is sent, same reasoning as api/r.js.
      if (lead && process.env.SLACK_EMAIL_CLICKS_WEBHOOK_URL) {
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
