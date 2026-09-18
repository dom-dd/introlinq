import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

// Shared site footer - single source of truth in partials/footer.html, also
// injected into the static pages by build.mjs. Read once at cold start.
// vercel.json keeps partials/** bundled with this function (includeFiles).
const FOOTER_HTML = readFileSync(new URL('../partials/footer.html', import.meta.url), 'utf8').trim();

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HEAD_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#1a1a2e;--ink-soft:#4a4a6a;--ink-muted:#8888a8;
  --cream:#faf8f4;--white:#ffffff;
  --sage:#3d7a5f;--sage-light:#edf5f0;--sage-mid:#c8e4d8;
  --gold:#e6a820;--border:rgba(26,26,46,0.10);--border-soft:rgba(26,26,46,0.06);
  --radius:12px;--radius-sm:8px;
}
body{font-family:'Inter',system-ui,sans-serif;background:#f0ede6;color:var(--ink);min-height:100vh;line-height:1.6;position:relative}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:
    radial-gradient(72% 60% at 3% -12%, rgba(61,122,95,0.50), transparent 55%),
    radial-gradient(66% 55% at 106% -4%, rgba(230,168,32,0.44), transparent 52%),
    radial-gradient(70% 62% at 102% 104%, rgba(61,122,95,0.34), transparent 55%),
    radial-gradient(52% 52% at 40% 122%, rgba(230,168,32,0.22), transparent 60%),
    linear-gradient(160deg, #efe9de, #e9e2d3);
}
a{color:inherit}
nav{display:flex;align-items:center;justify-content:space-between;padding:1.25rem 2rem;border-bottom:1px solid var(--border);background:rgba(250,248,244,0.8);position:sticky;top:0;z-index:100;backdrop-filter:blur(10px)}
.nav-logo{font-family:'DM Serif Display',serif;font-size:1.375rem;color:var(--ink);text-decoration:none}
.nav-logo span{color:var(--sage)}
.nav-cta{background:var(--ink);color:var(--white);border:none;padding:0.625rem 1.25rem;border-radius:100px;font-size:0.875rem;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;text-decoration:none;display:inline-block}
.nav-right{display:flex;align-items:center;gap:1.25rem}
.nav-login{font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none}
.page-wrap{max-width:760px;margin:0 auto;padding:4rem 2rem 5rem}
.back-link{font-size:0.875rem;color:var(--sage);text-decoration:none;display:inline-block;margin-bottom:2rem}
.page-title{font-family:'DM Serif Display',serif;font-size:2.25rem;color:var(--ink);letter-spacing:-0.03em;margin-bottom:0.75rem}
.page-sub{font-size:1.0625rem;color:var(--ink-soft);margin-bottom:3rem}
.post-card{display:block;background:var(--white);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:1.25rem;text-decoration:none}
.post-card img{width:100%;height:180px;object-fit:cover;display:block}
.post-card-body{padding:1.5rem}
.post-card-title{font-family:'DM Serif Display',serif;font-size:1.25rem;color:var(--ink);margin-bottom:0.5rem;line-height:1.3}
.post-card-excerpt{font-size:0.9375rem;color:var(--ink-soft);line-height:1.6}
.post-card-date{font-size:0.75rem;color:var(--ink-muted);margin-top:0.75rem;display:block}
.empty-note{color:var(--ink-muted);font-size:0.9375rem}
.article-hero{width:100%;border-radius:var(--radius);margin-bottom:0.5rem;display:block}
.article-credit{font-size:0.75rem;color:var(--ink-muted);margin-bottom:2rem}
.article-credit a{color:var(--ink-muted)}
.article-title{font-family:'DM Serif Display',serif;font-size:2.25rem;color:var(--ink);letter-spacing:-0.03em;line-height:1.2;margin-bottom:0.75rem}
.article-date{font-size:0.875rem;color:var(--ink-muted);margin-bottom:2rem}
.article-body{font-size:1.0625rem;color:var(--ink-soft);line-height:1.8}
.article-body h2{font-family:'DM Serif Display',serif;font-size:1.5rem;color:var(--ink);letter-spacing:-0.02em;margin:2rem 0 1rem}
.article-body h3{font-weight:600;color:var(--ink);margin:1.5rem 0 0.75rem;font-size:1.125rem}
.article-body p{margin-bottom:1.25rem}
.article-body ul{margin:0 0 1.25rem 1.25rem}
.article-body li{margin-bottom:0.5rem}
.article-cta{background:var(--ink);border-radius:20px;padding:2.5rem;text-align:center;margin-top:3rem}
.article-cta-title{font-family:'DM Serif Display',serif;font-size:1.375rem;color:var(--white);margin-bottom:1.25rem}
.btn-gold{background:var(--gold);color:var(--ink);border:none;padding:0.875rem 2rem;border-radius:100px;font-size:0.9375rem;font-weight:600;text-decoration:none;display:inline-block}
.related-title{font-family:'DM Serif Display',serif;font-size:1.25rem;color:var(--ink);letter-spacing:-0.02em;margin:3rem 0 1rem}
.related-guides{display:flex;flex-wrap:wrap;gap:0.75rem;margin-bottom:1rem}
.related-link{background:var(--white);border:1px solid var(--border);border-radius:100px;padding:0.625rem 1.25rem;font-size:0.875rem;font-weight:500;color:var(--sage);text-decoration:none}
.related-link:hover{border-color:var(--sage)}
@media(max-width:640px){.page-wrap{padding:2rem 1.25rem 4rem}nav{padding:1rem 1.25rem}.page-title,.article-title{font-size:1.75rem}}
`;

function nav() {
  return `<nav>
  <a class="nav-logo" href="/">Intro<span>Linq</span></a>
  <div class="nav-right">
    <a class="nav-login" href="/login">Log in</a>
    <a class="nav-cta" href="/signup">Create your account →</a>
  </div>
</nav>`;
}

function footer() {
  return FOOTER_HTML;
}

function fontLinks() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// A calm on-brand cover for posts with no photo (Wikimedia Commons search
// came back empty, or a seed post). Mirrors the site's own radial-blob
// background plus a small "connections" node graph, so it reads as designed
// art rather than a missing image. Deterministic per slug, so a given post
// always gets the same cover.
function svgCover(slug) {
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < slug.length; i++) { seed ^= slug.charCodeAt(i); seed = Math.imul(seed, 16777619) >>> 0; }
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const W = 1200, H = 420, N = 6;
  const nodes = [];
  for (let i = 0; i < N; i++) nodes.push([Math.round(140 + rand() * (W - 280)), Math.round(80 + rand() * (H - 190))]);
  let lines = '';
  for (let i = 1; i < N; i++) lines += `<line x1='${nodes[i - 1][0]}' y1='${nodes[i - 1][1]}' x2='${nodes[i][0]}' y2='${nodes[i][1]}'/>`;
  lines += `<line x1='${nodes[0][0]}' y1='${nodes[0][1]}' x2='${nodes[N - 1][0]}' y2='${nodes[N - 1][1]}'/>`;
  let dots = '';
  nodes.forEach((n, i) => {
    dots += `<circle cx='${n[0]}' cy='${n[1]}' r='${i % 2 ? 10 : 6}' fill='${i % 3 === 1 ? '#e6a820' : '#3d7a5f'}' fill-opacity='0.8'/>`;
  });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`
    + `<defs>`
    + `<linearGradient id='bg' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f2ede3'/><stop offset='1' stop-color='#e8e0d0'/></linearGradient>`
    + `<radialGradient id='s' cx='0.12' cy='0.05' r='0.7'><stop offset='0' stop-color='#3d7a5f' stop-opacity='0.42'/><stop offset='1' stop-color='#3d7a5f' stop-opacity='0'/></radialGradient>`
    + `<radialGradient id='o' cx='0.97' cy='0.03' r='0.6'><stop offset='0' stop-color='#e6a820' stop-opacity='0.4'/><stop offset='1' stop-color='#e6a820' stop-opacity='0'/></radialGradient>`
    + `</defs>`
    + `<rect width='${W}' height='${H}' fill='url(#bg)'/><rect width='${W}' height='${H}' fill='url(#s)'/><rect width='${W}' height='${H}' fill='url(#o)'/>`
    + `<g stroke='#3d7a5f' stroke-opacity='0.3' stroke-width='1.5'>${lines}</g>${dots}`
    + `<text x='64' y='372' font-family='Georgia, serif' font-size='30' fill='#1a1a2e' fill-opacity='0.66'>Intro<tspan fill='#3d7a5f' fill-opacity='0.85'>Linq</tspan></text>`
    + `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Real photo when the post has one, on-brand generated cover otherwise -
// so every card and every article header carries an image.
function coverSrc(post) {
  return post.image_url || svgCover(post.slug || '');
}

function renderIndex(posts) {
  const title = 'Blog - IntroLinq';
  const description = 'Ideas and guides on monetizing a blog, written for independent publishers.';
  const cards = posts.length
    ? posts.map((p) => `
      <a class="post-card" href="/blog/${esc(p.slug)}">
        <img src="${esc(coverSrc(p))}" alt="${esc(p.image_alt || p.title)}" loading="lazy">
        <div class="post-card-body">
          <div class="post-card-title">${esc(p.title)}</div>
          <p class="post-card-excerpt">${esc(p.excerpt || '')}</p>
          <span class="post-card-date">${formatDate(p.created_at)}</span>
        </div>
      </a>`).join('')
    : `<p class="empty-note">First post coming soon.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://www.introlinq.com/blog">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${fontLinks()}
