import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

let clickTableReady = false;

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function handler(req, res) {
  const { pub, provider, action } = req.query;
  if (!pub && action !== 'booking') return res.status(400).json({ error: 'Missing pub' });

  const sql = neon(process.env.DATABASE_URL);

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
    const resolvedExpert = expert_name || click?.expert_name || 'an expert';
    const articleUrl = click?.article_url || null;
    const articleTitle = click?.article_title || null;

    if (!test) {
      // Store booking
      await sql`CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY, publisher TEXT, expert_id INT, expert_name TEXT,
        booking_amount DECIMAL, currency TEXT, publisher_payout DECIMAL,
        click_id TEXT, article_url TEXT, article_title TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`.catch(() => {});

      await sql`
        INSERT INTO bookings (publisher, expert_id, expert_name, booking_amount, currency, publisher_payout, click_id, article_url, article_title)
        VALUES (${publisherSlug}, ${expert_id || null}, ${resolvedExpert}, ${booking_amount}, ${currency}, ${payout}, ${click_id || null}, ${articleUrl}, ${articleTitle})
      `;

      // Email publisher
      if (publisher.payment_email && process.env.RESEND_API_KEY) {
        const articleLine = articleTitle
          ? `\n\nThe booking came from your article: ${articleTitle}${articleUrl ? `\n${articleUrl}` : ''}`
          : '';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'IntroLinq <notifications@introlinq.com>',
            to: publisher.payment_email,
            subject: `You earned ${currency} ${payout.toFixed(2)} - new booking on your site`,
            text: `Hi ${publisher.name},\n\nA reader on your site just booked a session with ${resolvedExpert}.\n\nBooking value: ${currency} ${Number(booking_amount).toFixed(2)}\nYour commission (${Math.round(publisher.revenue_share * 100)}%): ${currency} ${payout.toFixed(2)}${articleLine}\n\nThis will be included in your next payout.\n\nBest,\nThe IntroLinq team`,
          }),
        }).catch(err => console.error('Booking email failed:', err));
      }
    }

    // Slack - always fires, marked [TEST] when in test mode
    if (process.env.SLACK_WEBHOOK_URL) {
      const testTag = test ? ' · *[TEST]*' : '';
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `💰 *New booking*${testTag} - ${resolvedExpert} · ${currency} ${Number(booking_amount).toFixed(2)} · ${publisher.name} · Payout: ${currency} ${payout.toFixed(2)}${articleTitle ? ` · _${articleTitle}_` : ''}` }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, test: !!test, publisher_payout: payout, publisher: publisherSlug, expert: resolvedExpert });
  }

  // Public redirect - routes Book button through IntroLinq before sending to partner
  if (req.method === 'GET' && action === 'out') {
    const { expert_id, expert_name, expert_url, article, phrase, lang, tz, device, source, title } = req.query;
    if (!expert_url) return res.status(400).json({ error: 'Missing expert_url' });

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
    ]);

    await sql`INSERT INTO click_logs (publisher, expert_id, expert_name, click_id, article_url, article_title, phrase, lang, timezone, device, traffic_source)
      VALUES (${pub}, ${expert_id || null}, ${expert_name || null}, ${click_id}, ${article || null},
              ${title || null}, ${phrase || null}, ${lang || null}, ${tz || null}, ${device || null}, ${source || null})
    `.catch(() => {});

    // Build partner URL with full attribution params
    try {
      const dest = new URL(decodeURIComponent(expert_url));
      dest.searchParams.set('ref', 'introlinq');
      dest.searchParams.set('aid', pub);
      dest.searchParams.set('click_id', click_id);
      if (lang) dest.searchParams.set('lang', lang);
      if (article) dest.searchParams.set('campaign', decodeURIComponent(article).slice(0, 200));
      return res.redirect(302, dest.toString());
    } catch {
      return res.redirect(302, decodeURIComponent(expert_url));
    }
  }

  // CORS for widget click tracking (cross-origin POST)
  if (req.method === 'POST' || req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
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

  if (req.method === 'PATCH') {
    const { match_power, match_sensitivity, widget_color, accent_color, widget_size, enabled_partners, payment_email, active, carousel_title } = req.body;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS carousel_title TEXT`.catch(() => {});
    const [updated] = await sql`
      UPDATE publishers SET
        match_power = COALESCE(${match_power ?? null}, match_power),
        match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
        widget_color = COALESCE(${widget_color ?? null}, widget_color),
        accent_color = COALESCE(${accent_color ?? null}, accent_color),
        widget_size = COALESCE(${widget_size ?? null}, widget_size),
        enabled_partners = COALESCE(${enabled_partners ? sql.array(enabled_partners) : null}, enabled_partners),
        payment_email = COALESCE(${payment_email ?? null}, payment_email),
        active = COALESCE(${active ?? null}, active),
        carousel_title = COALESCE(${carousel_title ?? null}, carousel_title)
      WHERE slug = ${pub} AND active = true
      RETURNING match_power, match_sensitivity, widget_color, accent_color, widget_size, enabled_partners, payment_email, active, carousel_title
    `;
    // Clear match cache if matching settings changed so new settings take effect immediately
    if (match_power != null || match_sensitivity != null || enabled_partners != null) {
      await sql`DELETE FROM match_cache WHERE publisher = ${pub}`.catch(() => {});
    }
    return res.status(200).json(updated);
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
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS carousel_title TEXT`.catch(() => {});
    // Ensure providers have a name column
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS name TEXT`;
    await sql`UPDATE providers SET name = 'OpenIntro' WHERE slug = 'openintro' AND name IS NULL`;
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS page_url TEXT`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS expert_booking_urls TEXT[]`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS no_match_reason TEXT`.catch(() => {});

    const [publisher] = await sql`
      SELECT id, name, slug, domain, created_at,
             match_power, match_sensitivity, widget_color, accent_color, widget_size,
             COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners,
             COALESCE(revenue_share, 0.70) AS revenue_share,
             payment_email, carousel_title
      FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
    `;

    if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

    const [bookingCountRow, payoutByCurrency, bookingRows] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM bookings WHERE publisher = ${pub}`.catch(() => [{ count: 0 }]),
      sql`SELECT currency, COALESCE(SUM(publisher_payout),0)::float AS payout FROM bookings WHERE publisher = ${pub} GROUP BY currency ORDER BY payout DESC`.catch(() => []),
      sql`SELECT expert_name, booking_amount, currency, publisher_payout, created_at FROM bookings WHERE publisher = ${pub} ORDER BY created_at DESC LIMIT 50`.catch(() => []),
    ]);
    const bookingSummary = { count: bookingCountRow[0]?.count || 0, by_currency: payoutByCurrency, rows: bookingRows };

    const [logs, clickData, providers, expertCounts, totalImpressions,
           clicksByDay, impressionsByDay, clicksByWeek, impressionsByWeek,
           clicksByMonth, impressionsByMonth,
           topPhrases, topSources, topDevices, pageUrls] = await Promise.all([
      sql`SELECT phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, created_at FROM match_logs WHERE publisher = ${pub} AND page_url IS NOT NULL ORDER BY created_at DESC LIMIT 50`.catch(() => []),
      sql`SELECT COUNT(*)::int AS total FROM click_logs WHERE publisher = ${pub}`.catch(() => [{ total: 0 }]),
      sql`SELECT slug, COALESCE(name, slug) AS name FROM providers WHERE is_demo IS NOT TRUE ORDER BY slug`,
      sql`SELECT COUNT(*)::int AS count FROM experts WHERE active = true`,
      sql`SELECT COUNT(*)::int AS total FROM match_logs WHERE publisher = ${pub} AND match_count > 0`.catch(() => [{ total: 0 }]),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('day', created_at)::date AS date, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND created_at > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT DATE_TRUNC('week', created_at)::date AS week_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY week_start ORDER BY week_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YY') AS month, DATE_TRUNC('month', created_at) AS month_start, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND created_at > NOW() - INTERVAL '12 months' GROUP BY month_start, month ORDER BY month_start`.catch(() => []),
      sql`SELECT phrase, COUNT(*)::int AS clicks FROM click_logs WHERE publisher = ${pub} AND phrase IS NOT NULL AND phrase != '' GROUP BY phrase ORDER BY clicks DESC LIMIT 5`.catch(() => []),
      sql`SELECT traffic_source AS source, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND traffic_source IS NOT NULL GROUP BY traffic_source ORDER BY count DESC`.catch(() => []),
      sql`SELECT device, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${pub} AND device IS NOT NULL GROUP BY device ORDER BY count DESC`.catch(() => []),
      sql`SELECT page_url, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${pub} AND match_count > 0 AND page_url IS NOT NULL GROUP BY page_url ORDER BY count DESC LIMIT 100`.catch(() => []),
    ]);

    const partnersWithStatus = providers.map(p => ({
      slug: p.slug,
      name: p.name,
      expert_count: expertCounts[0]?.count || 0,
      enabled: (publisher.enabled_partners || ['openintro']).includes(p.slug),
    }));

    return res.status(200).json({
      publisher,
      logs,
      clicks: clickData[0]?.total || 0,
      total_impressions: totalImpressions[0]?.total || 0,
      partners: partnersWithStatus,
      bookings: bookingSummary,
      clicks_by_day: clicksByDay,
      impressions_by_day: impressionsByDay,
      clicks_by_week: clicksByWeek,
      impressions_by_week: impressionsByWeek,
      clicks_by_month: clicksByMonth,
      impressions_by_month: impressionsByMonth,
      top_phrases: topPhrases,
      traffic_sources: topSources,
      devices: topDevices,
      page_urls: pageUrls,
    });
  }

  return res.status(405).end();
}
