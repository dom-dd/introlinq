import { neon } from '@neondatabase/serverless';

const TEST_MODE = true; // sends all emails to dom@open-intro.com, only for Little Green Agency
const TEST_PUBLISHER = 'little-green-agency';
const TEST_EMAIL = 'dom@open-intro.com';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  const publishers = TEST_MODE
    ? await sql`SELECT * FROM publishers WHERE slug = ${TEST_PUBLISHER} AND active = true`
    : await sql`SELECT * FROM publishers WHERE active = true`;

  const results = [];

  for (const pub of publishers) {
    const slug = pub.slug;
    const email = TEST_MODE ? TEST_EMAIL : pub.email;
    const firstName = pub.contact_first_name || pub.name;

    const [impressions, clicks, topPages, topExperts] = await Promise.all([
      sql`SELECT COUNT(*)::int AS count FROM match_logs WHERE publisher = ${slug} AND created_at >= NOW() - INTERVAL '7 days'`.catch(() => [{ count: 0 }]),
      sql`SELECT COUNT(*)::int AS count FROM click_logs WHERE publisher = ${slug} AND created_at >= NOW() - INTERVAL '7 days'`.catch(() => [{ count: 0 }]),
      sql`SELECT page_url, COUNT(*)::int AS count FROM match_logs WHERE publisher = ${slug} AND created_at >= NOW() - INTERVAL '7 days' AND page_url IS NOT NULL GROUP BY page_url ORDER BY count DESC LIMIT 5`.catch(() => []),
      sql`SELECT expert_name, COUNT(*)::int AS count FROM click_logs WHERE publisher = ${slug} AND created_at >= NOW() - INTERVAL '7 days' AND expert_name IS NOT NULL GROUP BY expert_name ORDER BY count DESC LIMIT 5`.catch(() => []),
    ]);

    const weekImpressions = impressions[0]?.count || 0;
    const weekClicks = clicks[0]?.count || 0;
    const ctr = weekImpressions > 0 ? ((weekClicks / weekImpressions) * 100).toFixed(1) : '0.0';

    const html = buildEmail(firstName, weekImpressions, weekClicks, ctr, topPages, topExperts);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: email,
        subject: `Your IntroLinq weekly report — ${weekImpressions} impressions, ${weekClicks} clicks`,
        html,
      }),
    });

    results.push({ publisher: slug, email, impressions: weekImpressions, clicks: weekClicks, sent: emailRes.ok });
  }

  return res.status(200).json({ sent: results.length, results });
}

function buildEmail(name, impressions, clicks, ctr, topPages, topExperts) {
  const pagesHtml = topPages.length
    ? topPages.map(p => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#1a1a2e;word-break:break-all">${p.page_url.replace(/^https?:\/\//, '')}</td>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#8888a8;text-align:right;white-space:nowrap;padding-left:16px">${p.count} run${p.count !== 1 ? 's' : ''}</td>
        </tr>`).join('')
    : '<tr><td colspan="2" style="padding:8px 0;font-size:13px;color:#8888a8">No data this week</td></tr>';

  const expertsHtml = topExperts.length
    ? topExperts.map(e => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#1a1a2e">${e.expert_name}</td>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;color:#8888a8;text-align:right;padding-left:16px">${e.count} click${e.count !== 1 ? 's' : ''}</td>
        </tr>`).join('')
    : '<tr><td colspan="2" style="padding:8px 0;font-size:13px;color:#8888a8">No clicks this week</td></tr>';

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:24px 32px">
    <div style="font-family:Georgia,serif;font-size:1.2rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
    <div style="color:#8888a8;font-size:13px;margin-top:4px">Weekly report</div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 24px;font-size:15px;color:#1a1a2e">Hi ${name}, here's how your widget performed this week.</p>

    <div style="display:flex;gap:12px;margin-bottom:28px">
      <div style="flex:1;background:#f7f7fb;border-radius:10px;padding:16px 20px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#1a1a2e">${impressions}</div>
        <div style="font-size:12px;color:#8888a8;margin-top:2px">Impressions</div>
      </div>
      <div style="flex:1;background:#f7f7fb;border-radius:10px;padding:16px 20px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#1a1a2e">${clicks}</div>
        <div style="font-size:12px;color:#8888a8;margin-top:2px">Clicks</div>
      </div>
      <div style="flex:1;background:#f7f7fb;border-radius:10px;padding:16px 20px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#e6a820">${ctr}%</div>
        <div style="font-size:12px;color:#8888a8;margin-top:2px">Click rate</div>
      </div>
    </div>

    <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#8888a8;text-transform:uppercase;letter-spacing:.05em">Top pages</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${pagesHtml}</table>

    <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:#8888a8;text-transform:uppercase;letter-spacing:.05em">Most clicked experts</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:28px">${expertsHtml}</table>

    <a href="https://www.introlinq.com/dashboard" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:12px;border-radius:100px;font-size:13px;font-weight:600;text-decoration:none">View full dashboard →</a>
  </div>
  <div style="padding:16px 32px;font-size:11px;color:#8888a8;text-align:center;border-top:1px solid #f0f0f0">
    IntroLinq · You're receiving this because you installed the widget on your site
  </div>
</div>
</body></html>`;
}