<style>${HEAD_STYLE}</style>
</head>
<body>
${nav()}
<div class="page-wrap">
  <a class="back-link" href="/">← IntroLinq</a>
  <h1 class="page-title">Blog</h1>
  <p class="page-sub">Ideas and guides on monetizing a blog, for independent publishers.</p>
  ${cards}
</div>
${footer()}
<script src="https://www.introlinq.com/widget.js" data-publisher="introlinq"></script>
</body>
</html>`;
}

function renderPost(post) {
  const url = `https://www.introlinq.com/blog/${post.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.meta_description || post.excerpt || '',
    datePublished: new Date(post.created_at).toISOString(),
    image: post.image_url || undefined,
    publisher: { '@type': 'Organization', name: 'IntroLinq', url: 'https://www.introlinq.com/' },
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(post.title)} | IntroLinq</title>
<meta name="description" content="${esc(post.meta_description || post.excerpt || '')}">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:description" content="${esc(post.meta_description || post.excerpt || '')}">
<meta property="og:type" content="article">
${post.image_url ? `<meta property="og:image" content="${esc(post.image_url)}">` : ''}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${fontLinks()}
<style>${HEAD_STYLE}</style>
</head>
<body>
${nav()}
<div class="page-wrap">
  <a class="back-link" href="/blog">← Blog</a>
  <img class="article-hero" src="${esc(coverSrc(post))}" alt="${esc(post.image_alt || post.title)}">
  ${post.image_credit ? `<p class="article-credit">Image: ${esc(post.image_credit)}</p>` : ''}
  <h1 class="article-title">${esc(post.title)}</h1>
  <p class="article-date">${formatDate(post.created_at)}</p>
  <div class="article-body">${post.body_html}</div>

  <div style="margin-top:3rem">
    <script src="https://www.introlinq.com/carousel.js" data-publisher="introlinq"></script>
  </div>

  <p class="related-title">More monetization guides</p>
  <div class="related-guides">
    <a class="related-link" href="/monetize-finance-blog">Finance blogs</a>
    <a class="related-link" href="/monetize-health-blog">Health &amp; wellness blogs</a>
    <a class="related-link" href="/monetize-career-blog">Career blogs</a>
    <a class="related-link" href="/monetize-fashion-blog">Fashion &amp; style blogs</a>
    <a class="related-link" href="/monetize-food-blog">Food &amp; nutrition blogs</a>
    <a class="related-link" href="/monetize-sport-blog">Sport &amp; fitness blogs</a>
  </div>

  <div class="article-cta">
    <p class="article-cta-title">Ready to turn your blog into a revenue stream?</p>
    <a class="btn-gold" href="/signup">Create your account →</a>
  </div>
