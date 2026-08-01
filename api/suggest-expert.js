import { neon } from '@neondatabase/serverless';
import { getClientIp } from './_botDetect.js';

// Reuses the same secret already used to pull OpenIntro's expert roster
// (api/sync/openintro.js) - OpenIntro confirmed this endpoint accepts the
// same shared key as a header rather than the query-string form the sync
// endpoint uses. Never generate a second key for this.
const OPENINTRO_SUGGEST_API = 'https://open-intro.com/api/introlinq/suggest-expert';

// Window length is hardcoded directly into the query below (Postgres INTERVAL
// literal), not interpolated as a variable - the sql`` tag auto-parameterizes
// every ${}, which breaks INTERVAL syntax if a variable lands inside the
// quoted literal (see match.js's scan-cap query for the same constraint).
const RATE_LIMIT_MAX = 5;

// Must match the <select> options in dashboard/index.html exactly - kept
// here too since a direct API call bypasses the dropdown entirely.
const CATEGORIES = [
  'Business & Entrepreneurship', 'Marketing & Sales', 'Finance & Investing',
  'Technology & Product', 'Legal', 'Health & Medicine', 'Fitness & Wellness',
  'Music', 'Art & Design', 'Media & Entertainment', 'Education & Coaching',
  'Real Estate', 'Other',
];

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

let tableReady = false;
async function ensureTable(sql) {
  if (tableReady) return;
  // Doubles as the rate-limit log (see the COUNT query below) and a local
  // record of every submission - OpenIntro is the system of record for
  // review/approval, this table exists so a relay failure or rate-limit
  // block isn't invisible to us if someone reports "I submitted and nothing
  // happened".
  await sql`CREATE TABLE IF NOT EXISTS expert_suggestions (
    id SERIAL PRIMARY KEY,
    ip TEXT,
    name TEXT,
    email TEXT,
    profile_url TEXT,
    category TEXT,
    suggester_name TEXT,
    suggester_email TEXT,
    partner_name TEXT,
    status TEXT NOT NULL,
    application_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE expert_suggestions ADD COLUMN IF NOT EXISTS partner_name TEXT`.catch(() => {});
  tableReady = true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // suggesterName/suggesterEmail/partnerName are derived from the logged-in
  // publisher's own session, never taken from the request body - the
  // dashboard form doesn't even show them as editable fields anymore, and a
  // client-submitted value here would be trivially spoofable (wrong person,
  // wrong account) if it were trusted instead.
  const sessionToken = getSessionToken(req);
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
  const [session] = await sql`
    SELECT publisher_slug FROM sessions WHERE token = ${sessionToken} AND expires_at > NOW()
  `.catch(() => [null]);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const [publisher] = await sql`
    SELECT name, email, contact_first_name, contact_last_name
    FROM publishers WHERE slug = ${session.publisher_slug} AND active = true LIMIT 1
  `.catch(() => [null]);
  if (!publisher) return res.status(401).json({ error: 'Not authenticated' });

  const suggesterName = [publisher.contact_first_name, publisher.contact_last_name].filter(Boolean).join(' ');
  const suggesterEmail = publisher.email;
  const partnerName = publisher.name;
  if (!suggesterName || !suggesterEmail) {
    return res.status(400).json({ error: 'Add your contact name and email under Account settings before suggesting an expert.' });
  }

  const { name, email, profileUrl, category } = req.body || {};
  if (!name || !email || !profileUrl || !category) {
    return res.status(400).json({ error: 'name, email, profileUrl, and category are required' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'category is not a recognized option' });
  }
  // Client-side type="url" is trivially bypassed (direct API call, or just
  // typing into a text-like field before the browser validates) - this is
  // the actual boundary. The URL constructor throws on anything that isn't
  // a well-formed absolute URL, which a plain string like "asdf" fails.
  try {
    new URL(profileUrl);
  } catch {
    return res.status(400).json({ error: 'profileUrl must be a valid URL' });
  }

  const ip = getClientIp(req);
  await ensureTable(sql);

  if (ip) {
    const [{ n }] = await sql`
      SELECT COUNT(*)::int AS n FROM expert_suggestions
      WHERE ip = ${ip} AND created_at > NOW() - INTERVAL '1 hour'
    `.catch(() => [{ n: 0 }]);
    if (n >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many suggestions submitted recently - please try again in a bit.' });
    }
  }

  const payload = {
    name,
    email,
    profileUrl: profileUrl || null,
    category: category || null,
    suggesterName,
    suggesterEmail,
    partnerName,
  };

  let openIntroRes;
  let openIntroBody;
  try {
    openIntroRes = await fetch(OPENINTRO_SUGGEST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-introlinq-secret': process.env.OPENINTRO_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    openIntroBody = await openIntroRes.json().catch(() => ({}));
  } catch (err) {
    console.error('suggest-expert relay to OpenIntro failed:', err);
    await sql`
      INSERT INTO expert_suggestions (ip, name, email, profile_url, category, suggester_name, suggester_email, partner_name, status)
      VALUES (${ip}, ${name}, ${email}, ${profileUrl || null}, ${category || null}, ${suggesterName}, ${suggesterEmail}, ${partnerName}, 'relay_failed')
    `.catch(() => {});
    return res.status(502).json({ error: "Couldn't reach OpenIntro right now - please try again shortly." });
  }

  await sql`
    INSERT INTO expert_suggestions (ip, name, email, profile_url, category, suggester_name, suggester_email, partner_name, status, application_id)
    VALUES (${ip}, ${name}, ${email}, ${profileUrl || null}, ${category || null}, ${suggesterName}, ${suggesterEmail}, ${partnerName},
            ${openIntroRes.ok ? 'sent' : 'openintro_rejected'}, ${openIntroBody.applicationId || null})
  `.catch(() => {});

  return res.status(openIntroRes.status).json(openIntroBody);
}
