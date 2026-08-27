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

// Countries where a large share of real mobile traffic exits through a
// small number of carrier-grade NAT gateways, so hundreds of distinct real
// readers can share one public IP. isSitewideBurst's flat per-IP count
// can't tell "one bot IP" from "one CGNAT gateway serving a national news
// site's real audience" - confirmed 2026-08-18 on challenges-tn (Tunisia):
// a single IP logged 30k+ hits over 18 days, comfortably real audience
// volume, not a bot, which flipped ~75% of the publisher's real traffic to
// is_bot=true and made the widget look dead on their dashboard until they
// removed it. isBurstTraffic (same-page, 2-minute window) still applies
// regardless of country and catches genuine same-page hammering - only
// this cross-page check is skipped, since it's the one that specifically
// can't distinguish "many pages hit by one bot" from "many pages read by
// many real people behind the same gateway."
const SITEWIDE_BURST_EXEMPT_COUNTRIES = ['TN'];

export async function isSitewideBurst(sql, table, { ip, publisher, country }) {
  if (!TABLE_URL_COLUMNS[table]) throw new Error('isSitewideBurst: invalid table ' + table);
  if (!ip) return false;
  if (country && SITEWIDE_BURST_EXEMPT_COUNTRIES.includes(country.toUpperCase())) return false;
  const rows = await sql.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ip = $1 AND publisher = $2 AND created_at > NOW() - INTERVAL '${SITEWIDE_WINDOW_INTERVAL}'`,
    [ip, publisher || '']
  ).catch(() => [{ n: 0 }]);
  return (rows[0]?.n || 0) >= SITEWIDE_THRESHOLD;
}

// Catches a THIRD bot shape, distinct from both isBurstTraffic (same IP,
// same page, rapid-fire) and isSitewideBurst (same IP, 10+ hits/24h
// regardless of page): a large ROTATING POOL of IPs, each making only a
// handful of hits, so no single IP ever reaches the sitewide threshold -
// but every one of those hits lands on a page/expert that IP has never
// touched before. Found on tchelete 2026-08-27: 140+ distinct IPs across
// three separate Asian cloud ASNs (Tencent 132203, Alibaba 45102, Byteplus/
// ByteDance 150436 - confirmed via RIPEstat, not residential/mobile space)
// in 3 days, each doing 4-8 clicks with zero repeated pages - the same
// "one hit per distinct expert per page" signature as the 2026-07-30 Meta
// incident, just spread across ~2,400 scattered cloud sub-ranges instead of
// one clean /16, which makes hardcoding CIDRs (isKnownCrawlerIp's approach)
// unmaintainable here - tomorrow's crawl uses fresh IPs from the same
// clouds. Calibrated against 30 days of real traffic on every OTHER
// publisher: no genuine reader IP ever produced a perfect no-repeat fan-out
// this large, so FAN_OUT_THRESHOLD is set just above the largest real one
// seen (a 5-page burst from what looks like internal testing traffic).
// Shares isSitewideBurst's CGNAT country exemption for the same reason: a
// shared gateway serving many real readers naturally produces "many
// distinct pages, no repeats" from one IP, which this check can't tell
// apart from one bot enumerating pages - isSitewideBurst already carries
// that same blind spot and this is the same class of check.
const FAN_OUT_THRESHOLD = 4;

export async function isFanoutBurst(sql, table, { ip, publisher, page_url, country }) {
  const urlColumn = TABLE_URL_COLUMNS[table];
  if (!urlColumn) throw new Error('isFanoutBurst: invalid table ' + table);
  if (!ip || !page_url) return false;
  if (country && SITEWIDE_BURST_EXEMPT_COUNTRIES.includes(country.toUpperCase())) return false;
  const rows = await sql.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT ${urlColumn})::int AS pages,
            COUNT(*) FILTER (WHERE ${urlColumn} = $3)::int AS same_page
     FROM ${table} WHERE ip = $1 AND publisher = $2 AND created_at > NOW() - INTERVAL '${SITEWIDE_WINDOW_INTERVAL}'`,
    [ip, publisher || '', page_url]
  ).catch(() => [{ n: 0, pages: 0, same_page: 0 }]);
  const { n, pages, same_page } = rows[0] || { n: 0, pages: 0, same_page: 0 };
  // same_page > 0 means this exact page was already hit by this IP - that's
  // a repeat, breaking the no-repeat fan-out signature, so exempt it (it's
  // isBurstTraffic/isSitewideBurst's job to catch same-page repeats instead).
  if (same_page > 0) return false;
  return n > 0 && n === pages && (n + 1) >= FAN_OUT_THRESHOLD;
}

// Single source of truth for "should this row count as a bot" - combines
// every signal (known-crawler IP range, known-crawler User-Agent, same-page
// burst, sitewide burst, distributed fan-out burst) so a signal added to
// one call site is never accidentally missing from another. isAllowlistedCrawler
// was previously wired only into the stale-cache-serve decision in match.js,
// never into any is_bot tagging - which meant Googlebot/Bingbot/GPTBot/etc
// traffic (identifiable by User-Agent even when its IP range isn't
// hardcoded, e.g. Googlebot's 66.249.64.0/19) sailed through untagged into
// match_logs, inflating Page visits for every publisher it crawled. A
// crawler is never a genuine reader regardless of whether its purpose is
// "good" (indexing) or "bad" (scraping), so all get the same is_bot=true
// treatment here.
export async function isBotHit(req, sql, table, { ip, publisher, page_url }) {
  if (isKnownCrawlerIp(ip) || isAllowlistedCrawler(req)) return true;
  if (await isBurstTraffic(sql, table, { ip, publisher, page_url })) return true;
  const country = req.headers['x-vercel-ip-country'];
  if (await isFanoutBurst(sql, table, { ip, publisher, page_url, country })) return true;
  return isSitewideBurst(sql, table, { ip, publisher, country });
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