</div>
${footer()}
<script src="https://www.introlinq.com/widget.js" data-publisher="introlinq"></script>
</body>
</html>`;
}

// Posts that ship with the repo rather than living in the blog_posts table.
// Rendered through the same template as DB posts (so they carry the nav,
// footer and the data-publisher="introlinq" widget script), and served when
// the DB has no row for that slug - which also means they keep working if
// the DB is briefly unreachable. A real blog_posts row with the same slug
// overrides the seed. Added 2026-09 as a clean, self-hosted widget demo
// surface for partner outreach.
const SEED_POSTS = [
  {
    slug: 'first-decisions-when-you-start-a-company',
    title: 'The First Decisions That Shape a Startup',
    meta_description: 'The early calls that are hard to undo later: co-founder equity, when to raise, pricing the first product, and your first hire.',
    excerpt: 'Most of what you do in year one is reversible. A few things are not. Here are the early decisions worth slowing down for.',
    image_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Business_man_and_woman_handshake_in_work_office.jpg/1920px-Business_man_and_woman_handshake_in_work_office.jpg',
    image_alt: 'Two business people shaking hands over a desk',
    image_credit: 'perzon seo / Wikimedia Commons, CC BY 2.0',
    topic: 'startups',
    created_at: '2026-09-08T09:00:00.000Z',
    body_html: `<p>Most of what you do in the first year of a company is reversible. You can rename the product, redo the landing page, cut a feature, change your mind about a market. A few decisions are different. They set terms that are awkward, expensive, or relationship-testing to unwind later, and they tend to get made fast, early, and with too little outside advice. These are the ones worth slowing down for.</p>

