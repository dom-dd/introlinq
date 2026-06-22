import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { viewId, timeSpent } = req.body;
  if (!viewId) return res.status(400).end();

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      UPDATE page_views SET time_spent_seconds = ${Math.round(timeSpent)}
      WHERE id = ${viewId}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).end();
  }
}
