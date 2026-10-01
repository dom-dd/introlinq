// Fast, non-AI liveness sweep over the Untouched bucket (status='discovered').
// A genuine network-level failure (DNS doesn't resolve, connection refused,
// timeout, 404/410) is a high-confidence "this isn't a real site" signal on
// its own - no AI judgment call needed, unlike reject-unfit-todo.js's
// content judgment, which deliberately leaves ambiguous fetch failures
// alone rather than risk a wrong rejection. This only acts on the
// unambiguous case: nothing answered at all.
//
// Usage: node discovery/check-dead-urls.js [--limit N] [--dry-run]

import { sql } from './lib/db.js';

const CONCURRENCY = 15;
const FETCH_TIMEOUT_MS = 7000;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg) + 1], 10) : null;

// Status codes that mean "the server answered and said this page is gone" -
// as opposed to 401/403/429 etc, which usually mean something is blocking
// us specifically (bot detection, rate limit), not that the site is dead.
const DEAD_STATUS_CODES = new Set([404, 410]);

// Domain-parking/for-sale/registrar-placeholder markers - these return a
// normal HTTP 200, so the status code alone can't catch them. Matched
// case-insensitively against the raw HTML of the response.
const PARKED_PAGE_MARKERS = [
  'this domain is for sale', 'buy this domain', 'domain may be for sale',
  'this domain has expired', 'domain name is parked', 'parkingcrew',
  'sedoparking', 'sedo.com', 'bodis.com', 'above.com', 'hugedomains.com',
  'dan.com/buy-domain', 'godaddy.com/domains', 'is coming soon',
  'future home of something quite cool', 'account has been suspended',
  'this site can’t be reached', 'this site can not be reached',
];

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function checkOne(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntroLinqBot/1.0)' },
      });
      if (DEAD_STATUS_CODES.has(res.status)) return { dead: true, reason: `HTTP ${res.status}` };
      if (res.ok) {
        const html = await res.text();
        const lower = html.toLowerCase();
        const marker = PARKED_PAGE_MARKERS.find((m) => lower.includes(m));
        if (marker) return { dead: true, reason: `parked page ("${marker}")` };
        // Short/empty raw HTML is ambiguous, not high-confidence - a
        // meta-refresh redirect or a bot-challenge page (both seen in
        // testing) also look "empty" to a plain fetch despite the site
        // being real, so this only gets flagged for manual review, not
        // auto-moved.
        const text = stripHtmlToText(html);
        if (text.length < 40 && !/meta\s+http-equiv=["']?refresh/i.test(html)) {
          return { dead: false, ambiguous: true, reason: 'very short/empty response' };
        }
      }
      return { dead: false };
    } catch (err) {
      const code = err.cause?.code || err.code || err.name;
      // ENOTFOUND/EAI_AGAIN = DNS doesn't resolve, ECONNREFUSED = nothing
      // listening, ECONNRESET = dropped mid-request - all unambiguous.
      // A plain timeout (AbortError/TimeoutError) gets a second try before
      // counting it, since a slow-but-real server shouldn't get one shot.
      const hardFailure = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET'].includes(code);
      if (hardFailure) return { dead: true, reason: code };
      if (attempt === 1) return { dead: false }; // timeout twice - inconclusive, leave it alone
    }
  }
  return { dead: false };
}

async function runPool(items, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
}

async function main() {
  let rows = await sql`SELECT id, domain, homepage_url FROM candidate_publishers WHERE status = 'discovered' ORDER BY id`;
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log(`Checking ${rows.length} Untouched leads...`);

  let dead = 0, ambiguous = 0, checked = 0;
  const ambiguousList = [];
  await runPool(rows, async (row) => {
    const result = await checkOne(row.homepage_url);
    checked++;
    if (result.dead) {
      dead++;
      console.log(`[${checked}/${rows.length}] DEAD (${result.reason}): ${row.domain}`);
      if (!DRY_RUN) {
        await sql`UPDATE candidate_publishers SET status = 'invalid_url' WHERE id = ${row.id}`;
      }
    } else if (result.ambiguous) {
      ambiguous++;
      ambiguousList.push(`${row.domain} (${result.reason})`);
    } else if (checked % 200 === 0) {
      console.log(`[${checked}/${rows.length}] ... (${dead} dead so far)`);
    }
  });

  console.log(`\nDone. ${dead} of ${checked} leads marked invalid_url${DRY_RUN ? ' (dry run, nothing written)' : ''}.`);
  console.log(`${ambiguous} more looked suspicious (short/empty response) but were left alone - not high-confidence enough to auto-move:`);
  for (const line of ambiguousList) console.log(`  ${line}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
