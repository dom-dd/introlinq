import { neon } from '@neondatabase/serverless';

// Rotating topic queue. Deterministic (postCount % length), so it never
// repeats until every topic has been used once, then cycles. Add more
// topics here over time rather than editing the rotation logic.
const TOPICS = [
  'How to monetize a blog without display ads',
  'The best blog monetization methods for niche bloggers',
  'How to turn old blog posts into a passive income stream',
  'WordPress blog monetization ideas beyond affiliate links',
  'How to add expert referrals to your blog without hurting reader trust',
  'Blog monetization ideas for career and job-advice bloggers',
  'Blog monetization ideas for fashion and style bloggers',
  'Blog monetization ideas for food and nutrition bloggers',
  'Blog monetization ideas for sport and fitness bloggers',
  'Why affiliate marketing alone is not enough to monetize a blog anymore',
  'How AI can match blog readers with the right expert automatically',
  'The real cost of running ads on your blog, and a free alternative',
  'How independent bloggers are earning commission without selling anything',
  'Blog monetization ideas for Ghost and Squarespace publishers',
  'How to monetize a small blog with under 10,000 monthly readers',
];

// Everything the model is allowed to claim about the product. Written out
// explicitly so a generated post can't invent a wrong commission rate,
// payout method, or platform claim the way the old static pages did.
const PRODUCT_FACTS = `
- Company: IntroLinq (introlinq.com). A free widget publishers add to their blog.
- What it does: reads each article, automatically detects where a reader could benefit from expert guidance, and shows a relevant bookable expert. No manual tagging.
- Commission: flat 50% of the booking fee to the publisher, on every booking, for as long as they use IntroLinq. Not tiered. There is no "founder" program or higher rate for early publishers - that offer is retired and must never be mentioned.
- Cost to the publisher: completely free forever. No setup fee, no monthly cost, ever, under any circumstance. The publisher NEVER pays IntroLinq anything - they only ever receive money.
- Setup: one script tag pasted once into the site's <head>. Runs on every article already published and every one written in future.
- Confirmed compatible platforms: WordPress, Ghost, Squarespace, Webflow, Wix, Notion, HubSpot, Mailchimp landing pages, Google Tag Manager, and any site where you can paste a script into <head> or the page body.
- NOT compatible: Substack and Medium do not allow custom scripts, so IntroLinq cannot run there. Never imply otherwise. If it's not relevant to the topic, don't mention it at all.
- Experts: 100+ vetted specialists across finance, health, business, legal, technology, coaching, and more. Matched automatically by topic, language, location, and budget.
- Payouts: monthly, via Wise or PayPal, once the publisher's pending balance reaches a $50 minimum.
- Sign-up is free and live in minutes at https://www.introlinq.com/signup.
`.trim();

async function generatePost(topic) {
  const system = `You write blog posts for the IntroLinq marketing blog. IntroLinq is the product; only state facts about it from the list below - never invent a statistic, commission rate, platform, testimonial, or customer name that isn't given to you.

PRODUCT FACTS (the only things you may claim about IntroLinq):
${PRODUCT_FACTS}

STYLE:
- Warm, direct, plain-spoken. Explain things the way a smart friend would, not corporate marketing copy.
- Second person ("you", "your blog").
- 700-1000 words.
- 2-4 H2 subheadings breaking up the piece.
- Naturally work in the target topic/keyword phrasing a reader would actually search.
- End with a short paragraph inviting the reader to sign up at https://www.introlinq.com/signup.
- NEVER use an em dash (—) anywhere in the text. Use a comma, a period, or parentheses instead.
- Do not wrap the body in <html>, <head>, or <body> tags, and do not use inline styles.

Respond with ONLY a single valid JSON object (no markdown code fences, no commentary before or after) with this exact shape:
{
  "title": "SEO title, under 65 characters",
  "slug": "kebab-case-url-slug, lowercase, no special characters",
  "metaDescription": "under 160 characters",
  "excerpt": "one or two sentence summary for a blog index card",
  "bodyHtml": "the full article as semantic HTML using <p>, <h2>, <h3>, <ul>/<li> tags only",
  "imageSearchQuery": "2-4 words to search for a relevant royalty-free photo, e.g. 'person writing laptop'",
  "imageAlt": "descriptive alt text for that image, specific to this article"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: `Write the post. Topic: "${topic}"` }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.content?.find((b) => b.type === 'text')?.text || '';
  const jsonText = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const post = JSON.parse(jsonText);

  // Defensive strip in case the model slips one in despite the instruction.
  post.title = post.title.replace(/—/g, ',');
  post.metaDescription = post.metaDescription.replace(/—/g, ',');
  post.excerpt = post.excerpt.replace(/—/g, ',');
  post.bodyHtml = post.bodyHtml.replace(/—/g, ',');
  post.slug = post.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  return post;
}

// Keyless Wikimedia Commons search - real royalty-free images with usable
// license metadata, no API key or third-party account required.
const ALLOWED_LICENSES = ['cc0', 'public domain', 'cc by', 'cc-by', 'cc by-sa', 'cc-by-sa'];

async function findCommonsImage(query) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1600&format=json&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data.query?.pages || {});

    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const license = (info.extmetadata?.LicenseShortName?.value || '').toLowerCase();
      const isAllowed = ALLOWED_LICENSES.some((l) => license.includes(l));
      if (!isAllowed) continue;
      const width = info.thumbwidth || 0;
      if (width < 800) continue;

      const artist = (info.extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').trim();
      const licenseName = info.extmetadata?.LicenseShortName?.value || 'Public domain';
      const credit = artist
        ? `${artist} / Wikimedia Commons, ${licenseName}`
        : `Wikimedia Commons, ${licenseName}`;

      return { url: info.thumburl || info.url, credit };
    }
    return null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
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
    `;

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM blog_posts`;
    const topic = TOPICS[count % TOPICS.length];

    const post = await generatePost(topic);
    const image = await findCommonsImage(post.imageSearchQuery);

    // Slug collision (e.g. model reuses a phrase) - suffix rather than fail.
    const [existing] = await sql`SELECT id FROM blog_posts WHERE slug = ${post.slug}`;
    const slug = existing ? `${post.slug}-${Date.now().toString(36)}` : post.slug;

    await sql`
      INSERT INTO blog_posts (slug, title, meta_description, excerpt, body_html, image_url, image_alt, image_credit, topic)
      VALUES (${slug}, ${post.title}, ${post.metaDescription}, ${post.excerpt}, ${post.bodyHtml}, ${image?.url || null}, ${image ? post.imageAlt : null}, ${image?.credit || null}, ${topic})
    `;

    const postUrl = `https://www.introlinq.com/blog/${slug}`;

    if (process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) {
      fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `📝 *New blog post published*\n${post.title}\n${postUrl}` }),
      }).catch(() => {});
    }

    if (process.env.RESEND_API_KEY) {
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'IntroLinq <hello@introlinq.com>',
          to: 'dom@introlinq.com',
          subject: `New blog post published: ${post.title}`,
          html: `<p>This week's blog post has been written and published automatically.</p><p><strong>${post.title}</strong></p><p><a href="${postUrl}">${postUrl}</a></p>`,
        }),
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, slug, title: post.title, url: postUrl });
  } catch (err) {
    console.error('weekly-blog failed:', err);
    return res.status(500).json({ error: 'Blog generation failed' });
  }
}
