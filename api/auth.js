import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { notifyTeam, escapeHtml } from './_notify.js';

// Lockout window for password login - 5 failed attempts locks the account
// for 15 minutes, reset on the next successful login. Guards the one new
// unauthenticated attack surface password login adds (a magic-link token is
// a 32-byte random value, too large to brute-force; a password isn't).
const PASSWORD_MAX_ATTEMPTS = 5;
const PASSWORD_LOCKOUT_MS = 15 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;

let tableReady = false;

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Sniffs a site's homepage HTML for platform-specific fingerprints so the
// Get Started tab can skip straight to the right install steps instead of
// making every new publisher pick from a grid. Deliberately conservative -
// only matches on things that are genuinely distinctive to that platform
// (a CDN domain baked into every page it serves, not a generic keyword),
// so a wrong guess is rare rather than just "usually right." Hostname
// checked first for Substack/Medium since those are hosted platforms
// identifiable from the domain alone, before any HTML is even fetched.
function detectPlatformFromSite(hostname, html) {
  const host = (hostname || '').toLowerCase();
  const h = (html || '').toLowerCase();
  // Medium's default URL is path-based (medium.com/@username), not a
  // subdomain - confirmed against a real publisher's domain on file
  // (medium.com/@mansidhyani) that the subdomain-only check below would
  // have missed entirely. The subdomain form still exists for older/custom
  // setups, so both are checked.
  if (host === 'medium.com' || host.endsWith('.medium.com')) return 'medium';
  if (host.endsWith('.substack.com')) return 'substack';
  if (h.includes('/wp-content/') || h.includes('/wp-includes/') || h.includes('wp-json') || /name=["']generator["'][^>]*wordpress/i.test(h)) return 'wordpress';
  if (h.includes('static.wixstatic.com') || /name=["']generator["'][^>]*wix\.com/i.test(h)) return 'wix';
  if (h.includes('squarespace-cdn.com') || h.includes('static1.squarespace.com') || /name=["']generator["'][^>]*squarespace/i.test(h)) return 'squarespace';
  if (h.includes('website-files.com') || h.includes('data-wf-site') || /name=["']generator["'][^>]*webflow/i.test(h)) return 'webflow';
  if (h.includes('/ghost/api/') || /name=["']generator["'][^>]*ghost/i.test(h)) return 'ghost';
  if (h.includes('framerusercontent.com') || /name=["']generator["'][^>]*framer/i.test(h)) return 'framer';
  if (h.includes('substackcdn.com')) return 'substack';
  // Checked last, deliberately - GTM can sit on top of any of the platforms
  // above, so a CMS-specific match should always win over "they have GTM".
  if (h.includes('googletagmanager.com/gtm.js')) return 'gtm';
  return null;
}

// Mirrors widget.js's own detectLanguage(), which runs client-side against
// extracted article text on every page load - carousel.js and expertboard.js
// have no article text to scan (they render a fixed expert list, not a
// scanned page), so this runs the same word-frequency detector once, server
// side, against the homepage HTML already fetched below for platform
// detection, and the result is persisted to publishers.widget_language for
// those two widgets to read at render time instead of trusting the page's
// <html lang> (often wrong/missing on CMS sites - see widget.js's own
// comment on that).
const LANG_WORDS = {
  en: ['the','and','of','to','is','in','that','for','with','you','your','are','this','have','from','will','not','but','they','was','can','what','how','which','their','has','been','were','would','about','when','more','other','into','than','them','then','some','also','because','through'],
  fr: ['le','la','les','des','une','est','et','pour','avec','dans','vous','votre','nous','sur','qui','que','pas','plus','cette','du','au','par','mais','ont','leur','aux','ce','ses','vos','elle','son','sa','comme','tout','aussi','bien','faire','peut','être','très','sans','même'],
  es: ['el','los','las','que','para','con','una','es','por','su','este','esta','del','se','más','como','pero','sus','al','lo','tiene','también','puede','hacer','todo','cuando','muy','sin','sobre','entre','ya','hay','desde','está','cada'],
  de: ['der','die','das','und','ist','für','mit','den','sie','auf','nicht','ein','eine','des','im','dem','zu','von','werden','auch','sich','bei','oder','wir','aber','wenn','kann','haben','mehr','wie','nach','über','nur','aus','durch','einen','einer','zum','zur','sind'],
  it: ['il','di','che','per','con','una','non','sono','questo','della','del','le','si','più','come','anche','alla','nel','gli','dei','delle','essere','hanno','questa','tra','ma','dal','ai','sul','nella'],
  pt: ['os','um','uma','não','com','para','por','mais','como','seu','sua','dos','das','em','ao','pelo','isso','você','tem','ser','foi','pela','são','muito','quando','também','já','ou','na','da'],
  nl: ['de','het','een','van','voor','met','niet','dat','dit','zijn','worden','ook','naar','maar','bij','uit','deze','wordt','heeft','hebben','kan','meer','als','dan','wat','onze','je'],
  pl: ['nie','się','jest','dla','na','że','ale','jak','po','przez','tego','być','są','oraz','tym','przy','czy','może','tylko','już','bardzo'],
  sv: ['och','att','det','som','för','med','inte','den','är','av','på','har','till','ett','om','ska','kan','från','vi','du','eller','men','efter','vid'],
  no: ['og','det','som','ikke','den','er','av','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','etter','ved','også'],
  da: ['og','det','som','ikke','den','er','af','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','efter','ved','også'],
  fi: ['ja','on','ei','se','että','ovat','tämä','mutta','kun','myös','voi','ole','sen','joka','niin','kuin','jos','vain','mitä'],
  ro: ['și','este','pentru','care','din','pe','cu','nu','mai','sau','sunt','această','acest','dar','după','până','fost','poate','fiecare'],
};
const LANG_SETS = {};
for (const l in LANG_WORDS) {
  const set = {};
  for (const w of LANG_WORDS[l]) set[w] = 1;
  LANG_SETS[l] = set;
}
export function detectLanguageFromSite(html) {
  const text = (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/[぀-ヿｦ-ﾟ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[一-鿿]/.test(text)) return 'zh';

  const words = text.slice(0, 20000).toLowerCase().split(/[^a-zß-ÿĀ-ſȘ-ț]+/);
  let best = 'en', bestN = 0;
  for (const lang in LANG_SETS) {
    const set = LANG_SETS[lang];
    let n = 0;
    for (const w of words) if (set[w]) n++;
    if (n > bestN) { bestN = n; best = lang; }
  }
  // Weak signal (very short/mixed page): default to English, same as widget.js
  if (best !== 'en' && bestN < 10) return 'en';
  return best;
}

async function ensureTables(sql) {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS magic_links (
    id SERIAL PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    publisher_slug TEXT NOT NULL,
    publisher_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_hash TEXT`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_fail_count INT DEFAULT 0`.catch(() => {});
  await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS password_locked_until TIMESTAMPTZ`.catch(() => {});
  tableReady = true;
}

// Issues a session exactly the way the magic-link flow does - password
// login is just a second way to reach this same call, not a parallel
// session mechanism to keep in sync.
async function issueSession(sql, res, pub) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`INSERT INTO sessions (token, publisher_slug, publisher_name, expires_at) VALUES (${sessionToken}, ${pub.slug}, ${pub.name}, ${expiresAt})`;
  res.setHeader('Set-Cookie', `il_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
}

// #introlinq-notifications (real events), not the #introlinq-general feed
// the widget's scan/match activity uses. Awaited, same reason as the /brief
// notifications in admin.js - a serverless function can be frozen the
// instant the response (here, the redirect) is sent.
async function notifyLogin(pubName, method) {
  if (!process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🔓 *${pubName}* logged in (${method})` }),
    });
  } catch {}
}

export async function createMagicToken(sql, email, expiresInMs) {
  await ensureTables(sql);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInMs);
  await sql`INSERT INTO magic_links (token, email, expires_at) VALUES (${token}, ${email}, ${expiresAt})`;
  return token;
}

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  await ensureTables(sql);

  const { action, token } = req.query;

  // GET ?token=xxx - verify magic link, create session, redirect to dashboard
  if (req.method === 'GET' && token) {
    // Reuse of an already-used token is allowed for a short grace window right
    // after first use. Real-world reason: some email providers/security
    // gateways silently pre-fetch links in an email to scan them before the
    // recipient ever opens it, which would otherwise permanently burn a
    // strictly single-use token before the actual human clicks it - they'd
    // see "This login link has expired" seconds after receiving the email
    // and have no way to recover except requesting a whole new link. A link
    // is still dead for good once this window passes or it truly expires.
    const [link] = await sql`
      SELECT * FROM magic_links
      WHERE token = ${token}
        AND expires_at > NOW()
        AND (used_at IS NULL OR used_at > NOW() - INTERVAL '5 minutes')
    `;
    if (!link) return res.redirect(302, '/login?error=expired');

    if (!link.used_at) {
      await sql`UPDATE magic_links SET used_at = NOW() WHERE token = ${token}`;
    }

    const [pub] = await sql`SELECT slug, name FROM publishers WHERE email = ${link.email} AND active = true LIMIT 1`;
    if (!pub) return res.redirect(302, '/login?error=notfound');

    await issueSession(sql, res, pub);
    await notifyLogin(pub.name, 'magic link');
    return res.redirect(302, `/dashboard?pub=${pub.slug}`);
  }

  // GET ?action=me - return session info (used by dashboard page on load,
  // and by chat-widget.js to show a known-publisher's identity in the chat)
  if (req.method === 'GET' && action === 'me') {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });
    const [session] = await sql`
      SELECT s.publisher_slug, s.publisher_name, p.email
      FROM sessions s JOIN publishers p ON p.slug = s.publisher_slug
      WHERE s.token = ${sessionToken} AND s.expires_at > NOW()
    `;
    if (!session) return res.status(401).json({ error: 'Session expired' });
    return res.status(200).json({ slug: session.publisher_slug, name: session.publisher_name, email: session.email });
  }

  // POST ?action=signup - self-service publisher signup
  if (req.method === 'POST' && action === 'signup') {
    const { name, email, domain, contact_first_name, contact_last_name, slug: requestedSlug } = req.body;
    if (!name || !email || !domain) return res.status(400).json({ error: 'Name, email and website are required' });

    const normalised = email.toLowerCase().trim();

    // Check email not already registered
    const [existing] = await sql`SELECT id FROM publishers WHERE email = ${normalised} LIMIT 1`;
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });

    // Generate unique slug
    const base = (requestedSlug || name)
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
    let slug = base;
    let suffix = 2;
    while (true) {
      const [taken] = await sql`SELECT id FROM publishers WHERE slug = ${slug} LIMIT 1`;
      if (!taken) break;
      slug = `${base}-${suffix++}`;
    }

    // Normalise domain
    let cleanDomain = domain.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleanDomain)) cleanDomain = 'https://' + cleanDomain;

    // no_match_fallback_enabled: true - unlike the column's own DEFAULT
    // false (existing publishers opted in one at a time), every new
    // account starts with the no-match fallback on from day one.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS no_match_fallback_enabled BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    const [pub] = await sql`
      INSERT INTO publishers (name, email, slug, domain, contact_first_name, contact_last_name, revenue_share, active, no_match_fallback_enabled)
      VALUES (${name.trim()}, ${normalised}, ${slug}, ${cleanDomain},
              ${contact_first_name?.trim() || null}, ${contact_last_name?.trim() || null},
              0.50, true, true)
      RETURNING *
    `;

    // Best-effort platform detection - never allowed to fail or meaningfully
    // delay signup. A wrong or missing result just means the Get Started
    // tab falls back to the manual picker, same as before this existed.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform TEXT`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS platform_detected BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
    // widget_language: read by api/board.js (carousel.js/expertboard.js) as
    // the site-level default those two widgets show in - detected once here
    // rather than per-page like widget.js's own detectLanguage(), since
    // neither has article text of its own to detect from. NULL means
    // detection failed/never ran; those widgets fall back to <html lang>
    // then 'en', same as before this existed.
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_language TEXT`.catch(() => {});
    try {
      const siteRes = await fetch(cleanDomain, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'IntroLinq-PlatformDetect/1.0 (+https://www.introlinq.com)' },
      });
      if (siteRes.ok) {
        const html = await siteRes.text();
        const detected = detectPlatformFromSite(new URL(cleanDomain).hostname, html);
        if (detected) {
          await sql`UPDATE publishers SET platform = ${detected}, platform_detected = true WHERE id = ${pub.id}`;
        }
        const detectedLang = detectLanguageFromSite(html);
        await sql`UPDATE publishers SET widget_language = ${detectedLang} WHERE id = ${pub.id}`;
      }
    } catch {}

    // Send welcome email with 7-day magic link
    const token = await createMagicToken(sql, normalised, 7 * 24 * 60 * 60 * 1000);
    const link = `https://www.introlinq.com/api/auth?token=${token}`;
    const firstName = contact_first_name?.trim() || name.trim();

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: normalised,
        subject: `Welcome to IntroLinq, ${firstName} - your dashboard is ready`,
        html: welcomeEmail(firstName, link, slug),
      })
    }).catch(() => {});

    // Add to the general mailing list (Resend audience) so product updates,
    // new partners and new-platform-support news reach them through normal
    // broadcasts - which also covers long-term re-engagement without a
    // bespoke cron. Resend manages unsubscribe on the broadcast side.
    if (process.env.RESEND_AUDIENCE_ID) {
      fetch(`https://api.resend.com/audiences/${process.env.RESEND_AUDIENCE_ID}/contacts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: normalised,
          first_name: (contact_first_name?.trim() || name.trim().split(' ')[0] || ''),
          last_name: (contact_last_name?.trim() || ''),
          unsubscribed: false,
        }),
      }).catch(() => {});
    }

    // Slack notification - #introlinq-notifications (real events), not the
    // #introlinq-general feed the widget's scan/match activity uses.
    if (process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) {
      fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `📝 New publisher signed up (not yet installed): *${name.trim()}* (${normalised}) - ${cleanDomain}` })
      }).catch(() => {});
    }

    notifyTeam(
      `New publisher signup: ${name.trim()}`,
      `<p><strong>${escapeHtml(name.trim())}</strong> (${escapeHtml(normalised)}) just signed up.</p><p>Domain: ${escapeHtml(cleanDomain)}</p><p>Not yet installed.</p>`
    ).catch(() => {});

    return res.status(201).json({ ok: true, slug });
  }

  // POST ?action=check-method { email } - tells the login page whether to
  // reveal a password field. Always returns hasPassword:false for an
  // unknown email, same as "no password set" - never reveals whether an
  // email is a registered publisher.
  if (req.method === 'POST' && action === 'check-method') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalised = email.toLowerCase().trim();
    const [pub] = await sql`SELECT password_hash FROM publishers WHERE email = ${normalised} AND active = true LIMIT 1`;
    return res.status(200).json({ hasPassword: !!(pub && pub.password_hash) });
  }

  // POST ?action=password-login { email, password } - the one genuinely new
  // unauthenticated attack surface this feature adds (a magic-link token is
  // a 32-byte random value, too large to brute-force; a password isn't) -
  // see PASSWORD_MAX_ATTEMPTS/PASSWORD_LOCKOUT_MS above.
  if (req.method === 'POST' && action === 'password-login') {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const normalised = email.toLowerCase().trim();

    const [pub] = await sql`
      SELECT id, slug, name, password_hash, password_fail_count, password_locked_until
      FROM publishers WHERE email = ${normalised} AND active = true LIMIT 1
    `;

    // Same generic error whether the email doesn't exist, has no password
    // set, is locked out, or the password is simply wrong - never reveal
    // which case it was, or this becomes an account-enumeration oracle.
    const genericError = () => res.status(401).json({ error: 'Invalid email or password' });

    if (!pub || !pub.password_hash) return genericError();
    if (pub.password_locked_until && new Date(pub.password_locked_until) > new Date()) return genericError();

    const valid = await bcrypt.compare(password, pub.password_hash);
    if (!valid) {
      const failCount = (pub.password_fail_count || 0) + 1;
      const lockUntil = failCount >= PASSWORD_MAX_ATTEMPTS ? new Date(Date.now() + PASSWORD_LOCKOUT_MS) : null;
      await sql`UPDATE publishers SET password_fail_count = ${lockUntil ? 0 : failCount}, password_locked_until = ${lockUntil} WHERE id = ${pub.id}`;
      return genericError();
    }

    await sql`UPDATE publishers SET password_fail_count = 0, password_locked_until = NULL WHERE id = ${pub.id}`;
    await issueSession(sql, res, pub);
    await notifyLogin(pub.name, 'password');
    return res.status(200).json({ ok: true, slug: pub.slug });
  }

  // POST { email } - send login magic link
  if (req.method === 'POST') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const normalised = email.toLowerCase().trim();
    // A malformed string ("openintro", not an email at all) gets a real
    // error instead of the generic "check your email" - that's a pure
    // format check, not an account-existence leak, so it doesn't weaken
    // the enumeration protection below.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const [pub] = await sql`SELECT slug FROM publishers WHERE email = ${normalised} AND active = true LIMIT 1`;
    if (!pub) return res.status(200).json({ ok: true }); // Don't reveal whether email exists

    const token = await createMagicToken(sql, normalised, 15 * 60 * 1000);
    const link = `https://www.introlinq.com/api/auth?token=${token}`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: normalised,
        subject: 'Your IntroLinq login link',
        html: loginEmail(link),
      })
    });

    return res.status(200).json({ ok: true });
  }

  // DELETE - logout
  if (req.method === 'DELETE') {
    const sessionToken = getSessionToken(req);
    if (sessionToken) await sql`DELETE FROM sessions WHERE token = ${sessionToken}`;
    res.setHeader('Set-Cookie', 'il_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}

function welcomeEmail(name, link, slug) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Welcome, ${name} 👋</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Your IntroLinq dashboard is ready. Click below to access it and get your embed code - this link is valid for 7 days.</p>
    <a href="${link}" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">Access my dashboard →</a>
    <div style="margin:24px 0;padding:16px;background:#faf8f4;border-radius:8px;border:1px solid rgba(26,26,46,0.08)">
      <p style="margin:0 0 6px;font-size:0.75rem;font-weight:600;color:#8888a8;text-transform:uppercase;letter-spacing:0.05em">Your embed code</p>
      <code style="font-size:0.75rem;color:#3d7a5f;word-break:break-all">&lt;script src="https://www.introlinq.com/widget.js" data-publisher="${slug}"&gt;&lt;/script&gt;</code>
    </div>
    <p style="margin:0;font-size:0.75rem;color:#8888a8;text-align:center">Paste this before the &lt;/body&gt; tag in your blog template to get started.</p>
  </div>
</div>
</body></html>`;
}

function loginEmail(link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">Access your dashboard</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">Click the button below to log in. This link expires in 15 minutes and can only be used once.</p>
    <a href="${link}" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">Access my dashboard →</a>
    <p style="margin:20px 0 0;font-size:0.75rem;color:#8888a8;text-align:center">If you didn't request this, you can safely ignore this email.</p>
  </div>
</div>
</body></html>`;
}
