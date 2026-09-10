import crypto from 'crypto';

/*
 * /proposal - a single password-gated page (rewrite in vercel.json points
 * /proposal at this function). The gate is server-side on purpose: the deal
 * terms below must not sit in the page source before the password is given,
 * which is all a client-side check would get us.
 *
 * One shared password, set here. On success we drop an HttpOnly cookie whose
 * value is sha256(secret + password) so the raw password never round-trips
 * back in a header. No database, no sessions table - this is a one-reader
 * page, not an account system.
 *
 * Slack alerts mirror the /brief page (see api/admin.js): a password
 * attempt fires one alert, the resulting page view fires another, and the
 * page beacons its open duration back when the tab is hidden/closed. All
 * go to #introlinq-notifications via SLACK_NOTIFICATIONS_WEBHOOK_URL.
 */
const PASSWORD = 'RobP';
const COOKIE = 'il_proposal';
const TOKEN = crypto.createHash('sha256').update('il-proposal-v1:' + PASSWORD).digest('hex');
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hasValidCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(COOKIE + '=([^;]+)'));
  return m ? safeEqual(decodeURIComponent(m[1]), TOKEN) : false;
}

// Same #introlinq-notifications channel / same deliberate await as the
// investor brief (api/admin.js notifySlack) - a serverless function can be
// frozen the instant the response is sent, so a fire-and-forget POST to
// Slack never actually lands. A missing webhook or a Slack outage must
// never break the page, so every error is swallowed.
async function notifySlack(text) {
  if (!process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Slack notify failed:', err);
  }
}

function whereFrom(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const city = req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : '';
  const country = req.headers['x-vercel-ip-country'] || '';
  const place = [city, country].filter(Boolean).join(', ');
  return place ? `IP: ${ip} (${place})` : `IP: ${ip}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const from = whereFrom(req);

  // Beacon from the proposal page itself (navigator.sendBeacon) when the tab
  // is hidden or closed, reporting how long it was open. No auth check - it
  // carries no content, it's a fire-and-forget analytics ping.
  if (req.method === 'POST' && req.query && req.query.ping === 'close') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const seconds = Math.max(0, Math.min(Number(body?.duration) || 0, 86400));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    await notifySlack(`👋 IntroLinq proposal session ended - ${mins}m ${secs}s\n${from}`);
    return res.status(204).end();
  }

  if (req.method === 'POST') {
    let pw = '';
    const b = req.body;
    if (b && typeof b === 'object') pw = b.password || '';
    else if (typeof b === 'string') {
      try { pw = new URLSearchParams(b).get('password') || ''; } catch { pw = ''; }
    }
    const correct = safeEqual(pw, PASSWORD);
    await notifySlack(`🔑 Password ${correct ? 'entered correctly' : 'attempt (wrong)'} on the IntroLinq proposal\n${from}`);
    if (correct) {
      res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
      res.writeHead(303, { Location: '/proposal' });
      return res.end();
    }
    res.writeHead(303, { Location: '/proposal?e=1' });
    return res.end();
  }

  if (req.query && req.query.logout !== undefined) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    res.writeHead(303, { Location: '/proposal' });
    return res.end();
  }

  if (hasValidCookie(req)) {
    await notifySlack(`📄 The IntroLinq proposal page was opened\n${from}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PROPOSAL_HTML);
  }

  const bad = req.query && req.query.e !== undefined;
  if (!bad) await notifySlack(`🔒 The IntroLinq proposal password prompt was shown\n${from}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(bad ? 401 : 200).send(gateHtml(bad));
}

function gateHtml(bad) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Protected &middot; IntroLinq</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#1a1a2e;--ink-soft:#4a4a6a;--ink-muted:#8888a8;--white:#fff;--sage:#3d7a5f;--gold:#e6a820;--border:rgba(26,26,46,0.10)}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;
  background:radial-gradient(72% 60% at 3% -12%,rgba(61,122,95,0.5),transparent 55%),radial-gradient(66% 55% at 106% -4%,rgba(230,168,32,0.44),transparent 52%),linear-gradient(160deg,#efe9de,#e9e2d3)}
.card{background:var(--white);border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 60px rgba(26,26,46,0.16);padding:2.5rem;max-width:400px;width:100%;text-align:center}
.logo{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);text-decoration:none;display:inline-block;margin-bottom:1.5rem}
.logo span{color:var(--sage)}
h1{font-family:'DM Serif Display',serif;font-size:1.375rem;font-weight:400;margin-bottom:0.5rem}
p{font-size:0.875rem;color:var(--ink-soft);line-height:1.6;margin-bottom:1.5rem}
input{width:100%;padding:0.75rem 1rem;border:1.5px solid var(--border);border-radius:10px;font-family:inherit;font-size:0.9375rem;outline:none;transition:border-color 0.15s}
input:focus{border-color:var(--sage)}
button{width:100%;margin-top:0.75rem;background:var(--ink);color:var(--white);border:none;padding:0.75rem 1rem;border-radius:100px;font-family:inherit;font-size:0.9375rem;font-weight:500;cursor:pointer;transition:opacity 0.15s}
button:hover{opacity:0.88}
.err{color:#c0392b;font-size:0.8125rem;margin-top:0.875rem;min-height:1em}
</style>
</head>
<body>
<form class="card" method="POST" action="/proposal">
  <a class="logo" href="/">Intro<span>Linq</span></a>
  <h1>Password required</h1>
  <p>This page is private. Enter the password to continue.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
  <button type="submit">View proposal</button>
  <div class="err">${bad ? 'Incorrect password. Try again.' : ''}</div>
</form>
</body>
</html>`;
}

const PROPOSAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Investment Proposal &middot; IntroLinq</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#1a1a2e;--ink-soft:#4a4a6a;--ink-muted:#8888a8;--cream:#faf8f4;--white:#fff;--sage:#3d7a5f;--sage-light:#edf5f0;--gold:#e6a820;--gold-light:#fef3c7;--border:rgba(26,26,46,0.10);--border-soft:rgba(26,26,46,0.06)}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);line-height:1.65;background:#f0ede6;position:relative}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(72% 60% at 3% -12%,rgba(61,122,95,0.4),transparent 55%),radial-gradient(66% 55% at 106% -4%,rgba(230,168,32,0.36),transparent 52%),linear-gradient(160deg,#efe9de,#e9e2d3)}
.sheet{max-width:780px;margin:3rem auto;background:var(--white);border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 60px rgba(26,26,46,0.12);padding:3.5rem 3.5rem 3rem}
.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:2.25rem}
.logo{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);text-decoration:none}
.logo span{color:var(--sage)}
.tag{font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--gold);border:1px solid var(--gold);border-radius:100px;padding:0.3rem 0.7rem;white-space:nowrap}
h1{font-family:'DM Serif Display',serif;font-size:2rem;font-weight:400;line-height:1.2;margin-bottom:0.5rem}
.meta{font-size:0.875rem;color:var(--ink-muted);margin-bottom:2rem}
h2{font-family:'DM Serif Display',serif;font-size:1.25rem;font-weight:400;margin:2.5rem 0 0.9rem;padding-bottom:0.4rem;border-bottom:1px solid var(--border-soft)}
p{font-size:0.9375rem;color:var(--ink-soft);margin-bottom:0.9rem}
ul,ol{margin:0 0 0.9rem 1.25rem}
li{font-size:0.9375rem;color:var(--ink-soft);margin-bottom:0.5rem}
li strong{color:var(--ink)}
strong{color:var(--ink);font-weight:600}
table{width:100%;border-collapse:collapse;margin:0.5rem 0 1rem;font-size:0.9375rem}
th,td{text-align:left;padding:0.7rem 0.8rem;border-bottom:1px solid var(--border-soft);vertical-align:top}
th{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-muted);font-weight:600}
td:first-child{color:var(--ink);font-weight:500;width:34%}
tr:last-child td{border-bottom:none}
.total td{border-top:2px solid var(--border);font-weight:600;color:var(--ink)}
.callout{background:var(--sage-light);border:1px solid rgba(61,122,95,0.2);border-radius:12px;padding:1rem 1.25rem;margin:1.25rem 0}
.callout p{margin:0;color:var(--ink)}
.note{background:var(--gold-light);border:1px solid rgba(230,168,32,0.35);border-radius:12px;padding:1rem 1.25rem;margin:1.5rem 0 0}
.note p{margin:0;color:#7a5b12;font-size:0.875rem}
.foot{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid var(--border-soft);font-size:0.8125rem;color:var(--ink-muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}
.foot a{color:var(--ink-muted)}
@media (max-width:640px){.sheet{padding:2rem 1.5rem;margin:1rem}h1{font-size:1.6rem}td:first-child{width:40%}}
</style>
</head>
<body>
<div class="sheet">
  <div class="topline">
    <a class="logo" href="/">Intro<span>Linq</span></a>
    <span class="tag">Confidential</span>
  </div>

  <h1>Investment Proposal</h1>
  <p class="meta">Prepared for Rob Pierre &nbsp;&middot;&nbsp; via Robert Rayner &amp; Talveer Atwal, Sarana Capital Partners &nbsp;&middot;&nbsp; 10 September 2026</p>

  <div class="callout">
    <p>Shape of the deal: RP reaches ~20% of IntroLinq - a 16% grant on day one (mirroring his 14.27% OpenIntro holding, rounded up as goodwill), plus ~2% + ~2% from two &pound;50,000 investments at &pound;2.5m and &pound;2.55m post-money caps. Total new cash: &pound;100,000, the second half milestone-gated.</p>
  </div>

  <h2>Headline terms</h2>
  <table>
    <tr><th>Element</th><th>Terms</th></tr>
    <tr><td>Day 1 grant</td><td>16% of IntroLinq issued to RP up front, mirroring his 14.27% OpenIntro holding with the balance offered as goodwill. Not tied to the new cash.</td></tr>
    <tr><td>Tranche 1</td><td>&pound;50,000, unconditional. ASA, transferred monthly as 6 &times; &pound;8,333. &pound;2.5m post-money cap &rarr; ~2%.</td></tr>
    <tr><td>Tranche 2</td><td>&pound;50,000, milestone-gated. Second ASA, drawn in one lump once the milestones are met. &pound;2.55m post-money cap &rarr; ~2%.</td></tr>
    <tr class="total"><td>If both tranches land</td><td>~20% for &pound;100,000 &nbsp;(16% + ~2% + ~2%)</td></tr>
    <tr class="total"><td>If Tranche 2 lapses</td><td>~18% for &pound;50,000 &nbsp;(16% + ~2%)</td></tr>
  </table>

  <h2>Day 1 - the 16% grant</h2>
  <ul>
    <li>RP&rsquo;s holding in OpenIntro is exactly 14.27%. IntroLinq will issue him shares equal to 16%, with the difference offered as goodwill in recognition of his early support.</li>
    <li>Mirrors his OpenIntro position, in respect of equity already contributed there.</li>
    <li>An unpriced grant, separate from the cash, so it does not set or depress IntroLinq&rsquo;s headline valuation.</li>
    <li>Supersedes the earlier idea of a single &pound;100k investment to equalise RP&rsquo;s OpenIntro shares into IntroLinq. Now: 16% grant + &pound;50k guaranteed + &pound;50k conditional.</li>
  </ul>

  <h2>Tranche 1 - &pound;50,000, guaranteed</h2>
  <ul>
    <li>Via ASA. No conditions once the ASA is signed.</li>
    <li>Transferred in 6 monthly instalments of &pound;8,333 (upfront each month). The commitment is unconditional; only the transfer is phased.</li>
    <li>&pound;2.5m post-money cap, or a 20% discount to the next round if that round prices below &pound;2.5m.</li>
    <li>Priced entry works out at 2% (2% &times; &pound;2.5m = &pound;50,000, exact).</li>
  </ul>

  <h2>Tranche 2 - &pound;50,000, milestone-gated</h2>
  <p>Second ASA, &pound;50,000 drawn in one go, subject to all of the following being met by the end of March 2027:</p>
  <ul>
    <li>At least one sales-team resource hired - expected to be offshore, part-time and heavily performance-incentivised, not necessarily a full-time UK employee.</li>
    <li>More than 200 publishers on the platform.</li>
    <li>More than 30 transactions - widened from &ldquo;bookings&rdquo; to &ldquo;transactions&rdquo; so it also captures course sales and other content.</li>
    <li>More than one supplier live on the platform (i.e. not only OpenIntro).</li>
  </ul>
  <ul>
    <li>The milestone period runs through to the end of March 2027, with an optional mid-point review of progress.</li>
    <li>&pound;2.55m post-money cap &rarr; ~2%. (2% &times; &pound;2.55m = &pound;51,000; treat as ~2% for &pound;50,000, with the exact share count set by counsel.)</li>
  </ul>

  <h2>Two funding rounds, back-to-back</h2>
  <ul>
    <li>Tranche 1 and Tranche 2 convert as two separate rounds, not a single conversion event.</li>
    <li>Round 1 at the &pound;2.5m cap; Round 2 at the &pound;2.55m cap.</li>
    <li>Structured this way to keep each tranche SEIS-qualifying.</li>
  </ul>

  <h2>SEIS</h2>
  <ul>
    <li>RP intends to claim SEIS relief on the investment.</li>
    <li>Tranche 1: treated as a single unconditional subscription despite the phased transfer, so it sits under one SEIS long-stop rather than one per instalment.</li>
    <li>Tranche 2: a separate ASA with its own SEIS long-stop running from milestone achievement.</li>
  </ul>

  <h2>Shareholding summary</h2>
  <table>
    <tr><th>Scenario</th><th>RP</th><th>Others</th></tr>
    <tr><td>Both tranches land</td><td>~20%</td><td>~80%</td></tr>
    <tr><td>Tranche 2 lapses</td><td>~18%</td><td>~82%</td></tr>
  </table>
  <p style="font-size:0.8125rem;color:var(--ink-muted)">Illustrative, before any option pool. Exact figures depend on the current cap table and how the pool is handled.</p>

  <div class="foot">
    <span>IntroLinq - Confidential</span>
    <a href="/proposal?logout">Lock this page</a>
  </div>
</div>
<script>
/* Beacon the open duration back when the tab is hidden or closed - same
   idea as the investor brief page. Fire-and-forget; guarded so it only
   sends once per view. */
(function () {
  var start = Date.now(), sent = false;
  function end() {
    if (sent) return; sent = true;
    var s = Math.round((Date.now() - start) / 1000);
    try {
      navigator.sendBeacon('/proposal?ping=close',
        new Blob([JSON.stringify({ duration: s })], { type: 'application/json' }));
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') end();
  });
  window.addEventListener('pagehide', end);
})();
</script>
</body>
</html>`;
