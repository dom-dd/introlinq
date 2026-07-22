import { neon } from '@neondatabase/serverless';
import { createMagicToken } from './auth.js';
import { DECK_HTML_B64 } from './_deckContent.js';

function auth(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const allowed = process.env.OWNER_IP?.split(',').map(s => s.trim());
  return allowed && allowed.includes(ip);
}

// Fire-and-forget - a Slack outage or missing webhook URL must never block
// or fail the brief itself, so all errors are swallowed here.
async function notifySlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Slack notify failed:', err);
  }
}

const DECK_PASSWORD = 'saranac';
const DECK_COOKIE = 'il_brief_auth';

// The actual deck markup lives in _deckContent.js (the underscore prefix
// tells Vercel's zero-config routing to exclude it from becoming its own
// Serverless Function - every OTHER api/*.js file counts toward the Hobby
// plan's 12-function cap regardless of whether it has a route handler,
// which is what broke the last two deploys). It's never statically served
// either way - unlike everything outside api/, files here are compiled into
// functions, not served as raw source - and is only ever returned after
// this password check, so there is no path that exposes it unauthenticated.
// noindex on every response (even the password form) keeps a crawler that
// somehow requests /brief from ever indexing anything here.
function deckPasswordForm(showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Introlinq - Investor Brief</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#12141F;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  form{background:#1C1E2B;border-radius:14px;padding:2.2rem 2.4rem;width:min(320px,88vw);box-shadow:0 16px 48px rgba(0,0,0,.4);box-sizing:border-box}
  h1{color:#F2EEE2;font-size:1.05rem;font-weight:600;margin:0 0 1.4rem}
  input{width:100%;box-sizing:border-box;-webkit-appearance:none;appearance:none;padding:.75rem .9rem;border-radius:8px;border:1px solid #2B2D3C;background:#15161F;color:#ECE9DE;font-size:.95rem;margin-bottom:.9rem}
  input::placeholder{color:#7B7F94}
  input:focus{outline:2px solid #F0B93A}
  /* Browser autofill (very common on a password field) silently overrides
     background/color with its own white/yellow styling, ignoring the rules
     above - this is the standard fix: paint over it with an inset shadow
     and force the text color via the -webkit-only text-fill property. */
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus {
    -webkit-text-fill-color: #ECE9DE;
    -webkit-box-shadow: 0 0 0px 1000px #15161F inset;
    box-shadow: 0 0 0px 1000px #15161F inset;
    caret-color: #ECE9DE;
    transition: background-color 5000s ease-in-out 0s;
  }
  button{width:100%;padding:.75rem;border-radius:8px;border:none;background:#F0B93A;color:#15161F;font-weight:600;font-size:.9rem;cursor:pointer}
  .err{color:#F0B93A;font-size:.82rem;margin:-.6rem 0 .9rem}
</style>
</head>
<body>
<form method="POST" action="/brief">
  <h1>This page is password protected</h1>
  ${showError ? '<div class="err">Incorrect password - try again.</div>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">View brief</button>
</form>
</body>
</html>`;
}

export default async function handler(req, res) {
  const { resource } = req.query;

  // IP check
  if (resource === 'auth') {
    return res.status(200).json({ ok: auth(req) });
  }

  // Password-gated investor brief. /brief is rewritten here (vercel.json) -
  // there is no static file at that path, so this handler is the only way
  // to reach the content.
  if (resource === 'brief') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

    // Two distinct alerts, not deduped - a single successful visit fires both
    // (a password-entered alert, then a page-loaded alert on the resulting
    // redirect), which is intentional: it's the difference between "someone
    // tried the door" and "someone is now looking at it".
    if (req.method === 'POST') {
      const correct = req.body?.password === DECK_PASSWORD;
      // Awaited - a serverless function can be frozen the instant the
      // response is sent, which was silently killing this fire-and-forget
      // before the fetch to Slack ever completed.
      await notifySlack(`🔑 Password ${correct ? 'entered correctly' : 'attempt (wrong)'} on the Introlinq investor brief\nIP: ${ip}`);
      if (correct) {
        res.setHeader('Set-Cookie', `${DECK_COOKIE}=1; HttpOnly; Secure; SameSite=Lax; Path=/brief; Max-Age=2592000`);
        return res.redirect(302, '/brief');
      }
      return res.status(401).send(deckPasswordForm(true));
    }

    await notifySlack(`📄 The Introlinq investor brief page was loaded\nIP: ${ip}`);

    const authed = (req.headers.cookie || '').split(';').some(c => c.trim() === `${DECK_COOKIE}=1`);
    if (!authed) return res.status(200).send(deckPasswordForm(false));

    return res.status(200).send(Buffer.from(DECK_HTML_B64, 'base64').toString('utf8'));
  }

  // Fired via navigator.sendBeacon from the brief page itself (see the
  // inline script near the end of _deckContent.js) when the tab is hidden
  // or closed, reporting how long it was open. Unauthenticated on purpose -
  // it's a fire-and-forget analytics ping, not a path to the content - and
  // sendBeacon can't attach the auth cookie's context beyond what the
  // browser already sends automatically, so there's nothing extra to check.
  if (resource === 'brief-close' && req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const seconds = Math.max(0, Math.min(Number(body?.duration) || 0, 86400));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    await notifySlack(`👋 Investor brief session ended - ${mins}m ${secs}s\nIP: ${ip}`);
    return res.status(204).end();
  }

  // Daily publisher discovery - authenticated via CRON_SECRET, triggered by
  // a GitHub Actions schedule (see .github/workflows/discovery-cron.yml)
  // rather than Vercel's own Cron Jobs, since Hobby caps both cron jobs (2)
  // and serverless functions (12) per deployment - this reuses the existing
  // api/admin.js function instead of adding a 13th file. Finds up to 50 new
  // candidate domains via SerpAPI using the same logic/tables as the manual
  // discovery/discover.js script. Deliberately does not run classify.js or
  // enrich.js - those cost Anthropic/Apollo credits per lead and stay a
  // manual, deliberate spend.
  if (resource === 'run-discovery') {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { generateQueries } = await import('../discovery/lib/queries.js');
    const { serpSearch, extractCandidates } = await import('../discovery/lib/serpapi.js');

    const sql = neon(process.env.DATABASE_URL);
    const started = Date.now();
    const DAILY_TARGET = 50;
    // api/admin.js is capped at maxDuration:60 (vercel.json). Each SerpAPI call
    // now times out at 10s (see serpapi.js), so budget stays low enough that
    // one more in-flight query after the check trips still finishes with
    // margin to spare before Vercel kills the function.
    const TIME_BUDGET_MS = 35000;

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

    const queries = generateQueries();
    const [{ count: seededCount }] = await sql`SELECT COUNT(*)::int AS count FROM discovery_queries`;
    if (seededCount < queries.length) {
      for (const q of queries) {
        // Seeding is otherwise unbounded - a large jump in queries.length (e.g.
        // TOPICS growing) shouldn't be able to eat the whole time budget itself
        // and leave nothing for the actual discovery loop below.
        if (Date.now() - started > TIME_BUDGET_MS) break;
        await sql`INSERT INTO discovery_queries (query) VALUES (${q}) ON CONFLICT (query) DO NOTHING`;
      }
    }

    let added = 0;
    let queriesRun = 0;
    let stopReason = 'daily target reached';

    while (added < DAILY_TARGET) {
      if (Date.now() - started > TIME_BUDGET_MS) { stopReason = 'time budget reached'; break; }

      const [query] = await sql`
        SELECT id, query FROM discovery_queries
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `;
      if (!query) { stopReason = 'query pool exhausted'; break; }

      try {
        const results = await serpSearch(query.query);
        const candidates = extractCandidates(results);
        let newCount = 0;
        for (const c of candidates) {
          const result = await sql`
            INSERT INTO candidate_publishers (domain, homepage_url, title, snippet, discovery_query)
            VALUES (${c.domain}, ${c.homepage_url}, ${c.title}, ${c.snippet}, ${query.query})
            ON CONFLICT (domain) DO NOTHING
            RETURNING id
          `;
          if (result.length > 0) newCount++;
        }
        await sql`
          UPDATE discovery_queries
          SET status = 'done', results_count = ${results.length}, new_domains_count = ${newCount}, run_at = NOW()
          WHERE id = ${query.id}
        `;
        added += newCount;
      } catch (err) {
        await sql`
          UPDATE discovery_queries
          SET status = 'failed', error = ${String(err.message || err).slice(0, 500)}, run_at = NOW()
          WHERE id = ${query.id}
        `;
      }
      queriesRun++;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return res.status(200).json({ ok: true, added, queriesRun, stopReason, elapsedMs: Date.now() - started });
  }

  if (!auth(req)) return res.status(403).json({ error: 'Forbidden' });

  const sql = neon(process.env.DATABASE_URL);

  // Stats
  if (resource === 'stats') {
    const [publishers, experts, subscribers, lastSync] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM publishers WHERE active = true AND slug NOT LIKE 'demo-%'`,
      // Labeled "from OpenIntro" in the UI - must actually filter to that
      // provider, not count every active expert across every provider
      // (demo providers included), or the number silently drifts from what
      // the label claims as soon as there's more than one provider.
      sql`SELECT COUNT(*)::int AS count FROM experts e JOIN providers p ON p.id = e.provider_id WHERE e.active = true AND p.slug = 'openintro'`,
      sql`SELECT COUNT(*)::int AS count FROM subscribers`,
      sql`SELECT last_synced_at FROM providers WHERE slug = 'openintro'`,
    ]);
    return res.status(200).json({
      publishers: publishers[0].count,
      experts: experts[0].count,
      subscribers: subscribers[0].count,
      last_synced_at: lastSync[0]?.last_synced_at || null,
    });
  }

  // Platform-wide analytics (impressions/clicks across every publisher) -
  // kept as its own endpoint rather than folded into `stats` above, since
  // `stats` runs on every admin page load regardless of which tab is open
  // and these queries are heavier; this only runs when the Stats tab is
  // actually opened. Demo publishers (slug LIKE 'demo-%') are excluded
  // everywhere here, same as the rest of admin - they're showcase pages,
  // not real traffic, and would inflate every number.
  if (resource === 'analytics') {
    const notDemo = sql`publisher NOT LIKE 'demo-%'`;
    const [totals, clicksByDay, imprByDay, clicksByWeek, imprByWeek, clicksByMonth, imprByMonth] = await Promise.all([
      sql`
        SELECT
          (SELECT COUNT(*) FROM match_logs WHERE match_count > 0 AND ${notDemo})::int AS impressions,
          (SELECT COUNT(*) FROM click_logs WHERE ${notDemo})::int AS clicks,
          (SELECT COUNT(*) FROM match_cache WHERE ${notDemo})::int AS pages_scanned,
          (SELECT COUNT(*) FROM publishers WHERE active = true AND slug NOT LIKE 'demo-%' AND first_widget_fire_at IS NOT NULL)::int AS publishers_live,
          (SELECT COUNT(*) FROM publishers WHERE active = true AND slug NOT LIKE 'demo-%')::int AS publishers_total
      `,
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM click_logs WHERE ${notDemo} AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`,
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM match_logs WHERE match_count > 0 AND ${notDemo} AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`,
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM click_logs WHERE ${notDemo} AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`,
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM match_logs WHERE match_count > 0 AND ${notDemo} AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`,
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM click_logs WHERE ${notDemo} AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`,
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM match_logs WHERE match_count > 0 AND ${notDemo} AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`,
    ]);
    return res.status(200).json({
      totals: totals[0],
      clicks_by_day: clicksByDay, impressions_by_day: imprByDay,
      clicks_by_week: clicksByWeek, impressions_by_week: imprByWeek,
      clicks_by_month: clicksByMonth, impressions_by_month: imprByMonth,
    });
  }

  // Waitlist signups (from the pre-launch landing pages) - not yet full
  // publisher accounts. Listed here so they can be followed up with a
  // personalized /signup link that pre-fills what they already gave us.
  if (resource === 'subscribers') {
    // Overrides let a human correct the auto-guessed fields (e.g.
    // "trainingdesignersclub" -> "Training Designers Club") once, in the
    // admin edit modal, instead of re-typing the fix every time the page
    // reloads. These never touch the subscriber's real email/blog_url -
    // just what gets used to build their /signup link. NULL means "no
    // override, use the live guess"; an empty string means "guessed wrong
    // and there's no good answer, leave it blank" - so the two states
    // must stay distinguishable.
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS contact_first_override TEXT`.catch(() => {});
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS contact_last_override TEXT`.catch(() => {});
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS email_override TEXT`.catch(() => {});
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS domain_override TEXT`.catch(() => {});
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS publication_name_override TEXT`.catch(() => {});
    await sql`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ`.catch(() => {});

    if (req.method === 'PATCH') {
      const { id, contacted, contact_first_override, contact_last_override, email_override, domain_override, publication_name_override } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });

      // The "mark as contacted" checkbox is a separate, lightweight toggle
      // from the edit-modal save below - it must not require (or clobber)
      // the other override fields, so it's handled as its own branch
      // rather than folded into the always-write-all-five UPDATE.
      if (contacted !== undefined) {
        await sql`UPDATE subscribers SET contacted_at = ${contacted ? new Date().toISOString() : null} WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      await sql`
        UPDATE subscribers
        SET contact_first_override = ${contact_first_override ?? null},
            contact_last_override = ${contact_last_override ?? null},
            email_override = ${email_override ?? null},
            domain_override = ${domain_override ?? null},
            publication_name_override = ${publication_name_override ?? null}
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }

    const rows = await sql`
      SELECT id, name, email, blog_url, monthly_visitors, country, created_at, contacted_at,
        contact_first_override, contact_last_override, email_override, domain_override, publication_name_override
      FROM subscribers ORDER BY created_at DESC
    `;
    return res.status(200).json(rows);
  }

  // Publishers
  if (resource === 'publishers') {
    await sql`
      CREATE TABLE IF NOT EXISTS publishers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        domain TEXT,
        notes TEXT,
        active BOOLEAN DEFAULT true,
        match_power TEXT DEFAULT 'moderate',
        match_sensitivity TEXT DEFAULT 'balanced',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS match_power TEXT DEFAULT 'moderate'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS match_sensitivity TEXT DEFAULT 'balanced'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_color TEXT DEFAULT '#e6a820'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT '#e6a820'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_size TEXT DEFAULT 'medium'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS contact_first_name TEXT`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS contact_last_name TEXT`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS revenue_share DECIMAL DEFAULT 0.70`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS payment_email TEXT`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS first_widget_fire_at TIMESTAMPTZ`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_widget_fire_at TIMESTAMPTZ`;

    if (req.method === 'GET') {
      // Demo publisher accounts (power the /demo/*.html showcase pages' widgets)
      // are excluded from this list - they're not real customers, and are
      // already visible under the Experts tab's Groups table.
      const publishers = await sql`SELECT * FROM publishers WHERE slug NOT LIKE 'demo-%' ORDER BY created_at DESC`;
      const [matchStats, clickStats] = await Promise.all([
        sql`SELECT publisher, COUNT(*)::int AS impressions FROM match_logs WHERE match_count > 0 GROUP BY publisher`.catch(() => []),
        sql`SELECT publisher, COUNT(*)::int AS clicks FROM click_logs GROUP BY publisher`.catch(() => []),
      ]);
      const matchMap = Object.fromEntries(matchStats.map(r => [r.publisher, r.impressions]));
      const clickMap = Object.fromEntries(clickStats.map(r => [r.publisher, r.clicks]));
      const result = publishers.map(p => ({
        ...p,
        impressions: matchMap[p.slug] || 0,
        clicks: clickMap[p.slug] || 0,
      }));
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      const { name, email, slug, domain, notes, contact_first_name, contact_last_name, revenue_share, enabled_partners, match_sensitivity } = req.body;
      if (!name || !email || !slug) {
        return res.status(400).json({ error: 'name, email and slug are required' });
      }
      const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS enabled_partners TEXT[]`.catch(() => {});
      try {
        const [pub] = await sql`
          INSERT INTO publishers (name, email, slug, domain, notes, contact_first_name, contact_last_name, revenue_share, enabled_partners, match_sensitivity)
          VALUES (${name}, ${email}, ${clean}, ${domain || null}, ${notes || null}, ${contact_first_name || null}, ${contact_last_name || null}, ${revenue_share ?? 0.70}, ${enabled_partners || null}, ${match_sensitivity || 'balanced'})
          RETURNING *
        `;

        // Send welcome email with magic link (7-day expiry)
        const firstName = contact_first_name || name;
        createMagicToken(sql, email.toLowerCase(), 7 * 24 * 60 * 60 * 1000).then(token => {
          const link = `https://www.introlinq.com/api/auth?token=${token}`;
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'IntroLinq <hello@introlinq.com>',
              to: email,
              subject: `Welcome to IntroLinq, ${firstName} - your dashboard is ready`,
              html: welcomeEmail(firstName, link),
            })
          });
        }).catch(err => console.error('Welcome email failed:', err));

        return res.status(201).json(pub);
      } catch (err) {
        if (err.message.includes('unique')) {
          return res.status(409).json({ error: 'Email or slug already exists' });
        }
        throw err;
      }
    }

    if (req.method === 'PATCH') {
      const { id, active, match_power, match_sensitivity, widget_color, accent_color, widget_size, enabled_partners, revenue_share } = req.body;
      // Deliberately admin-only: dashboard.js's own PATCH (session-authenticated
      // as the publisher) never accepts this field - a publisher must never be
      // able to set their own commission rate.
      if (revenue_share != null && (typeof revenue_share !== 'number' || revenue_share < 0 || revenue_share > 1)) {
        return res.status(400).json({ error: 'revenue_share must be a number between 0 and 1' });
      }
      const [pub] = await sql`
        UPDATE publishers SET
          active = COALESCE(${active ?? null}, active),
          match_power = COALESCE(${match_power ?? null}, match_power),
          match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
          widget_color = COALESCE(${widget_color ?? null}, widget_color),
          accent_color = COALESCE(${accent_color ?? null}, accent_color),
          widget_size = COALESCE(${widget_size ?? null}, widget_size),
          enabled_partners = COALESCE(${enabled_partners ?? null}, enabled_partners),
          revenue_share = COALESCE(${revenue_share ?? null}, revenue_share)
        WHERE id = ${id} RETURNING *
      `;
      // Clear match cache for this publisher so new settings take effect immediately
      await sql`DELETE FROM match_cache WHERE publisher = ${pub.slug}`.catch(() => {});
      return res.status(200).json(pub);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      const [pub] = await sql`SELECT slug, email FROM publishers WHERE id = ${id}`;
      if (!pub) return res.status(404).json({ error: 'Publisher not found' });
      await Promise.all([
        sql`DELETE FROM publishers WHERE id = ${id}`,
        sql`DELETE FROM match_logs WHERE publisher = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM click_logs WHERE publisher = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM sessions WHERE publisher_slug = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM magic_links WHERE email = ${pub.email}`.catch(() => {}),
      ]);
      return res.status(200).json({ ok: true });
    }
  }

  // Bookings - admin view + manual entry
  if (resource === 'bookings') {
    await sql`CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY, entry_type TEXT DEFAULT 'manual', provider TEXT,
      publisher TEXT, expert_name TEXT, booking_id TEXT UNIQUE,
      booking_amount DECIMAL, booking_currency TEXT DEFAULT 'GBP',
      commission_amount DECIMAL, commission_currency TEXT DEFAULT 'GBP',
      revenue_share DECIMAL, publisher_payout DECIMAL, introlinq_margin DECIMAL,
      raw_payload JSONB, booked_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )`.catch(() => {});
    // NULL = still owed, a timestamp = when it was actually paid out. Lets
    // both the admin panel and the publisher's own dashboard distinguish
    // "earned" from "already sent" instead of one number that only grows.
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payout_batch_id TEXT`.catch(() => {});

    if (req.method === 'GET') {
      const bookings = await sql`
        SELECT b.*, p.name AS publisher_name
        FROM bookings b
        LEFT JOIN publishers p ON p.slug = b.publisher
        ORDER BY b.booked_at DESC LIMIT 100
      `;
      const [totals] = await sql`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(commission_amount),0)::float AS total_commission,
               COALESCE(SUM(publisher_payout),0)::float AS total_payouts,
               COALESCE(SUM(introlinq_margin),0)::float AS total_margin
        FROM bookings
      `;
      // Who's actually owed money right now, grouped by publisher + currency
      // (a publisher could earn in more than one currency across partners).
      // payment_email surfaced here too so admin can see at a glance who
      // can't be paid yet because they never set one.
      const pendingPayouts = await sql`
        SELECT b.publisher, p.name AS publisher_name, p.payment_email,
               b.booking_currency AS currency,
               COALESCE(SUM(b.publisher_payout),0)::float AS pending
        FROM bookings b
        LEFT JOIN publishers p ON p.slug = b.publisher
        WHERE b.paid_at IS NULL AND b.publisher_payout IS NOT NULL
        GROUP BY b.publisher, p.name, p.payment_email, b.booking_currency
        HAVING COALESCE(SUM(b.publisher_payout),0) > 0
        ORDER BY pending DESC
      `.catch(() => []);
      return res.status(200).json({ bookings, totals, pendingPayouts });
    }

    if (req.method === 'POST') {
      const { provider = 'openintro', publisher, expert_name, booking_amount,
              booking_currency = 'GBP', commission_amount, commission_currency = 'GBP',
              booked_at, booking_id } = req.body;

      const [pub] = await sql`SELECT revenue_share FROM publishers WHERE slug = ${publisher} LIMIT 1`.catch(() => [null]);
      const revenue_share = parseFloat(pub?.revenue_share || 0.70);
      const publisher_payout = commission_amount ? Math.round(commission_amount * revenue_share * 100) / 100 : null;
      const introlinq_margin = commission_amount ? Math.round((commission_amount - publisher_payout) * 100) / 100 : null;

      await sql`INSERT INTO bookings
        (entry_type, provider, publisher, expert_name, booking_id, booking_amount, booking_currency,
         commission_amount, commission_currency, revenue_share, publisher_payout, introlinq_margin, booked_at)
        VALUES ('manual', ${provider}, ${publisher}, ${expert_name || null}, ${booking_id || null},
                ${booking_amount || null}, ${booking_currency}, ${commission_amount || null},
                ${commission_currency}, ${revenue_share}, ${publisher_payout}, ${introlinq_margin},
                ${booked_at ? new Date(booked_at) : new Date()})
        ON CONFLICT (booking_id) DO NOTHING`;
      return res.status(201).json({ ok: true });
    }
  }

  // Manual payout confirmation - admin already sent the money themselves
  // (Wise, PayPal by hand, bank transfer) and just needs the system to
  // reflect it. No PayPal credentials required for this path - it's the
  // thing that makes "who's been paid" trackable even before automated
  // payouts are wired up.
  if (resource === 'mark-paid' && req.method === 'POST') {
    const { publisher, currency } = req.body;
    if (!publisher || !currency) return res.status(400).json({ error: 'publisher and currency required' });
    const batchId = 'manual-' + Date.now();
    const result = await sql`
      UPDATE bookings SET paid_at = NOW(), payout_batch_id = ${batchId}
      WHERE publisher = ${publisher} AND booking_currency = ${currency} AND paid_at IS NULL
      RETURNING id, publisher_payout
    `;
    const total = result.reduce((s, r) => s + parseFloat(r.publisher_payout || 0), 0);
    return res.status(200).json({ ok: true, marked: result.length, total });
  }

  // Fully automated payout via PayPal - actually sends the money, then
  // marks paid only on confirmed success (never marks paid if the transfer
  // failed). Needs PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET - returns a clear
  // 503 explaining what's missing rather than failing silently if unset.
  if (resource === 'payout' && req.method === 'POST') {
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      return res.status(503).json({ error: 'PayPal not configured - use mark-paid for a manual payout, or add PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET to enable automated payouts' });
    }
    const { publisher, currency } = req.body;
    if (!publisher || !currency) return res.status(400).json({ error: 'publisher and currency required' });

    const [pub] = await sql`SELECT name, payment_email FROM publishers WHERE slug = ${publisher} LIMIT 1`;
    if (!pub) return res.status(404).json({ error: 'Publisher not found' });
    if (!pub.payment_email) return res.status(400).json({ error: 'Publisher has no payment email set' });

    const [pending] = await sql`
      SELECT COALESCE(SUM(publisher_payout),0)::float AS total
      FROM bookings WHERE publisher = ${publisher} AND booking_currency = ${currency} AND paid_at IS NULL
    `;
    if (!pending.total || pending.total <= 0) return res.status(400).json({ error: 'Nothing pending for this publisher/currency' });

    const batchId = `il-${publisher}-${Date.now()}`;
    let payoutBatchId;
    try {
      payoutBatchId = await sendPayPalPayout({
        email: pub.payment_email,
        amount: pending.total,
        currency,
        note: `IntroLinq payout - ${pub.name}`,
        batchId,
      });
    } catch (err) {
      console.error('PayPal payout failed:', err);
      return res.status(502).json({ error: 'PayPal payout failed: ' + err.message });
    }

    const result = await sql`
      UPDATE bookings SET paid_at = NOW(), payout_batch_id = ${payoutBatchId}
      WHERE publisher = ${publisher} AND booking_currency = ${currency} AND paid_at IS NULL
      RETURNING id
    `;
    return res.status(200).json({ ok: true, marked: result.length, total: pending.total, payout_batch_id: payoutBatchId });
  }

  // One-time: fix missing location_country for specific experts
  if (resource === 'fix-expert-locations' && req.method === 'POST') {
    const fixes = [
      { name: 'John Foy', country: 'Kuwait' },
      { name: 'Qasim Qazi', country: 'Saudi Arabia' },
    ];
    const results = [];
    for (const { name, country } of fixes) {
      const updated = await sql`
        UPDATE experts SET location_country = ${country}
        WHERE name = ${name} AND (location_country IS NULL OR location_country = '')
        RETURNING id, name, location_country
      `.catch(() => []);
      results.push(...updated);
    }
    return res.status(200).json({ updated: results });
  }

  // One-time: flag French-speaking experts by country + name
  if (resource === 'migrate-languages' && req.method === 'POST') {
    const namedExperts = ['Dominic Gagnon', 'Judith Fetzer', 'Andrew Lockhead', 'Philippe Therrien'];
    const [byCountry] = await sql`
      UPDATE experts
      SET languages = array(SELECT DISTINCT unnest(COALESCE(languages, '{}') || ARRAY['French']))
      WHERE location_country = 'FR'
      RETURNING COUNT(*)::int AS count
    `.catch(() => [{ count: 0 }]);
    const [byName] = await sql`
      UPDATE experts
      SET languages = array(SELECT DISTINCT unnest(COALESCE(languages, '{}') || ARRAY['French']))
      WHERE name = ANY(${namedExperts})
      RETURNING COUNT(*)::int AS count
    `.catch(() => [{ count: 0 }]);
    const updated = await sql`SELECT id, name, location_country, languages FROM experts WHERE 'French' = ANY(languages) ORDER BY name`;
    return res.status(200).json({ by_country: byCountry?.count, by_name: byName?.count, french_speakers: updated });
  }

  // Global logs
  if (resource === 'logs' && req.method === 'GET') {
    const logs = await sql`
      SELECT publisher, page_url, match_count, no_match_reason, country_code, expert_names, cost_usd, created_at
      FROM match_logs
      WHERE page_url IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `.catch(() => []);
    return res.status(200).json(logs);
  }

  // Delete all match logs for a publisher
  if (resource === 'clear-logs' && req.method === 'POST') {
    const { publisher } = req.body;
    if (!publisher) return res.status(400).json({ error: 'publisher required' });
    const result = await sql`DELETE FROM match_logs WHERE publisher = ${publisher} RETURNING id`;
    return res.status(200).json({ deleted: result.length });
  }

  // Login as publisher - generates a magic link for the admin to open
  if (resource === 'login_as' && req.method === 'POST') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const [pub] = await sql`SELECT slug FROM publishers WHERE email = ${email.toLowerCase()} AND active = true LIMIT 1`;
    if (!pub) return res.status(404).json({ error: 'Publisher not found' });
    const token = await createMagicToken(sql, email.toLowerCase(), 60 * 60 * 1000); // 1-hour link
    return res.status(200).json({ url: `https://www.introlinq.com/api/auth?token=${token}` });
  }

  // Clear no-match cache entries - forces re-scan on next visit
  if (resource === 'clear_nomatch_cache' && req.method === 'POST') {
    const result = await sql`DELETE FROM match_cache WHERE has_match = false AND publisher = '' RETURNING id`.catch(() => []);
    return res.status(200).json({ ok: true, deleted: result.length });
  }

  // Clear all match cache for a publisher - use after changing match settings
  // or to force a full recrawl of their pages (next visit re-scans each page)
  if (resource === 'clear-publisher-cache' && req.method === 'POST') {
    const { publisher } = req.body;
    if (!publisher) return res.status(400).json({ error: 'publisher required' });
    const result = await sql`DELETE FROM match_cache WHERE publisher = ${publisher} RETURNING id`.catch(() => []);
    return res.status(200).json({ ok: true, deleted: result.length });
  }

  // List cached pages (page + country -> stored match result), newest first
  if (resource === 'cache' && req.method === 'GET') {
    const entries = await sql`
      SELECT publisher, page_url, country_code, has_match, confirmed, cached_at
      FROM match_cache
      ORDER BY cached_at DESC
      LIMIT 1000
    `.catch(() => []);
    const [counts] = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE has_match)::int AS matched,
             COUNT(*) FILTER (WHERE NOT has_match AND NOT confirmed)::int AS pending
      FROM match_cache
    `.catch(() => [{ total: 0, matched: 0, pending: 0 }]);
    return res.status(200).json({ total: counts.total, matched: counts.matched, pending: counts.pending, entries });
  }

  // Groups (demo providers)
  if (resource === 'groups') {
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS name TEXT`.catch(() => {});
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false`.catch(() => {});
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS logo_url TEXT`.catch(() => {});
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS website_url TEXT`.catch(() => {});

    if (req.method === 'GET') {
      const groups = await sql`SELECT id, name, slug, logo_url, website_url, COALESCE(is_demo, false) AS is_demo FROM providers ORDER BY is_demo ASC, name ASC`;
      return res.status(200).json(groups);
    }

    if (req.method === 'PATCH') {
      try {
        const { id, name, logo_url, website_url } = req.body || {};
        if (!id || !name) return res.status(400).json({ error: 'id and name required' });
        const [updated] = await sql`
          UPDATE providers SET
            name = ${name},
            logo_url = ${logo_url || null},
            website_url = ${website_url || null}
          WHERE id = ${id}
          RETURNING id, name, slug, logo_url, website_url, is_demo
        `;
        return res.status(200).json(updated);
      } catch (e) {
        console.error('Groups PATCH error:', e);
        return res.status(500).json({ error: e.message || 'Failed to update group' });
      }
    }

    if (req.method === 'POST') {
      try {
        const { name, slug, logo_url, website_url } = req.body || {};
        if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });
        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const [existing] = await sql`SELECT id FROM providers WHERE slug = ${cleanSlug}`;
        if (existing) return res.status(400).json({ error: 'A group with this slug already exists' });
        const [group] = await sql`
          INSERT INTO providers (name, slug, logo_url, website_url, is_demo, connection_type)
          VALUES (${name}, ${cleanSlug}, ${logo_url || null}, ${website_url || null}, true, 'manual')
          RETURNING id, name, slug, logo_url, website_url, is_demo
        `;
        return res.status(200).json(group);
      } catch (e) {
        console.error('Groups POST error:', e);
        return res.status(500).json({ error: e.message || 'Failed to create group' });
      }
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const [prov] = await sql`SELECT slug FROM providers WHERE id = ${id}`;
      if (prov?.slug === 'openintro') return res.status(400).json({ error: 'Cannot delete OpenIntro' });
      await sql`DELETE FROM experts WHERE provider_id = ${id}`;
      await sql`DELETE FROM providers WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
  }

  // Expert headlines — generate + store (works for any expert, not just demo)
  if (resource === 'headlines') {
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS headlines JSONB DEFAULT '{}'`.catch(() => {});

    if (req.method === 'GET') {
      const { provider } = req.query;
      const experts = provider
        ? await sql`SELECT e.id, e.name, e.position, e.company, e.bio, e.topics, e.headlines, p.slug AS provider_slug FROM experts e JOIN providers p ON p.id = e.provider_id WHERE p.slug = ${provider} AND e.active = true ORDER BY e.name ASC`
        : await sql`SELECT e.id, e.name, e.position, e.company, e.bio, e.topics, e.headlines, p.slug AS provider_slug FROM experts e JOIN providers p ON p.id = e.provider_id WHERE e.active = true ORDER BY p.slug ASC, e.name ASC LIMIT 300`;
      return res.status(200).json(experts);
    }

    if (req.method === 'POST') {
      const { expert_id, headline } = req.body;
      if (!expert_id) return res.status(400).json({ error: 'expert_id required' });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

      const [expert] = await sql`SELECT id, name, bio, position, topics FROM experts WHERE id = ${expert_id}`;
      if (!expert) return res.status(404).json({ error: 'Expert not found' });

      let headlineEn = (headline || '').trim();

      if (!headlineEn) {
        const bio = [expert.position, expert.bio, (expert.topics || []).join(', ')].filter(Boolean).join('. ');
        const generated = await callClaude(`Write one short punchy headline for this expert's profile card. Like: "£500m exit", "100+ startup investments", "Built team 0 → 120", "20 years McKinsey". Max 8 words. No punctuation at end. No quotes in your answer.

${expert.name} — ${bio}`);
        headlineEn = generated.trim().replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '');
      }

      const translations = await translateHeadline(headlineEn);
      const headlines = { en: headlineEn, ...translations };

      await sql`UPDATE experts SET headlines = ${JSON.stringify(headlines)}::jsonb WHERE id = ${expert_id}`;
      return res.status(200).json({ ok: true, headlines });
    }
  }

  // Custom experts (demo groups only)
  if (resource === 'experts') {
    if (req.method === 'GET') {
      await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS headlines JSONB DEFAULT '{}'`.catch(() => {});
      const experts = await sql`
        SELECT e.id, e.name, e.position, e.company, e.bio, e.photo_url, e.booking_url,
               e.price_from, e.price_currency, e.active, e.headlines,
               p.name AS provider_name, p.slug AS provider_slug
        FROM experts e
        LEFT JOIN providers p ON p.id = e.provider_id
        WHERE COALESCE(p.is_demo, false) = true
        ORDER BY p.name ASC, e.name ASC
      `;
      return res.status(200).json(experts);
    }

    if (req.method === 'POST') {
      const { name, position, company, bio, photo_url, booking_url, price_from, price_currency = 'GBP', provider_slug } = req.body;
      if (!name || !provider_slug) return res.status(400).json({ error: 'Name and group required' });
      const [provider] = await sql`SELECT id FROM providers WHERE slug = ${provider_slug} AND is_demo = true LIMIT 1`;
      if (!provider) return res.status(400).json({ error: 'Group not found' });
      const [expert] = await sql`
        INSERT INTO experts (name, position, company, bio, photo_url, booking_url, price_from, price_currency, provider_id, active)
        VALUES (${name}, ${position || null}, ${company || null}, ${bio || null},
                ${photo_url || null}, ${booking_url || null}, ${price_from || null}, ${price_currency},
                ${provider.id}, true)
        RETURNING id, name
      `;
      return res.status(200).json(expert);
    }

    if (req.method === 'PATCH') {
      const { id, name, position, company, bio, photo_url, booking_url, price_from, price_currency } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const [check] = await sql`
        SELECT e.id FROM experts e
        LEFT JOIN providers p ON p.id = e.provider_id
        WHERE e.id = ${id} AND COALESCE(p.is_demo, false) = true
      `;
      if (!check) return res.status(400).json({ error: 'Not a demo expert' });
      const [updated] = await sql`
        UPDATE experts SET
          name = ${name},
          position = ${position || null},
          company = ${company || null},
          bio = ${bio || null},
          photo_url = ${photo_url || null},
          booking_url = ${booking_url || null},
          price_from = ${price_from || null},
          price_currency = ${price_currency || 'USD'}
        WHERE id = ${id}
        RETURNING id, name
      `;
      return res.status(200).json(updated);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const [check] = await sql`
        SELECT e.id FROM experts e
        LEFT JOIN providers p ON p.id = e.provider_id
        WHERE e.id = ${id} AND COALESCE(p.is_demo, false) = true
      `;
      if (!check) return res.status(400).json({ error: 'Not a demo expert' });
      await sql`DELETE FROM experts WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(404).json({ error: 'Unknown resource' });
}

// PAYPAL_ENV=live switches to the real API - defaults to sandbox so a
// missing/unset env var can never accidentally move real money.
const PAYPAL_API = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function sendPayPalPayout({ email, amount, currency, note, batchId }) {
  const token = await getPayPalAccessToken();
  const res = await fetch(`${PAYPAL_API}/v1/payments/payouts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: batchId, email_subject: 'You have a payout from IntroLinq', email_message: note },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: amount.toFixed(2), currency },
        receiver: email,
        note,
        sender_item_id: batchId,
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 300));
  return data.batch_header?.payout_batch_id || batchId;
}

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  return d.content?.[0]?.text || '';
}

async function translateHeadline(headline) {
  const text = await callClaude(`Translate this expert headline into 7 languages. Keep it equally punchy and short (max 8 words). Natural tone, not literal.

English: "${headline}"

Return ONLY valid JSON: {"fr":"...","es":"...","de":"...","it":"...","pt":"...","nl":"...","pl":"...","sv":"..."}`);
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch(e) { return {}; }
}

function welcomeEmail(name, link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Welcome, ${name} 👋</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Your IntroLinq dashboard is ready. Click below to access it - this link is valid for 7 days.</p>
    <a href="${link}" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">Access my dashboard →</a>
    <p style="margin:20px 0 0;font-size:0.75rem;color:#8888a8;text-align:center">Once logged in, you'll find your embed code, widget settings, and stats all in one place.</p>
  </div>
</div>
</body></html>`;
}
