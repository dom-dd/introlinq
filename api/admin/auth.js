export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const allowed = process.env.OWNER_IP?.split(',').map(s => s.trim());
  if (!allowed || !allowed.includes(ip)) {
    return res.status(403).json({ ok: false });
  }
  return res.status(200).json({ ok: true, ip });
}
