// Free, no-credit contact finder that reads a lead's own site for a real
// email address - a useful complement to Apollo, which is built around
// registered companies with LinkedIn-style employee records and often has
// nothing on file for a solo blogger. Tried before Apollo in enrich.js's
// loop so a successful scrape also saves an Apollo credit.

const FETCH_TIMEOUT_MS = 7000;
const CANDIDATE_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/write-for-us'];

// Known platform/system addresses and placeholder domains that regularly
// show up in page source but are never the right outreach target.
const JUNK_DOMAINS = [
  'sentry.io', 'wixpress.com', 'godaddy.com', 'cloudflare.com', 'schema.org',
  'w3.org', 'example.com', 'yourdomain.com', 'email.com', 'domain.com',
  'wordpress.org', 'wordpress.com', 'gravatar.com', 'mailchimp.com',
  'sendgrid.net', 'googlemail.com', '2x.png', 'sentry-next.wixpress.com',
];
const JUNK_LOCAL_PARTS = ['noreply', 'no-reply', 'donotreply', 'postmaster', 'webmaster@wordpress'];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function isJunkEmail(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!domain) return true;
  if (JUNK_DOMAINS.some((j) => domain.includes(j))) return true;
  if (JUNK_LOCAL_PARTS.some((j) => local.includes(j))) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(domain)) return true;
  return false;
}

function extractEmails(html) {
  const found = new Set();
  const mailtoRe = /mailto:([^"'?\s]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    const addr = decodeURIComponent(m[1]).trim();
    if (EMAIL_RE.test(addr) && !isJunkEmail(addr)) found.add(addr.toLowerCase());
    EMAIL_RE.lastIndex = 0;
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  while ((m = EMAIL_RE.exec(text))) {
    if (!isJunkEmail(m[0])) found.add(m[0].toLowerCase());
  }
  return [...found];
}

// Best-effort only - a missing name just means the email template falls
// back to "Hi there" (see outreachEmailTemplates), so this doesn't need to
// be exhaustive, just free upside when it's easy to find.
function extractName(html) {
  const metaMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["']/i);
  if (metaMatch && metaMatch[1].trim().split(/\s+/).length <= 4) return metaMatch[1].trim();

  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const byMatch = text.match(/\b(?:written by|by|hi,?\s*i'?m|i'?m)\s+([A-Z][a-z]+ [A-Z][a-z]+)\b/);
  if (byMatch) return byMatch[1];

  return null;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntroLinqBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Picks the best candidate when multiple emails are found: prefers an
// address on the lead's own domain over a third-party one (e.g. a personal
// Gmail mentioned in a testimonial), but still returns something rather
// than nothing if no same-domain match exists.
function pickBestEmail(emails, domain) {
  if (!emails.length) return null;
  const bareDomain = domain.replace(/^www\./, '');
  const sameDomain = emails.find((e) => e.split('@')[1]?.endsWith(bareDomain));
  return sameDomain || emails[0];
}

// Returns {email, name} or null. Checks the homepage first, then a handful
// of common contact/about paths only if the homepage didn't have one -
// most sites resolve on the first fetch, so this rarely needs more than
// one request.
export async function findContactOnSite(domain) {
  const base = `https://${domain}`;
  for (const path of CANDIDATE_PATHS) {
    const html = await fetchPage(base + path);
    if (!html) continue;
    const emails = extractEmails(html);
    const email = pickBestEmail(emails, domain);
    if (email) {
      return { email, name: extractName(html) };
    }
  }
  return null;
}
