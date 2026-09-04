// blog-directory.org discovery source - a large (27k+ business-tagged
// listings as of Sept 2026) self-submission directory. Confirmed by hand
// that most listings are single promotional posts from local businesses/
// agencies rather than real blogs, not the curated-listicle problem the
// blacklist in lib/serpapi.js was built for - candidates from here still go
// through the normal classify.js / verify-publisher-fit.js filters like
// every other source, this module's only job is turning directory listings
// into the { domain, homepage_url, title } shape those expect.
//
// There's no public list/search API - a search-results page only exposes
// internal /blog/<slug> paths; the real external site only appears on that
// slug's own detail page (baked into a `blogUrl` field in the page's React
// Server Component payload, not a plain <a href>). So every candidate costs
// one extra fetch to resolve. Both the slug list and the detail page's
// blogUrl are present in the raw HTML response as-is (a Next.js streaming-
// SSR payload) - no JS execution needed, plain fetch + regex is enough.

const BASE = 'https://www.blog-directory.org';
const UA = 'Mozilla/5.0 (compatible; IntroLinqBot/1.0)';
const FETCH_TIMEOUT_MS = 10000;

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

// Extracts every /blog/<slug> link on a search-results page (order of first
// appearance, deduped) plus the highest page number referenced by any
// pagination link on the page (its own page number included, so the last
// page correctly reports itself as the max once reached).
export function parseSearchPage(html) {
  const slugs = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/blog\/([a-z0-9-]+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      slugs.push(m[1]);
    }
  }
  let totalPages = null;
  for (const m of html.matchAll(/page=(\d+)/g)) {
    const n = parseInt(m[1], 10);
    if (!totalPages || n > totalPages) totalPages = n;
  }
  return { slugs, totalPages };
}

export async function fetchSearchPage(query, page) {
  const url = `${BASE}/discover?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`;
  return parseSearchPage(await fetchText(url));
}

// The detail page embeds the real external post URL as `"blogUrl":"..."`
// inside an escaped JSON string within the RSC payload - the literal bytes
// in the response are `\"blogUrl\":\"https://...\"`, hence matching a
// literal backslash-quote delimiter rather than a normal JSON key. Title
// comes from the plain <title> tag instead (no escaping to worry about),
// with the site's own " · Blog Directory" suffix stripped.
export function parseDetailPage(html) {
  const urlMatch = html.match(/\\"blogUrl\\":\\"([^\\]+)/);
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const blogUrl = urlMatch ? urlMatch[1] : null;
  const rawTitle = titleMatch ? titleMatch[1] : null;
  const title = rawTitle ? rawTitle.replace(/\s*[·.]\s*Blog Directory\s*$/i, '').trim() || null : null;
  return { blogUrl, title };
}

export async function fetchDetailPage(slug) {
  return parseDetailPage(await fetchText(`${BASE}/blog/${slug}`));
}

// Small concurrency-pool runner (same shape as verify-publisher-fit.js) -
// resolving detail pages one at a time would make a 24-listing page take
// too long; unbounded parallelism would hammer a third party's server.
export async function runPool(items, worker, concurrency) {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}
