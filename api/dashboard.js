import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getClientIp, isBotHit, ensureBotColumns } from './_botDetect.js';
import { notifyTeam, escapeHtml } from './_notify.js';

const PASSWORD_MIN_LENGTH = 8;

let clickTableReady = false;
let hoverTableReady = false;
let seenTableReady = false;
let carouselSourceColumnReady = false;
let clickBotColumnsReady = false;
let hoverBotColumnsReady = false;
let seenBotColumnsReady = false;
let carouselBotColumnsReady = false;

// Display name for the `pub` a partner sends on their webhook calls (e.g.
// "open-intro") - falls back to a title-cased version of the raw slug for
// any partner not listed here, so a new integration still reads reasonably
// rather than showing a bare lowercase-hyphenated string.
const PROVIDER_NAMES = { 'open-intro': 'OpenIntro' };
function providerDisplayName(pub) {
  if (PROVIDER_NAMES[pub]) return PROVIDER_NAMES[pub];
  return String(pub || '').split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || pub;
}

// Temporary per-publisher Slack notification cooldown - a backstop on top of
// is_bot classification, not a replacement for it. isCoordinatedBurst and
// isFanoutBurst (see _botDetect.js) can only flag a hit once they've seen a
// SECOND matching signal (another IP on the same target, or a repeat page
// from the same IP) - the very first hit in a fresh bot cluster always
// looks like a real click when it happens, so it still fires a Slack ping.
// On tchelete (2026-08-27 proxy-pool incident) that first-hit-per-cluster
// is still one notification roughly every minute, all day, even with both
// detection rules working correctly - Dom confirmed this is still too
// noisy. This does NOT touch is_bot/analytics at all, only whether a click
// event's Slack ping is allowed to actually send - a publisher in this map
// still gets accurately-tagged data, just throttled real-time noise while
// under sustained automated traffic. Remove tchelete's entry once this
// incident subsides; not applied to any other publisher.
const NOTIFICATION_COOLDOWN_MINUTES = { tchelete: 15 };

async function isNotificationCoolingDown(sql, pub) {
  const minutes = NOTIFICATION_COOLDOWN_MINUTES[pub];
  if (!minutes) return false;
  const rows = await sql.query(
    `SELECT 1 FROM click_logs WHERE publisher = $1 AND is_bot = false AND created_at > NOW() - INTERVAL '${minutes} minutes' LIMIT 1`,
    [pub]
  ).catch(() => []);
  return rows.length > 0;
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Cross-mode activation model (v2). Every behaviour change it drives is
// gated on this one env var so the whole thing can be reverted from the
// Vercel dashboard with no redeploy: unset ACTIVATION_V2 and every reader
// (reminder cron, removed-check cron, admin panel, publisher dashboard)
// falls straight back to the widget-only first_widget_fire_at logic. The
// new columns and board_view rows simply stop being written/read.
const ACTIVATION_V2 = !!process.env.ACTIVATION_V2;
let _activityColsReady = false;
async function stampActivity(sql, pub, { script }) {
  if (!ACTIVATION_V2 || !pub) return;
  if (!_activityColsReady) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_script_activity_at TIMESTAMPTZ`.catch(() => {});
    _activityColsReady = true;
  }
  // A script-embed signal (widget/carousel/board render or click) also
  // resets widget_removed_notified_at, exactly like a widget fire does in
  // match.js - a manual newsletter-link click never does, since there's no
  // embed on the publisher's side that could have been "removed".
  // RETURNING + comparing activated_at to this statement's own NOW() (same
  // trick as match.js's first_widget_fire_at check) detects "this call is
  // the one that just activated them" - the AI widget's own first-fire
  // already notifies from match.js, so this only covers the two ACTIVATION_V2
  // added: carousel/board (script) and manual link (not script) - previously
  // silent, added 2026-09-04.
  let row;
  if (script) {
    [row] = await sql`
      UPDATE publishers SET activated_at = COALESCE(activated_at, NOW()), last_activity_at = NOW(), last_script_activity_at = NOW(), widget_removed_notified_at = NULL
      WHERE slug = ${pub}
      RETURNING name, (activated_at = NOW()) AS just_activated
    `.catch(() => [null]);
  } else {
    // Manual link click. Always a "last activity" signal. It counts as
    // activation (silences the reminder sequence) once there's real reader
    // traffic - either a non-bot click from an earlier calendar day, or
    // non-bot clicks from 2+ distinct IPs (the publisher's own IP plus at
    // least one real reader). A few same-IP self-test clicks on signup day
    // still don't count.
    [row] = await sql`
      UPDATE publishers p SET
        last_activity_at = NOW(),
        activated_at = COALESCE(
          p.activated_at,
          (SELECT NOW() FROM click_logs c
             WHERE c.publisher = ${pub} AND c.is_bot = false
               AND (c.integration = 'manual' OR c.traffic_source = 'newsletter')
             HAVING COUNT(*) FILTER (WHERE c.created_at::date < CURRENT_DATE) > 0
                 OR COUNT(DISTINCT c.ip) >= 2)
        )
      WHERE p.slug = ${pub}
      RETURNING name, (activated_at = NOW()) AS just_activated
    `.catch(() => [null]);
  }
  if (row?.just_activated) {
    notifyFirstActivation(row.name, pub, script ? 'carousel/board' : 'manual link').catch(() => {});
  }
}

// Mirrors match.js's notifyPublisherWentLive (Slack + team email) for the
// two ACTIVATION_V2 activation modes that never had a "first activation"
// notification at all before this.
async function notifyFirstActivation(name, slug, mode) {
  if (process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) {
    fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🎉 *${name}* just activated via ${mode} - first real engagement confirmed!` }),
    }).catch(() => {});
  }
  notifyTeam(
    `${name} just activated (${mode})`,
    `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(slug)}) just activated via ${escapeHtml(mode)} - first real engagement confirmed!</p>`
  ).catch(() => {});
}

