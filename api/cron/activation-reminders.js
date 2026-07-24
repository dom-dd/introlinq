import { neon } from '@neondatabase/serverless';

// Redirects every send to TEST_EMAIL and scopes the publisher query down to
// TEST_PUBLISHER - flip to false only once a real run has been reviewed.
const TEST_MODE = true;
const TEST_PUBLISHER = 'little-green-agency';
const TEST_EMAIL = 'dom@open-intro.com';

// Days since signup at which each stage becomes eligible. Checked in order,
// lowest first - a publisher who's behind (e.g. after a cron outage) catches
// up one stage per run instead of getting every backlogged email at once.
const STAGES = [
  { n: 1, days: 1, col: 'reminder_1_sent_at', label: 'Day 1' },
  { n: 2, days: 3, col: 'reminder_2_sent_at', label: 'Day 3' },
  { n: 3, days: 10, col: 'reminder_3_sent_at', label: 'Day 10' },
  { n: 4, days: 24, col: 'reminder_4_sent_at', label: 'Day 24 (final)' },
];

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS reminder_1_sent_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS reminder_2_sent_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS reminder_3_sent_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS reminder_4_sent_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS reminders_paused BOOLEAN DEFAULT false`.catch(() => {});

  // first_widget_fire_at IS NULL is the actual "stop the sequence" condition -
  // the moment a publisher's widget genuinely fires for the first time, they
  // stop matching this query entirely and no further reminder ever sends,
  // regardless of which stage they were on.
  const candidates = TEST_MODE
    ? await sql`SELECT * FROM publishers WHERE slug = ${TEST_PUBLISHER} AND active = true`
    : await sql`
        SELECT * FROM publishers
        WHERE active = true
          AND first_widget_fire_at IS NULL
          AND reminders_paused = false
          AND created_at IS NOT NULL
      `;

  const results = [];

  for (const pub of candidates) {
    const daysSinceSignup = (Date.now() - new Date(pub.created_at).getTime()) / 86400000;
    const stage = STAGES.find(s => daysSinceSignup >= s.days && !pub[s.col]);
    if (!stage) continue;

    const email = TEST_MODE ? TEST_EMAIL : pub.email;
    const firstName = pub.contact_first_name || pub.name;
    const commissionPct = Math.round((pub.revenue_share ?? 0.5) * 100);

    const { subject, html } = buildReminderEmail(stage.n, {
      firstName,
      siteName: pub.name,
      slug: pub.slug,
      commissionPct,
    });

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'IntroLinq <hello@introlinq.com>', to: email, subject, html }),
    });

    if (emailRes.ok) {
      // Explicit per-column statements rather than a dynamic identifier -
      // this driver's support for interpolating a column name isn't
      // something to guess at in a write query.
      if (stage.col === 'reminder_1_sent_at') await sql`UPDATE publishers SET reminder_1_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_2_sent_at') await sql`UPDATE publishers SET reminder_2_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_3_sent_at') await sql`UPDATE publishers SET reminder_3_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_4_sent_at') await sql`UPDATE publishers SET reminder_4_sent_at = NOW() WHERE id = ${pub.id}`;
    }

    results.push({ publisher: pub.slug, stage: stage.n, label: stage.label, email, sent: emailRes.ok });
  }

  return res.status(200).json({ testMode: TEST_MODE, checked: candidates.length, sent: results.length, results });
}

function shell(inner) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    ${inner}
  </div>
</div>
</body></html>`;
}

function embedBlock(slug) {
  return `<div style="margin:24px 0;padding:16px;background:#faf8f4;border-radius:8px;border:1px solid rgba(26,26,46,0.08)">
    <p style="margin:0 0 6px;font-size:0.75rem;font-weight:600;color:#8888a8;text-transform:uppercase;letter-spacing:0.05em">Your embed code</p>
    <code style="font-size:0.75rem;color:#3d7a5f;word-break:break-all">&lt;script src="https://www.introlinq.com/widget.js" data-publisher="${slug}"&gt;&lt;/script&gt;</code>
  </div>
  <p style="margin:0 0 24px;font-size:0.75rem;color:#8888a8;text-align:center">Paste this before the &lt;/body&gt; tag in your blog template - takes about 2 minutes.</p>`;
}

function cta(label) {
  return `<a href="https://www.introlinq.com/dashboard" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">${label}</a>`;
}

function buildReminderEmail(stageN, { firstName, siteName, slug, commissionPct }) {
  if (stageN === 1) {
    return {
      subject: `Quick thing before you go - your IntroLinq snippet`,
      html: shell(`
        <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Hi ${firstName},</p>
        <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">Noticed you haven't added IntroLinq to ${siteName} yet - just wanted to make sure the snippet didn't get buried in your inbox.</p>
        <p style="margin:0 0 8px;font-size:0.875rem;color:#8888a8;line-height:1.6">It's one line of code, takes about 2 minutes, and starts earning you ${commissionPct}% commission on every booking your readers make. No ongoing work after that.</p>
        ${embedBlock(slug)}
        ${cta('Go to my dashboard →')}
        <p style="margin:20px 0 0;font-size:0.75rem;color:#8888a8;text-align:center">Stuck on where to paste it? The <a href="https://www.introlinq.com/install" style="color:#3d7a5f">install guide</a> covers WordPress, Ghost, Substack, Webflow, and anywhere else.</p>
      `),
    };
  }
  if (stageN === 2) {
    return {
      subject: `Need a hand installing IntroLinq?`,
      html: shell(`
        <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Hi ${firstName},</p>
        <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">A lot of people mean to add this and then it slips - totally normal. If it's a "I don't have a developer" thing: you don't need one. It's a single script tag, works with every major platform, and most people are done in under 2 minutes.</p>
        ${embedBlock(slug)}
        <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">If something specific is blocking you, just reply to this email and I'll help directly.</p>
        ${cta('Go to my dashboard →')}
      `),
    };
  }
  if (stageN === 3) {
    return {
      subject: `You're one line of code away from your first booking`,
      html: shell(`
        <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Hi ${firstName},</p>
        <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">Every article on ${siteName} already has readers who could use expert help - right now none of them are earning you anything. Once the snippet's live, IntroLinq matches the right expert to the right article automatically, and you keep ${commissionPct}% of every booking that comes from it.</p>
        ${embedBlock(slug)}
        <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Setup hasn't changed - still one line, still free, still no ongoing work.</p>
        ${cta('Go to my dashboard →')}
      `),
    };
  }
  return {
    subject: `Last check-in from us`,
    html: shell(`
      <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Hi ${firstName},</p>
      <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">This is the last automated reminder you'll get about this - didn't want to keep nudging your inbox if now's just not the right time.</p>
      <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">Your account and dashboard aren't going anywhere, and the ${commissionPct}% commission rate is still there whenever you're ready.</p>
      ${embedBlock(slug)}
      <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">If you'd like a hand getting set up, just reply - a real person (me) will help.</p>
      ${cta('Go to my dashboard →')}
    `),
  };
}
