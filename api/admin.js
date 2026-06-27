import { neon } from '@neondatabase/serverless';

function auth(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const allowed = process.env.OWNER_IP?.split(',').map(s => s.trim());
  return allowed && allowed.includes(ip);
}

export default async function handler(req, res) {
  const { resource } = req.query;

  // IP check
  if (resource === 'auth') {
    return res.status(200).json({ ok: auth(req) });
  }

  if (!auth(req)) return res.status(403).json({ error: 'Forbidden' });

  const sql = neon(process.env.DATABASE_URL);

  // Stats
  if (resource === 'stats') {
    const [publishers, experts, subscribers, lastSync] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM publishers WHERE active = true`,
      sql`SELECT COUNT(*)::int AS count FROM experts WHERE active = true`,
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

    if (req.method === 'GET') {
      const publishers = await sql`SELECT * FROM publishers ORDER BY created_at DESC`;
      return res.status(200).json(publishers);
    }

    if (req.method === 'POST') {
      const { name, email, slug, domain, notes } = req.body;
      if (!name || !email || !slug) {
        return res.status(400).json({ error: 'name, email and slug are required' });
      }
      const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      try {
        const [pub] = await sql`
          INSERT INTO publishers (name, email, slug, domain, notes)
          VALUES (${name}, ${email}, ${clean}, ${domain || null}, ${notes || null})
          RETURNING *
        `;
        return res.status(201).json(pub);
      } catch (err) {
        if (err.message.includes('unique')) {
          return res.status(409).json({ error: 'Email or slug already exists' });
        }
        throw err;
      }
    }

    if (req.method === 'PATCH') {
      const { id, active, match_power, match_sensitivity, widget_color, accent_color, widget_size } = req.body;
      const [pub] = await sql`
        UPDATE publishers SET
          active = COALESCE(${active ?? null}, active),
          match_power = COALESCE(${match_power ?? null}, match_power),
          match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
          widget_color = COALESCE(${widget_color ?? null}, widget_color),
          accent_color = COALESCE(${accent_color ?? null}, accent_color),
          widget_size = COALESCE(${widget_size ?? null}, widget_size)
        WHERE id = ${id} RETURNING *
      `;
      return res.status(200).json(pub);
    }
  }

  return res.status(404).json({ error: 'Unknown resource' });
}
