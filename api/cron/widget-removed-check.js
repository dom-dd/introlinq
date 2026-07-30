import { neon } from '@neondatabase/serverless';

// One internal heads-up to Dom the first time a previously-live publisher
// goes quiet - no publisher-facing emails. Follow-up happens personally
// from there (worked fine for psyll: a manual, personally-worded email got
// a real reply). 3 days rules out a single quiet weekend or a low-traffic
// blog's normal gap, while still catching real removals fast enough to
// follow up while it's fresh.
const DAYS_SILENT = 3;
const NOTIFY_EMAIL = 'dom@introlinq.com';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_removed_notified_at TIMESTAMPTZ`.catch(() => {});

  // ever went live, currently silent, not already notified about this
  // silence episode (widget_removed_notified_at is cleared in match.js the
  // moment the widget fires again, so a reinstall + later re-removal
  // re-triggers this cleanly).
  const candidates = await sql`
    SELECT * FROM publishers
    WHERE active = true
      AND first_widget_fire_at IS NOT NULL
      AND last_widget_fire_at IS NOT NULL
      AND widget_removed_notified_at IS NULL
      AND slug NOT LIKE 'demo-%'
  `;

  const results = [];

  for (const pub of candidates) {
    const daysSinceQuiet = (Date.now() - new Date(pub.last_widget_fire_at).getTime()) / 86400000;
    if (daysSinceQuiet < DAYS_SILENT) continue;

    const lastFire = new Date(pub.last_widget_fire_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <notifications@introlinq.com>',
        to: NOTIFY_EMAIL,
        subject: `${pub.name} may have removed the widget`,
        text: `${pub.name} (${pub.slug}, ${pub.email}) hasn't fired the widget since ${lastFire} (${Math.floor(daysSinceQuiet)} days silent). They were live before, so this looks like a removal rather than a never-installed case. Worth a personal follow-up.`,
      }),
    });

    if (emailRes.ok) {
      await sql`UPDATE publishers SET widget_removed_notified_at = NOW() WHERE id = ${pub.id}`;
    }

    results.push({ publisher: pub.slug, daysSinceQuiet: Math.floor(daysSinceQuiet), notified: emailRes.ok });
  }

  return res.status(200).json({ checked: candidates.length, results });
}
