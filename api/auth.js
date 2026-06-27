import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

let tableReady = false;

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function ensureTables(sql) {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS magic_links (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    publisher_slug TEXT NOT NULL,
    publisher_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  tableReady = true;
}

export async function createMagicToken(sql, email, expiresInMs) {
  await ensureTables(sql);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInMs);
  await sql`INSERT INTO magic_links (token, email, expires_at) VALUES (${token}, ${email}, ${expiresAt})`;
  return token;
}

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  await ensureTables(sql);

  const { action, token } = req.query;

  // GET ?token=xxx — verify magic link, create session, redirect to dashboard
  if (req.method === 'GET' && token) {
    const [link] = await sql`
      SELECT * FROM magic_links
      WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()
    `;
    if (!link) return res.redirect(302, '/login?error=expired');

    await sql`UPDATE magic_links SET used_at = NOW() WHERE token = ${token}`;

    const [pub] = await sql`SELECT slug, name FROM publishers WHERE email = ${link.email} AND active = true LIMIT 1`;
    if (!pub) return res.redirect(302, '/login?error=notfound');

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await sql`INSERT INTO sessions (token, publisher_slug, publisher_name, expires_at) VALUES (${sessionToken}, ${pub.slug}, ${pub.name}, ${expiresAt})`;

    res.setHeader('Set-Cookie', `il_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.redirect(302, `/dashboard?pub=${pub.slug}`);
  }

  // GET ?action=me — return session info (used by dashboard page on load)
  if (req.method === 'GET' && action === 'me') {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
    const [session] = await sql`
      SELECT publisher_slug, publisher_name FROM sessions
      WHERE token = ${sessionToken} AND expires_at > NOW()
    `;
    if (!session) return res.status(401).json({ error: 'Session expired' });
    return res.status(200).json({ slug: session.publisher_slug, name: session.publisher_name });
  }

  // POST { email } — send login magic link
  if (req.method === 'POST') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalised = email.toLowerCase().trim();

    const [pub] = await sql`SELECT slug FROM publishers WHERE email = ${normalised} AND active = true LIMIT 1`;
    if (!pub) return res.status(200).json({ ok: true }); // Don't reveal whether email exists

    const token = await createMagicToken(sql, normalised, 15 * 60 * 1000);
    const link = `https://www.introlinq.com/api/auth?token=${token}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: normalised,
        subject: 'Your IntroLinq login link',
        html: loginEmail(link),
      })
    });

    return res.status(200).json({ ok: true });
  }

  // DELETE — logout
  if (req.method === 'DELETE') {
    const sessionToken = getSessionToken(req);
    if (sessionToken) await sql`DELETE FROM sessions WHERE token = ${sessionToken}`;
    res.setHeader('Set-Cookie', 'il_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function loginEmail(link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Access your dashboard</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Click the button below to log in. This link expires in 15 minutes and can only be used once.</p>
    <a href="${link}" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">Access my dashboard →</a>
    <p style="margin:20px 0 0;font-size:0.75rem;color:#8888a8;text-align:center">If you didn't request this, you can safely ignore this email.</p>
  </div>
</div>
</body></html>`;
}
