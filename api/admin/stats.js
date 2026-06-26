import { neon } from '@neondatabase/serverless';

function auth(req) {
  return req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.DATABASE_URL);

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
