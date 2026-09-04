// Resumable crawler for blog-directory.org (see discovery/lib/blogdirectory.js) -
// a large self-submission directory (27k+ "business"-tagged listings as of
// Sept 2026, ~1,153 pages at 24 listings/page). Most listings are single
// promotional posts from local businesses/agencies rather than real blogs
// (confirmed by hand on the first few pages) - this script's only job is
// turning directory listings into raw candidate_publishers rows; the actual
// publisher/vendor judgment happens downstream in classify.js and
// verify-publisher-fit.js exactly like every other discovery source.
//
// Progress (which page we're up to for a given query) lives in
// blogdirectory_progress so repeated runs (this cron included) page forward
// instead of re-scraping page 1 every time. At the cron's default --pages
// budget this works through the ~1,153-page "business" query over roughly
// three weeks, not in one sitting - see .github/workflows/discovery-cron.yml.
//
// Usage: node discovery/discover-blogdirectory.js --pages 15 [--query business]

import { sql, ensureSchema } from './lib/db.js';
import { isBlacklistedDomain, isInstitutionalDomain } from './lib/serpapi.js';
import { fetchSearchPage, fetchDetailPage, runPool } from './lib/blogdirectory.js';

const CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { pages: 15, query: 'business' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages') args.pages = parseInt(argv[++i], 10) || args.pages;
    if (argv[i] === '--query') args.query = argv[++i];
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureProgressTable() {
  await sql`CREATE TABLE IF NOT EXISTS blogdirectory_progress (
    query TEXT PRIMARY KEY,
    next_page INT NOT NULL DEFAULT 1,
    total_pages INT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

function domainFromUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

async function main() {
  const { pages, query } = parseArgs(process.argv.slice(2));
  await ensureSchema();
  await ensureProgressTable();

  const inserted_ = await sql`
    INSERT INTO blogdirectory_progress (query) VALUES (${query})
    ON CONFLICT (query) DO NOTHING
    RETURNING next_page, total_pages
  `;
  const row = inserted_[0] || (await sql`SELECT next_page, total_pages FROM blogdirectory_progress WHERE query = ${query}`)[0];
  let nextPage = row.next_page;
  let totalPages = row.total_pages;

  if (totalPages && nextPage > totalPages) {
    console.log(`"${query}" is fully crawled (${totalPages} pages) - nothing left to do. Pass a different --query to keep going.`);
    return;
  }

  console.log(`Starting at page ${nextPage} of "${query}"${totalPages ? ` (${totalPages} total)` : ''}, budget ${pages} page(s) this run.`);

  let inserted = 0, dupes = 0, filtered = 0, noUrl = 0, pagesRun = 0;

  for (let i = 0; i < pages; i++) {
    const page = nextPage + i;
    if (totalPages && page > totalPages) {
      console.log(`Reached the last page (${totalPages}) of "${query}".`);
      break;
    }

    let slugs, pageTotal;
    try {
      ({ slugs, totalPages: pageTotal } = await fetchSearchPage(query, page));
    } catch (err) {
      // Stop rather than skip ahead - a transient failure shouldn't burn a
      // page's worth of listings; the next run retries this same page since
      // progress is only advanced after a page succeeds, below.
      console.error(`[page ${page}] FAILED to fetch: ${err.message}`);
      break;
    }
    if (pageTotal) totalPages = pageTotal;
    if (slugs.length === 0) {
      console.log(`[page ${page}] no listings found - treating as the end of "${query}".`);
      totalPages = page - 1;
      break;
    }

    await runPool(slugs, async (slug) => {
      let detail;
      try {
        detail = await fetchDetailPage(slug);
      } catch (err) {
        console.error(`  [${slug}] FAILED to fetch detail page: ${err.message}`);
        return;
      }
      const domain = domainFromUrl(detail.blogUrl);
      if (!domain) {
        noUrl++;
        return;
      }
      if (isBlacklistedDomain(domain) || isInstitutionalDomain(domain)) {
        filtered++;
        return;
      }

      const result = await sql`
        INSERT INTO candidate_publishers (domain, homepage_url, title, discovery_query, discovery_source)
        VALUES (${domain}, ${'https://' + domain}, ${detail.title}, ${`blogdirectory:${query}:${slug}`}, 'blogdirectory')
        ON CONFLICT (domain) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted++;
      else dupes++;
    }, CONCURRENCY);

    pagesRun++;
    console.log(`[page ${page}/${totalPages || '?'}] ${slugs.length} listings resolved`);
    await sql`
      UPDATE blogdirectory_progress SET next_page = ${page + 1}, total_pages = ${totalPages || null}, updated_at = NOW()
      WHERE query = ${query}
    `;
    await sleep(500);
  }

  console.log(`\nDone. ${pagesRun} page(s) crawled, ${inserted} new domains added, ${dupes} already known, ${filtered} filtered (blacklisted/institutional), ${noUrl} had no resolvable external URL.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
