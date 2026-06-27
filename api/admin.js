import { neon } from '@neondatabase/serverless';
import { createMagicToken } from './auth.js';

function auth(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  const allowed = process.env.OWNER_IP?.split(',').map(s => s.trim());
  return allowed && allowed.includes(ip);
}

export default async function handler(req, res) {
  const { resource } = req.query;

  // IP check
  if (resource === 'auth') {
    return res.status(200).json({ ok: auth(req) });
  }

  if (!auth(req)) return res.status(403).json({ error: 'Forbidden' });

  const sql = neon(process.env.DATABASE_URL);

  // Stats
  if (resource === 'stats') {
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

  // Publishers
  if (resource === 'publishers') {
    await sql`
      CREATE TABLE IF NOT EXISTS publishers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        domain TEXT,
        notes TEXT,
        active BOOLEAN DEFAULT true,
        match_power TEXT DEFAULT 'moderate',
        match_sensitivity TEXT DEFAULT 'balanced',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS match_power TEXT DEFAULT 'moderate'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS match_sensitivity TEXT DEFAULT 'balanced'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_color TEXT DEFAULT '#e6a820'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT '#e6a820'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_size TEXT DEFAULT 'medium'`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS contact_first_name TEXT`;
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS contact_last_name TEXT`;

    if (req.method === 'GET') {
      const publishers = await sql`SELECT * FROM publishers ORDER BY created_at DESC`;
      const [matchStats, clickStats] = await Promise.all([
        sql`SELECT publisher, COUNT(*)::int AS impressions FROM match_logs GROUP BY publisher`.catch(() => []),
        sql`SELECT publisher, COUNT(*)::int AS clicks FROM click_logs GROUP BY publisher`.catch(() => []),
      ]);
      const matchMap = Object.fromEntries(matchStats.map(r => [r.publisher, r.impressions]));
      const clickMap = Object.fromEntries(clickStats.map(r => [r.publisher, r.clicks]));
      const result = publishers.map(p => ({
        ...p,
        impressions: matchMap[p.slug] || 0,
        clicks: clickMap[p.slug] || 0,
      }));
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      const { name, email, slug, domain, notes, contact_first_name, contact_last_name } = req.body;
      if (!name || !email || !slug) {
        return res.status(400).json({ error: 'name, email and slug are required' });
      }
      const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      try {
        const [pub] = await sql`
          INSERT INTO publishers (name, email, slug, domain, notes, contact_first_name, contact_last_name)
          VALUES (${name}, ${email}, ${clean}, ${domain || null}, ${notes || null}, ${contact_first_name || null}, ${contact_last_name || null})
          RETURNING *
        `;

        // Send welcome email with magic link (7-day expiry)
        const firstName = contact_first_name || name;
        createMagicToken(sql, email.toLowerCase(), 7 * 24 * 60 * 60 * 1000).then(token => {
          const link = `https://www.introlinq.com/api/auth?token=${token}`;
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'IntroLinq <hello@introlinq.com>',
              to: email,
              subject: `Welcome to IntroLinq, ${firstName} — your dashboard is ready`,
              html: welcomeEmail(firstName, link),
            })
          });
        }).catch(err => console.error('Welcome email failed:', err));

        return res.status(201).json(pub);
      } catch (err) {
        if (err.message.includes('unique')) {
          return res.status(409).json({ error: 'Email or slug already exists' });
        }
        throw err;
      }
    }

    if (req.method === 'PATCH') {
      const { id, active, match_power, match_sensitivity, widget_color, accent_color, widget_size } = req.body;
      const [pub] = await sql`
        UPDATE publishers SET
          active = COALESCE(${active ?? null}, active),
          match_power = COALESCE(${match_power ?? null}, match_power),
          match_sensitivity = COALESCE(${match_sensitivity ?? null}, match_sensitivity),
          widget_color = COALESCE(${widget_color ?? null}, widget_color),
          accent_color = COALESCE(${accent_color ?? null}, accent_color),
          widget_size = COALESCE(${widget_size ?? null}, widget_size)
        WHERE id = ${id} RETURNING *
      `;
      return res.status(200).json(pub);
    }

    if (req.method === 'DELETE') {
      const { id } = req.body;
      const [pub] = await sql`SELECT slug, email FROM publishers WHERE id = ${id}`;
      if (!pub) return res.status(404).json({ error: 'Publisher not found' });
      await Promise.all([
        sql`DELETE FROM publishers WHERE id = ${id}`,
        sql`DELETE FROM match_logs WHERE publisher = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM click_logs WHERE publisher = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM sessions WHERE publisher_slug = ${pub.slug}`.catch(() => {}),
        sql`DELETE FROM magic_links WHERE email = ${pub.email}`.catch(() => {}),
      ]);
      return res.status(200).json({ ok: true });
    }
  }

  // Login as publisher — generates a magic link for the admin to open
  if (resource === 'login_as' && req.method === 'POST') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const [pub] = await sql`SELECT slug FROM publishers WHERE email = ${email.toLowerCase()} AND active = true LIMIT 1`;
    if (!pub) return res.status(404).json({ error: 'Publisher not found' });
    const token = await createMagicToken(sql, email.toLowerCase(), 60 * 60 * 1000); // 1-hour link
    return res.status(200).json({ url: `https://www.introlinq.com/api/auth?token=${token}` });
  }

  return res.status(404).json({ error: 'Unknown resource' });
}

function welcomeEmail(name, link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Welcome, ${name} 👋</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Your IntroLinq dashboard is ready. Click below to access it — this link is valid for 7 days.</p>
    <a href="${link}" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">Access my dashboard →</a>
    <p style="margin:20px 0 0;font-size:0.75rem;color:#8888a8;text-align:center">Once logged in, you'll find your embed code, widget settings, and stats all in one place.</p>
  </div>
</div>
</body></html>`;
}
