import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { visitor_type } = req.body;
  const country = req.headers['x-vercel-ip-country'] || null;

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS page_views (
        id SERIAL PRIMARY KEY,
        visitor_type TEXT,
        country TEXT,
        time_spent_seconds INT,
        converted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT FALSE`;

    const result = await sql`
      INSERT INTO page_views (visitor_type, country)
      VALUES (${visitor_type}, ${country})
      RETURNING id
    `;
    const viewId = result[0].id;

    if (process.env.SLACK_WEBHOOK_URL) {
      const emoji = visitor_type === 'new' ? '👋' : '🔁';
      const label = visitor_type === 'new' ? 'New visitor' : 'Returning visitor';
      const flag = country ? ` :flag-${country.toLowerCase()}:` : '';
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} *${label}*${flag}\n• Country: ${country || 'Unknown'}`
        })
      });
    }

    return res.status(200).json({ ok: true, viewId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Tracking failed' });
  }
}
