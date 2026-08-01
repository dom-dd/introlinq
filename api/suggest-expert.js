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
    status TEXT NOT NULL,
    application_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  tableReady = true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, profileUrl, category, suggesterName, suggesterEmail } = req.body || {};
  if (!name || !email || !suggesterName || !suggesterEmail) {
    return res.status(400).json({ error: 'name, email, suggesterName, and suggesterEmail are required' });
  }

  const ip = getClientIp(req);
  const sql = neon(process.env.DATABASE_URL);
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
      INSERT INTO expert_suggestions (ip, name, email, profile_url, category, suggester_name, suggester_email, status)
      VALUES (${ip}, ${name}, ${email}, ${profileUrl || null}, ${category || null}, ${suggesterName}, ${suggesterEmail}, 'relay_failed')
    `.catch(() => {});
    return res.status(502).json({ error: "Couldn't reach OpenIntro right now - please try again shortly." });
  }

  await sql`
    INSERT INTO expert_suggestions (ip, name, email, profile_url, category, suggester_name, suggester_email, status, application_id)
    VALUES (${ip}, ${name}, ${email}, ${profileUrl || null}, ${category || null}, ${suggesterName}, ${suggesterEmail},
            ${openIntroRes.ok ? 'sent' : 'openintro_rejected'}, ${openIntroBody.applicationId || null})
  `.catch(() => {});

  return res.status(openIntroRes.status).json(openIntroBody);
}
