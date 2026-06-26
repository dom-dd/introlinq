export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const response = await fetch('https://open-intro.com/api/1.1/obj/expert?limit=2', {
    headers: { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` }
  });

  const data = await response.json();
  return res.status(response.status).json(data);
}
