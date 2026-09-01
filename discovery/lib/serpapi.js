const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
const SERPAPI_ACCOUNT_ENDPOINT = 'https://serpapi.com/account.json';

// SerpAPI is a 250-searches/MONTH free plan (2026-09-01, after the previously
// shared key was downgraded). This is the real constraint on discovery now -
// every serpSearch() below counts against a pool that has to last the whole
// calendar month. Hold a small buffer under 250 so a miscount, a retry, or a
// manual discover.js run can't tip us over into blocked/paid territory.
export const MONTHLY_SEARCH_BUDGET = 240;

// Domains that show up constantly in searches but are never realistic
// outreach targets - social platforms, marketplaces, reference sites, major
// news organizations (huge newsrooms, not blogs), and blog directories
// (useful as a future discovery *source*, not as an outreach target itself).
const DOMAIN_BLACKLIST = new Set([
  // social / platforms
  'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com',
  'youtube.com', 'pinterest.com', 'reddit.com', 'tiktok.com', 'wikipedia.org',
  'amazon.com', 'google.com', 'apple.com', 'play.google.com', 'apps.apple.com',
  'yelp.com', 'indeed.com', 'glassdoor.com', 'crunchbase.com', 'quora.com',
  // major news / media - not blogs, unrealistic outreach targets
  'cnn.com', 'nytimes.com', 'bbc.com', 'bbc.co.uk', 'cnbc.com', 'businessinsider.com',
  'bloomberg.com', 'wsj.com', 'forbes.com', 'reuters.com', 'theguardian.com',
  'washingtonpost.com', 'usatoday.com', 'npr.org', 'time.com', 'fortune.com', 'ft.com',
  'economist.com', 'techcrunch.com', 'inc.com', 'fastcompany.com', 'huffpost.com',
  'buzzfeed.com', 'axios.com', 'politico.com', 'marketwatch.com', 'thestreet.com',
  'businessweek.com', 'apnews.com', 'abcnews.go.com', 'nbcnews.com', 'cbsnews.com',
  'entrepreneur.com',
  // blog directories/aggregators - good future discovery source, not a target
  'businessblogshub.com', 'alltop.com', 'feedspot.com',
  // publishing platforms - bare domain is never a specific business's own blog
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'sites.google.com'
]);

// .gov / .mil / .edu domains (US and international, e.g. site.gov.uk) are
// institutional, not businesses - never outreach targets. 'ac' catches
// international academic TLDs (ac.uk, ac.nz, ac.jp, ac.in, etc).
function isInstitutionalDomain(domain) {
  const labels = domain.split('.');
  return labels.includes('gov') || labels.includes('mil') || labels.includes('edu') || labels.includes('ac');
}

// Matches the blacklist on the domain itself or any parent domain, so a
// subdomain (aws.amazon.com, sites.google.com) is caught even if only the
// apex domain (amazon.com, google.com) is listed.
function isBlacklistedDomain(domain) {
  if (DOMAIN_BLACKLIST.has(domain)) return true;
  const labels = domain.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    if (DOMAIN_BLACKLIST.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// "50 Best Business Blogs of 2026" / "Top 12 Write For Us Guest Post Sites"
// are roundup articles ABOUT other blogs, not a blog you can pitch directly.
const LISTICLE_PATTERNS = [
  /\b\d+\s+(best|top|great|essential|favorite|favourite|inspiring|must-read|amazing|useful|awesome|leading)\b.*\b(blogs?|sites?)\b/i,
  /\b(best|top)\s+\d+\b.*\b(blogs?|sites?)\b/i,
  /\d+\s+.*\bblog\s+examples\b/i,
  /\b(blogs?|sites?)\s+(to\s+follow|to\s+read|you\s+should\s+follow|worth\s+reading)\b/i,
  // Bare "N Blogs/Sites [that/to/for/you]..." - almost always a roundup
  // article even without an adjective like "best"/"top" in front.
  /\b\d+\s+(blogs?|sites?|newsletters?|podcasts?)\s+(that|to|for|you|worth)\b/i
];
function isListicleTitle(title) {
  if (!title) return false;
  return LISTICLE_PATTERNS.some((re) => re.test(title));
}

export async function serpSearch(query, { num = 10 } = {}) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY is not set. Copy discovery/.env.local.example to discovery/.env.local and fill it in.');

  const url = new URL(SERPAPI_ENDPOINT);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(num));
  url.searchParams.set('api_key', apiKey);

  // No timeout here previously meant one slow SerpAPI response could hang past
  // the caller's own time-budget check (which only runs between iterations,
  // not during a request) and push the whole admin.js function past Vercel's
  // maxDuration - killing it with a 504 instead of failing this one query.
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SerpAPI error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`);
  return data.organic_results || [];
}

// Asks SerpAPI how much of the monthly quota is already spent and returns how
// many more searches we can safely run this calendar month under
// MONTHLY_SEARCH_BUDGET. The /account call itself is free and does NOT count
// against the search quota. `remaining` is never negative.
export async function serpSearchesRemaining() {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY is not set. Copy discovery/.env.local.example to discovery/.env.local and fill it in.');

  const url = new URL(SERPAPI_ACCOUNT_ENDPOINT);
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SerpAPI account error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // this_month_usage counts up; plan_searches_left counts down. Trust whichever
  // is tighter, so we stop even if one field lags or the plan resets mid-run.
  const usedThisMonth = Number(data.this_month_usage ?? 0);
  const planLeft = Number(data.plan_searches_left ?? data.total_searches_left ?? Infinity);
  const budgetLeft = MONTHLY_SEARCH_BUDGET - usedThisMonth;
  return {
    usedThisMonth,
    planLeft,
    remaining: Math.max(0, Math.min(budgetLeft, planLeft))
  };
}

// Extracts a clean, deduplicated-by-domain list of candidates from raw
// SerpAPI organic results, filtering out non-blog domains and listicle pages.
export function extractCandidates(organicResults) {
  const seen = new Set();
  const candidates = [];
  for (const r of organicResults) {
    if (!r.link) continue;
    let url;
    try {
      url = new URL(r.link);
    } catch {
      continue;
    }
    const domain = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!domain || seen.has(domain)) continue;
    if (isBlacklistedDomain(domain) || isInstitutionalDomain(domain)) continue;
    if (isListicleTitle(r.title)) continue;
    seen.add(domain);
    candidates.push({
      domain,
      homepage_url: `${url.protocol}//${domain}`,
      title: r.title || null,
      snippet: r.snippet || null
    });
  }
  return candidates;
}
