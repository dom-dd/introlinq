import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS providers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      connection_type TEXT NOT NULL,
      connection_config JSONB DEFAULT '{}',
      active BOOLEAN DEFAULT true,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS experts (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER REFERENCES providers(id),
      external_id TEXT,
      name TEXT NOT NULL,
      bio TEXT,
      photo_url TEXT,
      topics TEXT[] DEFAULT '{}',
      languages TEXT[] DEFAULT '{}',
      location_country TEXT,
      price_from DECIMAL,
      price_currency TEXT DEFAULT 'GBP',
      booking_url TEXT,
      profile_url TEXT,
      active BOOLEAN DEFAULT true,
      raw_data JSONB,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(provider_id, external_id)
    )
  `;

  const [provider] = await sql`
    INSERT INTO providers (name, slug, connection_type, connection_config)
    VALUES ('OpenIntro', 'openintro', 'api', '{"base_url": "https://open-intro.com"}')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  const experts = [
    {
      external_id: 'oi-001',
      name: 'Dr Sarah Mitchell',
      bio: 'Chartered financial planner with 15 years experience helping individuals and families build long-term financial security.',
      photo_url: 'https://i.pravatar.cc/150?img=47',
      topics: ['personal finance', 'retirement planning', 'pension', 'investing', 'financial planning', 'savings', 'ISA', 'wealth management', 'tax'],
      languages: ['English'],
      location_country: 'GB',
      price_from: 150,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/sarah-mitchell',
      profile_url: 'https://open-intro.com/experts/sarah-mitchell'
    },
    {
      external_id: 'oi-002',
      name: 'Marcus Williams',
      bio: 'Growth marketing strategist who has scaled B2B SaaS companies from zero to Series B. Specialises in content-led growth and SEO.',
      photo_url: 'https://i.pravatar.cc/150?img=12',
      topics: ['content marketing', 'SEO', 'growth marketing', 'digital marketing', 'social media', 'email marketing', 'lead generation', 'copywriting', 'brand strategy', 'paid ads'],
      languages: ['English'],
      location_country: 'US',
      price_from: 200,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/marcus-williams',
      profile_url: 'https://open-intro.com/experts/marcus-williams'
    },
    {
      external_id: 'oi-003',
      name: 'Elena Kovacs',
      bio: 'Startup coach and ex-founder who has helped 200+ early-stage founders navigate product-market fit, fundraising, and team building.',
      photo_url: 'https://i.pravatar.cc/150?img=32',
      topics: ['startup', 'entrepreneurship', 'fundraising', 'venture capital', 'product market fit', 'business strategy', 'scaling', 'leadership', 'hiring', 'co-founder'],
      languages: ['English', 'French'],
      location_country: 'FR',
      price_from: 175,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/elena-kovacs',
      profile_url: 'https://open-intro.com/experts/elena-kovacs'
    },
    {
      external_id: 'oi-004',
      name: 'Dr James Okafor',
      bio: 'Registered nutritionist and health coach specialising in sustainable lifestyle change, gut health, and performance nutrition.',
      photo_url: 'https://i.pravatar.cc/150?img=8',
      topics: ['nutrition', 'diet', 'gut health', 'mental health', 'fitness', 'wellness', 'weight loss', 'healthy eating', 'sleep', 'stress', 'burnout', 'exercise'],
      languages: ['English'],
      location_country: 'GB',
      price_from: 90,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/james-okafor',
      profile_url: 'https://open-intro.com/experts/james-okafor'
    },
    {
      external_id: 'oi-005',
      name: 'Priya Nair',
      bio: 'Product and AI strategy consultant. Former VP Product at two YC-backed companies. Helps teams build AI-native products and processes.',
      photo_url: 'https://i.pravatar.cc/150?img=44',
      topics: ['artificial intelligence', 'AI', 'product management', 'product strategy', 'technology', 'machine learning', 'automation', 'software', 'digital transformation', 'ChatGPT', 'LLM'],
      languages: ['English'],
      location_country: 'US',
      price_from: 250,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/priya-nair',
      profile_url: 'https://open-intro.com/experts/priya-nair'
    },
    {
      external_id: 'oi-006',
      name: 'Thomas Berger',
      bio: 'Commercial solicitor and IP specialist with 20 years experience advising startups, SMEs, and creators on contracts and intellectual property.',
      photo_url: 'https://i.pravatar.cc/150?img=15',
      topics: ['legal', 'contracts', 'intellectual property', 'employment law', 'business law', 'GDPR', 'compliance', 'trademark', 'copyright', 'terms of service', 'privacy'],
      languages: ['English', 'German'],
      location_country: 'DE',
      price_from: 220,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/thomas-berger',
      profile_url: 'https://open-intro.com/experts/thomas-berger'
    },
    {
      external_id: 'oi-007',
      name: 'Amara Diallo',
      bio: 'Executive career coach and former recruiter at Goldman Sachs. Specialises in career transitions, salary negotiation, and interview preparation.',
      photo_url: 'https://i.pravatar.cc/150?img=25',
      topics: ['career', 'job search', 'interview', 'salary negotiation', 'CV', 'resume', 'career change', 'promotion', 'networking', 'LinkedIn', 'recruitment'],
      languages: ['English', 'French'],
      location_country: 'GB',
      price_from: 120,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/amara-diallo',
      profile_url: 'https://open-intro.com/experts/amara-diallo'
    },
    {
      external_id: 'oi-008',
      name: 'Rafael Mendez',
      bio: 'Property investment advisor and former estate agent with 12 years helping first-time buyers and investors navigate the UK housing market.',
      photo_url: 'https://i.pravatar.cc/150?img=18',
      topics: ['property', 'real estate', 'mortgage', 'buy to let', 'first time buyer', 'house purchase', 'property investment', 'rental', 'remortgage', 'housing market'],
      languages: ['English', 'Spanish'],
      location_country: 'GB',
      price_from: 130,
      price_currency: 'GBP',
      booking_url: 'https://open-intro.com/experts/rafael-mendez',
      profile_url: 'https://open-intro.com/experts/rafael-mendez'
    }
  ];

  let seeded = 0;
  for (const e of experts) {
    const result = await sql`
      INSERT INTO experts (provider_id, external_id, name, bio, photo_url, topics, languages, location_country, price_from, price_currency, booking_url, profile_url)
      VALUES (${provider.id}, ${e.external_id}, ${e.name}, ${e.bio}, ${e.photo_url}, ${e.topics}, ${e.languages}, ${e.location_country}, ${e.price_from}, ${e.price_currency}, ${e.booking_url}, ${e.profile_url})
      ON CONFLICT (provider_id, external_id) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) seeded++;
  }

  return res.status(200).json({ success: true, provider_id: provider.id, experts_seeded: seeded });
}
