import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { pub } = req.query;
  if (!pub) return res.status(400).json({ error: 'Missing pub' });

  const sql = neon(process.env.DATABASE_URL);

  const [publishers] = await sql`
    SELECT id, name, slug, domain, created_at FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
  `;

  if (!publishers) return res.status(404).json({ error: 'Publisher not found' });

  const logs = await sql`
    SELECT phrases, expert_names, match_count, created_at
    FROM match_logs
    WHERE publisher = ${pub}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return res.status(200).json({ publisher: publishers, logs });
}
