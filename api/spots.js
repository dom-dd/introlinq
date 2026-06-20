import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const result = await sql`SELECT COUNT(*)::int AS count FROM subscribers`;
    const taken = result[0].count + 73; // seed: starts at 27 remaining
    const remaining = Math.max(0, 100 - taken);
    return res.status(200).json({ remaining, taken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Could not fetch spots' });
  }
}
