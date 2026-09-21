import crypto from 'crypto';

/*
 * /preply-example - a private, password-gated demo page for Preply (rewrite in
 * vercel.json points /preply-example at this function). Same server-side gate
 * and Slack alerts as /proposal (api/proposal.js) and /brief (api/admin.js):
 * one shared password, an HttpOnly cookie holding sha256(secret + password),
 * and four #introlinq-notifications pings - prompt shown, password attempt,
 * page opened, and how long the tab stayed open.
 *
 * The page shows the REAL IntroLinq widget, carousel and expert board running
 * under the `language-blog-demo` publisher, which is enabled for Preply only,
 * so every expert it can surface is one of the Preply tutors in the database.
 */
const PASSWORD = 'patz';
const COOKIE = 'il_preply';
const TOKEN = crypto.createHash('sha256').update('il-preply-v1:' + PASSWORD).digest('hex');
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days
const LABEL = 'Preply example page';

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

// Awaited on purpose - a serverless function can be frozen the moment the
// response is sent, so a fire-and-forget POST to Slack would never land. A
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

  // Beacon from the page itself (navigator.sendBeacon) when the tab is hidden
  // or closed, reporting how long it was open. It carries no content, so no
  // auth check - a fire-and-forget analytics ping.
  if (req.method === 'POST' && req.query && req.query.ping === 'close') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const seconds = Math.max(0, Math.min(Number(body?.duration) || 0, 86400));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    await notifySlack(`👋 ${LABEL} session ended - ${mins}m ${secs}s\n${from}`);
    return res.status(204).end();
  }

  if (req.method === 'POST') {
    let pw = '';
    const b = req.body;
    if (b && typeof b === 'object') pw = b.password || '';
    else if (typeof b === 'string') {
      try { pw = new URLSearchParams(b).get('password') || ''; } catch { pw = ''; }
    }
    // Trimmed and case-insensitive so a stray space or a capital from a phone
    // keyboard doesn't lock the reader out of a one-word password.
    const correct = safeEqual(String(pw).trim().toLowerCase(), PASSWORD);
    await notifySlack(`🔑 Password ${correct ? 'entered correctly' : 'attempt (wrong)'} on the ${LABEL}\n${from}`);
    if (correct) {
      res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
      res.writeHead(303, { Location: '/preply-example' });
      return res.end();
    }
    res.writeHead(303, { Location: '/preply-example?e=1' });
    return res.end();
  }

  if (req.query && req.query.logout !== undefined) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    res.writeHead(303, { Location: '/preply-example' });
    return res.end();
  }

  if (hasValidCookie(req)) {
    await notifySlack(`📄 The ${LABEL} was opened\n${from}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE_HTML);
  }

  const bad = req.query && req.query.e !== undefined;
  if (!bad) await notifySlack(`🔒 The ${LABEL} password prompt was shown\n${from}`);
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
<form class="card" method="POST" action="/preply-example">
  <a class="logo" href="/">Intro<span>Linq</span></a>
  <h1>Password required</h1>
  <p>This page is private. Enter the password to continue.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
  <button type="submit">View example</button>
  <div class="err">${bad ? 'Incorrect password. Try again.' : ''}</div>
</form>
</body>
</html>`;
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>IntroLinq and Preply &middot; Example</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#1a1a2e;--ink-soft:#4a4a6a;--ink-muted:#8888a8;--cream:#faf8f4;--white:#fff;--sage:#3d7a5f;--sage-light:#edf5f0;--gold:#e6a820;--gold-light:#fef3c7;--border:rgba(26,26,46,0.10);--border-soft:rgba(26,26,46,0.06)}
body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);line-height:1.65;background:#f0ede6;position:relative}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(72% 60% at 3% -12%,rgba(61,122,95,0.4),transparent 55%),radial-gradient(66% 55% at 106% -4%,rgba(230,168,32,0.36),transparent 52%),linear-gradient(160deg,#efe9de,#e9e2d3)}
.sheet{max-width:1040px;margin:3rem auto;background:var(--white);border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 60px rgba(26,26,46,0.12);padding:3rem 3.25rem}
.topline{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:2.25rem}
.logo{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);text-decoration:none}
.logo span{color:var(--sage)}
.tag{font-size:0.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--gold);border:1px solid var(--gold);border-radius:100px;padding:0.3rem 0.7rem;white-space:nowrap}
.intro{display:flex;gap:1.25rem;align-items:center;margin-bottom:1.25rem}
.intro img{width:64px;height:64px;border-radius:14px;flex-shrink:0;box-shadow:0 4px 14px rgba(26,26,46,0.14)}
h1{font-family:'DM Serif Display',serif;font-size:2rem;font-weight:400;line-height:1.2}
.meta{font-size:0.875rem;color:var(--ink-muted);margin-top:0.25rem}
p{font-size:0.9375rem;color:var(--ink-soft);margin-bottom:0.9rem}
strong{color:var(--ink);font-weight:600}
.callout{background:var(--sage-light);border:1px solid rgba(61,122,95,0.2);border-radius:12px;padding:1rem 1.25rem;margin:1.25rem 0 0}
.callout p{margin:0;color:var(--ink);font-size:0.875rem}
h2{font-family:'DM Serif Display',serif;font-size:1.375rem;font-weight:400;margin:3rem 0 0.4rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border-soft)}
h2 .n{display:inline-block;width:1.7rem;height:1.7rem;line-height:1.7rem;text-align:center;border-radius:50%;background:var(--sage);color:#fff;font-family:'Inter',sans-serif;font-size:0.8125rem;font-weight:600;margin-right:0.6rem;vertical-align:middle}
.lead{margin:0.6rem 0 1.25rem}
.post{max-width:720px;margin:0 auto;background:var(--white);border:1px solid var(--border);border-radius:12px;padding:1.75rem 2rem}
.post-kicker{font-size:0.7rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:0.5rem}
.post-title{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);line-height:1.3;margin-bottom:0.35rem}
.post-byline{font-size:0.8125rem;color:var(--ink-muted);margin-bottom:1.1rem}
.post p{font-size:0.9375rem;color:var(--ink-soft);line-height:1.85;margin-bottom:0.9rem}
.post p:last-child{margin-bottom:0}
.hint{font-size:0.8rem;color:var(--ink-muted);text-align:center;margin-top:0.85rem}
.embed{border:1px solid var(--border);border-radius:12px;padding:1.25rem;background:var(--white);overflow:hidden}
.foot{margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--border-soft);font-size:0.8125rem;color:var(--ink-muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}
.foot a{color:var(--ink-muted)}
@media (max-width:700px){.sheet{padding:1.75rem 1.25rem;margin:1rem}h1{font-size:1.6rem}.post{padding:1.25rem}}
</style>
</head>
<body>
<div class="sheet">
  <div class="topline">
    <a class="logo" href="/">Intro<span>Linq</span></a>
    <span class="tag">Private example</span>
  </div>

  <div class="intro">
    <img src="/networks%20logos/preply.png" alt="Preply" width="64" height="64">
    <div>
      <h1>IntroLinq and Preply</h1>
      <p class="meta">Prepared for Patz &nbsp;&middot;&nbsp; September 2026</p>
    </div>
  </div>

  <p><strong>Preply</strong> is an online marketplace where learners book 1-on-1 lessons with tutors across many languages. <strong>IntroLinq</strong> helps publishers earn from their content by recommending the right expert to a reader at the moment an article shows they need one. The publisher adds one line of code, IntroLinq reads each article, and the best-matched expert appears in context.</p>
  <p>Below is how Preply tutors would appear on a language-learning blog, in the three formats a publisher can choose from. Everything on this page is the live product, not a mockup, and every tutor link goes through your Impact tracking link.</p>
  <div class="callout"><p>The tutor profiles shown here are placeholders for illustration. They would be replaced by real Preply tutors once a tutor feed is connected.</p></div>

  <h2><span class="n">1</span>AI text widget</h2>
  <p class="lead">IntroLinq's AI reads the article and highlights the phrase where a tutor would genuinely help. Hover or tap a highlighted phrase to see who it recommends.</p>
  <article class="post post-content">
    <div class="post-kicker">From the blog</div>
    <div class="post-title">Six months of language apps later: what actually got me speaking</div>
    <div class="post-byline">By Priya Nandakumar &middot; 7 min read</div>
    <p>The app told me my Spanish was coming along brilliantly. Every lesson green, every review perfect. Then I stood in a café in Oaxaca and completely froze - not because I didn't know the words, but because I had never once said them out loud to a real person.</p>
    <p>Apps are brilliant for building vocabulary and drilling grammar. What they can't do is make you uncomfortable in the right way. Real conversation is fast, messy and full of words you only half know, and the only way to get comfortable with it is to have a lot of it, with someone patient who can correct you as you go.</p>
    <p>My sister spent three years in French classes and still panicked when she had to order lunch in Lyon. Classroom French and spoken French turned out to be almost different languages. A few casual conversation sessions with a native speaker closed the gap faster than another semester would have.</p>
    <p>My friend Jonas hit the same wall with German. He had eight weeks before moving to Berlin, and flashcards were never going to help him deal with a landlord or open a bank account. Lessons built around the conversations he would actually have got him functional before the move.</p>
    <p>My partner and I are planning a month in Puglia next spring. Neither of us needs perfect grammar. We just want to chat in Italian with the family who run the farmhouse and follow a menu without pointing, and that comes down to a handful of everyday conversations.</p>
    <p>My neighbour Ana moved from Lisbon to Manchester last year. Her English is fine on paper, but she dreaded the school gate, the GP's reception and small talk with the people next door. A few relaxed weekly sessions with an English tutor made everyday conversations feel ordinary instead of exhausting.</p>
    <p>It is the same story at work. A colleague of mine reads English perfectly but goes quiet in meetings, because thinking on your feet in a live discussion is a different skill from reading and writing. Practising real business English scenarios - presenting, negotiating, writing sharp emails - with a tutor changed that in a few weeks.</p>
    <p>If I could go back, I would cut the app time in half and book conversation practice from week one. The streak makes you feel like you are progressing. Speaking to a person is what actually shows you where you are.</p>
  </article>
  <p class="hint">The highlighted phrases are found and matched automatically by IntroLinq's AI. Nothing here was placed by hand.</p>

  <h2><span class="n">2</span>Expert carousel</h2>
  <p class="lead">A standalone block a publisher can drop between posts or into a sidebar. It scrolls on its own and pauses when the reader hovers.</p>
  <div class="embed">
    <script src="https://www.introlinq.com/carousel.js" data-publisher="language-blog-demo"></script>
  </div>

  <h2><span class="n">3</span>Expert board</h2>
  <p class="lead">A searchable directory readers can browse and book from without leaving the publisher's page.</p>
  <div class="embed">
    <script src="https://www.introlinq.com/expertboard.js" data-publisher="language-blog-demo"></script>
  </div>

  <div class="foot">
    <span>IntroLinq - Private example prepared for Preply</span>
    <a href="/preply-example?logout">Lock this page</a>
  </div>
</div>
<script src="https://www.introlinq.com/widget.js" data-publisher="language-blog-demo"></script>
<script>
/* Beacon the open duration back when the tab is hidden or closed - same idea
   as the proposal page. Fire-and-forget; guarded so it only sends once. */
(function () {
  var start = Date.now(), sent = false;
  function end() {
    if (sent) return; sent = true;
    var s = Math.round((Date.now() - start) / 1000);
    try {
      navigator.sendBeacon('/preply-example?ping=close',
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
