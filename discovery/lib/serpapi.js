const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

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

// "50 Best Business Blogs of 2026" / "Top 12 Write For Us Guest Post Sites"
// are roundup articles ABOUT other blogs, not a blog you can pitch directly.
const LISTICLE_PATTERNS = [
  /\b\d+\s+(best|top|great|essential|favorite|favourite|inspiring|must-read|amazing|useful|awesome|leading)\b.*\b(blogs?|sites?)\b/i,
  /\b(best|top)\s+\d+\b.*\b(blogs?|sites?)\b/i,
  /\d+\s+.*\bblog\s+examples\b/i,
  /\b(blogs?|sites?)\s+(to\s+follow|to\s+read|you\s+should\s+follow|worth\s+reading)\b/i
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

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SerpAPI error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`SerpAPI error: ${data.error}`);
  return data.organic_results || [];
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
    if (DOMAIN_BLACKLIST.has(domain) || isInstitutionalDomain(domain)) continue;
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
