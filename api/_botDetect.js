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

export async function ensureBotColumns(sql, table) {
  const urlColumn = TABLE_URL_COLUMNS[table];
  if (!urlColumn) throw new Error('ensureBotColumns: invalid table ' + table);
  await Promise.all([
    sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ip TEXT`).catch(() => {}),
    sql.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false`).catch(() => {}),
  ]);
  await sql.query(`CREATE INDEX IF NOT EXISTS ${table}_ip_page_idx ON ${table}(ip, publisher, ${urlColumn}, created_at)`).catch(() => {});
}