<h2>Splitting equity with a co-founder</h2>
<p>The default instinct is a clean 50/50, and for two people starting at the same time with the same commitment, that is often the right answer. The mistake is treating the split as a one-line agreement rather than a structure. Whatever the percentages, put everyone on a vesting schedule, usually four years with a one-year cliff, so a co-founder who leaves after five months does not walk away owning a quarter of the company. Write down what happens if someone goes part-time, brings in outside money on a side project, or wants out entirely.</p>
<p>The conversation feels adversarial while you are still excited and aligned, which is exactly why it is easy to skip. It is far harder to have a year in, when the stakes are real and the goodwill is thinner. If you cannot get through the awkward version of this discussion now, that is useful information too.</p>

<h2>Deciding when to raise, and how much</h2>
<p>Raising money is not a milestone, it is a trade. You are selling a permanent share of the company for a temporary runway, and the price is set by how little proof you have. Raising before you can show that someone wants what you are building means selling that share cheaply. Raising a much larger round than you need buys time you might spend going in the wrong direction, and raises the bar for the round after it.</p>
<p>Before you start a process, get specific about what the money is for. What will be true in twelve months that is not true today, and what is the smallest amount that gets you there with a margin for error. The structure matters as much as the amount. An early convertible or SAFE with a sensible cap is fast and cheap. A priced round brings a lead investor, a board seat, and terms that shape every round that follows. Someone who has sat on both sides of that table can talk you out of agreeing to something standard-looking that quietly costs you later.</p>

<h2>Pricing the first version</h2>
<p>Founders underprice. The first number you pick becomes an anchor that is hard to move up without a story, and a low anchor pulls in the customers who are hardest to serve and quickest to leave. Pricing at this stage is not a spreadsheet exercise. It is a series of conversations with the people you want as buyers, where you are trying to learn what the problem currently costs them and what they already pay to make it hurt less.</p>
<p>Charge money early, even from friendly design partners, even at a discount. A customer who pays is giving you a real signal. A customer who uses it for free is doing you a favour.</p>

<h2>Making the first hire</h2>
<p>The first person you bring on sets the culture whether you mean them to or not. They usually need to be a generalist who is comfortable with no process and shifting priorities, not the strongest specialist you can afford. Try the working relationship as a paid contract project before either side commits to full time. Be honest with yourself about what you are genuinely slow or bad at, and hire against that, instead of hiring another version of yourself.</p>
<p>The cost of a wrong early hire is not just the salary. It is the months you spend managing around the problem, and the bar it sets for everyone who joins after them.</p>

<h2>Where to get a second opinion</h2>
<p>None of these decisions has a single correct answer, and the advice that helps is specific to your situation, not a blog post. The people worth asking are the ones who have made the same call, ideally more than once, and can tell you what they would do differently. A short conversation before you sign something is worth far more than a long one afterwards.</p>`,
  },
];

// DB posts win over a seed with the same slug; seeds fill in when the DB has
// none for that slug (or is unreachable). Newest first, by created_at.
function mergePosts(dbPosts) {
  const seen = new Set(dbPosts.map((p) => p.slug));
  return dbPosts
    .concat(SEED_POSTS.filter((p) => !seen.has(p.slug)))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      meta_description TEXT,
      excerpt TEXT,
      body_html TEXT NOT NULL,
      image_url TEXT,
      image_alt TEXT,
      image_credit TEXT,
      topic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `.catch(() => {});

  const { slug } = req.query;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (slug) {
    const [dbPost] = await sql`SELECT * FROM blog_posts WHERE slug = ${slug}`.catch(() => []);
    const post = dbPost || SEED_POSTS.find((p) => p.slug === slug);
    if (!post) {
      res.status(404);
      const dbPosts = await sql`SELECT slug, title, excerpt, image_url, image_alt, created_at FROM blog_posts ORDER BY created_at DESC`.catch(() => []);
      return res.send(renderIndex(mergePosts(dbPosts)));
    }
    return res.send(renderPost(post));
  }

  const dbPosts = await sql`SELECT slug, title, excerpt, image_url, image_alt, created_at FROM blog_posts ORDER BY created_at DESC`.catch(() => []);
  return res.send(renderIndex(mergePosts(dbPosts)));
}
