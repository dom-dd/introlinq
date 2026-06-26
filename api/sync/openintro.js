import { neon } from '@neondatabase/serverless';

const BUBBLE_API = 'https://open-intro.com/api/1.1/obj/Experts';

const COUNTRY_LANGUAGES = {
  'France': ['French', 'English'],
  'Belgium': ['French', 'Dutch', 'English'],
  'Switzerland': ['French', 'German', 'Italian', 'English'],
  'Luxembourg': ['French', 'German', 'English'],
  'Monaco': ['French'],
  'Germany': ['German', 'English'],
  'Austria': ['German', 'English'],
  'Spain': ['Spanish', 'English'],
  'Mexico': ['Spanish', 'English'],
  'Argentina': ['Spanish', 'English'],
  'Colombia': ['Spanish', 'English'],
  'Chile': ['Spanish', 'English'],
  'Portugal': ['Portuguese', 'English'],
  'Brazil': ['Portuguese', 'English'],
  'Italy': ['Italian', 'English'],
  'Netherlands': ['Dutch', 'English'],
  'United Kingdom': ['English'],
  'Ireland': ['English'],
  'United States': ['English'],
  'Canada': ['English', 'French'],
  'Australia': ['English'],
  'New Zealand': ['English'],
  'South Africa': ['English'],
  'Singapore': ['English'],
  'India': ['English', 'Hindi'],
  'Sweden': ['Swedish', 'English'],
  'Norway': ['Norwegian', 'English'],
  'Denmark': ['Danish', 'English'],
  'Finland': ['Finnish', 'English'],
  'Poland': ['Polish', 'English'],
  'Romania': ['Romanian', 'English'],
  'Czech Republic': ['Czech', 'English'],
  'Hungary': ['Hungarian', 'English'],
  'Greece': ['Greek', 'English'],
  'Turkey': ['Turkish', 'English'],
  'Israel': ['Hebrew', 'English'],
  'UAE': ['Arabic', 'English'],
  'Saudi Arabia': ['Arabic', 'English'],
  'Japan': ['Japanese'],
  'China': ['Chinese'],
  'South Korea': ['Korean', 'English'],
  'Hong Kong': ['Chinese', 'English'],
  'Taiwan': ['Chinese', 'English'],
  'Thailand': ['Thai', 'English'],
  'Vietnam': ['Vietnamese', 'English'],
  'Indonesia': ['Indonesian', 'English'],
  'Malaysia': ['Malay', 'English'],
  'Philippines': ['Filipino', 'English'],
  'Morocco': ['Arabic', 'French'],
  'Tunisia': ['Arabic', 'French'],
  'Senegal': ['French'],
  'Ivory Coast': ['French'],
};

