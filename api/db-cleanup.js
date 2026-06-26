import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // Deactivate the hand-seeded placeholder experts (external_id starts with 'oi-')
  const result = await sql`
    UPDATE experts SET active = false
    WHERE external_id LIKE 'oi-%'
    RETURNING id, name
  `;

  return res.status(200).json({ deactivated: result.map(r => r.name) });
}
