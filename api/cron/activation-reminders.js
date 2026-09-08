import { neon } from '@neondatabase/serverless';

// Redirects every send to TEST_EMAIL and scopes the publisher query down to
// TEST_PUBLISHER - used to review real test runs before going live.
const TEST_MODE = false;
const TEST_PUBLISHER = 'little-green-agency';
const TEST_EMAIL = 'dom@open-intro.com';
const BCC_EMAIL = 'dom@introlinq.com';

// Days since signup at which each stage becomes eligible. Checked in order,
// lowest first - a publisher who's behind (e.g. after a cron outage) catches
// up one stage per run instead of getting every backlogged email at once.
const STAGES = [
  { n: 1, days: 1, col: 'reminder_1_sent_at', label: 'Day 1' },
  { n: 2, days: 3, col: 'reminder_2_sent_at', label: 'Day 3' },
  { n: 3, days: 10, col: 'reminder_3_sent_at', label: 'Day 10' },
  { n: 4, days: 24, col: 'reminder_4_sent_at', label: 'Day 24 (final)' },
];

// Platforms that can run a script embed, with a one-line install hint used
// in the "ready" segment's emails. Mirrors ONBOARDING_PLATFORMS in the
// dashboard - keep the keys in sync. WordPress is special-cased to the
// plugin (see installBlock).
const SUPPORTED_PLATFORMS = {
  html:        { label: 'your site',           hint: "Open your site's main layout or template file and paste the snippet just before the &lt;/body&gt; tag." },
  wordpress:   { label: 'WordPress',           hint: 'Install the IntroLinq plugin from Plugins &rarr; Add New.' },
  ghost:       { label: 'Ghost',               hint: 'In Ghost: Settings &rarr; Code injection &rarr; Site Footer, paste the snippet and save.' },
  webflow:     { label: 'Webflow',             hint: 'In Webflow: Project Settings &rarr; Custom Code &rarr; Footer Code, paste the snippet, then publish.' },
  squarespace: { label: 'Squarespace',         hint: 'In Squarespace: Settings &rarr; Advanced &rarr; Code Injection &rarr; Footer, paste the snippet and save.' },
  wix:         { label: 'Wix',                 hint: "In Wix: Settings &rarr; Custom Code &rarr; + Add Custom Code, paste the snippet, set placement to 'Body - end', apply to all pages." },
  framer:      { label: 'Framer',              hint: 'In Framer: Project Settings &rarr; General &rarr; Custom Code &rarr; End of &lt;body&gt; tag, paste the snippet and publish.' },
  gtm:         { label: 'Google Tag Manager',  hint: 'In GTM: new Tag &rarr; Custom HTML, paste the snippet, set the trigger to All Pages, then publish the container.' },
};

const STARTED_LABELS = {
  text: 'the AI text widget', carousel: 'the expert carousel', board: 'the expert board',
  newsletter: 'your newsletter links', social: 'your social links', website: 'your manual tracked links',
  medium: 'your Medium links', substack: 'your Substack links', manual: 'your tracked links',
};
const STARTED_PRIORITY = ['text', 'carousel', 'board', 'newsletter', 'social', 'website', 'medium', 'substack', 'manual'];
const SCRIPT_STARTED = new Set(['text', 'carousel', 'board']);

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  catch { return ''; }
}

