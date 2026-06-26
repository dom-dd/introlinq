export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const candidates = [
    'Expert', 'expert', 'Experts', 'experts',
    'Expert profile', 'Expert_profile', 'ExpertProfile',
    'OpenIntro Expert', 'Profile', 'profile', 'User'
  ];

  const results = {};
  for (const name of candidates) {
    const res2 = await fetch(
      `https://open-intro.com/api/1.1/obj/${encodeURIComponent(name)}?limit=1`,
      { headers: { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` } }
    );
    const data = await res2.json();
    if (res2.ok) {
      return res.status(200).json({ found: name, data });
    }
    results[name] = data?.body?.message || data?.message || res2.status;
  }

  return res.status(404).json({ error: 'No matching type found', tried: results });
}
