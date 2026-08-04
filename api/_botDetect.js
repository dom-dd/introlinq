// Shared bot-burst detection used by match.js (impressions) and
// dashboard.js (clicks/hovers/seen). A real reader's single page-view can
// legitimately fire more than one tracking call against the same page
// (e.g. match.js's quick + report pair), so the threshold sits well above
// that - the first 3 hits from a given IP to the same page/publisher inside
// the window always pass as real; only the 4th-and-beyond is treated as
// automated. Nothing is blocked or hidden from the widget itself - is_bot
// only keeps a row out of the public-facing counts and Slack notifications,
// so a wrong call here never breaks the product, just mislabels one
// analytics row.
const BURST_WINDOW_INTERVAL = '2 minutes';
const BURST_THRESHOLD = 3;

// Not user input - always one of the 4 literal table names below - but
// allowlisted anyway since the table name is string-interpolated (Postgres
// can't parameterize identifiers) rather than passed as a query param.
// match_logs' URL column is `page_url`; the other three use `article_url`.
const TABLE_URL_COLUMNS = {
  match_logs: 'page_url',
  click_logs: 'article_url',
  hover_logs: 'article_url',
  seen_logs: 'article_url',
};

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : null) || req.socket?.remoteAddress || null;
}

// Server-side infrastructure blocks for platforms whose automated systems
// are known to visit every outbound link on a page - not a real reader's
// own device (which shows up on their ISP/mobile carrier, not a tech
// company's corporate ASN), so no volume threshold is needed here the way
// isBurstTraffic/isSitewideBurst need one - a single hit from a known
// crawler range is enough. Deliberately a short, explicit, manually-
// maintained list (not a live lookup - see below) rather than broad or
// automatic, so a wrong entry here is easy to spot and remove.
//
// 57.141.0.0/16: confirmed via ipinfo.io as AS32934 (Facebook/Meta) on
// 2026-07-30, after tchelete's carousel got hit by ~5,950 clicks from 195
// IPs across this exact range in one day - source was 100% "carousel",
// one hit per distinct expert per page, matching Meta's link-preview/
// safety-scanning behaviour (visiting every clickable link on a page that
// was shared on Facebook/Instagram/WhatsApp), not real readers.
// 66.249.64.0/19: Google's own officially documented Googlebot range
// (developers.google.com/search/docs/crawling-indexing/verifying-googlebot).
// Already caught going forward by isAllowlistedCrawler's User-Agent check,
// but that signal isn't stored anywhere per-row, so a historical row has no
// way to prove which UA made it - this IP-range entry is what lets the
// retroactive is_bot backfill recover Googlebot traffic that predates the
// User-Agent check being wired in. Confirmed 2026-08-03 on challenges-tn:
// 66.249.65.195-198 each hit hundreds of distinct pages in a systematic
// ~1:1 page:hit pattern, the classic signature of a real crawl rather than
// a handful of repeat readers.
const KNOWN_CRAWLER_RANGES = [
  { cidr: '57.141.0.0/16', note: 'Facebook/Meta (AS32934) - link preview/safety crawler, confirmed 2026-07-30' },
  { cidr: '66.249.64.0/19', note: 'Google (AS15169) - Googlebot crawl range, confirmed 2026-08-03' },
];

