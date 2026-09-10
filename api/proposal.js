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

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'POST') {
    let pw = '';
    const b = req.body;
    if (b && typeof b === 'object') pw = b.password || '';
    else if (typeof b === 'string') {
      try { pw = new URLSearchParams(b).get('password') || ''; } catch { pw = ''; }
    }
    if (safeEqual(pw, PASSWORD)) {
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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PROPOSAL_HTML);
  }

  const bad = req.query && req.query.e !== undefined;
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
.sheet{max-width:760px;margin:3rem auto;background:var(--white);border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 60px rgba(26,26,46,0.12);padding:3.5rem 3.5rem 3rem}
.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:2.25rem}
.logo{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);text-decoration:none}
.logo span{color:var(--sage)}
.tag{font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--gold);border:1px solid var(--gold);border-radius:100px;padding:0.3rem 0.7rem}
h1{font-family:'DM Serif Display',serif;font-size:2rem;font-weight:400;line-height:1.2;margin-bottom:0.5rem}
.meta{font-size:0.875rem;color:var(--ink-muted);margin-bottom:2rem}
h2{font-family:'DM Serif Display',serif;font-size:1.25rem;font-weight:400;margin:2.5rem 0 0.9rem;padding-bottom:0.4rem;border-bottom:1px solid var(--border-soft)}
p{font-size:0.9375rem;color:var(--ink-soft);margin-bottom:0.9rem}
ul,ol{margin:0 0 0.9rem 1.25rem}
li{font-size:0.9375rem;color:var(--ink-soft);margin-bottom:0.45rem}
strong{color:var(--ink);font-weight:600}
table{width:100%;border-collapse:collapse;margin:0.5rem 0 1rem;font-size:0.9375rem}
th,td{text-align:left;padding:0.65rem 0.75rem;border-bottom:1px solid var(--border-soft);vertical-align:top}
th{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-muted);font-weight:600}
td:first-child{color:var(--ink);font-weight:500;width:38%}
tr:last-child td{border-bottom:none}
.total td{border-top:2px solid var(--border);font-weight:600;color:var(--ink)}
.callout{background:var(--sage-light);border:1px solid rgba(61,122,95,0.2);border-radius:12px;padding:1rem 1.25rem;margin:1.25rem 0}
.callout p{margin:0;color:var(--ink)}
.note{background:var(--gold-light);border:1px solid rgba(230,168,32,0.35);border-radius:12px;padding:1rem 1.25rem;margin:1.25rem 0}
.note p{margin:0;color:#7a5b12;font-size:0.875rem}
.foot{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--border-soft);font-size:0.8125rem;color:var(--ink-muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}
.foot a{color:var(--ink-muted)}
@media (max-width:640px){.sheet{padding:2rem 1.5rem;margin:1rem}h1{font-size:1.6rem}}
</style>
</head>
<body>
<div class="sheet">
  <div class="topline">
    <a class="logo" href="/">Intro<span>Linq</span></a>
    <span class="tag">Confidential</span>
  </div>

  <h1>Investment Proposal</h1>
  <p class="meta">Prepared for Rob P &nbsp;&middot;&nbsp; 10 September 2026 &nbsp;&middot;&nbsp; Draft for discussion &mdash; not a binding offer</p>

  <p>This summarises the terms reached in correspondence. It is a working reference to take into the subscription and shareholders' agreement, not the definitive document. Figures in <strong>&pound;</strong> sterling.</p>

  <h2>Headline terms</h2>
  <table>
    <tr><th>Item</th><th>Terms</th></tr>
    <tr><td>Initial stake</td><td>16% equity, granted up front on completion</td></tr>
    <tr><td>Phase 1 investment</td><td>&pound;50,000 for a further 2%, at a &pound;2,500,000 post-money valuation</td></tr>
    <tr><td>Phase 2 investment</td><td>&pound;50,000 for a further 2%, at a &pound;2,550,000 post-money valuation</td></tr>
    <tr class="total"><td>Total to investor</td><td>20% equity for &pound;100,000 cash (phased)</td></tr>
  </table>

  <h2>How the stake builds</h2>
  <ol>
    <li><strong>On completion &mdash; 16%.</strong> Rob P is issued 16% of the company up front.</li>
    <li><strong>Phase 1 &mdash; +2% to 18%.</strong> Rob P invests <strong>&pound;50,000</strong> at a <strong>&pound;2.5m post-money</strong> valuation for a further 2%.</li>
    <li><strong>Phase 2 &mdash; +2% to 20%.</strong> A second <strong>&pound;50,000</strong> at a <strong>&pound;2.55m post-money</strong> valuation for a further 2%, bringing the total holding to <strong>20%</strong>.</li>
  </ol>

  <div class="callout">
    <p><strong>Net result:</strong> Rob P ends on <strong>20%</strong>, the company takes in <strong>&pound;100,000</strong> of new cash across the two phases, and the second-phase money comes in at a valuation <strong>&pound;50,000 higher</strong> than the first.</p>
  </div>

  <h2>Valuation check</h2>
  <ul>
    <li>Phase 1 is exact: 2% &times; &pound;2,500,000 = &pound;50,000.</li>
    <li>Phase 2 as described gives 2% &times; &pound;2,550,000 = &pound;51,000. Treat it as <strong>~2% for &pound;50,000</strong> and let the lawyers pin the exact share count &mdash; the intent is a modest step-up between phases, not a precise number.</li>
  </ul>

  <h2>Open points to confirm before papering</h2>
  <p>These were not settled in the summary provided and need to be nailed down in the agreement:</p>
  <ul>
    <li><strong>Consideration for the initial 16%</strong> &mdash; cash on completion, advisory/services, or other. Not stated in the thread.</li>
    <li><strong>Instrument</strong> &mdash; direct share subscription now, or a SAFE/ASA converting later.</li>
    <li><strong>Triggers and long-stop dates</strong> for the Phase 1 and Phase 2 tranches &mdash; what unlocks each &pound;50,000, and by when.</li>
    <li><strong>Basis of the percentages</strong> &mdash; fully diluted or not, and how any option pool is created and counted.</li>
    <li><strong>Investor rights</strong> &mdash; board seat or observer, information rights, pro-rata, anti-dilution.</li>
    <li><strong>Founder terms</strong> &mdash; vesting, leaver provisions, warranties, confidentiality, any exclusivity period.</li>
  </ul>

  <h2>Indicative cap table &mdash; after Phase 2</h2>
  <table>
    <tr><th>Holder</th><th>Stake</th></tr>
    <tr><td>Rob P</td><td>20%</td></tr>
    <tr><td>Founder &amp; existing holders</td><td>80%</td></tr>
  </table>
  <p style="font-size:0.8125rem;color:var(--ink-muted)">Illustrative, pre option-pool. Exact figures depend on the current cap table and how the pool is handled.</p>

  <h2>Next steps</h2>
  <ol>
    <li>Confirm the open points above.</li>
    <li>Instruct solicitors to draft the subscription &amp; shareholders' agreement.</li>
    <li>Board approval and shareholder consents for the allotment.</li>
    <li>Complete the initial 16%; Phase 1 and Phase 2 follow on their agreed triggers.</li>
  </ol>

  <div class="note">
    <p>Drafted from a short summary of the agreed terms, not the full correspondence. Once the email chain is to hand, this page should be checked line by line against it.</p>
  </div>

  <div class="foot">
    <span>IntroLinq &mdash; Confidential. Do not distribute.</span>
    <a href="/proposal?logout">Lock this page</a>
  </div>
</div>
</body>
</html>`;