// placed_pending  - copied a tracked link, no reader click yet (soft track)
// manual_platform - on Medium/Substack, no embed possible
// unfinished      - went through an add flow but never activated
// ready           - supported platform known, nothing started
// cold            - nothing known
function segmentFor(pub) {
  if (pub.manual_link_copied_at) return 'placed_pending';
  if (pub.platform === 'medium' || pub.platform === 'substack') return 'manual_platform';
  const started = (Array.isArray(pub.started_widgets) ? pub.started_widgets : []).filter(w => STARTED_LABELS[w]);
  if (started.length) return 'unfinished';
  if (pub.platform && SUPPORTED_PLATFORMS[pub.platform]) return 'ready';
  return 'cold';
}

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
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS started_widgets TEXT[] DEFAULT '{}'`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_link_copied_at TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_placed_at TIMESTAMPTZ`.catch(() => {});

  // The "stop the sequence" condition. With ACTIVATION_V2, activated_at IS
  // NULL means no real activity of any kind (widget fire, carousel/board
  // render, or a genuine reader click on a manual link). manual_placed_at
  // is the publisher's own hard stop for the manual path.
  const V2 = !!process.env.ACTIVATION_V2;
  if (V2) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`.catch(() => {});
  }
  const candidates = TEST_MODE
    ? await sql`SELECT * FROM publishers WHERE slug = ${TEST_PUBLISHER} AND active = true`
    : V2
      ? await sql`
          SELECT * FROM publishers
          WHERE active = true
            AND activated_at IS NULL
            AND first_widget_fire_at IS NULL
            AND manual_placed_at IS NULL
            AND reminders_paused = false
            AND created_at IS NOT NULL
        `
      : await sql`
          SELECT * FROM publishers
          WHERE active = true
            AND first_widget_fire_at IS NULL
            AND manual_placed_at IS NULL
            AND reminders_paused = false
            AND created_at IS NOT NULL
        `;

  const results = [];

  for (const pub of candidates) {
    const daysSinceSignup = (Date.now() - new Date(pub.created_at).getTime()) / 86400000;
    const stage = STAGES.find(s => daysSinceSignup >= s.days && !pub[s.col]);
    if (!stage) continue;

    const segment = segmentFor(pub);
    const email = TEST_MODE ? TEST_EMAIL : pub.email;
    const firstName = pub.contact_first_name || pub.name;
    const commissionPct = Math.round((pub.revenue_share ?? 0.5) * 100);
    const startedId = (Array.isArray(pub.started_widgets) ? pub.started_widgets : [])
      .filter(w => STARTED_LABELS[w])
      .sort((a, b) => STARTED_PRIORITY.indexOf(a) - STARTED_PRIORITY.indexOf(b))[0] || null;

    const built = buildReminderEmail(stage.n, segment, {
      firstName,
      siteName: pub.name,
      slug: pub.slug,
      commissionPct,
      platform: pub.platform || null,
      startedId,
      copiedOn: pub.manual_link_copied_at ? fmtDate(pub.manual_link_copied_at) : null,
    });

    // A segment can opt out of a given stage - still mark the column so the
    // sequence advances, just don't send anything.
    let sent = false;
    if (built.skip) {
      sent = true;
    } else {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'IntroLinq <hello@introlinq.com>', to: email, bcc: BCC_EMAIL, subject: built.subject, html: built.html }),
      });
      sent = emailRes.ok;
    }

    if (sent && !TEST_MODE) {
      if (stage.col === 'reminder_1_sent_at') await sql`UPDATE publishers SET reminder_1_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_2_sent_at') await sql`UPDATE publishers SET reminder_2_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_3_sent_at') await sql`UPDATE publishers SET reminder_3_sent_at = NOW() WHERE id = ${pub.id}`;
      else if (stage.col === 'reminder_4_sent_at') await sql`UPDATE publishers SET reminder_4_sent_at = NOW() WHERE id = ${pub.id}`;
    }

    results.push({ publisher: pub.slug, segment, stage: stage.n, label: stage.label, email, skipped: !!built.skip, sent });
  }

  return res.status(200).json({ testMode: TEST_MODE, checked: candidates.length, acted: results.length, results });
}

