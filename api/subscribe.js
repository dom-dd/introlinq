import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function normaliseUrl(url) {
  if (!url) return url;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function formatVisitors(val) {
  const map = {
    under_1k: 'Under 1,000',
    '1k_10k': '1,000 – 10,000',
    '10k_50k': '10,000 – 50,000',
    '50k_100k': '50,000 – 100,000',
    '100k_plus': '100,000+',
  };
  return map[val] || val;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, blog, monthly_visitors } = req.body;
  const country = req.headers['x-vercel-ip-country'] || null;

  if (!name || !email || !blog) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const blogUrl = normaliseUrl(blog);

  try {
    // 1. Save to Neon database
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS subscribers (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT NOT NULL UNIQUE,
        blog_url TEXT,
        phone TEXT,
        monthly_visitors TEXT,
        country TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      INSERT INTO subscribers (name, email, blog_url, monthly_visitors, country)
      VALUES (${name}, ${email}, ${blogUrl}, ${monthly_visitors}, ${country || null})
      ON CONFLICT (email) DO NOTHING
    `;

    // 2. Add to Resend Audience
    await resend.contacts.create({
      audienceId: process.env.RESEND_AUDIENCE_ID,
      email,
      firstName: name.split(' ')[0],
      lastName: name.split(' ').slice(1).join(' ') || '',
      unsubscribed: false,
    });

    // 3. Send confirmation email to signup
    await resend.emails.send({
      from: 'IntroLinq <hello@introlinq.com>',
      to: email,
      subject: 'Your spot is saved - welcome to IntroLinq',
      html: confirmationEmail(name),
    });

    // 4. Send alert email to dom
    await resend.emails.send({
      from: 'IntroLinq <hello@introlinq.com>',
      to: 'dom@open-intro.com',
      subject: `New signup: ${name}`,
      html: alertEmail({ name, email, blogUrl, monthly_visitors, country }),
    });

    // 5. Slack notification
    if (process.env.SLACK_WEBHOOK_URL) {
      const flag = country ? ` → :flag-${country.toLowerCase()}:` : '';
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🎉 *New signup: ${name}*${flag}\n• Email: ${email}\n• Blog: ${blogUrl}\n• Monthly visitors: ${formatVisitors(monthly_visitors)}`
        })
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

function confirmationEmail(name) {
  const firstName = name.split(' ')[0];
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid rgba(26,26,46,0.10);overflow:hidden">
        <tr><td style="padding:40px 48px 32px">
          <p style="font-family:Georgia,serif;font-size:24px;color:#1a1a2e;margin:0 0 24px;letter-spacing:-0.02em">Intro<span style="color:#3d7a5f">Linq</span></p>
          <h1 style="font-family:Georgia,serif;font-size:28px;color:#1a1a2e;margin:0 0 16px;line-height:1.2">You're in, ${firstName}.</h1>
          <p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 16px">Your spot is saved. You've locked in the <strong style="color:#1a1a2e">90% commission split!</strong></p>
          <p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 16px">One thing to keep in mind: the 90% rate applies as long as you install IntroLinq <strong style="color:#1a1a2e">within 10 days of us launching</strong>. We'll make sure you have everything you need to do that quickly and easily.</p>
          <p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 16px">We'll be in touch with the next steps as soon as we are ready to launch! In the meantime, if you have any questions just reply to this email and it will be our pleasure to assist.</p>
          <p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 32px">Feel free to share the deal with other bloggers you might know!</p>
          <p style="font-size:15px;color:#1a1a2e;margin:0">Welcome aboard,<br><strong>The IntroLinq team</strong></p>
        </td></tr>
        <tr><td style="background:#faf8f4;padding:24px 48px;border-top:1px solid rgba(26,26,46,0.06)">
          <p style="font-size:12px;color:#8888a8;margin:0;line-height:1.6">IntroLinq · Free forever · No card needed · You can leave anytime</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function alertEmail({ name, email, blogUrl, monthly_visitors, country }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;padding:40px 20px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid rgba(26,26,46,0.10)">
        <tr><td style="padding:40px 48px">
          <h2 style="font-family:Georgia,serif;font-size:22px;color:#1a1a2e;margin:0 0 24px">New IntroLinq signup</h2>
          <table cellpadding="0" cellspacing="0" width="100%">
            <tr><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#8888a8;width:140px">Name</td><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#1a1a2e;font-weight:500">${name}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#8888a8">Email</td><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#1a1a2e;font-weight:500">${email}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#8888a8">Blog</td><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#1a1a2e;font-weight:500">${blogUrl}</td></tr>
            <tr><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#8888a8">Monthly visitors</td><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#1a1a2e;font-weight:500">${formatVisitors(monthly_visitors)}</td></tr>
            <tr><td style="padding:10px 0;font-size:14px;color:#8888a8">Country</td><td style="padding:10px 0;font-size:14px;color:#1a1a2e;font-weight:500">${country || '-'}</td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
