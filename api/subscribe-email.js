import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;
  const country = req.headers['x-vercel-ip-country'] || null;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`ALTER TABLE subscribers ALTER COLUMN name DROP NOT NULL`.catch(() => {});
    await sql`ALTER TABLE subscribers ALTER COLUMN blog_url DROP NOT NULL`.catch(() => {});
    await sql`
      INSERT INTO subscribers (name, email, blog_url, monthly_visitors, country)
      VALUES (null, ${email}, null, null, ${country || null})
      ON CONFLICT (email) DO NOTHING
    `;

    await resend.contacts.create({
      audienceId: process.env.RESEND_AUDIENCE_ID,
      email,
      unsubscribed: false,
    });

    await resend.emails.send({
      from: 'IntroLinq <hello@introlinq.com>',
      to: email,
      subject: 'Your spot is saved - welcome to IntroLinq',
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;padding:40px 20px"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid rgba(26,26,46,0.10);overflow:hidden"><tr><td style="padding:40px 48px 32px"><p style="font-family:Georgia,serif;font-size:24px;color:#1a1a2e;margin:0 0 24px;letter-spacing:-0.02em">Intro<span style="color:#3d7a5f">Linq</span></p><h1 style="font-family:Georgia,serif;font-size:28px;color:#1a1a2e;margin:0 0 16px;line-height:1.2">You're in.</h1><p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 16px">Your spot is saved. You've locked in the <strong style="color:#1a1a2e">90% commission split!</strong></p><p style="font-size:16px;color:#4a4a6a;line-height:1.75;margin:0 0 16px">We'll be in touch with next steps as soon as we're ready to launch. If you have any questions just reply to this email.</p><p style="font-size:15px;color:#1a1a2e;margin:0">Welcome aboard,<br><strong>The IntroLinq team</strong></p></td></tr><tr><td style="background:#faf8f4;padding:24px 48px;border-top:1px solid rgba(26,26,46,0.06)"><p style="font-size:12px;color:#8888a8;margin:0;line-height:1.6">IntroLinq · Free forever · No card needed · You can leave anytime</p></td></tr></table></td></tr></table></body></html>`,
    });

    await resend.emails.send({
      from: 'IntroLinq <hello@introlinq.com>',
      to: 'dom@open-intro.com',
      subject: `New email signup: ${email}`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;padding:40px 20px"><tr><td align="center"><table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid rgba(26,26,46,0.10)"><tr><td style="padding:40px 48px"><h2 style="font-family:Georgia,serif;font-size:22px;color:#1a1a2e;margin:0 0 24px">New exit popup signup</h2><table cellpadding="0" cellspacing="0" width="100%"><tr><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#8888a8;width:140px">Email</td><td style="padding:10px 0;border-bottom:1px solid rgba(26,26,46,0.06);font-size:14px;color:#1a1a2e;font-weight:500">${email}</td></tr><tr><td style="padding:10px 0;font-size:14px;color:#8888a8">Country</td><td style="padding:10px 0;font-size:14px;color:#1a1a2e;font-weight:500">${country || '-'}</td></tr></table></td></tr></table></td></tr></table></body></html>`,
    });

    if (process.env.SLACK_WEBHOOK_URL) {
      const flag = country ? ` → :flag-${country.toLowerCase()}:` : '';
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `📧 *Exit popup signup*${flag}\n• Email: ${email}` })
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
