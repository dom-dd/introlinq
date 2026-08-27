import { neon } from '@neondatabase/serverless';

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
body{font-family:'Inter',system-ui,sans-serif;background:var(--cream);color:var(--ink);min-height:100vh;line-height:1.6}
a{color:inherit}
nav{display:flex;align-items:center;justify-content:space-between;padding:1.25rem 2rem;border-bottom:1px solid var(--border);background:var(--cream);position:sticky;top:0;z-index:100;backdrop-filter:blur(8px)}
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
footer{background:var(--ink);padding:3rem 2rem 2rem}
.footer-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem}
.footer-logo{font-family:'DM Serif Display',serif;font-size:1.25rem;color:var(--white);text-decoration:none}
.footer-logo span{color:var(--sage-mid)}
.footer-links{display:flex;gap:1.5rem;flex-wrap:wrap}
.footer-link{font-size:0.8125rem;color:rgba(255,255,255,0.55);text-decoration:none}
.footer-copy{font-size:0.75rem;color:rgba(255,255,255,0.4);width:100%;margin-top:1.5rem;text-align:center}
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
  return `<footer>
  <div class="footer-inner">
    <a class="footer-logo" href="/">Intro<span>Linq</span></a>
    <div class="footer-links">
      <a class="footer-link" href="/signup">Create your account</a>
      <a class="footer-link" href="/privacy">Privacy Policy</a>
      <a class="footer-link" href="/terms">Terms of Service</a>
    </div>
    <p class="footer-copy">Copyright &copy; 2026 IntroLinq. All rights reserved.</p>
  </div>
</footer>`;
}

function fontLinks() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderIndex(posts) {
  const title = 'Blog - IntroLinq';
  const description = 'Ideas and guides on monetizing a blog, written for independent publishers.';
  const cards = posts.length
    ? posts.map((p) => `
      <a class="post-card" href="/blog/${esc(p.slug)}">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.image_alt || '')}" loading="lazy">` : ''}
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
${post.image_url ? `<meta property="og:image" content="${esc(post.image_url)}">` : ''}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${fontLinks()}
<style>${HEAD_STYLE}</style>
</head>
<body>
${nav()}
<div class="page-wrap">
  <a class="back-link" href="/blog">← Blog</a>
  ${post.image_url ? `<img class="article-hero" src="${esc(post.image_url)}" alt="${esc(post.image_alt || '')}">` : ''}
  ${post.image_credit ? `<p class="article-credit">Image: ${esc(post.image_credit)}</p>` : ''}
  <h1 class="article-title">${esc(post.title)}</h1>
  <p class="article-date">${formatDate(post.created_at)}</p>
  <div class="article-body">${post.body_html}</div>

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
</body>
</html>`;
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
    const [post] = await sql`SELECT * FROM blog_posts WHERE slug = ${slug}`.catch(() => []);
    if (!post) {
      res.status(404);
      return res.send(renderIndex(await sql`SELECT slug, title, excerpt, image_url, image_alt, created_at FROM blog_posts ORDER BY created_at DESC`.catch(() => [])));
    }
    return res.send(renderPost(post));
  }

  const posts = await sql`SELECT slug, title, excerpt, image_url, image_alt, created_at FROM blog_posts ORDER BY created_at DESC`.catch(() => []);
  return res.send(renderIndex(posts));
}