function ipToInt(ip) {
  const parts = (ip || '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

function isIpInCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  const bits = Number(bitsStr);
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// Deliberately NOT a live lookup (e.g. an ipinfo.io call) - that would add
// external-network latency and a third-party dependency to every single
// tracked request, and risks hitting that provider's rate limits under
// real traffic. This only ever checks against the small hardcoded list
// above, so it's instant and has no failure mode beyond "list needs a new
// entry someday".
export function isKnownCrawlerIp(ip) {
  if (!ip) return false;
  return KNOWN_CRAWLER_RANGES.some(r => isIpInCidr(ip, r.cidr));
}

// Known-good AI/search crawlers always get a real scan, never the
// serve-stale-cache short-circuit below - these are the ones that might
// actually represent IntroLinq's widget content to someone else's
// audience, so accuracy matters more here than for anonymous traffic, and
// legitimate crawlers don't hammer the same URL rapidly the way the bot
// traffic this was built for does.
const CRAWLER_UA_ALLOWLIST = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|Googlebot|Google-Extended|Bingbot|DuckDuckBot|Applebot/i;

export function isAllowlistedCrawler(req) {
  const ua = req.headers['user-agent'] || '';
  return CRAWLER_UA_ALLOWLIST.test(ua);
}

export async function isBurstTraffic(sql, table, { ip, publisher, page_url }) {
  const urlColumn = TABLE_URL_COLUMNS[table];
  if (!urlColumn) throw new Error('isBurstTraffic: invalid table ' + table);
  if (!ip || !page_url) return false;
  const rows = await sql.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ip = $1 AND publisher = $2 AND ${urlColumn} = $3 AND created_at > NOW() - INTERVAL '${BURST_WINDOW_INTERVAL}'`,
    [ip, publisher || '', page_url]
  ).catch(() => [{ n: 0 }]);
  return (rows[0]?.n || 0) >= BURST_THRESHOLD;
}

// Catches a different bot shape than isBurstTraffic above: one that
// deliberately spreads its hits across many DIFFERENT pages of the same
// publisher - often from a rotating pool of IPs - specifically to stay
// under the per-page threshold. Found on tchelete: 195 IPs (all sequential
// within one /24-ish block), each hitting ~35-45 different pages once
// each, never repeating a page - invisible to the per-page check no matter
// how low its threshold went. A real reader essentially never racks up
// double-digit clicks/hovers/seens on ONE publisher's site in a day
// regardless of how many different pages they're spread across - 10 is
// comfortably above genuine engagement and comfortably below what every
// bot IP in that incident actually did.
const SITEWIDE_WINDOW_INTERVAL = '24 hours';
const SITEWIDE_THRESHOLD = 10;

export async function isSitewideBurst(sql, table, { ip, publisher }) {
  if (!TABLE_URL_COLUMNS[table]) throw new Error('isSitewideBurst: invalid table ' + table);
  if (!ip) return false;
  const rows = await sql.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ip = $1 AND publisher = $2 AND created_at > NOW() - INTERVAL '${SITEWIDE_WINDOW_INTERVAL}'`,
    [ip, publisher || '']
  ).catch(() => [{ n: 0 }]);
  return (rows[0]?.n || 0) >= SITEWIDE_THRESHOLD;
}

// Single source of truth for "should this row count as a bot" - combines
// every signal (known-crawler IP range, known-crawler User-Agent, same-page
// burst, sitewide burst) so a signal added to one call site is never
// accidentally missing from another. isAllowlistedCrawler was previously
// wired only into the stale-cache-serve decision in match.js, never into
// any is_bot tagging - which meant Googlebot/Bingbot/GPTBot/etc traffic
// (identifiable by User-Agent even when its IP range isn't hardcoded, e.g.
// Googlebot's 66.249.64.0/19) sailed through untagged into match_logs,
// inflating Page visits for every publisher it crawled. A crawler is never
// a genuine reader regardless of whether its purpose is "good" (indexing)
// or "bad" (scraping), so all get the same is_bot=true treatment here.
export async function isBotHit(req, sql, table, { ip, publisher, page_url }) {
  if (isKnownCrawlerIp(ip) || isAllowlistedCrawler(req)) return true;
  if (await isBurstTraffic(sql, table, { ip, publisher, page_url })) return true;
  return isSitewideBurst(sql, table, { ip, publisher });
}

export async function ensureBotColumns(sql, table) {
  const urlColumn = TABLE_URL_COLUMNS[table];
  if (!urlColumn) throw new Error('ensureBotColumns: invalid table ' + table);
  await Promise.all([
    sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ip TEXT`).catch(() => {}),
    sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false`).catch(() => {}),
  ]);
  await Promise.all([
    sql.query(`CREATE INDEX IF NOT EXISTS ${table}_ip_page_idx ON ${table}(ip, publisher, ${urlColumn}, created_at)`).catch(() => {}),
    sql.query(`CREATE INDEX IF NOT EXISTS ${table}_ip_pub_idx ON ${table}(ip, publisher, created_at)`).catch(() => {}),
  ]);
}