async function fetchAllExperts() {
  const results = [];
  let cursor = 0;

  while (true) {
    const res = await fetch(`${BUBBLE_API}?limit=100&cursor=${cursor}`, {
      headers: { 'Authorization': `Bearer ${process.env.BUBBLE_API_KEY}` }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bubble API ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const batch = data.response?.results || [];
    results.push(...batch);

    if (!data.response?.remaining || batch.length === 0) break;
    cursor += 100;
  }

  return results;
}

function mapExpert(raw, providerId) {
  const slug = raw['Slug'] || '';
  const country = raw['n-Country'] || '';
  const languages = COUNTRY_LANGUAGES[country] || ['English'];

  const services = [
    raw['Service 1'], raw['Service 2'], raw['Service 3'],
    raw['Service 4'], raw['Service 5']
  ].filter(Boolean);

  const vertical = raw['Vertical group'] ? [raw['Vertical group']] : [];
  // Tags and Not_categories are Bubble internal IDs - skip them
  const topics = [...new Set([...services, ...vertical])].filter(Boolean);

  // Picture URL starts with // - prepend https:
  const rawPhoto = raw['Picture'] || '';
  const photo_url = rawPhoto.startsWith('//') ? `https:${rawPhoto}` : rawPhoto;

  const gbp = parseFloat(raw['GBP15Fee']) || null;
  const eur = parseFloat(raw['EUR15Fee']) || null;
  const usd = parseFloat(raw['USD15Fee']) || null;
  const cad = parseFloat(raw['CAD15Fee']) || null;

  return {
    provider_id: providerId,
    external_id: raw['_id'],
    name: raw['Full Name'] || raw['Fullname'] || '',
    bio: raw['Short description (index)'] || '',
    description_long: raw['Description'] || '',
    photo_url,
    position: raw['Position'] || '',
    company: raw['Company'] || '',
    topics,
    services,
    languages,
    location_country: country,
    price_from: gbp || eur || usd || cad,
    price_currency: gbp ? 'GBP' : eur ? 'EUR' : usd ? 'USD' : cad ? 'CAD' : 'GBP',
    price_eur: eur,
    price_usd: usd,
    price_cad: cad,
    // TODO: append ?ref={publisher_slug} once referral tracking is live in OpenIntro
    booking_url: slug ? `https://open-intro.com/expert/${slug}` : null,
    profile_url: slug ? `https://open-intro.com/expert/${slug}` : null,
    raw_data: raw,
  };
}

export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Add any new columns that didn't exist at db-init time
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS position TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS company TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS description_long TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS price_eur DECIMAL`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS price_usd DECIMAL`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS price_cad DECIMAL`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS services TEXT[] DEFAULT '{}'`;

    const [provider] = await sql`SELECT id FROM providers WHERE slug = 'openintro'`;
    if (!provider) return res.status(500).json({ error: 'OpenIntro provider not found - run /api/db-init?key=il2026 first' });

    const allExperts = await fetchAllExperts();

    const publicExperts = allExperts.filter(e => {
      const status = e['Profile status'] || e['Profile_status'] || '';
      return status.includes('Public');
    });

    const activeIds = [];
    let upserted = 0;

    for (const raw of publicExperts) {
      const e = mapExpert(raw, provider.id);
      if (!e.name || !e.external_id) continue;
      activeIds.push(e.external_id);

      await sql`
        INSERT INTO experts (
          provider_id, external_id, name, bio, description_long, photo_url,
          position, company, topics, services, languages, location_country,
          price_from, price_currency, price_eur, price_usd, price_cad,
          booking_url, profile_url, active, raw_data, synced_at
        ) VALUES (
          ${e.provider_id}, ${e.external_id}, ${e.name}, ${e.bio}, ${e.description_long},
          ${e.photo_url}, ${e.position}, ${e.company}, ${e.topics}, ${e.services},
          ${e.languages}, ${e.location_country}, ${e.price_from}, ${e.price_currency},
          ${e.price_eur}, ${e.price_usd}, ${e.price_cad},
          ${e.booking_url}, ${e.profile_url}, true, ${JSON.stringify(e.raw_data)}, NOW()
        )
        ON CONFLICT (provider_id, external_id) DO UPDATE SET
          name = EXCLUDED.name,
          bio = EXCLUDED.bio,
          description_long = EXCLUDED.description_long,
          photo_url = EXCLUDED.photo_url,
          position = EXCLUDED.position,
          company = EXCLUDED.company,
          topics = EXCLUDED.topics,
          services = EXCLUDED.services,
          languages = EXCLUDED.languages,
          location_country = EXCLUDED.location_country,
          price_from = EXCLUDED.price_from,
          price_currency = EXCLUDED.price_currency,
          price_eur = EXCLUDED.price_eur,
          price_usd = EXCLUDED.price_usd,
          price_cad = EXCLUDED.price_cad,
          booking_url = EXCLUDED.booking_url,
          profile_url = EXCLUDED.profile_url,
          active = true,
          raw_data = EXCLUDED.raw_data,
          synced_at = NOW()
      `;
      upserted++;
    }

    // Deactivate experts removed or hidden since last sync
    if (activeIds.length > 0) {
      await sql`
        UPDATE experts SET active = false
        WHERE provider_id = ${provider.id}
        AND external_id != ALL(${activeIds})
      `;
    }

    await sql`UPDATE providers SET last_synced_at = NOW() WHERE id = ${provider.id}`;

    return res.status(200).json({
      success: true,
      total_fetched: allExperts.length,
      public_only: publicExperts.length,
      upserted,
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
