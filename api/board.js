import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);
  const { pub } = req.query;

  if (!pub) return res.status(400).json({ error: 'pub required' });

  await Promise.all([
    sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS carousel_title TEXT`.catch(() => {}),
    sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS board_text_color TEXT`.catch(() => {}),
    sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_language TEXT`.catch(() => {}),
    sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS headlines JSONB DEFAULT '{}'`.catch(() => {}),
  ]);

  const [publisher] = await sql`
    SELECT name, widget_color, accent_color, carousel_title, board_text_color, widget_language, COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners
    FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
  `;
  if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

  const experts = await sql`
    SELECT e.id, e.name, e.position, e.company, e.bio, e.description_long, e.photo_url, e.booking_url,
           e.price_from, e.price_currency, e.topics, e.languages, e.location_country,
           COALESCE(e.headlines, '{}'::jsonb) AS headlines,
           COALESCE(e.highlights, '{}') AS highlights,
           COALESCE(e.services, '{}') AS services,
           COALESCE(e.notable_categories, '{}') AS notable_categories,
           p.slug AS provider_slug, p.name AS provider_name, p.website_url AS provider_url
    FROM experts e
    JOIN providers p ON p.id = e.provider_id
    WHERE e.active = true
      AND p.is_demo IS NOT TRUE
      AND p.slug = ANY(${publisher.enabled_partners})
    ORDER BY e.name ASC
  `;

  // Collect all unique topics for filter bar
  const topicSet = new Set();
  experts.forEach(e => (e.topics || []).forEach(t => topicSet.add(t)));
  const topics = [...topicSet].sort();

  // The providers actually behind this publisher's experts, so the carousel and
  // board can name them in their "in partnership with" line instead of always
  // saying OpenIntro.
  const partners = [];
  const seenProviders = new Set();
  experts.forEach(e => {
    if (seenProviders.has(e.provider_slug)) return;
    seenProviders.add(e.provider_slug);
    partners.push({ slug: e.provider_slug, name: e.provider_name, url: e.provider_url });
  });
  partners.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  res.setHeader('Cache-Control', 'public, s-maxage=300');
  return res.status(200).json({
    experts,
    topics,
    config: {
      color: publisher.widget_color || '#e6a820',
      accent: publisher.accent_color || publisher.widget_color || '#e6a820',
      carousel_title: publisher.carousel_title || null,
      text_color: publisher.board_text_color || '#1a1a2e',
      language: publisher.widget_language || null,
      partners,
    }
  });
}
