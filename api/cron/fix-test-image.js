import { neon } from '@neondatabase/serverless';

// One-off: replaces the mismatched hero image on the first test post with a
// manually verified, on-topic, correctly-licensed photo. Safe to delete
// (along with its temporary cron entry in vercel.json) once it has run once.
export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  const result = await sql`
    UPDATE blog_posts
    SET
      image_url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Woman_works_on_laptop_while_holding_cup_of_coffee_in_cozy_home_office.jpg/1920px-Woman_works_on_laptop_while_holding_cup_of_coffee_in_cozy_home_office.jpg',
      image_alt = 'A woman working on a laptop with a cup of coffee in a cozy home office',
      image_credit = 'Shixart1985 / Wikimedia Commons, CC BY 2.0'
    WHERE slug = 'how-to-monetize-a-blog-without-display-ads'
    RETURNING slug
  `;

  return res.status(200).json({ ok: true, updated: result.length });
}
