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