// Best-guess of which channel a manual link click came from, when the link
// itself didn't carry an explicit &channel= (copied before the selector
// existed, or pasted somewhere other than where it was grabbed). Referer is
// only a hint - a "website" guess needs the publisher's own domain to match,
// everything else falls through to null rather than a wrong label.
const SOCIAL_REFERER_HOSTS = ['t.co', 'lnkd.in', 'linkedin.com', 'facebook.com', 'fb.me', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'youtube.com', 'threads.net', 'bsky.app', 'tiktok.com', 'pinterest.com'];
function inferManualChannel(referer, pubSlug) {
  if (!referer) return null;
  let host;
  try { host = new URL(referer).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
  if (SOCIAL_REFERER_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return 'social';
  if (/(^|\.)(substack\.com|beehiiv\.com|ghost\.io|mailchi\.mp|campaign-archive\.com|list-manage\.com)$/.test(host)) return 'newsletter';
  if (pubSlug && host.includes(String(pubSlug).toLowerCase())) return 'website';
  return null;
}

export default async function handler(req, res) {
  const { pub, provider, action } = req.query;
  if (!pub && action !== 'booking') return res.status(400).json({ error: 'Missing pub' });

  const sql = neon(process.env.DATABASE_URL);
  const ip = getClientIp(req);

  // Booking webhook - called by partners (OpenIntro etc.) when a booking completes
  if (req.method === 'POST' && action === 'booking') {
    const secret = req.headers['x-introlinq-secret'];
    if (!process.env.BOOKING_WEBHOOK_SECRET || secret !== process.env.BOOKING_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { click_id, expert_id, expert_name, booking_amount, currency = 'GBP', test = false } = req.body || {};
    if (!booking_amount) return res.status(400).json({ error: 'Missing booking_amount' });

    // Look up click for attribution
    let click = null;
    if (click_id) {
      [click] = await sql`
        SELECT publisher, expert_name, article_url, article_title
        FROM click_logs WHERE click_id = ${click_id} LIMIT 1
      `.catch(() => [null]);
    }

    const publisherSlug = click?.publisher || pub;
    if (!publisherSlug) return res.status(400).json({ error: 'Cannot resolve publisher' });

    const [publisher] = await sql`
      SELECT slug, name, payment_email, COALESCE(revenue_share, 0.70) AS revenue_share
      FROM publishers WHERE slug = ${publisherSlug} AND active = true LIMIT 1
    `.catch(() => [null]);

    if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

    const payout = Math.round(booking_amount * publisher.revenue_share * 100) / 100;
    const introlinqMargin = Math.round((booking_amount - payout) * 100) / 100;
    const resolvedExpert = expert_name || click?.expert_name || 'an expert';
    const articleUrl = click?.article_url || null;
    const articleTitle = click?.article_title || null;

    // Was this booking actually recorded (vs. a deduped retry)? Gates the
    // publisher email/Slack ping below so a webhook retry doesn't double-notify.
    let inserted = false;

    if (!test) {
      // Schema must match api/admin.js's ensureBookingsTable-equivalent CREATE
      // (the admin "Bookings" tab reads/writes the same table for manual
      // entries) - entry_type/provider distinguish this row's source, and
      // booking_amount is treated as the commission basis per documentation.html.
      await sql`CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        entry_type TEXT DEFAULT 'webhook',
        provider TEXT NOT NULL,
        publisher TEXT,
        expert_name TEXT,
        booking_id TEXT UNIQUE,
        booking_amount DECIMAL,
        booking_currency TEXT DEFAULT 'GBP',
        commission_amount DECIMAL,
        commission_currency TEXT DEFAULT 'GBP',
        revenue_share DECIMAL,
        publisher_payout DECIMAL,
        introlinq_margin DECIMAL,
        raw_payload JSONB,
        booked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`.catch(() => {});
      await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`.catch(() => {});
      await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_batch_id TEXT`.catch(() => {});

      // click_id doubles as the idempotency key - a webhook retry for the
      // same booking carries the same click_id (it's tied to the original
      // click, not regenerated per attempt), so ON CONFLICT silently no-ops
      // instead of double-crediting the publisher. Multiple NULL click_ids
      // are fine: Postgres UNIQUE never treats NULL as equal to NULL.
      const rows = await sql`
        INSERT INTO bookings (entry_type, provider, publisher, expert_name, booking_id, booking_amount, booking_currency, commission_amount, commission_currency, revenue_share, publisher_payout, introlinq_margin, raw_payload, booked_at)
        VALUES ('webhook', ${pub}, ${publisherSlug}, ${resolvedExpert}, ${click_id || null}, ${booking_amount}, ${currency}, ${booking_amount}, ${currency}, ${publisher.revenue_share}, ${payout}, ${introlinqMargin}, ${JSON.stringify({ ...req.body, article_url: articleUrl, article_title: articleTitle })}, NOW())
        ON CONFLICT (booking_id) DO NOTHING
        RETURNING id
      `;
      inserted = rows.length > 0;

      // Email publisher (skipped on a deduped retry - they were already told once)
      if (inserted && publisher.payment_email && process.env.RESEND_API_KEY) {
        const articleLine = articleTitle
          ? `\n\nThe booking came from your article: ${articleTitle}${articleUrl ? `\n${articleUrl}` : ''}`
          : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'IntroLinq <notifications@introlinq.com>',
            to: publisher.payment_email,
            subject: `IntroLinq - You earned ${currency} ${payout.toFixed(2)} - new booking on your site`,
            text: `Hi ${publisher.name},\n\nA reader on your site just booked a session with ${resolvedExpert} via ${providerDisplayName(pub)}.\n\nBooking value: ${currency} ${Number(booking_amount).toFixed(2)}\nYour commission (${Math.round(publisher.revenue_share * 100)}%): ${currency} ${payout.toFixed(2)}${articleLine}\n\nThis will be included in your next payout.\n\nBest,\nThe IntroLinq team`,
          }),
        }).catch(err => console.error('Booking email failed:', err));
      }

      // Internal copy showing the full margin breakdown - independent of
      // whether the publisher has a payment_email configured, since this is
      // about IntroLinq's own visibility into revenue, not the publisher payout.
      if (inserted && process.env.RESEND_API_KEY && process.env.COMPANY_NOTIFICATION_EMAIL) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'IntroLinq <notifications@introlinq.com>',
            to: process.env.COMPANY_NOTIFICATION_EMAIL,
            subject: `IntroLinq - New booking - ${currency} ${Number(booking_amount).toFixed(2)} via ${publisher.name}`,
            text: `Provider: ${providerDisplayName(pub)}\nPublisher: ${publisher.name} (${publisherSlug})\nExpert: ${resolvedExpert}\n\nBooking amount: ${currency} ${Number(booking_amount).toFixed(2)}\nPublisher payout (${Math.round(publisher.revenue_share * 100)}%): ${currency} ${payout.toFixed(2)}\nIntroLinq margin: ${currency} ${introlinqMargin.toFixed(2)}${articleTitle ? `\n\nArticle: ${articleTitle}${articleUrl ? `\n${articleUrl}` : ''}` : ''}`,
          }),
        }).catch(err => console.error('Company notification email failed:', err));
      }
    }

    // Slack - fires for test calls (so partners can verify delivery) and for
    // real, newly-recorded bookings; skipped on a deduped retry. Posts to
    // #introlinq-notifications (real events), not #introlinq-general.
    if (process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL && (test || inserted)) {
      const testTag = test ? ' · *[TEST]*' : '';
      await fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `💰 *New booking*${testTag} - ${resolvedExpert} · ${currency} ${Number(booking_amount).toFixed(2)} · ${publisher.name} · Payout: ${currency} ${payout.toFixed(2)}${articleTitle ? ` · _${articleTitle}_` : ''}` }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, test: !!test, publisher_payout: payout, publisher: publisherSlug, expert: resolvedExpert });
  }

  // Public redirect - routes Book button through IntroLinq before sending to partner
  if (req.method === 'GET' && action === 'out') {
    const { expert_id, expert_name, expert_url, article, phrase, lang, tz, device, source, title, click_source, il_type, channel } = req.query;
    // Explicit integration tag set by each surface (text / carousel / board
    // / manual). Older links/cached scripts don't send it - left null, and
    // the source/phrase heuristic still classifies those.
    const integration = ['text', 'carousel', 'board', 'manual'].includes(il_type) ? il_type : null;
    if (!expert_url) return res.status(400).json({ error: 'Missing expert_url' });

    // For manual links only: which of the publisher's own channels the link
    // was placed in. Explicit `channel` (set by the copy-link tool) wins;
    // otherwise inferred from the click's Referer so links copied before the
    // selector existed, or pasted somewhere else, still get a best guess.
    let manualChannel = null;
    if (integration === 'manual') {
      const explicit = ['website', 'newsletter', 'social', 'medium', 'substack'].includes(channel) ? channel : null;
      manualChannel = explicit || inferManualChannel(req.headers.referer || req.headers.referrer, pub);
    }

    const click_id = crypto.randomUUID();

    // Ensure table and all columns exist
    await sql`CREATE TABLE IF NOT EXISTS click_logs (
      id SERIAL PRIMARY KEY, publisher TEXT, expert_id INT, expert_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`.catch(() => {});
    await Promise.all([
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS click_id TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS article_url TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS phrase TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS lang TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS timezone TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS device TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS traffic_source TEXT`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS article_title TEXT`.catch(() => {}),
      // Which UI element the reader actually clicked - only meaningful for
      // the widget4/5-style layout, where a "cta" (top button) click and a
      // "person" (a specific named expert's own Meet/name/photo link) click
      // can lead to the exact same destination URL for the primary option,
      // making them otherwise indistinguishable in this table. Null for
      // every other widget/link type, which only ever has one click style.
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS click_source TEXT`.catch(() => {}),
      // Records whether a Slack ping was actually attempted for this row -
      // separate from is_bot, since the notification cooldown above (see
      // isNotificationCoolingDown) can suppress a real (is_bot=false) row's
      // notification without changing its bot classification. Without this,
      // there was no way to verify from the data alone whether the cooldown
      // was actually working, only whether Slack messages stopped arriving
      // in practice (2026-08-27).
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN`.catch(() => {}),
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS integration TEXT`.catch(() => {}),
      // Which publisher channel a manual link sat in (website / newsletter /
      // social) - null for every non-manual click. Drives the per-channel
      // click breakdown on the dashboard.
      sql`ALTER TABLE click_logs ADD COLUMN IF NOT EXISTS manual_channel TEXT`.catch(() => {}),
    ]);
    if (!clickBotColumnsReady) {
      await ensureBotColumns(sql, 'click_logs');
      clickBotColumnsReady = true;
    }
    const isBot = await isBotHit(req, sql, 'click_logs', { ip, publisher: pub, page_url: article, expert_id: expert_id || null, expert_name: expert_name || null });

    // Impact.com-backed providers (Preply etc.) don't call our booking
    // webhook - there's no live push, so attribution has to survive inside
    // Impact's own tracking link instead, via their subId1/subId2 params
    // (confirmed format: help.impact.com .../sub-id-and-shared-id-parameters-explained-for-partners).
    // A separate reconciliation job later pulls Impact's reporting API and
    // matches bookings back to a publisher by subId1. Looked up by expert_id
    // since the widget only ever sends us the destination URL, not the
    // provider it came from.
    let providerSlug = null;
    if (expert_id) {
      const [expertRow] = await sql`
        SELECT p.slug AS provider_slug FROM experts e
        LEFT JOIN providers p ON p.id = e.provider_id
        WHERE e.id = ${expert_id} LIMIT 1
      `.catch(() => [null]);
      providerSlug = expertRow?.provider_slug || null;
    }

    // Build partner URL with full attribution params
    let destUrl;
    try {
      const dest = new URL(decodeURIComponent(expert_url));
      dest.searchParams.set('ref', 'introlinq');
      dest.searchParams.set('aid', pub);
      dest.searchParams.set('click_id', click_id);
      if (lang) dest.searchParams.set('lang', lang);
      if (article) dest.searchParams.set('campaign', decodeURIComponent(article).slice(0, 200));
      if (providerSlug === 'preply') {
        dest.searchParams.set('subId1', pub);
        dest.searchParams.set('subId2', click_id);
      }
      destUrl = dest.toString();
    } catch {
      destUrl = decodeURIComponent(expert_url);
    }

    // Slack notification for the click. This MUST complete before the
    // redirect is sent: work after the response ends is not guaranteed to
    // run on Vercel (needs waitUntil), which is why this notification never
    // actually fired in its original post-redirect position - clicks landed
    // in click_logs (inserted pre-redirect) but the Slack call was silently
    // frozen. Every Slack message that does arrive (match.js report path)
    // is awaited pre-response for the same reason. Kept fast: no extra SQL
    // lookup (slug instead of display name), hard 1.5s timeout, and run
    // concurrently with the click INSERT so the reader's added wait is
    // max(insert, slack) rather than their sum.
    const articleTitle = title ? String(title).slice(0, 80) : null;
    const coolingDown = await isNotificationCoolingDown(sql, pub);
    const willNotify = !!(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL && !isBot && !coolingDown);
    const slackPromise = willNotify
      ? fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(1500),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `👉 *Expert link clicked* - ${expert_name || 'an expert'} · ${pub || '/app'}${articleTitle ? ` · _${articleTitle}_` : ''}` }),
        }).catch(() => {})
      : Promise.resolve();

    // A newsletter/manual link click is the only click type that isn't
    // proof of an embed rendering on the publisher's site, so it stamps
    // last_activity_at but not last_script_activity_at (removal detection).
    // Keyed off the explicit integration tag now that manual links can carry
    // source=website|social too - the old source/phrase==='newsletter' check
    // still catches links copied before il_type was sent.
    const isManualLink = il_type === 'manual' || source === 'newsletter' || phrase === 'newsletter';
    // Clicks that originate on introlinq.com itself (the /expertboard
    // preview page, dashboard previews) are QA, not real publisher usage -
    // don't let them count as activation.
    const isPreview = /introlinq\.com/i.test(article || '');
    await Promise.all([
      sql`INSERT INTO click_logs (publisher, expert_id, expert_name, click_id, article_url, article_title, phrase, lang, timezone, device, traffic_source, ip, is_bot, click_source, notification_sent, integration, manual_channel)
        VALUES (${pub}, ${expert_id || null}, ${expert_name || null}, ${click_id}, ${article || null},
                ${title || null}, ${phrase || null}, ${lang || null}, ${tz || null}, ${device || null}, ${source || null}, ${ip || null}, ${isBot}, ${click_source || null}, ${willNotify}, ${integration}, ${manualChannel})
      `.catch(() => {}),
      slackPromise,
      (isBot || isPreview) ? Promise.resolve() : stampActivity(sql, pub, { script: !isManualLink }),
    ]);

    return res.redirect(302, destUrl);
  }

  // CORS for widget click tracking (cross-origin POST)
  if (req.method === 'POST' || req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
  }

  // Viewability tracking - fired by widget.js once per highlighted phrase
  // per page view, the first time it's actually scrolled into the reader's
  // viewport (60%+ visible for a full second), independent of the discovery
  // cue animation - this fires even for publishers who've turned the cue
  // off, since "was this phrase physically on screen" is a different
  // question from "did we nudge them toward it". Sits between impression
  // (the page had a match somewhere) and hover: an impression on a page a
  // reader never scrolls past isn't something they could ever have noticed,
  // and conflating the two overstates how many people had a real chance to
  // engage.
  if (req.method === 'POST' && action === 'seen') {
    const { expert_id, expert_name, phrase, article, device } = req.body || {};
    if (!seenTableReady) {
      await sql`
        CREATE TABLE IF NOT EXISTS seen_logs (
          id SERIAL PRIMARY KEY,
          publisher TEXT,
          expert_id INT,
          expert_name TEXT,
          phrase TEXT,
          article_url TEXT,
          device TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      seenTableReady = true;
    }
    if (!seenBotColumnsReady) {
      await ensureBotColumns(sql, 'seen_logs');
      seenBotColumnsReady = true;
    }
    const isBot = await isBotHit(req, sql, 'seen_logs', { ip, publisher: pub, page_url: article, expert_id: expert_id || null, expert_name: expert_name || null });
    await sql`
      INSERT INTO seen_logs (publisher, expert_id, expert_name, phrase, article_url, device, ip, is_bot)
      VALUES (${pub}, ${expert_id || null}, ${expert_name || null}, ${phrase || null}, ${article || null}, ${device || null}, ${ip || null}, ${isBot})
    `.catch(() => {});
    return res.status(200).end();
  }

  // Hover tracking - fired by widget.js once per highlighted phrase per page
  // view, the first time a reader actually hovers (desktop) or taps (touch)
  // it, regardless of whether they go on to click. This is the missing
  // middle funnel step between impression (shown) and click (booked) - it's
  // what tells a discoverability problem (nobody ever hovers) apart from a
  // relevance/commitment-bar problem (readers hover and see the expert, but
  // don't click through). Public/no-auth like the click redirect above -
  // this is a beacon fired directly by the widget on a reader's page, not an
  // authenticated dashboard action.
  if (req.method === 'POST' && action === 'hover') {
    const { expert_id, expert_name, phrase, article, device } = req.body || {};
    if (!hoverTableReady) {
      await sql`
        CREATE TABLE IF NOT EXISTS hover_logs (
          id SERIAL PRIMARY KEY,
          publisher TEXT,
          expert_id INT,
          expert_name TEXT,
          phrase TEXT,
          article_url TEXT,
          device TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      hoverTableReady = true;
    }
    if (!hoverBotColumnsReady) {
      await ensureBotColumns(sql, 'hover_logs');
      hoverBotColumnsReady = true;
    }
    const isBot = await isBotHit(req, sql, 'hover_logs', { ip, publisher: pub, page_url: article, expert_id: expert_id || null, expert_name: expert_name || null });
    await sql`
      INSERT INTO hover_logs (publisher, expert_id, expert_name, phrase, article_url, device, ip, is_bot)
      VALUES (${pub}, ${expert_id || null}, ${expert_name || null}, ${phrase || null}, ${article || null}, ${device || null}, ${ip || null}, ${isBot})
    `.catch(() => {});
    return res.status(200).end();
  }

  // Carousel impression tracking - fired once by carousel.js the moment it
  // successfully renders on a page. Unlike the main widget, the carousel
  // shows a fixed, publisher-curated expert list rather than an AI content
  // scan, so it never wrote a match_logs row - every carousel click landed
  // in click_logs with no corresponding impression anywhere, which let CTR
  // (clicks/impressions) run past 100%. This writes into match_logs (tagged
  // source='carousel') specifically so it's picked up for free by the
  // existing match_count>0 Impressions COUNT and day/week/month breakdowns
  // below - it's excluded from the Recent Activity feed further down since
  // it isn't a phrase-match run and would render there as a confusing
  // empty-phrase / "no expert matched" row.
  // board_view mirrors carousel_view exactly - the Expert Board is a
  // script embed with a fixed curated list and no content scan, so like
  // the carousel it has no other moment that logs a "this was shown"
  // event. Fired once by expertboard.js right after a real render. Gated
  // on ACTIVATION_V2: while it's off, the endpoint is a harmless no-op so
  // an already-cached expertboard.js can keep pinging with no effect.
  if (req.method === 'POST' && (action === 'carousel_view' || action === 'board_view')) {
    if (action === 'board_view' && !ACTIVATION_V2) return res.status(200).end();
    const isBoard = action === 'board_view';
    const { expert_names, match_count, article } = req.body || {};
    if (!carouselSourceColumnReady) {
      await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS source TEXT`.catch(() => {});
      carouselSourceColumnReady = true;
    }
    const names = Array.isArray(expert_names) ? expert_names.slice(0, 50) : [];
    const count = Number.isFinite(match_count) && match_count > 0 ? match_count : names.length;
    if (!carouselBotColumnsReady) {
      await ensureBotColumns(sql, 'match_logs');
      carouselBotColumnsReady = true;
    }
    const isBot = await isBotHit(req, sql, 'match_logs', { ip, publisher: pub, page_url: article });
    // A render on introlinq.com's own preview page (/expertboard?pub=...) is
    // QA, not the embed being live on the publisher's site.
    const isPreview = /introlinq\.com/i.test(article || '');
    await Promise.all([
      sql`
        INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, match_count, page_url, source, ip, is_bot)
        VALUES (${pub}, ${isBoard ? '[board]' : '[carousel]'}, ${[]}, ${names}, ${count}, ${article || null}, ${isBoard ? 'board' : 'carousel'}, ${ip || null}, ${isBot})
      `.catch(() => {}),
      (isBot || isPreview) ? Promise.resolve() : stampActivity(sql, pub, { script: true }),
    ]);
    return res.status(200).end();
  }

  // GET and PATCH: require valid session cookie
  if (req.method === 'GET' || req.method === 'PATCH') {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
    const [session] = await sql`
      SELECT publisher_slug FROM sessions
      WHERE token = ${sessionToken} AND expires_at > NOW()
    `.catch(() => [null]);
    if (!session || session.publisher_slug !== pub) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Click tracking - fired by widget when Book button is clicked
  if (req.method === 'POST') {
    const { expert_id, expert_name } = req.body;
    if (!clickTableReady) {
      await sql`
        CREATE TABLE IF NOT EXISTS click_logs (
          id SERIAL PRIMARY KEY,
          publisher TEXT,
          expert_id INT,
          expert_name TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      clickTableReady = true;
    }
    await sql`INSERT INTO click_logs (publisher, expert_id, expert_name) VALUES (${pub}, ${expert_id || null}, ${expert_name || null})`;
    return res.status(200).end();
  }

  // Password login opt-in/out - handled as its own branch (not folded into
  // the generic settings PATCH below) because setting a password needs
  // hashing before it ever reaches SQL, and needs its own validation error
  // instead of silently accepting whatever's given. No re-verification of
  // identity beyond the session check above is needed - that's the whole
  // point of gating this on an authenticated session rather than a
  // separate email-based reset flow.
  if (req.method === 'PATCH' && (req.body.password || req.body.remove_password)) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_hash TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_fail_count INT DEFAULT 0`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_locked_until TIMESTAMPTZ`.catch(() => {});

    if (req.body.remove_password) {
      await sql`UPDATE publishers SET password_hash = NULL, password_fail_count = 0, password_locked_until = NULL WHERE slug = ${pub}`;
      return res.status(200).json({ ok: true, has_password: false });
    }

    const { password } = req.body;
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }
    const hash = await bcrypt.hash(password, 10);
    await sql`UPDATE publishers SET password_hash = ${hash}, password_fail_count = 0, password_locked_until = NULL WHERE slug = ${pub}`;
    return res.status(200).json({ ok: true, has_password: true });
  }

  // Email change - its own branch (not folded into the generic settings PATCH
  // below) because it needs a uniqueness check with a friendly error and a
  // security notification, neither of which the generic COALESCE update
  // supports. The notification goes to the OLD address, not the new one -
  // it's a tripwire ("did you mean to do this?"), not a confirm-your-new-
  // email flow, so a hijacked session that changes the email still alerts
  // whoever actually owns the inbox this account was reachable at before.
  if (req.method === 'PATCH' && req.body.email) {
    const newEmail = String(req.body.email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    const [current] = await sql`SELECT email, name FROM publishers WHERE slug = ${pub}`;
    if (newEmail === current.email) {
      return res.status(200).json({ ok: true, email: current.email });
    }
    const [existing] = await sql`SELECT id FROM publishers WHERE email = ${newEmail} AND slug != ${pub}`;
    if (existing) {
      return res.status(409).json({ error: 'That email is already registered to another account' });
    }
    await sql`UPDATE publishers SET email = ${newEmail} WHERE slug = ${pub}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: current.email,
        subject: 'Your IntroLinq account email was changed',
        html: emailChangedNotice(current.name, newEmail),
      }),
    }).catch(() => {});
    return res.status(200).json({ ok: true, email: newEmail });
  }

  // Mark a surface as "install flow started" - additive, never removes. Its
  // own branch (not the generic COALESCE update) because it needs
  // array_append-if-absent semantics, not replace. Confirmation that the
  // surface is actually live still comes only from a real load ping
  // (first_widget_fire_at / last_script_activity_at / a manual click).
  // Valid Widgets-tab tab ids: the 3 script widgets + the manual-link
  // channels ('manual' kept for legacy started_widgets rows).
  const WIDGET_IDS = ['text', 'carousel', 'board', 'manual', 'newsletter', 'social', 'website', 'medium', 'substack'];

  if (req.method === 'PATCH' && req.body.started_widget) {
    const w = String(req.body.started_widget);
    if (!WIDGET_IDS.includes(w)) {
      return res.status(400).json({ error: 'Invalid widget' });
    }
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS started_widgets TEXT[] DEFAULT '{}'`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS removed_widgets JSONB DEFAULT '{}'`.catch(() => {});
    // Re-adding clears any prior removal of the same id.
    const [row] = await sql`
      UPDATE publishers
      SET started_widgets = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(started_widgets, '{}') || ARRAY[${w}]::text[]))),
          removed_widgets = COALESCE(removed_widgets, '{}'::jsonb) - ${w}
      WHERE slug = ${pub} AND active = true
      RETURNING started_widgets, removed_widgets
    `.catch(() => [null]);
    return res.status(200).json({ ok: true, started_widgets: row?.started_widgets || [], removed_widgets: row?.removed_widgets || {} });
  }

  // Remove a tab from the Widgets view. Records the removal time in
  // removed_widgets and drops it from started_widgets; the GET self-heal
  // brings the tab back if newer activity appears.
  if (req.method === 'PATCH' && req.body.remove_widget) {
    const w = String(req.body.remove_widget);
    if (!WIDGET_IDS.includes(w) || w === 'manual') {
      return res.status(400).json({ error: 'Invalid widget' });
    }
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS started_widgets TEXT[] DEFAULT '{}'`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS removed_widgets JSONB DEFAULT '{}'`.catch(() => {});
    // Removing the Newsletter tab also clears the legacy 'manual' marker.
    const alsoDrop = w === 'newsletter' ? 'manual' : w;
    const [row] = await sql`
      UPDATE publishers
      SET removed_widgets = COALESCE(removed_widgets, '{}'::jsonb) || jsonb_build_object(${w}::text, to_jsonb(NOW())),
          started_widgets = array_remove(array_remove(COALESCE(started_widgets, '{}'), ${w}), ${alsoDrop})
      WHERE slug = ${pub} AND active = true
      RETURNING started_widgets, removed_widgets
    `.catch(() => [null]);
    return res.status(200).json({ ok: true, started_widgets: row?.started_widgets || [], removed_widgets: row?.removed_widgets || {} });
  }

  // Manual-links signals for the activation reminder cron. Copying a tracked
  // link is intent (not activation - a real reader click still is); "mark as
  // placed" is the publisher's own hard stop for the reminder sequence.
  if (req.method === 'PATCH' && req.body.manual_link_copied) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_link_copied_at TIMESTAMPTZ`.catch(() => {});
    await sql`UPDATE publishers SET manual_link_copied_at = COALESCE(manual_link_copied_at, NOW()) WHERE slug = ${pub} AND active = true`.catch(() => {});
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'PATCH' && 'manual_placed' in req.body) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_placed_at TIMESTAMPTZ`.catch(() => {});
    const [row] = req.body.manual_placed
      ? await sql`UPDATE publishers SET manual_placed_at = COALESCE(manual_placed_at, NOW()) WHERE slug = ${pub} AND active = true RETURNING manual_placed_at`.catch(() => [null])
      : await sql`UPDATE publishers SET manual_placed_at = NULL WHERE slug = ${pub} AND active = true RETURNING manual_placed_at`.catch(() => [null]);
    return res.status(200).json({ ok: true, manual_placed_at: row?.manual_placed_at || null });
  }

  if (req.method === 'PATCH') {
    const { match_power, match_sensitivity, widget_color, accent_color, widget_size, highlight_style, discovery_cue_enabled, no_match_fallback_enabled, no_match_text_color, enabled_partners, payment_email, payment_method, active, carousel_title, board_text_color, name, contact_first_name, contact_last_name, domain, platform } = req.body;
    // Which rail the publisher chose for payouts - only these two are offered
    // in the dashboard, so anything else is treated as "not set".
    const payoutMethod = (payment_method === 'wise' || payment_method === 'paypal') ? payment_method : null;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform_detected BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS carousel_title TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS board_text_color TEXT`.catch(() => {});
    // Same reasoning as board_text_color: the no-match fallback's hook line
    // renders directly in the article's own background (not inside the
    // white popup card, where the fixed dark navy text is always safe), so
    // a dark-themed publisher needs to be able to override it - confirmed
    // unreadable ("dark grey on black") on justcharmaine.co.uk. Null keeps
    // the existing #1a1a2e default.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS no_match_text_color TEXT`.catch(() => {});
    // 'fill' = tinted background + solid underline (original/default). 'underline'
    // = dotted underline only, no background wash - purely a rendering choice
    // read fresh by the widget on every request, same as widget_color/widget_size,
    // so it never touches match_cache and needs no invalidation on change.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS highlight_style TEXT DEFAULT 'fill'`.catch(() => {});
    // Default true so every existing publisher and every new signup keeps
    // the discoverability nudge unless they explicitly turn it off - same
    // "pure rendering choice, no cache invalidation" reasoning as highlight_style.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS discovery_cue_enabled BOOLEAN DEFAULT true`.catch(() => {});
    // Default FALSE, unlike the toggle above - a publisher agreed to a hover
    // widget on matched phrases, not a line that appears on every page with
    // no match at all, so this is opt-in, not opt-out. Also a pure rendering
    // choice (read fresh per request, same as highlight_style) - the multi-
    // variant handler in match.js just omits randomExperts when this is off.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS no_match_fallback_enabled BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS payment_method TEXT`.catch(() => {});
    const [updated] = await sql`
      UPDATE publishers SET
        match_power = COALESCE(${match_power ?? null}, match_power),
        match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
        widget_color = COALESCE(${widget_color ?? null}, widget_color),
        accent_color = COALESCE(${accent_color ?? null}, accent_color),
        widget_size = COALESCE(${widget_size ?? null}, widget_size),
        highlight_style = COALESCE(${highlight_style ?? null}, highlight_style),
        discovery_cue_enabled = COALESCE(${discovery_cue_enabled ?? null}, discovery_cue_enabled),
        no_match_fallback_enabled = COALESCE(${no_match_fallback_enabled ?? null}, no_match_fallback_enabled),
        no_match_text_color = COALESCE(${no_match_text_color ?? null}, no_match_text_color),
        enabled_partners = COALESCE(${enabled_partners ? sql.array(enabled_partners) : null}, enabled_partners),
        payment_email = COALESCE(${payment_email ?? null}, payment_email),
        payment_method = COALESCE(${payoutMethod}, payment_method),
        active = COALESCE(${active ?? null}, active),
        carousel_title = COALESCE(${carousel_title ?? null}, carousel_title),
        board_text_color = COALESCE(${board_text_color ?? null}, board_text_color),
        name = COALESCE(${name?.trim() || null}, name),
        contact_first_name = COALESCE(${contact_first_name?.trim() || null}, contact_first_name),
        contact_last_name = COALESCE(${contact_last_name?.trim() || null}, contact_last_name),
        domain = COALESCE(${domain?.trim() || null}, domain),
        platform = COALESCE(${platform ?? null}, platform),
        -- A platform arriving through this endpoint is always a manual pick
        -- from the Get Started picker, never the signup-time auto-detect
        -- (that writes directly via SQL in api/auth.js) - so it always means
        -- "confirmed by the publisher," clearing any earlier detected guess.
        platform_detected = CASE WHEN ${platform ?? null}::text IS NOT NULL THEN false ELSE platform_detected END
      WHERE slug = ${pub} AND active = true
      RETURNING match_power, match_sensitivity, widget_color, accent_color, widget_size, highlight_style, discovery_cue_enabled, no_match_fallback_enabled, no_match_text_color, enabled_partners, payment_email, payment_method, active, carousel_title, board_text_color, name, contact_first_name, contact_last_name, domain, platform, platform_detected
    `;
    // Clear match cache if matching settings changed so new settings take effect immediately.
    // highlight_style is deliberately excluded - it's a pure rendering choice
    // (like widget_color/widget_size), never baked into a cached match.
    if (match_power != null || match_sensitivity != null || enabled_partners != null) {
      await sql`DELETE FROM match_cache WHERE publisher = ${pub}`.catch(() => {});
    }
    return res.status(200).json(updated);
  }

  // On-demand live check - fired by the dashboard on every load, not just
  // relied on via the passive last_widget_fire_at timestamp (which only
  // updates from real reader traffic, so a removed-but-not-yet-quiet-long-
  // enough widget can sit showing "last checked 2d ago" as if nothing's
  // wrong). Fetches a real page and looks for either supported install
  // method directly, same check a human would do by viewing source. Still
  // won't catch a GTM install whose container is only injected client-side
  // after page load (nothing to find in the raw HTML a plain fetch sees
  // then) - a known gap, not a promise this covers every possible setup,
  // but it's the fast/cheap check, not a full browser render.
  if (req.method === 'GET' && action === 'check_live') {
    const [pubRow] = await sql`SELECT slug, domain FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1`;
    if (!pubRow) return res.status(200).json({ status: 'unknown' });

    // Most sites only embed the widget in article/post templates, not the
    // bare homepage (which usually has no long-form content for it to
    // scan anyway) - checking the homepage alone false-negatives on those
    // (confirmed on littlegreenagency.co.uk: homepage has no widget, every
    // blog post does). Pages the widget has actually fired on before are
    // the right thing to re-check, so try up to 5 of the most recent
    // match_cache entries in order - a high-churn content site (confirmed
    // on psyll.com) can have its single most-recent page already 404/410
    // through completely unrelated content rotation, which would otherwise
    // read as "unreachable" and mask a real removal. Bare domain is the
    // last resort, tried only if every recent page fails or none exist.
    const recentPages = await sql`SELECT page_url FROM match_cache WHERE publisher = ${pub} ORDER BY cached_at DESC LIMIT 5`.catch(() => []);
    // match_cache is populated by widget fires only, so a carousel/board-only
    // publisher has none - fall back to the pages their embed actually
    // rendered on (recorded by carousel_view/board_view) before resorting to
    // the bare homepage, which is usually the wrong page to check.
    const embedPages = ACTIVATION_V2
      ? await sql`SELECT page_url FROM match_logs WHERE publisher = ${pub} AND source IN ('carousel','board') AND page_url IS NOT NULL AND is_bot = false ORDER BY created_at DESC LIMIT 10`.catch(() => [])
      : [];
    const homepage = pubRow.domain ? (/^https?:\/\//i.test(pubRow.domain) ? pubRow.domain : 'https://' + pubRow.domain) : null;
    const candidates = [...new Set([...recentPages.map(r => r.page_url), ...embedPages.map(r => r.page_url), homepage].filter(Boolean))].slice(0, 6);
    if (!candidates.length) return res.status(200).json({ status: 'unknown', reason: 'no_domain' });

    // Deliberately NOT parsing <script> tag boundaries - confirmed on
    // open-intro.com (a Next.js site) that next/script serializes the
    // embed as JSON inside a React hydration payload
    // (\"src\":\"...widget.js\",\"data-publisher\":\"openintro\"), which
    // never appears as a literal <script src=...> tag in the raw HTML at
    // all. Three supported shapes, matched as plain substrings anywhere in
    // the document instead: an HTML attribute (data-publisher="slug"), the
    // same thing JSON-escaped (\"data-publisher\":\"slug\"), or the
    // GTM/custom IL_PUBLISHER_ID variable form. A real introlinq.com
    // widget script reference has to be present somewhere too, so an
    // unrelated page that merely mentions "data-publisher" some other way
    // can't false-positive.
    const escapedSlug = pubRow.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slugPattern = new RegExp(
      'data-publisher\\s*=\\s*["\']' + escapedSlug + '["\']' +
      '|\\\\?["\']data-publisher\\\\?["\']\\s*:\\s*\\\\?["\']' + escapedSlug + '\\\\?["\']',
      'i'
    );
    const slugVarPattern = new RegExp('IL_PUBLISHER_ID\\s*=\\s*["\']' + escapedSlug + '["\']', 'i');

    let lastFailure = null;
    for (const target of candidates) {
      let html;
      try {
        const fetchRes = await fetch(target, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'IntroLinq-WidgetCheck/1.0 (+https://www.introlinq.com)' },
        });
        if (!fetchRes.ok) { lastFailure = { status: 'unreachable', httpStatus: fetchRes.status }; continue; }
        html = await fetchRes.text();
      } catch {
        lastFailure = { status: 'unreachable' };
        continue;
      }

      const found = (/introlinq\.com\/(widget\d*|carousel|expertboard)\.js/i.test(html) && slugPattern.test(html))
        || slugVarPattern.test(html);
      // A page that loaded fine either way tells us something real - live
      // or genuinely not found - so it's the answer either way, no need to
      // try further candidates.
      return res.status(200).json({ status: found ? 'live' : 'not_found', checkedAt: new Date().toISOString() });
    }

    // Every candidate page failed to load at all - genuinely can't verify.
    return res.status(200).json(lastFailure || { status: 'unreachable' });
  }

  if (req.method === 'GET') {
    // Expert list for a specific provider
    if (provider) {
      const experts = await sql`
        SELECT e.id, e.name, e.position, e.company, e.topics, e.photo_url, e.booking_url, e.price_from, e.location_country
        FROM experts e
        JOIN providers p ON p.id = e.provider_id
        WHERE e.active = true AND p.slug = ${provider} AND p.is_demo IS NOT TRUE
        ORDER BY e.name ASC
      `;
      return res.status(200).json({ experts });
    }

    // Ensure columns exist
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS enabled_partners TEXT[] DEFAULT ARRAY['openintro']`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS revenue_share DECIMAL DEFAULT 0.70`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS payment_email TEXT`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS payment_method TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS carousel_title TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS board_text_color TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS highlight_style TEXT DEFAULT 'fill'`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS discovery_cue_enabled BOOLEAN DEFAULT true`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS no_match_fallback_enabled BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS no_match_text_color TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform_detected BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_script_activity_at TIMESTAMPTZ`.catch(() => {});
    // Which surfaces the publisher has gone through the install flow for
    // ('text' | 'carousel' | 'board' | 'manual'). Intent, not confirmation -
    // it's what tells the Widgets tab to show a "Pending" card for something
    // set up but not yet confirmed by a load ping, instead of "never started".
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS started_widgets TEXT[] DEFAULT '{}'`.catch(() => {});
    // Tabs the publisher has explicitly removed from the Widgets view, as a
    // JSONB map id -> ISO timestamp of removal. A tab stays hidden while its
    // last activity predates the removal; the GET below self-heals (drops
    // the key) the moment newer activity shows up, so the tab returns.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS removed_widgets JSONB DEFAULT '{}'`.catch(() => {});
    // Manual-links activation aids for the reminder cron: first time a
    // tracked link was copied, and a self-declared "my links are placed".
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_link_copied_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS manual_placed_at TIMESTAMPTZ`.catch(() => {});
    // Ensure providers have a name column
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS name TEXT`;
    await sql`UPDATE providers SET name = 'OpenIntro' WHERE slug = 'openintro' AND name IS NULL`;
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS page_url TEXT`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS expert_booking_urls TEXT[]`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS no_match_reason TEXT`.catch(() => {});
    // Guarantees ip/is_bot exist on all 4 log tables before the stats queries
    // below filter on is_bot - those queries silently return [] (via .catch)
    // rather than error on a missing column, which would otherwise blank out
    // a publisher's whole dashboard until some insert path happened to create
    // the column first.
    if (!clickBotColumnsReady) { await ensureBotColumns(sql, 'click_logs'); clickBotColumnsReady = true; }
    if (!hoverBotColumnsReady) { await ensureBotColumns(sql, 'hover_logs'); hoverBotColumnsReady = true; }
    if (!seenBotColumnsReady) { await ensureBotColumns(sql, 'seen_logs'); seenBotColumnsReady = true; }
    if (!carouselBotColumnsReady) { await ensureBotColumns(sql, 'match_logs'); carouselBotColumnsReady = true; }

    const [publisher] = await sql`
      SELECT id, name, slug, domain, created_at,
             match_power, match_sensitivity, widget_color, accent_color, widget_size,
             COALESCE(highlight_style, 'fill') AS highlight_style,
             COALESCE(discovery_cue_enabled, true) AS discovery_cue_enabled,
             COALESCE(no_match_fallback_enabled, false) AS no_match_fallback_enabled,
             COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners,
             COALESCE(revenue_share, 0.70) AS revenue_share,
             payment_email, payment_method, carousel_title, board_text_color, no_match_text_color, first_widget_fire_at, last_widget_fire_at, activated_at, last_activity_at, last_script_activity_at, platform, platform_detected,
             COALESCE(started_widgets, '{}') AS started_widgets,
             COALESCE(removed_widgets, '{}'::jsonb) AS removed_widgets,
             manual_link_copied_at, manual_placed_at,
             email, contact_first_name, contact_last_name,
             (password_hash IS NOT NULL) AS has_password
      FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
    `;

    if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

    const [bookingCountRow, payoutByCurrency, bookingRows] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM bookings WHERE publisher = ${pub}`.catch(() => [{ count: 0 }]),
      // total = everything ever earned; paid/pending split by whether a
      // payout has actually gone out yet, so the dashboard can show "you're
      // owed X" separately from the cumulative all-time total, instead of
      // one number that only ever grows even after being paid.
      sql`SELECT booking_currency AS currency,
                 COALESCE(SUM(publisher_payout),0)::float AS payout,
                 COALESCE(SUM(publisher_payout) FILTER (WHERE paid_at IS NOT NULL),0)::float AS paid,
                 COALESCE(SUM(publisher_payout) FILTER (WHERE paid_at IS NULL),0)::float AS pending
          FROM bookings WHERE publisher = ${pub} GROUP BY booking_currency ORDER BY payout DESC`.catch(() => []),
      // article_title/article_url live inside raw_payload (set by the webhook
      // from the original click's attribution) - pulled out explicitly here
      // rather than returning the whole payload, which also holds internal
      // bookkeeping fields (click_id etc.) not meant for the publisher UI.
      sql`SELECT expert_name, booking_amount, booking_currency AS currency, publisher_payout, revenue_share, created_at, provider, paid_at,
                 raw_payload->>'article_title' AS article_title, raw_payload->>'article_url' AS article_url
          FROM bookings WHERE publisher = ${pub} ORDER BY created_at DESC LIMIT 50`.catch(() => []),
    ]);
    const bookingSummary = { count: bookingCountRow[0]?.count || 0, by_currency: payoutByCurrency, rows: bookingRows };

    // Stats reset point - bumped forward again so Seen aligns with the rest
    // of the funnel from the same moment (it launched a few hours after the
    // original reset, which would have diluted the seen-rate the same way
    // hover-rate was diluted before the first reset). Nothing is deleted
    // (click_logs is still needed intact for booking attribution via
    // click_id) - this is purely a query-level filter, so it's trivially
    // reversible if ever needed. Not intended as a repeating pattern - see
    // the comment on this constant in api/admin.js.
    const STATS_RESET_AT = '2026-07-24T23:15:00Z';

    const [logsMatched, logsNoMatch, clickData, hoverData, seenData, providers, expertCounts, totalImpressions, totalImpressionsRaw,
           clicksByDay, impressionsByDay, hoversByDay, seenByDay, clicksByWeek, impressionsByWeek, hoversByWeek, seenByWeek,
           clicksByMonth, impressionsByMonth, hoversByMonth, seenByMonth,
           totalExpertShown, expertShownByDay, expertShownByWeek, expertShownByMonth,
           topPhrases, topSources, topDevices, pageUrls, manualByChannel, clicksByIntegration, manualLastClick] = await Promise.all([
      // Split into two queries rather than one chronological "last 50" -
      // a busy, low-match-rate site (mostly-news publishers correctly get
      // few matches - see match.js's "NEVER match news" rule) can easily
      // have its last 50 raw fires be 100% no-match, which made the
      // Matched tab look empty/broken even when real matches exist further
      // back. Each half gets its own genuine most-recent-50, so Matched
      // always shows real history instead of whatever the chronological
      // stream happened to contain.
      sql`SELECT phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, created_at FROM match_logs WHERE publisher = ${pub} AND page_url IS NOT NULL AND (source IS NULL OR source NOT IN ('carousel','board')) AND is_bot = false AND match_count > 0 AND created_at >= ${STATS_RESET_AT} ORDER BY created_at DESC LIMIT 50`.catch(() => []),
      sql`SELECT phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, created_at FROM match_logs WHERE publisher = ${pub} AND page_url IS NOT NULL AND (source IS NULL OR source NOT IN ('carousel','board')) AND is_bot = false AND match_count = 0 AND created_at >= ${STATS_RESET_AT} ORDER BY created_at DESC LIMIT 50`.catch(() => []),
      sql`SELECT COUNT(*)::int AS total FROM click_logs WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      sql`SELECT COUNT(*)::int AS total FROM hover_logs WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      sql`SELECT COUNT(*)::int AS total FROM seen_logs WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      sql`SELECT id, slug, COALESCE(name, slug) AS name FROM providers WHERE is_demo IS NOT TRUE ORDER BY slug`,
      // Grouped per provider - this used to be one ungrouped COUNT(*) applied
      // identically to every partner in the list, so a small provider showed
      // the same (wrong) total as everyone else the moment there was more
      // than one provider in the table.
      sql`SELECT provider_id, COUNT(*)::int AS count FROM experts WHERE active = true GROUP BY provider_id`,
      // "Page visits" - EVERY widget fire, matched or not (no match_count
      // filter). Every genuine page load produces exactly one match_logs
      // row regardless of outcome - the cache-hit path and the fresh-scan
      // report path each log once - so this is a real, honest page-visit
      // count, not an approximation. Previously this filtered to
      // match_count > 0, which quietly made "Page visits" mean "pages
      // where an expert was shown" - the narrowest number in the funnel,
      // wearing the broadest-sounding label. That definition still exists,
      // it's just correctly named "Expert shown" now (below).
      sql`SELECT COUNT(*)::int AS total FROM match_logs WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      // Same query with no is_bot filter - lets the dashboard show how many
      // detected bot visits were excluded from Page visits above, rather
      // than silently dropping them with no explanation of the gap between
      // what a publisher might see elsewhere and what's shown here.
      sql`SELECT COUNT(*)::int AS total FROM match_logs WHERE publisher = ${pub} AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '30 days' AND created_at >= ${STATS_RESET_AT} GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '30 days' AND created_at >= ${STATS_RESET_AT} GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM hover_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM seen_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 weeks' AND created_at >= ${STATS_RESET_AT} GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 weeks' AND created_at >= ${STATS_RESET_AT} GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM hover_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM seen_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 months' AND created_at >= ${STATS_RESET_AT} GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 months' AND created_at >= ${STATS_RESET_AT} GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM hover_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM seen_logs WHERE publisher = ${pub} AND is_bot = false AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      // "Expert shown" - the OLD "Page visits" definition (match_count > 0),
      // now correctly named: of all the pages the widget ran on, how many
      // actually had an expert to display. Subset of Page visits above.
      sql`SELECT COUNT(*)::int AS total FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND is_bot = false AND created_at >= ${STATS_RESET_AT}`.catch(() => [{ total: 0 }]),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND is_bot = false AND created_at > NOW() - INTERVAL '30 days' AND created_at >= ${STATS_RESET_AT} GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND is_bot = false AND created_at > NOW() - INTERVAL '12 weeks' AND created_at >= ${STATS_RESET_AT} GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND is_bot = false AND created_at > NOW() - INTERVAL '12 months' AND created_at >= ${STATS_RESET_AT} GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT phrase, COUNT(*)::int AS clicks FROM click_logs WHERE publisher = ${pub} AND phrase IS NOT NULL AND phrase != '' AND is_bot = false AND created_at >= ${STATS_RESET_AT} GROUP BY phrase ORDER BY clicks DESC LIMIT 5`.catch(() => []),
      sql`SELECT traffic_source AS source, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND traffic_source IS NOT NULL AND is_bot = false AND created_at >= ${STATS_RESET_AT} GROUP BY traffic_source ORDER BY count DESC`.catch(() => []),
      sql`SELECT device, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND device IS NOT NULL AND is_bot = false AND created_at >= ${STATS_RESET_AT} GROUP BY device ORDER BY count DESC`.catch(() => []),
      sql`SELECT page_url, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND page_url IS NOT NULL AND is_bot = false AND created_at >= ${STATS_RESET_AT} GROUP BY page_url ORDER BY count DESC LIMIT 100`.catch(() => []),
      // Manual-link clicks split by the channel they were placed in. Legacy
      // manual clicks (tagged only source='newsletter', no manual_channel)
      // fold into 'newsletter' via COALESCE so the split still adds up to the
      // manual total.
      sql`SELECT COALESCE(manual_channel, CASE WHEN traffic_source = 'newsletter' THEN 'newsletter' ELSE 'other' END) AS channel, COUNT(*)::int AS count
          FROM click_logs
          WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}
            AND (integration = 'manual' OR traffic_source = 'newsletter')
          GROUP BY 1`.catch(() => []),
      // Clicks per surface (text / carousel / board / manual). Legacy clicks
      // with no integration tag are almost all pre-tag text-widget clicks -
      // bucket them as 'text' so the surface totals reconcile to the grand
      // total instead of leaving a large untagged remainder.
      sql`SELECT COALESCE(NULLIF(integration, ''), CASE WHEN traffic_source IN ('carousel','board') THEN traffic_source WHEN traffic_source = 'newsletter' THEN 'manual' ELSE 'text' END) AS surface, COUNT(*)::int AS count
          FROM click_logs
          WHERE publisher = ${pub} AND is_bot = false AND created_at >= ${STATS_RESET_AT}
          GROUP BY 1`.catch(() => []),
      // Most recent manual-link click per channel - lets the dashboard
      // un-hide a removed manual tab the moment one of its links is clicked
      // again (see removed_widgets self-heal below).
      sql`SELECT manual_channel AS channel, MAX(created_at) AS last_at
          FROM click_logs
          WHERE publisher = ${pub} AND is_bot = false AND integration = 'manual' AND manual_channel IS NOT NULL
          GROUP BY 1`.catch(() => []),
    ]);

    const expertCountByProvider = new Map(expertCounts.map(r => [r.provider_id, r.count]));
    const partnersWithStatus = providers.map(p => ({
      slug: p.slug,
      name: p.name,
      expert_count: expertCountByProvider.get(p.id) || 0,
      enabled: (publisher.enabled_partners || ['openintro']).includes(p.slug),
    }));

    // Integration mode set - which of widget / carousel / board / manual
    // this publisher is actually using, each from its own positive signal.
    // Only used for display (a small label, and the manual-only dashboard
    // layout); nothing depends on it being exhaustive.
    const clicksTotal = clickData[0]?.total || 0;
    const impressionsTotal = totalImpressions[0]?.total || 0;
    let modes = [];
    let manualOnly = false;
    if (ACTIVATION_V2) {
      // Same preview/sandbox host guard as the admin panel's mode CTE - a
      // carousel/board render inside an email-builder preview pane or an
      // AI code sandbox (about:srcdoc, *.oaiusercontent.com, *.claude.site)
      // must not light up a mode label on the publisher's own dashboard.
      const embedSources = await sql`
        SELECT DISTINCT source FROM match_logs
        WHERE publisher = ${pub} AND is_bot = false AND source IS NOT NULL
          AND page_url LIKE 'http%'
          AND page_url NOT ILIKE '%introlinq.com%'
          AND page_url NOT ILIKE '%oaiusercontent.com%'
          AND page_url NOT ILIKE '%claudeusercontent.com%'
          AND page_url NOT ILIKE '%claude.site%'`.catch(() => []);
      const clickSources = (topSources || []).map(r => r.source);
      const has = s => embedSources.some(r => r.source === s) || clickSources.includes(s);
      if (publisher.first_widget_fire_at) modes.push('widget');
      if (has('carousel')) modes.push('carousel');
      if (has('board')) modes.push('board');
      // Any manual-link click, whatever channel it was tagged with (the old
      // check only saw source='newsletter').
      const manualClicks = (clicksByIntegration || []).reduce((n, r) => n + (r.surface === 'manual' ? r.count : 0), 0);
      if (manualClicks > 0 || clickSources.includes('newsletter')) modes.push('manual');
      // Manual-only: real click traffic but nothing that produces a view
      // signal (no widget/carousel/board render ever). This is what drives
      // the clicks-first dashboard layout instead of an all-zeros funnel.
      manualOnly = impressionsTotal === 0 && clicksTotal > 0;
    }

    // Self-heal removed_widgets: a tab whose widget or tagged link has fired
    // since it was removed comes back - drop the key and report the id in
    // `resurfaced` so the dashboard can say so.
    let removedWidgets = publisher.removed_widgets || {};
    const resurfaced = [];
    const removedKeys = Object.keys(removedWidgets);
    if (removedKeys.length) {
      const manualLastByChannel = Object.fromEntries((manualLastClick || []).map((r) => [r.channel, r.last_at]));
      const kept = {};
      for (const id of removedKeys) {
        const removedAt = new Date(removedWidgets[id]);
        let lastAct = null;
        if (id === 'text') lastAct = publisher.last_widget_fire_at;
        else if (id === 'carousel' || id === 'board') lastAct = publisher.last_script_activity_at;
        else lastAct = manualLastByChannel[id];
        if (lastAct && new Date(lastAct) > removedAt) resurfaced.push(id);
        else kept[id] = removedWidgets[id];
      }
      if (resurfaced.length) {
        removedWidgets = kept;
        await sql`UPDATE publishers SET removed_widgets = ${JSON.stringify(kept)}::jsonb WHERE slug = ${pub}`.catch(() => {});
      }
    }
    publisher.removed_widgets = removedWidgets;

    return res.status(200).json({
      publisher,
      activation_v2: ACTIVATION_V2,
      modes,
      resurfaced,
      manual_only: manualOnly,
      logs_matched: logsMatched,
      logs_no_match: logsNoMatch,
      clicks: clicksTotal,
      hovers: hoverData[0]?.total || 0,
      seen: seenData[0]?.total || 0,
      total_impressions: impressionsTotal,
      total_impressions_raw: totalImpressionsRaw[0]?.total || 0,
      total_expert_shown: totalExpertShown[0]?.total || 0,
      partners: partnersWithStatus,
      bookings: bookingSummary,
      clicks_by_day: clicksByDay,
      impressions_by_day: impressionsByDay,
      hovers_by_day: hoversByDay,
      seen_by_day: seenByDay,
      clicks_by_week: clicksByWeek,
      impressions_by_week: impressionsByWeek,
      hovers_by_week: hoversByWeek,
      seen_by_week: seenByWeek,
      clicks_by_month: clicksByMonth,
      impressions_by_month: impressionsByMonth,
      hovers_by_month: hoversByMonth,
      seen_by_month: seenByMonth,
      expert_shown_by_day: expertShownByDay,
      expert_shown_by_week: expertShownByWeek,
      expert_shown_by_month: expertShownByMonth,
      top_phrases: topPhrases,
      traffic_sources: topSources,
      devices: topDevices,
      page_urls: pageUrls,
      // Per-surface + per-manual-channel click counts for the Widgets tab
      // card status lines (and, later, the per-surface Overview blocks).
      clicks_by_surface: Object.fromEntries((clicksByIntegration || []).map((r) => [r.surface, r.count])),
      manual_clicks_by_channel: Object.fromEntries((manualByChannel || []).map((r) => [r.channel, r.count])),
      manual_last_click_by_channel: Object.fromEntries((manualLastClick || []).map((r) => [r.channel, r.last_at])),
    });
  }

  return res.status(405).end();
}

function emailChangedNotice(name, newEmail) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Hi ${name},</p>
    <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">The login email on your IntroLinq account was just changed to <strong style="color:#1a1a2e">${newEmail}</strong>.</p>
    <p style="margin:0;font-size:0.875rem;color:#8888a8;line-height:1.6">If this was you, no action needed. If you didn't make this change, reply to this email right away so we can help secure your account.</p>
  </div>
</div>
</body></html>`;
}
