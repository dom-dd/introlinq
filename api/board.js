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
    sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS headlines JSONB DEFAULT '{}'`.catch(() => {}),
  ]);

  const [publisher] = await sql`
    SELECT name, widget_color, accent_color, carousel_title, COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners
    FROM publishers WHERE slug = ${pub} AND active = true LIMIT 1
  `;
  if (!publisher) return res.status(404).json({ error: 'Publisher not found' });

  const experts = await sql`
    SELECT e.id, e.name, e.position, e.company, e.bio, e.photo_url, e.booking_url,
           e.price_from, e.price_currency, e.topics, e.languages, e.location_country,
           COALESCE(e.headlines, '{}'::jsonb) AS headlines,
           p.slug AS provider_slug, p.website_url AS provider_url
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

  res.setHeader('Cache-Control', 'public, s-maxage=300');
  return res.status(200).json({
    experts,
    topics,
    config: {
      color: publisher.widget_color || '#e6a820',
      accent: publisher.accent_color || publisher.widget_color || '#e6a820',
      carousel_title: publisher.carousel_title || null,
    }
  });
}