/* ────────────────────────────  email building  ──────────────────────────── */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function shell(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1eee7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1eee7;padding:32px 14px;font-family:${FONT}">
  <tr><td align="center">
    <table role="presentation" width="524" cellpadding="0" cellspacing="0" style="max-width:524px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e1d7">
      <tr><td style="padding:24px 36px 20px;border-bottom:1px solid #f0ece3">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:#1a1a2e;letter-spacing:-0.01em">Intro<span style="color:#e6a820">Linq</span></span>
      </td></tr>
      <tr><td style="padding:34px 36px 12px">
        ${inner}
      </td></tr>
      <tr><td style="padding:20px 36px 28px;border-top:1px solid #f0ece3">
        <p style="margin:0;font-size:11px;line-height:1.6;color:#a8a29a">You're getting this because you created a free IntroLinq account. To stop these setup reminders, <a href="mailto:hello@introlinq.com?subject=Stop%20setup%20reminders" style="color:#8a857c">reply with &ldquo;stop&rdquo;</a>.</p>
      </td></tr>
    </table>
    <p style="margin:14px 0 0;font-size:11px;color:#b3ada3">IntroLinq &middot; Free for publishers &middot; You keep 50% of every booking</p>
  </td></tr>
</table>
</body></html>`;
}

const hi = (name) => `<p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#1a1a2e">Hi ${name},</p>`;
const p = (t) => `<p style="margin:0 0 16px;font-size:14.5px;line-height:1.65;color:#585868">${t}</p>`;

// Earnings callout - the "why bother" line, as a soft green panel.
const earn = (pct) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr><td style="background:#f2f8f4;border:1px solid #d6e9df;border-radius:10px;padding:14px 16px;font-size:13.5px;line-height:1.6;color:#2f6b52"><strong style="color:#22503d">You keep ${pct}% of every booking</strong> a reader makes &mdash; IntroLinq finds the right expert for each article, you collect the commission, and there's nothing to maintain after setup.</td></tr></table>`;

// Product screenshot. Wrapped so it still reads fine if images are blocked.
const shot = (file, alt) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 24px"><tr><td style="border:1px solid #e6e1d7;border-radius:10px;overflow:hidden;background:#faf8f4"><img src="https://www.introlinq.com/product/screens/${file}" alt="${alt}" width="450" style="display:block;width:100%;max-width:450px;height:auto;border:0"></td></tr></table>`;

const codeBox = (slug) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 20px"><tr><td style="background:#faf8f4;border:1px solid #e6e1d7;border-radius:10px;padding:14px 16px">
  <p style="margin:0 0 6px;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:#a8a29a;text-transform:uppercase">Your snippet</p>
  <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#3d7a5f;word-break:break-all">&lt;script src="https://www.introlinq.com/widget.js" data-publisher="${slug}"&gt;&lt;/script&gt;</code>
</td></tr></table>`;

const pluginBox = (slug) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 20px"><tr><td style="background:#faf8f4;border:1px solid #e6e1d7;border-radius:10px;padding:16px">
  <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#1a1a2e">The easiest way: our WordPress plugin</p>
  <p style="margin:0 0 10px;font-size:13.5px;line-height:1.6;color:#585868">In your WordPress admin go to <strong>Plugins &rarr; Add New</strong>, search <strong>&ldquo;IntroLinq&rdquo;</strong>, install and activate, then enter your Publisher ID: <code style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#3d7a5f">${slug}</code>. No theme editing, no code.</p>
  <a href="https://wordpress.org/plugins/introlinq/" style="font-size:13px;font-weight:600;color:#3d7a5f;text-decoration:none">View the plugin on WordPress.org &rarr;</a>
</td></tr></table>`;

// CTA with deliberate breathing room above it.
const cta = (label, href) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px"><tr><td style="border-radius:100px;background:#1a1a2e">
  <a href="${href || 'https://www.introlinq.com/dashboard'}" style="display:inline-block;padding:15px 32px;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:100px">${label}</a>
</td></tr></table>`;

// Which screenshot best represents this publisher's path.
function shotFor(startedId) {
  if (startedId === 'board') return shot('board.jpg', 'The IntroLinq expert board on a publisher site');
  if (startedId === 'carousel') return shot('carousel.jpg', 'The IntroLinq expert carousel on a publisher site');
  return shot('inline.jpg', 'IntroLinq highlighting phrases in an article, linking readers to a bookable expert');
}

// Install instructions for a supported platform - the WordPress plugin for
// WP, otherwise the snippet plus the platform's one-line hint.
function installBlock(platform, slug) {
  if (platform === 'wordpress') return pluginBox(slug);
  const plat = SUPPORTED_PLATFORMS[platform];
  return codeBox(slug) + (plat ? p(plat.hint) : '');
}

// Returns { subject, html } or { skip: true }.
export function buildReminderEmail(stageN, segment, ctx) {
  const { firstName, siteName, slug, commissionPct, platform, startedId, copiedOn } = ctx;
  const plat = SUPPORTED_PLATFORMS[platform] || null;
  const platName = platform === 'medium' ? 'Medium' : platform === 'substack' ? 'Substack' : (plat ? plat.label : 'your site');

  /* ── final stage: one shared, soft close for every segment ── */
  if (stageN === 4) {
    return {
      subject: `Last check-in from us`,
      html: shell(
        hi(firstName) +
        p(`This is the last automated reminder you'll get &mdash; didn't want to keep nudging if now isn't the right time.`) +
        p(`Your account and dashboard aren't going anywhere, and the ${commissionPct}% commission rate is there whenever you're ready.`) +
        p(`If you'd like a hand getting set up, just reply &mdash; a real person (me) will help.`) +
        cta('Go to my dashboard →')
      ),
    };
  }

  /* ── placed_pending: only stage 2 sends ── */
  if (segment === 'placed_pending') {
    if (stageN !== 2) return { skip: true };
    return {
      subject: `Did your IntroLinq links go out?`,
      html: shell(
        hi(firstName) +
        p(`You copied a tracked link${copiedOn ? ` on ${copiedOn}` : ''} &mdash; nice. Once one is live in a post and a reader clicks it, it shows up on your dashboard and these reminders stop on their own.`) +
        p(`If your links are already placed, mark that in the dashboard and we'll go quiet now. If something's in the way, just reply.`) +
        cta('Open my dashboard →')
      ),
    };
  }

  /* ── manual_platform: Medium / Substack, never show an embed ── */
  if (segment === 'manual_platform') {
    if (stageN === 1) {
      return {
        subject: `Start earning on ${platName} with IntroLinq`,
        html: shell(
          hi(firstName) +
          p(`${platName} can't run our widget &mdash; but tracked expert links do the same job, and they're just as trackable.`) +
          earn(commissionPct) +
          p(`In your dashboard there's a <strong>${platName} links</strong> tab: paste a post, get matching experts, copy the link, drop it in. Nothing to install.`) +
          cta(`Open my ${platName} links →`)
        ),
      };
    }
    if (stageN === 2) {
      return {
        subject: `Want me to set up your first ${platName} links?`,
        html: shell(
          hi(firstName) +
          p(`Happy to do the first few for you &mdash; reply with a link to a recent ${platName} post and I'll send back the tracked links to paste in.`) +
          p(`After that it's about a 30-second job per post, straight from your dashboard.`) +
          cta('Open my dashboard →')
        ),
      };
    }
    return {
      subject: `Your ${platName} posts could be earning`,
      html: shell(
        hi(firstName) +
        p(`Every ${platName} post you've published already has readers who'd book an expert &mdash; right now none of that is earning you anything.`) +
        earn(commissionPct) +
        p(`Adding a tracked link takes seconds and it's free.`) +
        cta(`Open my ${platName} links →`)
      ),
    };
  }

  /* ── unfinished: they started something, name it ── */
  if (segment === 'unfinished') {
    const what = STARTED_LABELS[startedId] || 'your setup';
    const isScript = SCRIPT_STARTED.has(startedId);
    const finishBlock = isScript ? installBlock(platform, slug)
      : p(`The tab's ready in your dashboard &mdash; paste a post or browse the roster, then copy a tracked link into your content.`);
    if (stageN === 1) {
      return {
        subject: `You're one step from earning on ${siteName}`,
        html: shell(
          hi(firstName) +
          p(`You started setting up ${what} but it looks like it didn't quite get finished.`) +
          (isScript ? shotFor(startedId) : '') +
          earn(commissionPct) +
          finishBlock +
          cta('Finish setup →')
        ),
      };
    }
    if (stageN === 2) {
      return {
        subject: `Need a hand finishing your IntroLinq setup?`,
        html: shell(
          hi(firstName) +
          p(`Still meaning to finish ${what}? Totally normal for it to slip.`) +
          p(`Reply to this email and I'll walk you through the last step &mdash; or just do it for you.`) +
          cta('Go to my dashboard →')
        ),
      };
    }
    return {
      subject: `${siteName} is a step away from its first booking`,
      html: shell(
        hi(firstName) +
        p(`Once ${what} is live, IntroLinq matches the right expert to the right article automatically.`) +
        earn(commissionPct) +
        finishBlock +
        cta('Finish setup →')
      ),
    };
  }

  /* ── ready: supported platform known, nothing started ── */
  if (segment === 'ready') {
    if (stageN === 1) {
      return {
        subject: `Start earning on ${siteName} &mdash; about 2 minutes on ${platName}`,
        html: shell(
          hi(firstName) +
          p(`Just making sure setup didn't get buried. Here's what your readers see &mdash; a relevant expert, right where the article calls for one:`) +
          shotFor(null) +
          earn(commissionPct) +
          installBlock(platform, slug) +
          cta('Go to my dashboard →')
        ),
      };
    }
    if (stageN === 2) {
      return {
        subject: `Need a hand installing IntroLinq?`,
        html: shell(
          hi(firstName) +
          p(`You don't need a developer for this${platform === 'wordpress' ? ' &mdash; the plugin does it all' : " &mdash; it's a single script tag"}.`) +
          installBlock(platform, slug) +
          p(`If something specific is blocking you, just reply and I'll help directly.`) +
          cta('Go to my dashboard →')
        ),
      };
    }
    return {
      subject: `You're minutes away from your first booking`,
      html: shell(
        hi(firstName) +
        p(`Every article on ${siteName} already has readers who could use expert help &mdash; right now none of them are earning you anything. Once it's live, matching happens automatically.`) +
        shotFor(null) +
        earn(commissionPct) +
        installBlock(platform, slug) +
        cta('Go to my dashboard →')
      ),
    };
  }

  /* ── cold: nothing known, keep it open-ended ── */
  if (stageN === 1) {
    return {
      subject: `Start earning from the content you've already published`,
      html: shell(
        hi(firstName) +
        p(`You haven't set up IntroLinq on ${siteName} yet. Here's what it looks like for your readers:`) +
        shot('carousel.jpg', 'The IntroLinq expert carousel on a publisher site') +
        earn(commissionPct) +
        p(`There's more than one way in &mdash; a widget that runs on every article automatically, a carousel or expert board you place once, or just tracked links for a newsletter or socials. Most people are done in a couple of minutes.`) +
        cta('Pick a setup →')
      ),
    };
  }
  if (stageN === 2) {
    return {
      subject: `Need a hand setting up IntroLinq?`,
      html: shell(
        hi(firstName) +
        p(`A lot of people mean to do this and then it slips &mdash; totally normal.`) +
        p(`If you're not sure which option fits ${siteName}, reply to this email and I'll tell you exactly what to do, or set it up for you.`) +
        cta('Go to my dashboard →')
      ),
    };
  }
  return {
    subject: `Every article on ${siteName} could be earning &mdash; none are yet`,
    html: shell(
      hi(firstName) +
      p(`Once IntroLinq is live it matches the right expert to the right article automatically.`) +
      shot('carousel.jpg', 'The IntroLinq expert carousel on a publisher site') +
      earn(commissionPct) +
      p(`Setup is still free and still quick &mdash; a widget, a visual block, or tracked links, whichever suits you.`) +
      cta('Go to my dashboard →')
    ),
  };
}
