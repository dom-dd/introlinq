import { neon } from '@neondatabase/serverless';

function auth(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const allowed = process.env.OWNER_IP?.split(',').map(s => s.trim());
  return allowed && allowed.includes(ip);
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS publishers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      domain TEXT,
      notes TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

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
    const { id, active } = req.body;
    const [pub] = await sql`
      UPDATE publishers SET active = ${active} WHERE id = ${id} RETURNING *
    `;
    return res.status(200).json(pub);
  }

  return res.status(405).end();
}
