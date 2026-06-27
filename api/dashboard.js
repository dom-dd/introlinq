import { neon } from '@neondatabase/serverless';

let clickTableReady = false;

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function handler(req, res) {
  const { pub, provider } = req.query;
  if (!pub) return res.status(400).json({ error: 'Missing pub' });

  const sql = neon(process.env.DATABASE_URL);

  // POST: click tracking from widget (cross-origin, no session needed)
  if (req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(200).end();

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

  // Click tracking — fired by widget when Book button is clicked
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
    const { match_power, match_sensitivity, widget_color, accent_color, widget_size, enabled_partners } = req.body;
    const [updated] = await sql`
      UPDATE publishers SET
        match_power = COALESCE(${match_power ?? null}, match_power),
        match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
        widget_color = COALESCE(${widget_color ?? null}, widget_color),
        accent_color = COALESCE(${accent_color ?? null}, accent_color),
        widget_size = COALESCE(${widget_size ?? null}, widget_size),
        enabled_partners = COALESCE(${enabled_partners ? sql.array(enabled_partners) : null}, enabled_partners)
      WHERE slug = ${pub} AND active = true
      RETURNING match_power, match_sensitivity, widget_color, accent_color, widget_size, enabled_partners
    `;
    return res.status(200).json(updated);
  }

  if (req.method === 'GET') {
    // Expert list for a specific provider
    if (provider) {
      const experts = await sql`
        SELECT id, name, position, company, topics, photo_url, booking_url, price_from, location_country
        FROM experts WHERE active = true ORDER BY name ASC
      `;
      return res.status(200).json({ experts });
    }

    // Ensure enabled_partners column exists
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS enabled_partners TEXT[] DEFAULT ARRAY['openintro']`;
    // Ensure providers have a name column
    await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS name TEXT`;
    await sql`UPDATE providers SET name = 'OpenIntro' WHERE slug = 'openintro' AND name IS NULL`;

    const [publisher] = await sql`
      SELECT id, name, slug, domain, created_at,
             match_power, match_sensitivity, widget_color, accent_color, widget_size,
             COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners
      FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
    `;

    if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

    const [logs, clickData, providers, expertCounts] = await Promise.all([
      sql`SELECT phrases, expert_names, match_count, created_at FROM match_logs WHERE publisher = ${pub} ORDER BY created_at DESC LIMIT 20`,
      sql`SELECT COUNT(*)::int AS total FROM click_logs WHERE publisher = ${pub}`.catch(() => [{ total: 0 }]),
      sql`SELECT slug, COALESCE(name, slug) AS name FROM providers ORDER BY slug`,
      sql`SELECT COUNT(*)::int AS count FROM experts WHERE active = true`,
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
      partners: partnersWithStatus,
    });
  }

  return res.status(405).end();
}
