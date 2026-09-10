import crypto from 'crypto';

/*
 * /artifact - a single password-gated page (rewrite in vercel.json points
 * /artifact at this function). Same shape as /proposal (api/proposal.js):
 * the gate is server-side so the doc never sits in page source before the
 * password is given, one shared password set here, an HttpOnly cookie whose
 * value is sha256(secret + password) so the raw password never round-trips
 * back in a header. No database, no sessions table.
 *
 * Slack alerts mirror /proposal: a password attempt fires one alert, the
 * resulting page view fires another, and the page beacons its open duration
 * back when the tab is hidden/closed. All go to #introlinq-notifications via
 * SLACK_NOTIFICATIONS_WEBHOOK_URL.
 */
const PASSWORD = 'NolanD';
const COOKIE = 'il_artifact';
const TOKEN = crypto.createHash('sha256').update('il-artifact-v1:' + PASSWORD).digest('hex');
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days

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

// Same #introlinq-notifications channel / same deliberate await as
// api/proposal.js - a serverless function can be frozen the instant the
// response is sent, so a fire-and-forget POST to Slack never lands. A
// missing webhook or a Slack outage must never break the page.
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

  // Beacon from the page itself (navigator.sendBeacon) when the tab is
  // hidden or closed, reporting how long it was open. No auth check - it
  // carries no content, it's a fire-and-forget analytics ping.
  if (req.method === 'POST' && req.query && req.query.ping === 'close') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const seconds = Math.max(0, Math.min(Number(body?.duration) || 0, 86400));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    await notifySlack(`👋 IntroLinq partner map session ended - ${mins}m ${secs}s\n${from}`);
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
    await notifySlack(`🔑 Password ${correct ? 'entered correctly' : 'attempt (wrong)'} on the IntroLinq partner map\n${from}`);
    if (correct) {
      res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
      res.writeHead(303, { Location: '/artifact' });
      return res.end();
    }
    res.writeHead(303, { Location: '/artifact?e=1' });
    return res.end();
  }

  if (req.query && req.query.logout !== undefined) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    res.writeHead(303, { Location: '/artifact' });
    return res.end();
  }

  if (hasValidCookie(req)) {
    await notifySlack(`🧭 The IntroLinq partner map was opened\n${from}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(ARTIFACT_HTML);
  }

  const bad = req.query && req.query.e !== undefined;
  if (!bad) await notifySlack(`🔒 The IntroLinq partner map password prompt was shown\n${from}`);
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
<form class="card" method="POST" action="/artifact">
  <a class="logo" href="/">Intro<span>Linq</span></a>
  <h1>Password required</h1>
  <p>This page is private. Enter the password to continue.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
  <button type="submit">View the map</button>
  <div class="err">${bad ? 'Incorrect password. Try again.' : ''}</div>
</form>
</body>
</html>`;
}

const ARTIFACT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Expert-Supply Partner Map &middot; IntroLinq</title>
<meta name="description" content="Which blog verticals have viable bookable-expert or affiliate supply for IntroLinq - model, economics, integration cost, and a recommended outreach sequence.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ground: #faf8f4;
    --paper: #ffffff;
    --raised: #f4f1ea;
    --ink: #1e1e2d;
    --ink-soft: #4c4c63;
    --ink-muted: #86869c;
    --border: rgba(30,30,45,0.12);
    --border-strong: rgba(30,30,45,0.22);
    --sage: #3d7a5f;
    --sage-soft: #e8f1eb;
    --gold: #b3801a;
    --gold-soft: #f7edd4;
    --rich: #2f7a54;
    --mid: #b5791b;
    --thin: #a8473d;
    --rich-fill: #e7f1ea;
    --mid-fill: #f7edd6;
    --thin-fill: #f6e6e3;
    --shadow: 0 1px 2px rgba(30,30,45,0.04), 0 8px 28px rgba(30,30,45,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #14141d;
      --paper: #1c1c28;
      --raised: #23232f;
      --ink: #ecebf2;
      --ink-soft: #b6b6c6;
      --ink-muted: #7f7f95;
      --border: rgba(236,235,242,0.14);
      --border-strong: rgba(236,235,242,0.26);
      --sage: #6cbd97;
      --sage-soft: #1c2f27;
      --gold: #e6b64c;
      --gold-soft: #33291320;
      --rich: #5cba8a;
      --mid: #dda552;
      --thin: #e0857a;
      --rich-fill: #17281f;
      --mid-fill: #2a2213;
      --thin-fill: #2b1b18;
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 10px 34px rgba(0,0,0,0.4);
    }
  }
  :root[data-theme="dark"] {
    --ground: #14141d;
    --paper: #1c1c28;
    --raised: #23232f;
    --ink: #ecebf2;
    --ink-soft: #b6b6c6;
    --ink-muted: #7f7f95;
    --border: rgba(236,235,242,0.14);
    --border-strong: rgba(236,235,242,0.26);
    --sage: #6cbd97;
    --sage-soft: #1c2f27;
    --gold: #e6b64c;
    --gold-soft: #33291320;
    --rich: #5cba8a;
    --mid: #dda552;
    --thin: #e0857a;
    --rich-fill: #17281f;
    --mid-fill: #2a2213;
    --thin-fill: #2b1b18;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 10px 34px rgba(0,0,0,0.4);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: clamp(1.5rem, 4vw, 4rem) clamp(1rem, 4vw, 2.75rem) 5rem; }
  .col { max-width: 68ch; }

  /* Masthead */
  .masthead { border-bottom: 2px solid var(--ink); padding-bottom: 1.5rem; margin-bottom: 2.25rem; }
  .eyebrow {
    font-size: 0.7rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--sage); margin: 0 0 0.75rem;
  }
  h1 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-weight: 400; font-size: clamp(2rem, 5.5vw, 3rem); line-height: 1.08;
    margin: 0 0 0.85rem; text-wrap: balance; letter-spacing: -0.01em;
  }
  .standfirst { font-size: 1.05rem; color: var(--ink-soft); margin: 0; }
  .standfirst strong { color: var(--ink); font-weight: 600; }

  /* Section headings */
  h2 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-weight: 400; font-size: 1.5rem; line-height: 1.15;
    margin: 3.25rem 0 1rem; text-wrap: balance;
  }
  h2:first-of-type { margin-top: 2.5rem; }
  h2 .n {
    font-family: 'Inter', sans-serif; font-size: 0.8rem; font-weight: 700;
    color: var(--sage); vertical-align: 0.4em; margin-right: 0.6rem; letter-spacing: 0.04em;
  }
  p { margin: 0 0 1rem; }
  a { color: var(--sage); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:focus-visible, summary:focus-visible { outline: 2px solid var(--sage); outline-offset: 3px; border-radius: 2px; }

  /* Framing callout */
  .frame {
    background: var(--paper); border: 1px solid var(--border); border-left: 3px solid var(--sage);
    border-radius: 4px; padding: 1.25rem 1.4rem; margin: 1.75rem 0 0; box-shadow: var(--shadow);
  }
  .frame .col { max-width: none; }
  .frame dl { margin: 0; display: grid; gap: 0.9rem; }
  .frame dt { font-weight: 600; font-size: 0.95rem; color: var(--ink); }
  .frame dt .tag {
    display: inline-block; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 0.1rem 0.45rem; border-radius: 3px; margin-left: 0.55rem; vertical-align: 0.12em;
  }
  .tag.market { background: var(--sage-soft); color: var(--sage); }
  .tag.flat { background: var(--gold-soft); color: var(--gold); }
  .frame dd { margin: 0.2rem 0 0; font-size: 0.92rem; color: var(--ink-soft); }

  /* Tier legend */
  .legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1.4rem; margin: 1.25rem 0 0; font-size: 0.85rem; color: var(--ink-soft); }
  .legend span { display: inline-flex; align-items: center; gap: 0.45rem; }
  .dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex-shrink: 0; }
  .dot.rich { background: var(--rich); }
  .dot.mid { background: var(--mid); }
  .dot.thin { background: var(--thin); }

  /* Table */
  .tablewrap { overflow-x: auto; margin: 1.5rem 0 0; border: 1px solid var(--border); border-radius: 6px; box-shadow: var(--shadow); }
  table { width: 100%; border-collapse: collapse; min-width: 860px; background: var(--paper); }
  thead th {
    text-align: left; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--ink-muted); padding: 0.85rem 0.9rem; border-bottom: 1.5px solid var(--border-strong);
    background: var(--raised); position: sticky; top: 0;
  }
  tbody td { padding: 0.95rem 0.9rem; font-size: 0.86rem; color: var(--ink-soft); border-bottom: 1px solid var(--border); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr { border-left: 4px solid transparent; }
  tr.t-rich { border-left-color: var(--rich); }
  tr.t-mid  { border-left-color: var(--mid); }
  tr.t-thin { border-left-color: var(--thin); }
  .vert { font-weight: 600; color: var(--ink); font-size: 0.9rem; display: flex; gap: 0.5rem; align-items: baseline; }
  .vert .dot { position: relative; top: 1px; }
  .supply { color: var(--ink); font-weight: 500; }
  .econ { font-variant-numeric: tabular-nums; }
  .verdict { font-weight: 600; color: var(--ink); }
  .diff {
    display: inline-block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.03em;
    padding: 0.12rem 0.5rem; border-radius: 3px; white-space: nowrap;
  }
  .diff.easy { background: var(--rich-fill); color: var(--rich); }
  .diff.med  { background: var(--mid-fill); color: var(--mid); }
  .diff.hard { background: var(--thin-fill); color: var(--thin); }

  /* Cross-vertical box */
  .cross { background: var(--sage-soft); border: 1px solid var(--border); border-radius: 6px; padding: 1.4rem 1.5rem; margin: 1.5rem 0 0; }
  .cross h3 { margin: 0 0 0.9rem; font-size: 1rem; font-weight: 700; color: var(--ink); }
  .cross ul { margin: 0; padding-left: 1.1rem; display: grid; gap: 0.55rem; }
  .cross li { font-size: 0.9rem; color: var(--ink-soft); }
  .cross li strong { color: var(--ink); }
  .cross .kicker { margin: 1rem 0 0; font-size: 0.9rem; font-weight: 600; color: var(--sage); }

  /* Sequence */
  ol.seq { counter-reset: step; list-style: none; margin: 1.5rem 0 0; padding: 0; display: grid; gap: 0.9rem; }
  ol.seq > li {
    counter-increment: step; position: relative; padding: 1rem 1.2rem 1rem 3.2rem;
    background: var(--paper); border: 1px solid var(--border); border-radius: 5px; box-shadow: var(--shadow);
    font-size: 0.94rem; color: var(--ink-soft);
  }
  ol.seq > li::before {
    content: counter(step); position: absolute; left: 1rem; top: 1rem;
    width: 1.6rem; height: 1.6rem; border-radius: 50%; background: var(--sage); color: #fff;
    font-size: 0.82rem; font-weight: 700; display: grid; place-items: center;
    font-variant-numeric: tabular-nums;
  }
  ol.seq strong { color: var(--ink); font-weight: 600; }

  .note {
    margin: 1.5rem 0 0; padding: 1.15rem 1.35rem; border: 1px dashed var(--border-strong);
    border-radius: 5px; font-size: 0.9rem; color: var(--ink-soft); background: var(--raised);
  }
  .note strong { color: var(--ink); }

  /* Method / sources */
  .method { margin-top: 3.5rem; border-top: 1px solid var(--border); padding-top: 1.5rem; font-size: 0.84rem; color: var(--ink-muted); }
  .method h2 { font-size: 1.1rem; margin: 0 0 0.8rem; }
  .method ul { margin: 0 0 1.2rem; padding-left: 1.1rem; }
  .method li { margin-bottom: 0.4rem; }
  .method .col { max-width: 74ch; }
  details summary { cursor: pointer; font-weight: 600; color: var(--ink-soft); }
  .srclist { columns: 2; column-gap: 2rem; margin-top: 0.8rem; font-size: 0.8rem; }
  .srclist a { display: block; margin-bottom: 0.35rem; word-break: break-word; }
  @media (max-width: 560px) { .srclist { columns: 1; } }

  .pagefoot { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; font-size: 0.8rem; color: var(--ink-muted); }
  .pagefoot a { color: var(--ink-muted); }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">IntroLinq &middot; Partnerships &middot; Sept 2026</p>
    <h1>Expert-supply, vertical by vertical</h1>
    <p class="standfirst col">Where bookable-expert or affiliate supply actually exists for the widget to match against - and where this model runs out of road. Built to answer one question: <strong>which partnerships to chase, and in what order.</strong></p>
  </header>

  <p class="col">The instinct - sign 20 partners, put the logos on the site, tell bloggers you cover every field - is right about the goal and wrong about the lever. Two things get conflated:</p>

  <div class="frame">
    <dl>
      <dt>Marketplace integration <span class="tag market">deep</span></dt>
      <dd>Individual bookable experts, matched to a page by topic - like OpenIntro. High quality, real per-expert matching. Each one is an expert feed, vetting, category mapping and attribution plumbing. You can run 2-4 of these well.</dd>
      <dt>Vertical affiliate program <span class="tag flat">wide</span></dt>
      <dd>One flat referral link per field - BetterHelp for psychology, SmartAsset for finance. Near-zero build. This is how you get to "we cover 15 verticals" fast - but it's the <em>service</em> side of the affiliate model you set aside, and a widget that's mostly flat links reads differently to a blogger than one matching named experts.</dd>
    </dl>
  </div>

  <p class="col" style="margin-top:1.5rem">A blogger doesn't value your music partner if they write about parenting - they want depth in <em>their</em> niche. So the target is 2-3 credible options across the top 6-8 verticals, not 20 logos. Supply is not evenly distributed: finance and mental health are rich, beauty and literature barely support the model at all.</p>

  <div class="legend" role="note">
    <span><span class="dot rich"></span>Rich - real supply, viable economics</span>
    <span><span class="dot mid"></span>Workable - thinner, or a compromise on model/brand</span>
    <span><span class="dot thin"></span>Off-model - product affiliate or no commission mechanism</span>
  </div>

  <h2><span class="n">01</span>The map</h2>
  <p class="col">Sorted by how well the vertical supports IntroLinq's model, richest first. <span style="white-space:nowrap">"Integration"</span> is the build cost: <strong>flat link</strong> is a URL, <strong>feed</strong> means ingesting and vetting an expert roster.</p>

  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th scope="col">Vertical</th>
          <th scope="col">Viable supply</th>
          <th scope="col">Model</th>
          <th scope="col">Economics</th>
          <th scope="col">Integration</th>
          <th scope="col">Verdict</th>
        </tr>
      </thead>
      <tbody>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Finance &amp; Investing</span></td>
          <td><span class="supply">SmartAsset</span>, Zoe Financial, Wealthramp</td>
          <td>Advisor-matching, flat affiliate / lead-gen</td>
          <td class="econ">SmartAsset ~ $70 / qualified lead &middot; 30-day cookie</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Pursue now - top payout, no build</td>
        </tr>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Psychology &amp; Mental Health</span></td>
          <td><span class="supply">BetterHelp</span>, Talkspace</td>
          <td>Therapy-subscription lead-gen, flat affiliate</td>
          <td class="econ">BetterHelp $100-200 / new client (volume-negotiable) &middot; 30-day cookie &middot; $50 min payout</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Pursue now - but it's a link, not matched experts</td>
        </tr>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Business &amp; Entrepreneurship</span></td>
          <td><span class="supply">OpenIntro</span>, MentorCruise, Intro.co, GrowthMentor</td>
          <td>Expert marketplace - booked 1:1s</td>
          <td class="econ">MentorCruise 50% of monthly fee, recurring &middot; Intro.co per-session</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Your anchor - add MentorCruise as partner #2</td>
        </tr>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Marketing &amp; Sales</span></td>
          <td><span class="supply">MentorCruise</span>, GrowthMentor, Intro.co, OpenIntro</td>
          <td>Expert marketplace</td>
          <td class="econ">Same deals as Business - 50% recurring</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Covered by the Business anchor - no separate deal</td>
        </tr>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Technology &amp; Product</span></td>
          <td><span class="supply">MentorCruise</span>, Codementor, Intro.co, GrowthMentor &middot; <em>ADPList mostly free</em></td>
          <td>Expert marketplace - Codementor for hands-on coding help &amp; code review; ADPList largely unpaid</td>
          <td class="econ">MentorCruise 50% recurring &middot; Codementor no public affiliate - direct deal &middot; ADPList ~ none</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">MentorCruise / Intro as anchor; Codementor for coding depth; skip ADPList for revenue</td>
        </tr>
        <tr class="t-rich">
          <td><span class="vert"><span class="dot rich"></span>Education, Languages &amp; Tutoring</span></td>
          <td><span class="supply">italki</span>, Preply, Superprof, Outschool</td>
          <td>Lesson marketplace - commission (italki / Preply) or connection-fee (Superprof)</td>
          <td class="econ">italki / Preply affiliate per first purchase &middot; Superprof per paid connection</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Preply meeting is here; if their mechanics don't fit, <strong>Superprof</strong> is the multi-vertical play</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Legal</span></td>
          <td><span class="supply">Rocket Lawyer</span>, LegalMatch, Avvo</td>
          <td>Legal-service subscription + attorney-connect, affiliate</td>
          <td class="econ">Rocket Lawyer 30% / sale &middot; 30-day cookie</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Pursue now - same batch as finance / psychology</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Career &amp; Job Search</span></td>
          <td><span class="supply">TopResume</span>, TealHQ, MentorCruise career mentors</td>
          <td>Service affiliate + mentor marketplace</td>
          <td class="econ">TopResume flat / order &middot; MentorCruise 50% recurring</td>
          <td><span class="diff med">Link / feed</span></td>
          <td class="verdict">Rides the MentorCruise anchor + one resume affiliate</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Music &amp; Instruments</span></td>
          <td><span class="supply">Lessonface</span>, Superprof, Outschool, Tunelark</td>
          <td>Lesson marketplace <em>(TakeLessons shut down Nov 2024)</em></td>
          <td class="econ">Affiliate terms unpublished - must ask directly</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Defer - no off-the-shelf affiliate; free if you sign Superprof anyway</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Health &amp; Medicine</span></td>
          <td><span class="supply">JustAnswer</span>, telehealth affiliates</td>
          <td>Q&amp;A marketplace / telehealth affiliate</td>
          <td class="econ">JustAnswer $5-15 / sale &middot; 2-day cookie (vs your 90)</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Logo-only at best - economics and cookie don't fit</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Spiritual, Astrology &amp; Tarot</span></td>
          <td><span class="supply">Keen</span>, Kasamba, Purple Garden, Mysticsense</td>
          <td>Reading marketplace, affiliate via Impact</td>
          <td class="econ">Negotiable / undisclosed - consumer spend is real</td>
          <td><span class="diff med">Link / feed</span></td>
          <td class="verdict">Works mechanically - brand-fit call is yours</td>
        </tr>
        <tr class="t-mid">
          <td><span class="vert"><span class="dot mid"></span>Writing &amp; Publishing</span></td>
          <td><span class="supply">Reedsy</span> <em>(credit, not cash)</em>, writing coaches on MentorCruise</td>
          <td>Freelance marketplace; Reedsy pays referral credit</td>
          <td class="econ">Reedsy $25-100 in credit &rarr; effectively unusable for you</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Defer - no cash-commission partner; partial via MentorCruise</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Fitness &amp; Wellness</span></td>
          <td>Future, Noom, Trainerize &middot; some coaches on Superprof</td>
          <td>App-subscription affiliate - not booked experts</td>
          <td class="econ">Per-signup subscription affiliate</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Subscription-affiliate only - off-model</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Nutrition &amp; Diet</span></td>
          <td>Supplement / product programs; few coaching affiliates</td>
          <td>Product affiliate</td>
          <td class="econ">~ 8% of ~$50 AOV ~ $4 / sale</td>
          <td><span class="diff easy">Flat link</span></td>
          <td class="verdict">Product niche - not expert supply</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Parenting &amp; Family</span></td>
          <td>MissPoppins <em>(no commission)</em>, Tinyhood (3%), Parenting Simply (course)</td>
          <td>Course / product affiliate; marketplaces take no commission</td>
          <td class="econ">Course affiliate only</td>
          <td><span class="diff med">n/a</span></td>
          <td class="verdict">No commissionable marketplace - skip for now</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Beauty &amp; Skincare</span></td>
          <td>None for expert calls - Sephora / Amazon / brand product affiliate</td>
          <td>Retail product affiliate</td>
          <td class="econ">Product commission %</td>
          <td><span class="diff med">n/a</span></td>
          <td class="verdict">Won't work with this model - this is the retail path you rejected</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Real Estate</span></td>
          <td>Agent-referral networks (not consumer-facing affiliate)</td>
          <td>Agent referral fee - B2B, closed-deal</td>
          <td class="econ">Referral fee on close &middot; long cycle</td>
          <td><span class="diff hard">Custom</span></td>
          <td class="verdict">Off-model for now</td>
        </tr>
        <tr class="t-thin">
          <td><span class="vert"><span class="dot thin"></span>Art &amp; Design</span></td>
          <td>MentorCruise, Superprof, ADPList (design) - no dedicated marketplace</td>
          <td>Rides general mentor marketplaces</td>
          <td class="econ">MentorCruise 50% recurring where a mentor exists</td>
          <td><span class="diff hard">Feed</span></td>
          <td class="verdict">Incidental coverage via the anchor - no separate deal</td>
        </tr>
      </tbody>
    </table>
  </div>

  <h2><span class="n">02</span>The shortcut: one deal, many verticals</h2>
  <p class="col">Four partners each span a wide slice of the taxonomy on a single integration. One of these does more for coverage than five niche affiliate signups.</p>
  <div class="cross">
    <h3>Multi-vertical partners</h3>
    <ul>
      <li><strong>Superprof</strong> - one deal, 2,000+ subjects: music, arts, academic, sport, cooking, professional skills. Connection-fee model.</li>
      <li><strong>MentorCruise</strong> - one deal, 50% recurring commission, spans business, marketing, tech, career, design and writing.</li>
      <li><strong>JustAnswer</strong> - one deal, 700+ categories - but $5-15 per sale and a 2-day cookie make it a logo, not a revenue line.</li>
      <li><strong>Intro.co</strong> - one deal, broad expert marketplace, celebrity/creator-skewed.</li>
    </ul>
    <p class="kicker">Pick one anchor: MentorCruise if your blog pipeline skews professional, Superprof if it skews education / hobby / wellbeing.</p>
  </div>

  <h2><span class="n">03</span>Recommended sequence</h2>
  <ol class="seq">
    <li><strong>This week - send the flat-affiliate intros.</strong> SmartAsset, BetterHelp, Rocket Lawyer. Roughly zero build, and it covers finance, psychology and legal. Decide deliberately that these are lead-gen links, not matched experts.</li>
    <li><strong>Pick anchor #2.</strong> MentorCruise (professional / tech / career / marketing / design / writing on 50% recurring) or Superprof (music / arts / academic / wellbeing on one feed). One integration, many verticals.</li>
    <li><strong>Hold OpenIntro as the quality anchor.</strong> Don't dilute the "vetted experts you pay" story while you're bolting on flat links elsewhere.</li>
    <li><strong>Prove one vertical end-to-end</strong> - reader &rarr; widget &rarr; click &rarr; booking &rarr; commission - before signing partner #4. IntroLinq's <code>bookings</code> table is still empty; capacity isn't the current constraint.</li>
    <li><strong>Don't spend outreach cycles</strong> on beauty, nutrition, parenting or real estate. They're structurally product-affiliate or no-commission; chasing them burns the scarce resource, which is your attention.</li>
  </ol>

  <div class="note">
    <strong>The trade-off to hold in view:</strong> SmartAsset / BetterHelp / Rocket Lawyer fill vertical gaps fast and let you say "partners across 10 fields" - but they're flat links, and match quality is what has kept the widget installed on the sites that kept it. Blend deep and wide; don't tilt all-affiliate.
  </div>

  <div class="method">
    <h2>Method &amp; caveats</h2>
    <div class="col">
      <ul>
        <li>Figures are from public affiliate directories and partner program pages, September 2026. Rates are commonly negotiable and rise with traffic volume - treat them as a floor.</li>
        <li>"Won't work with this model" means there is no per-expert or per-booking commission mechanism - not that there's no money in the niche.</li>
        <li>Cookie windows vary widely. IntroLinq's is 90 days; a 2-day window (JustAnswer) barely survives the gap between a blog read and a booking.</li>
        <li>Confirm current terms and integration options directly with each partner before any build. Preply's meeting is the live test of whether their mechanics fit at all.</li>
      </ul>
      <details>
        <summary>Sources</summary>
        <div class="srclist">
          <a href="https://getlasso.co/affiliate/smartasset/">SmartAsset affiliate - getlasso.co</a>
          <a href="https://uppromote.com/affiliate-programs/mental-health/">Mental-health affiliate programs - uppromote.com</a>
          <a href="http://commissiondex.com/programs/betterhelp/">BetterHelp program detail - commissiondex.com</a>
          <a href="https://mentorcruise.com/partners/">MentorCruise partner program - mentorcruise.com</a>
          <a href="https://commission.academy/blog/best-mentorship-affiliate-programs/">Mentorship affiliate programs - commission.academy</a>
          <a href="https://sidehusl.com/superprof-international-marketplace-for-students-tutors/">Superprof model - sidehusl.com</a>
          <a href="https://www.yo-coach.com/blog/how-does-superprof-make-money/">Superprof revenue model - yo-coach.com</a>
          <a href="https://blog.tunelark.com/takelessons-shut-down-alternatives/">TakeLessons shutdown / alternatives - tunelark.com</a>
          <a href="https://sidehusl.com/lessonface/">Lessonface model - sidehusl.com</a>
          <a href="https://reedsy.com/faq/freelancers/referrals">Reedsy referral terms - reedsy.com</a>
          <a href="https://www.moneysmylife.com/reedsy-promotions/">Reedsy referral bonuses - moneysmylife.com</a>
          <a href="https://www.performcb.com/agency/clients/justanswer/">JustAnswer affiliate - performcb.com</a>
          <a href="https://theaffiliatemonkey.com/affiliate/justanswer-affiliate-program/">JustAnswer commission / cookie - theaffiliatemonkey.com</a>
          <a href="https://getlasso.co/affiliate/rocket-lawyer/">Rocket Lawyer affiliate - getlasso.co</a>
          <a href="https://uppromote.com/affiliate-programs/parenting/">Parenting affiliate programs - uppromote.com</a>
          <a href="https://misspoppins.io/">MissPoppins (no-commission marketplace) - misspoppins.io</a>
          <a href="https://uppromote.com/affiliate-programs/nutrition/">Nutrition affiliate programs - uppromote.com</a>
          <a href="https://www.flexoffers.com/affiliate-programs/keen-affiliate-program/">Keen affiliate - flexoffers.com</a>
          <a href="https://intro.co/">Intro.co marketplace - intro.co</a>
          <a href="https://www.codementor.io/">Codementor marketplace (no public affiliate found) - codementor.io</a>
        </div>
      </details>
    </div>
  </div>

  <div class="pagefoot">
    <span>IntroLinq - internal</span>
    <a href="/artifact?logout">Lock this page</a>
  </div>
</div>
<script>
/* Beacon the open duration back when the tab is hidden or closed - same
   idea as api/proposal.js. Fire-and-forget; guarded so it only sends once. */
(function () {
  var start = Date.now(), sent = false;
  function end() {
    if (sent) return; sent = true;
    var s = Math.round((Date.now() - start) / 1000);
    try {
      navigator.sendBeacon('/artifact?ping=close',
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
