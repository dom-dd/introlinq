import { neon } from '@neondatabase/serverless';
import { getClientIp, isBurstTraffic, isSitewideBurst, isKnownCrawlerIp, isBotHit, ensureBotColumns, isAllowlistedCrawler } from './_botDetect.js';

// match_cache is global per page now, not per reader country - country
// fragmentation (every new country paying for its own fresh scan) turned
// out to cost real money for no real benefit at this scale, and directly
// caused the "works on desktop, nothing on phone" confusion when a single
// visitor's two devices got geolocated to different countries (mobile
// carriers and privacy features like iCloud Private Relay routinely do
// this even on the same WiFi). One page = one cache entry = one scan,
// shown identically to every reader everywhere. readerCountry is still
// captured and logged for analytics (dashboard stats, Slack) - it just no
// longer affects what gets cached or matched.
const GLOBAL_CACHE_COUNTRY = 'XX';

let logTableReady = false;
let matchLogsBotColumnsReady = false;
let cacheTableReady = false;
let publisherActivityColumnsReady = false;
let discoveryCueColumnReady = false;
let scanCapColumnReady = false;
let aiCallLogTableReady = false;
let expertsCache = null;
let expertsCacheTime = 0;
const EXPERTS_TTL = 5 * 60 * 1000;

// New publishers only scan up to this many distinct pages within a rolling
// window before further fresh scans pause (existing publishers as of
// 2026-07-28 were grandfathered in via scan_cap_override=true, since they'd
// already been scanning freely for a while with no cap in mind - see project
// memory). Deliberately a ROLLING window, not a lifetime total: a lifetime
// cap permanently dead-ends a publisher once crossed - their newest articles
// (the ones most likely to actually be read) would never get scanned again,
// same as their oldest backlog page. A rolling window means last month's
// scans age out and free up room each month, so ongoing new content always
// gets a shot - it just competes with any not-yet-scanned backlog for that
// month's allowance rather than jumping the queue. Counts every cache entry
// regardless of verdict (a "no match" scan still cost real money), not just
// positive matches. Admin can lift this per publisher via the scan-cap icon
// in the admin panel. Window length lives directly in the query below
// (Postgres INTERVAL literal) rather than as a template variable - the sql``
// tag auto-parameterizes every ${} it sees, which breaks INTERVAL syntax if
// a variable lands inside the quoted literal (see _botDetect.js's isBurstTraffic
// for the same constraint, solved there with sql.query() instead).
const SCAN_CAP_LIMIT = 250; // per rolling 30-day window (see query below)

// Loads the full active-experts list (module-cached for EXPERTS_TTL). Used by
// BOTH the fresh-scan path (to build the AI prompt) and the cache-hit path
// (to hydrate slim cached matches with each expert's CURRENT details - see
// hydrateMatches). Returns null on a DB failure with no usable cached copy,
// so callers can distinguish "no experts" from "couldn't fetch experts".
async function loadExperts(sql) {
  const now = Date.now();
  if (!expertsCache || now - expertsCacheTime > EXPERTS_TTL) {
    // Stable order, NOT random: the experts block is the bulk of every AI
    // prompt, and Anthropic prompt caching only hits when the prefix is
    // byte-identical across requests. Random per-instance ordering meant no
    // two serverless instances ever shared a cache entry (and the same page
    // could match differently depending on which instance served it).
    // Fairness is handled by a deterministic daily rotation in the handler.
    const rows = await sql`
      SELECT e.id, e.name, e.bio, e.description_long, e.highlights, e.photo_url, e.position, e.company,
             e.topics, e.services, e.languages, e.price_from, e.price_currency,
             e.booking_url, e.location_country,
             p.name AS provider_name, p.slug AS provider_slug, p.logo_url AS provider_logo_url, p.website_url AS provider_website_url,
             COALESCE(p.is_demo, false) AS is_demo_provider
      FROM experts e
      LEFT JOIN providers p ON p.id = e.provider_id
      WHERE e.active = true
      ORDER BY e.id
    `.catch(() => null);
    // Only remember a *successful* fetch's timestamp - if the query failed,
    // leave expertsCacheTime alone so the very next request retries the DB
    // instead of being stuck treating this transient failure as fresh for TTL.
    if (rows) {
      expertsCache = rows;
      expertsCacheTime = now;
    }
  }
  return expertsCache;
}

// Targeted fetch for hydrating a cache HIT: a cached page references a
// handful of experts (6 on average, measured against real data), not the
// whole active roster - fetching everyone just to hydrate 6 was the actual
// driver behind a 5GB/month Neon egress warning (full-roster fetch on every
// single request, hit or miss, after live hydration started needing expert
// data on cache hits too). No module-level cache here - unlike loadExperts,
// the id set differs per page, so there's nothing stable to cache across
// requests, but the payload is small enough that it doesn't need one.
// Deliberately does NOT filter by enabled_partners/is_demo here - those are
// still applied by hydrateMatches so both fetch paths behave identically.
async function loadExpertsByIds(sql, ids) {
  if (!ids || ids.length === 0) return [];
  return await sql`
    SELECT e.id, e.name, e.bio, e.description_long, e.photo_url, e.position, e.company,
           e.topics, e.services, e.languages, e.price_from, e.price_currency,
           e.booking_url, e.location_country,
           p.name AS provider_name, p.slug AS provider_slug, p.logo_url AS provider_logo_url, p.website_url AS provider_website_url,
           COALESCE(p.is_demo, false) AS is_demo_provider
    FROM experts e
    LEFT JOIN providers p ON p.id = e.provider_id
    WHERE e.active = true AND e.id = ANY(${ids})
  `.catch(() => null);
}

// Every expert id a cached entry could possibly need to hydrate - primaries
// and alternates, in both the current slim shape and legacy full-snapshot
// rows (m.expert.id). Shared by both callers of loadExpertsByIds so the id
// collection logic can't drift between them.
function collectReferencedIds(cachedMatches) {
  const ids = new Set();
  for (const m of cachedMatches || []) {
    const primaryId = m.expert_id ?? m.expert?.id;
    if (primaryId != null) ids.add(primaryId);
    for (const a of (Array.isArray(m.alts) ? m.alts : [])) {
      if (a.expert_id != null) ids.add(a.expert_id);
    }
  }
  return [...ids];
}

// Cache writes store only what can't be recomputed later: which experts
// matched (ids) and the page-specific reason/credential sentences. Everything
// else about the expert (name, bio, booking_url, photo...) is hydrated LIVE
// at serve time, so profile edits, changed booking links and unpublished
// experts never require re-scanning a page. Each entry keeps the primary
// match plus its interchangeable `alts` candidates (serve-time rotation
// shows one per visit). Accepts both fresh-scan matches ({...m, expert:
// {...}}) and already-slim entries (re-reporting a cached result), and
// drops anything without a resolvable expert id.
function slimMatches(matches) {
  return (matches || [])
    .map(m => {
      const expertId = m.expert_id ?? m.expert?.id;
      if (!m.phrase || expertId == null) return null;
      const out = { phrase: m.phrase, reason: m.reason || '', expert_id: expertId };
      if (typeof m.credential === 'string' && m.credential.trim()) out.credential = m.credential;
      const alts = (Array.isArray(m.alts) ? m.alts : [])
        .filter(a => a && a.expert_id != null && a.expert_id !== expertId && typeof a.reason === 'string')
        .slice(0, 2)
        .map(a => {
          const altOut = { expert_id: a.expert_id, reason: a.reason };
          if (typeof a.credential === 'string' && a.credential.trim()) altOut.credential = a.credential;
          return altOut;
        });
      if (alts.length > 0) out.alts = alts;
      return out;
    })
    .filter(Boolean);
}

// Rebuilds full matches from a cached entry using the CURRENT experts list.
// Each entry's candidates (primary + alts) are filtered down to experts who
// are still published AND visible to this publisher (partner enabled) AND
// not already picked for another phrase on this page - then ONE surviving
// candidate is chosen at random per phrase, so repeat visits rotate through
// equally-fitting experts instead of always showing the same one. Removal
// is pure subtraction and never needs an AI call; a phrase only disappears
// when every one of its candidates is gone. Handles legacy cache rows that
// still contain full expert snapshots (hydrates by their id; never serves
// the stale snapshot itself).
function hydrateMatches(cachedMatches, experts, enabledPartners) {
  const byId = new Map(experts.map(e => [e.id, e]));
  const seen = new Set();
  const out = [];
  for (const m of cachedMatches || []) {
    const primaryId = m.expert_id ?? m.expert?.id;
    if (primaryId == null) continue;
    const candidates = [
      { expert_id: primaryId, reason: m.reason, credential: m.credential },
      ...(Array.isArray(m.alts) ? m.alts : [])
    ].filter(c => {
      if (c.expert_id == null || seen.has(c.expert_id)) return false;
      const expert = byId.get(c.expert_id);
      if (!expert) return false; // unpublished or deactivated since the scan
      return enabledPartners
        ? enabledPartners.includes(expert.provider_slug || 'openintro')
        : !expert.is_demo_provider; // null = homepage demo: hide demo-partner experts
    });
    if (candidates.length === 0) continue;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    seen.add(pick.expert_id);
    const hydrated = { phrase: m.phrase, reason: pick.reason, expert: byId.get(pick.expert_id) };
    if (typeof pick.credential === 'string' && pick.credential.trim()) hydrated.credential = pick.credential;
    out.push(hydrated);
  }
  return out;
}

// Small, curated topic -> hook/cta template lookup for widget4/5's
// generic-hook header, matched against the PRIMARY expert's own topics[]
// at SERVE time - no AI call, so it works instantly on every already-
// cached page without a rescan. Built from the real distribution of
// topics across active experts (Strategy/Founder/CEO/B2B are the most
// common but too generic to build a specific ask around, so deliberately
// excluded here in favour of more actionable topics further down the
// frequency list). Order matters - checked top to bottom, first match on
// the expert's own topics[] wins, so more specific asks are listed ahead
// of broader ones.
const TOPIC_HOOKS = [
  // Not real expert topic tags (no expert is tagged "SEO" - checked the
  // real taxonomy, it doesn't exist) - these only ever match via the
  // reason/phrase text search above, never the topics[] fallback. Added
  // after littlegreenagency.co.uk (an SEO/marketing agency) surfaced a
  // "Speaking in public soon?" hook on a Search-Console/local-SEO article,
  // because neither the reason nor phrase mentioned any topic already in
  // this list, so it fell through to the matched expert's own broad tags.
  { topic: 'SEO', hook: 'Need help with SEO? Talk to someone who has grown organic traffic before.', cta: 'Get SEO advice →' },
  { topic: 'Search Console', hook: 'Making sense of Search Console data? Talk to someone who reads this for a living.', cta: 'Get SEO advice →' },
  { topic: 'Google Ads', hook: 'Running Google Ads? Talk to someone who has managed real ad spend.', cta: 'Get ads advice →' },
  { topic: 'Analytics', hook: 'Untangling your analytics setup? Talk to someone who has done this before.', cta: 'Get analytics advice →' },
  { topic: 'Fundraising', hook: 'Raising funds? We have a list of active investors to speak to.', cta: 'Get funding now →' },
  { topic: 'Startup Funding', hook: 'Raising funds? We have a list of active investors to speak to.', cta: 'Get funding now →' },
  { topic: 'VC (Venture Capital)', hook: 'Raising funds? We have a list of active investors to speak to.', cta: 'Get funding now →' },
  { topic: 'Angel Investor', hook: 'Raising funds? We have a list of active investors to speak to.', cta: 'Get funding now →' },
  { topic: 'Seed', hook: 'Raising a seed round? Talk to investors who fund exactly this stage.', cta: 'Get funding now →' },
  { topic: 'Pre-Seed', hook: 'Raising pre-seed? Talk to investors who fund exactly this stage.', cta: 'Get funding now →' },
  { topic: 'Investment Preparation', hook: 'Getting ready to raise? Talk to someone who knows what investors look for.', cta: 'Get investor-ready →' },
  { topic: 'Exits', hook: 'Thinking about an exit? Talk to founders who have actually been through one.', cta: 'Get exit advice →' },
  { topic: 'Storytelling', hook: 'Need to sharpen your pitch? Talk to someone who tells stories for a living.', cta: 'Sharpen my pitch →' },
  { topic: 'Public Speaking', hook: 'Speaking in public soon? Get advice from someone who does it professionally.', cta: 'Improve my speaking →' },
  { topic: 'Marketing', hook: 'Need to grow your audience? Talk to a marketing expert who has done it before.', cta: 'Get marketing advice →' },
  { topic: 'Growth', hook: 'Stuck on growth? Talk to someone who has scaled a company before.', cta: 'Get growth advice →' },
  { topic: 'Go-To-Market', hook: 'Planning a launch? Get your go-to-market strategy right the first time.', cta: 'Nail my launch →' },
  { topic: 'Branding', hook: 'Building your brand? Talk to someone who has built one that worked.', cta: 'Get branding advice →' },
  { topic: 'Leadership', hook: 'First time leading a team? Get matched with leaders who have been there.', cta: 'Get leadership advice →' },
  { topic: 'Career Coaching', hook: 'At a career crossroads? Talk to someone who coaches people through exactly this.', cta: 'Get career advice →' },
  { topic: 'Personal Development', hook: 'Looking to grow, not just professionally? Talk to someone who coaches this.', cta: 'Get personal advice →' },
  { topic: 'SaaS', hook: 'Building a SaaS product? Talk to founders who have built and scaled one.', cta: 'Get SaaS advice →' },
  { topic: 'Product', hook: 'Building your product? Talk to someone who has shipped one that worked.', cta: 'Get product advice →' },
  { topic: 'E-commerce', hook: 'Running an e-commerce business? Talk to someone who has scaled one.', cta: 'Get e-commerce advice →' },
  { topic: 'Artificial Intelligence', hook: 'Building with AI? Talk to someone working on this right now.', cta: 'Get AI advice →' },
  { topic: 'Social Impact', hook: 'Building something with real impact? Talk to founders doing the same.', cta: 'Get impact advice →' },
  { topic: 'Sustainability', hook: 'Working on sustainability? Talk to someone who has built in this space.', cta: 'Get sustainability advice →' },
  { topic: 'Operations', hook: 'Operations getting complicated? Talk to someone who has scaled a team before.', cta: 'Get operations advice →' },
];
const FALLBACK_HOOK = { hook: 'Need advice on this? Talk to someone who has been there before.', cta: 'Talk to an expert →' };

// Searches the REASON text first (why this expert was matched to THIS
// specific phrase - "Dan has trained 10,000+ people on AI... he can
// clarify what GA4 means for your marketing decisions"), not just the
// expert's own static topics[] list. An expert with many broad tags (e.g.
// someone who also does public speaking, on top of their actual marketing
// expertise) would otherwise get whichever tag happens to rank first in
// TOPIC_HOOKS regardless of what this specific match is actually about -
// confirmed live on littlegreenagency.co.uk, where a GA4-tracking match
// surfaced "Speaking in public soon?" purely because the matched expert's
// profile also listed Public Speaking, which outranked Marketing in the
// list even though the actual match reason was about GA4/marketing, not
// public speaking at all. Falls back to the expert's topics[] only if the
// reason/phrase text itself doesn't mention a known keyword.
function deriveHook(expert, reasonText, phraseText) {
  const haystack = ((reasonText || '') + ' ' + (phraseText || '')).toLowerCase();
  for (const entry of TOPIC_HOOKS) {
    if (haystack.includes(entry.topic.toLowerCase())) return { ...entry, query: entry.topic.toLowerCase() };
  }
  if (expert && Array.isArray(expert.topics)) {
    for (const entry of TOPIC_HOOKS) {
      if (expert.topics.includes(entry.topic)) return { ...entry, query: entry.topic.toLowerCase() };
    }
  }
  return { ...FALLBACK_HOOK, query: 'expert advice' };
}

// widget2.js experiment only (see handleMultiVariant) - keeps up to 3
// candidates per phrase instead of randomly committing to one, so the
// reader gets a short pick-one list rather than a single named suggestion.
// Deliberately a separate function rather than a `multi` flag threaded
// through hydrateMatches above: that function is on the hot path for every
// real publisher's widget, and forking its behaviour on a flag risked a
// subtle bug reaching production traffic for a feature that's currently
// only ever exercised on one demo page.
function hydrateMatchesMulti(cachedMatches, experts, enabledPartners, maxPerPhrase = 3) {
  const byId = new Map(experts.map(e => [e.id, e]));
  const seen = new Set();
  const out = [];
  for (const m of cachedMatches || []) {
    const primaryId = m.expert_id ?? m.expert?.id;
    if (primaryId == null) continue;
    const candidates = [
      { expert_id: primaryId, reason: m.reason, credential: m.credential },
      ...(Array.isArray(m.alts) ? m.alts : [])
    ].filter(c => {
      if (c.expert_id == null || seen.has(c.expert_id)) return false;
      const expert = byId.get(c.expert_id);
      if (!expert) return false;
      return enabledPartners
        ? enabledPartners.includes(expert.provider_slug || 'openintro')
        : !expert.is_demo_provider;
    });
    if (candidates.length === 0) continue;
    const picked = candidates.slice(0, maxPerPhrase);
    picked.forEach(c => seen.add(c.expert_id));
    const options = picked.map(c => {
      const opt = { reason: c.reason, expert: byId.get(c.expert_id) };
      if (typeof c.credential === 'string' && c.credential.trim()) opt.credential = c.credential;
      return opt;
    });
    const primaryExpert = byId.get(picked[0].expert_id);
    const { hook, cta, query } = deriveHook(primaryExpert, picked[0].reason, m.phrase);
    out.push({ phrase: m.phrase, options, hook, cta, query: query || '' });
  }
  return out;
}

// widget6.js's no-match fallback: since there's no matched phrase to hang a
// recommendation off of, it shows a plain random sample instead - same
// eligibility rule as hydrateMatches/hydrateMatchesMulti (enabled partner,
// not a demo-only provider), just without any expert already being
// "referenced" by a match. Pulls from the module-cached full roster
// (loadExperts) rather than a fresh query, since this only runs for the
// widget2-7 demo variant path and the roster is already cached for the
// fresh-scan path anyway. Fisher-Yates shuffle, not ORDER BY RANDOM() in
// SQL, so this costs nothing extra when the roster's already in memory.
function pickRandomExperts(experts, enabledPartners, n = 3) {
  const eligible = experts.filter(e => enabledPartners
    ? enabledPartners.includes(e.provider_slug || 'openintro')
    : !e.is_demo_provider);
  const pool = eligible.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // e.highlights is the expert's own curated highlight-reel bullets (set on
  // their profile, same field an expert board/profile page would show) -
  // there's no per-match reason to build a punchier fragment from here (no
  // match at all is the whole premise of this fallback), so the first 2
  // stand in for widget5's AI-derived credential facts. Real data, no AI
  // call, no per-page cost.
  return pool.slice(0, n).map(e => ({
    expert: e,
    credentials: Array.isArray(e.highlights) ? e.highlights.slice(0, 2) : []
  }));
}

// widget2.js experiment only - a self-contained cache-read-only path,
// deliberately NOT folded into the main handler's tryServeFromCache/
// fresh-scan flow below. Only ever reached when a request explicitly opts
// in (see handler's `variant === 'multi'` check), so it can't affect any
// real publisher's widget.js traffic. Never triggers a fresh AI scan -
// meant for already-cached demo pages, not general use.
async function handleMultiVariant(sql, { publisher, page_url, page_title, readerCountry, ip, req, pubConfig, enabledPartners }) {
  // Same WHERE clause as the single-match path's own cache lookup
  // (mirrors tryServeFromCache's caller) - now also looks up CONFIRMED
  // negative entries, not just positive ones. Widget6.js's no-match
  // fallback needs to tell "genuinely scanned, confirmed no expert here"
  // apart from "never scanned yet, still pending" - both cases used to
  // return the exact same { matches: [] } with no `cached` field at all,
  // since this query only ever selected has_match = true rows.
  const [cachedRows] = await Promise.all([
    page_url
      ? sql`SELECT result, has_match FROM match_cache
          WHERE page_url = ${page_url} AND publisher = ${publisher || ''} AND country_code = ${GLOBAL_CACHE_COUNTRY}
            AND (has_match = true OR (has_match = false AND (confirmed = true OR cached_at > NOW() - INTERVAL '24 hours')))
          ORDER BY has_match DESC LIMIT 1`.catch(() => [null])
      : Promise.resolve([null]),
  ]);
  const cached = cachedRows[0];
  // No row at all = never scanned, still pending - no `cached` field, same
  // as before, so the widget knows to just wait/do nothing.
  if (!cached) return { matches: [], config: pubConfig };
  // A confirmed negative entry - cached: true but matches: [] tells the
  // widget "this was genuinely scanned, there's really nothing here" as
  // opposed to "still pending." randomExperts backs widget6.js's no-match
  // fallback block (see pickRandomExperts) - best-effort, so a roster fetch
  // failure just means the fallback has nobody to show, not a hard error.
  if (!cached.has_match) {
    const roster = await loadExperts(sql);
    const randomExperts = roster ? pickRandomExperts(roster, enabledPartners) : [];
    return { matches: [], config: pubConfig, cached: true, noMatch: true, randomExperts };
  }

  const referencedExperts = await loadExpertsByIds(sql, collectReferencedIds(cached.result.matches));
  if (!referencedExperts) return { matches: [], config: pubConfig };

  const hydrated = hydrateMatchesMulti(cached.result.matches, referencedExperts, enabledPartners);
  if (hydrated.length === 0) {
    const roster = await loadExperts(sql);
    const randomExperts = roster ? pickRandomExperts(roster, enabledPartners) : [];
    return { matches: [], config: pubConfig, cached: true, noMatch: true, randomExperts };
  }

  // Flattened single-expert view (first option per phrase) purely so the
  // existing impression logger/stats stay schema-compatible - doesn't
  // affect what's actually rendered to the reader.
  const flatForLogging = hydrated.map(h => ({ phrase: h.phrase, expert: h.options[0]?.expert }));
  await logCachedImpression(sql, { publisher, page_url, page_title, matches: flatForLogging, readerCountry, ip, req });

  return { matches: hydrated, config: pubConfig, cached: true, multi: true };
}

// Claude Haiku 4.5 pricing ($/token, from Anthropic's published rates) - only
// used to print a rough per-scan cost estimate in Slack, not for billing.
// cacheWrite is 2.00e-6 (not the 5-min TTL's 1.25e-6) since the static block
// below is cached with ttl: '1h'.
const HAIKU_PRICE_PER_TOKEN = { input: 1.00e-6, output: 5.00e-6, cacheWrite: 2.00e-6, cacheRead: 0.10e-6 };
// Static USD->GBP rate for the Slack estimate - a live FX call would add
// latency for a figure that's already an order-of-magnitude estimate.
const USD_TO_GBP = 0.79;

function usageCostUSD(usage) {
  if (!usage) return 0;
  const p = HAIKU_PRICE_PER_TOKEN;
  return (usage.input_tokens || 0) * p.input
    + (usage.output_tokens || 0) * p.output
    + (usage.cache_creation_input_tokens || 0) * p.cacheWrite
    + (usage.cache_read_input_tokens || 0) * p.cacheRead;
}

async function ensureAiCallLogTable(sql) {
  if (aiCallLogTableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS ai_call_logs (
    id SERIAL PRIMARY KEY,
    publisher TEXT,
    page_url TEXT,
    call_type TEXT,
    input_tokens INT,
    output_tokens INT,
    cache_creation_input_tokens INT,
    cache_read_input_tokens INT,
    cost_usd NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`.catch(() => {});
  aiCallLogTableReady = true;
}

// Logged the instant an Anthropic response comes back, for every quick/chunk/full
// call - unlike match_logs.cost_usd, which only gets a number when the BROWSER
// successfully sums every quick+chunk cost and posts a final report. A reader who
// navigates away mid-scan means that report never happens, even though Anthropic
// already billed for a real completed generation - this table is what makes that
// spend visible instead of permanently unaccounted for. Never throws: a failure to
// log a cost shouldn't turn into a failure to serve the match that already ran.
async function logAiCall(sql, { publisher, pageUrl, callType, usage, costUsd }) {
  await ensureAiCallLogTable(sql);
  const u = usage || {};
  await sql`
    INSERT INTO ai_call_logs (publisher, page_url, call_type, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd)
    VALUES (${publisher || null}, ${pageUrl || null}, ${callType}, ${u.input_tokens || 0}, ${u.output_tokens || 0}, ${u.cache_creation_input_tokens || 0}, ${u.cache_read_input_tokens || 0}, ${costUsd || 0})
  `.catch(() => {});
}

// One-time-per-instance schema check for match_logs. The ALTER TABLE
// statements used to run on EVERY report request (they sat outside the
// ready-flag guard) - four wasted sequential DB round trips per page view.
async function ensureLogTable(sql) {
  if (logTableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS match_logs (id SERIAL PRIMARY KEY, publisher TEXT, article_preview TEXT, phrases TEXT[], expert_names TEXT[], match_count INT, created_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS page_url TEXT`.catch(() => {});
  await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS expert_booking_urls TEXT[]`.catch(() => {});
  await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS no_match_reason TEXT`.catch(() => {});
  await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS country_code TEXT`.catch(() => {});
  await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC`.catch(() => {});
  logTableReady = true;
}

// Called whenever the widget successfully reaches this endpoint for a real,
// registered publisher - a cache-hit impression, or simply a request that
// went on to trigger (or find already in flight) a background scan.
// first_widget_fire_at is set only once - the
// COALESCE keeps whatever value it already had, and NOW() is evaluated
// once per statement in Postgres, so comparing it back against the exact
// same NOW() reliably detects "this call is the one that just set it" vs
// "it was already set before this call" without a race condition.
// last_widget_fire_at updates on every call, letting the admin panel later
// tell "went quiet after being live" apart from "never installed at all".
async function markPublisherActivity(sql, publisher) {
  if (!publisher) return;
  if (!publisherActivityColumnsReady) {
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS first_widget_fire_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_widget_fire_at TIMESTAMPTZ`.catch(() => {});
    await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS widget_removed_notified_at TIMESTAMPTZ`.catch(() => {});
    publisherActivityColumnsReady = true;
  }
  // Clearing widget_removed_notified_at on every fire (not just the first)
  // is what lets widget-removed-check.js notify again if a publisher
  // reinstalls and later goes quiet a second time - most calls just reset
  // an already-null column, a no-op.
  const [row] = await sql`
    UPDATE publishers
    SET last_widget_fire_at = NOW(),
        first_widget_fire_at = COALESCE(first_widget_fire_at, NOW()),
        widget_removed_notified_at = NULL
    WHERE slug = ${publisher}
    RETURNING name, email, (first_widget_fire_at = NOW()) AS just_went_live
  `.catch(() => [null]);
  if (row?.just_went_live) {
    notifyPublisherWentLive(row.name, row.email, publisher).catch(() => {});
  }
}

// Fires once per publisher, ever - the moment their widget successfully
// reaches this endpoint for the first time, confirming installation
// actually happened. Lets the team celebrate real go-lives, tells them by
// omission who to follow up with, and - the part that actually matters to
// the publisher - reassures the publisher themselves that it worked. A lot
// of people paste the snippet and have no way to know whether it actually
// took; this is the "yes, it's working" confirmation for that anxiety.
// Posts to #introlinq-notifications, not #introlinq-general - a go-live is
// rare and real, unlike the constant scan/match traffic postSlackNotification
// (below) posts to general.
async function notifyPublisherWentLive(name, email, publisher) {
  if (process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) {
    fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🎉 *${name}* just went live - their widget fired for the first time. Installation confirmed!` }),
    }).catch(() => {});
  }
  if (process.env.RESEND_API_KEY && process.env.COMPANY_NOTIFICATION_EMAIL) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <notifications@introlinq.com>',
        to: process.env.COMPANY_NOTIFICATION_EMAIL,
        subject: `${name} just went live on IntroLinq`,
        text: `${name} (${publisher}) just installed the widget and it fired for the first time - they're officially live.`,
      }),
    }).catch(() => {});
  }
  if (process.env.RESEND_API_KEY && email) {
    const firstName = (name || '').split(' ')[0] || name;
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: email,
        subject: `You're live! IntroLinq is working on your site 🎉`,
        html: widgetLiveEmail(firstName),
      }),
    }).catch(() => {});
  }
}

function widgetLiveEmail(firstName) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf8f4;font-family:'Inter',system-ui,sans-serif">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid rgba(26,26,46,0.08)">
  <div style="background:#1a1a2e;padding:28px 32px">
    <div style="font-family:Georgia,serif;font-size:1.25rem;color:#fff">Intro<span style="color:#e6a820">Linq</span></div>
  </div>
  <div style="padding:32px">
    <p style="margin:0 0 8px;font-size:1rem;font-weight:600;color:#1a1a2e">You're live, ${firstName} 🎉</p>
    <p style="margin:0 0 16px;font-size:0.875rem;color:#8888a8;line-height:1.6">Good news - we just confirmed IntroLinq is correctly installed and working on your site. No further setup needed on your end.</p>
    <p style="margin:0 0 24px;font-size:0.875rem;color:#8888a8;line-height:1.6">From here it runs on its own: readers on your articles will start seeing relevant experts they can book, and you'll earn a commission on every session. Thanks for adding it - excited to see it grow on your site.</p>
    <a href="https://www.introlinq.com/dashboard" style="display:block;background:#1a1a2e;color:#fff;text-align:center;padding:14px;border-radius:100px;font-size:0.875rem;font-weight:600;text-decoration:none">View my dashboard →</a>
  </div>
</div>
</body></html>`;
}

// A cache hit still counts as an impression (log) and, when it actually
// showed experts, a Slack ping. Shared by every cache-serving path - this
// block used to be copy-pasted three times with drifting details.
// The INSERT is awaited by its caller now (unlike the pre-burst-detection
// version) - work fired after a response is already sent isn't guaranteed
// to run to completion on Vercel, and got silently dropped in testing once
// this had ensureBotColumns + isBurstTraffic to await first, not just a
// single fire-and-forget INSERT. markPublisherActivity/Slack stay
// fire-and-forget - only the row this feature's correctness depends on
// needs to reliably land.
async function logCachedImpression(sql, { publisher, page_url, page_title, matches, readerCountry, ip, req }) {
  const phrases = matches.map(m => m.phrase);
  const expertNames = matches.map(m => m.expert?.name).filter(Boolean);
  const expertBookingUrls = matches.map(m => m.expert?.booking_url || null);
  if (!matchLogsBotColumnsReady) {
    await ensureBotColumns(sql, 'match_logs');
    matchLogsBotColumnsReady = true;
  }
  // Same full bot-detection stack as dashboard.js's click/hover/seen/carousel
  // handlers (isKnownCrawlerIp + isAllowlistedCrawler + isSitewideBurst, not
  // just isBurstTraffic) - this was the one place still missing them, which
  // meant a crawler spreading across many different pages once each (Meta's
  // exact pattern on tchelete - see isKnownCrawlerIp's own comment) sailed
  // through untagged into match_logs, inflating Page visits/Expert shown for
  // the publishers it hit hardest even after click_logs was fixed.
  const isBot = await isBotHit(req, sql, 'match_logs', { ip, publisher, page_url });
  await sql`INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, country_code, cost_usd, ip, is_bot)
    VALUES (${publisher || null}, '[cached]', ${phrases}, ${expertNames}, ${expertBookingUrls}, ${matches.length}, ${page_url}, ${readerCountry || null}, 0, ${ip || null}, ${isBot})
  `.catch(() => {});
  markPublisherActivity(sql, publisher).catch(() => {});
  if (!isBot) {
    postSlackNotification(sql, { publisher, page_url, page_title, matchCount: matches.length, readerCountry, cached: true }).catch(() => {});
  }
}

// Shared by both the normal cache-hit path and the burst short-circuit
// below - the only difference is whether the entry looked fresh or stale
// when it was decided this was safe to serve. Sends the response itself
// and returns true on success; returns false (sending nothing) when the
// cache row turned out to be unusable, so the caller falls through to a
// real scan rather than serving a false empty result.
async function tryServeFromCache(res, sql, { cached, enabledPartners, publisher, page_url, page_title, readerCountry, ip, pubConfig, stale, req }) {
  const referencedExperts = await loadExpertsByIds(sql, collectReferencedIds(cached.result.matches));
  if (!referencedExperts) return false;
  const hydrated = hydrateMatches(cached.result.matches, referencedExperts, enabledPartners);
  const emptiedPositive = cached.has_match && hydrated.length === 0;
  if (emptiedPositive) return false;
  // One request per page-view now (no more quick/chunk fan-out), so this
  // always logs - no per-piece dedup guard needed anymore. Awaited so the log
  // write reliably lands - see the comment on logCachedImpression for why
  // that matters more than it used to.
  await logCachedImpression(sql, { publisher, page_url, page_title, matches: hydrated, readerCountry, ip, req });
  res.status(200).json({ matches: hydrated, config: pubConfig, cached: true, ...(stale ? { stale: true } : {}) });
  return true;
}

const COUNTRY_NAMES = { AF:'Afghanistan',AL:'Albania',DZ:'Algeria',AR:'Argentina',AU:'Australia',AT:'Austria',BE:'Belgium',BR:'Brazil',CA:'Canada',CL:'Chile',CN:'China',CO:'Colombia',HR:'Croatia',CZ:'Czechia',DK:'Denmark',EG:'Egypt',FI:'Finland',FR:'France',DE:'Germany',GH:'Ghana',GR:'Greece',HK:'Hong Kong',HU:'Hungary',IN:'India',ID:'Indonesia',IE:'Ireland',IL:'Israel',IT:'Italy',JP:'Japan',KE:'Kenya',MY:'Malaysia',MX:'Mexico',MA:'Morocco',NL:'Netherlands',NZ:'New Zealand',NG:'Nigeria',NO:'Norway',PK:'Pakistan',PH:'Philippines',PL:'Poland',PT:'Portugal',RO:'Romania',RU:'Russia',SA:'Saudi Arabia',SG:'Singapore',ZA:'South Africa',KR:'South Korea',ES:'Spain',SE:'Sweden',CH:'Switzerland',TW:'Taiwan',TH:'Thailand',TR:'Turkey',UA:'Ukraine',AE:'UAE',GB:'United Kingdom',US:'United States',VN:'Vietnam' };

const LANG_NAMES = { en:'English', fr:'French', es:'Spanish', de:'German', it:'Italian', pt:'Portuguese', nl:'Dutch', pl:'Polish', sv:'Swedish', no:'Norwegian', da:'Danish', fi:'Finnish', ro:'Romanian', tr:'Turkish', ar:'Arabic', zh:'Chinese', ja:'Japanese', ko:'Korean' };

// Structural approaches for opening the "reason" sentence. A random subset is
// picked per request and assigned one-per-match, so reasons never fall into
// the same "As a first-time founder..." template every time.
const REASON_OPENERS = [
  'Open with a direct question about the reader\'s current challenge',
  'Open by naming the expert\'s most striking credential or number first',
  'Open with a short, blunt imperative telling the reader what to do',
  'Open by naming the specific mistake people often make in this situation',
  'Open with an "It\'s not enough to just X - you also need Y" contrast',
  'Open by referencing the exact decision point from the article phrase',
  'Open with the expert\'s name plus one concrete fact about their track record',
  'Open with "If you\'re stuck on X, ..."',
  'Open by describing what happens if this is gotten wrong',
  'Open with a brief empathetic acknowledgment of the difficulty, then pivot',
  'Open by contrasting reading about it versus actually doing it',
  'Open using the expert\'s company or background as social proof',
  'Open with a rhetorical question about the outcome the reader wants',
  'Open by citing a specific number from the expert\'s experience',
  'Open with "Before you [next logical step], ..."',
  'Open by describing what a 1:1 call unlocks that reading alone can\'t',
  'Open with a comparison to generic advice versus this expert\'s specific help',
  'Open by naming the reader\'s likely internal doubt or hesitation',
  'Open with an action-verb command',
  'Open by naming the specific tactical skill this expert brings',
  'Open with "Getting this right early saves trouble later"',
  'Open with a brief observation about the article\'s point, then bridge to the expert',
  'Open by highlighting a common failure mode this expert has seen repeatedly',
  'Open with what makes this expert\'s angle different from typical advice',
  'Open by acknowledging time pressure founders/readers face here',
  'Open with a specific outcome the expert has delivered for others before',
  'Open by directly referencing the exact topic or phrase from the article',
  'Open with "Most people underestimate..." then pivot to the expert',
  'Open by mentioning the risk of skipping this step entirely',
  'Open by citing the expert\'s years of experience or number of people helped',
  'Open by describing a scenario the reader might recognize themselves in',
  'Open with "One overlooked factor here is..." then pivot to the expert',
  'Open by contrasting generic advice with personalized 1:1 guidance',
  'Open with the specific outcome or goal the reader is chasing',
  'Open by stating plainly why this expert, specifically, and not just anyone'
];
function pickReasonOpeners(n) {
  const shuffled = [...REASON_OPENERS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// Each reason ends with a soft call-to-action nudging the reader toward the
// booking button. Varied per-match the same way as the openers - a single
// fixed instruction ("end with a CTA") converges on identical "We suggest
// talking to X" closers on every card.
const REASON_CLOSERS = [
  'Close by suggesting a quick call with the expert before the reader\'s next step',
  'Close with "worth a chat with [first name] before you commit" style phrasing',
  'Close by noting the expert can walk the reader through it 1:1',
  'Close with "we\'d suggest talking to [first name] about this" style phrasing',
  'Close by inviting the reader to bring their specific situation to the expert',
  'Close by noting this is exactly the kind of problem the expert solves on calls',
  'Close with a "20 minutes with [first name] could save you..." style nudge',
  'Close by suggesting the reader get the expert\'s take before deciding',
  'Close with "if you have time, [first name] is the person to ask" style phrasing',
  'Close by framing a call as the faster path than figuring it out alone',
  'Close by suggesting the reader run their plan past the expert first',
  'Close with a simple, direct "talk to [first name]" style invitation',
  'Close by noting the expert has helped others through this exact situation',
  'Close by inviting the reader to ask the expert their hardest question about this'
];
function pickReasonClosers(n) {
  const shuffled = [...REASON_CLOSERS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// Em/en dashes are banned from output; always use a plain hyphen instead.
function stripEmDash(text) {
  if (!text) return text;
  return text.replace(/[—–]/g, ' - ').replace(/\s{2,}/g, ' ').trim();
}

// Defends against the AI naming the wrong expert in the reason text (it can
// confuse two similar experts from the list): if the correct expert's first
// name is missing but another expert's first name appears instead, swap it.
function fixReasonName(reason, correctExpert, allExperts) {
  if (!reason || !correctExpert?.name) return reason;
  const correctFirst = correctExpert.name.split(' ')[0];
  if (!correctFirst || reason.includes(correctFirst)) return reason;
  for (const e of allExperts) {
    if (e.id === correctExpert.id) continue;
    const otherFirst = (e.name || '').split(' ')[0];
    if (!otherFirst || otherFirst.length < 3) continue;
    const re = new RegExp(`\\b${otherFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(reason)) return reason.replace(re, correctFirst);
  }
  return reason;
}
// Counts total function-word occurrences per language, with English competing
// directly, so the article's dominant language wins even if fragments of another
// language (e.g. a French expert bio quoted on the page) appear in the text.
const LANG_WORDS = {
  en: ['the','and','of','to','is','in','that','for','with','you','your','are','this','have','from','will','not','but','they','was','can','what','how','which','their','has','been','were','would','about','when','more','other','into','than','them','then','some','also','because','through'],
  fr: ['le','la','les','des','une','est','et','pour','avec','dans','vous','votre','nous','sur','qui','que','pas','plus','cette','du','au','par','mais','ont','leur','aux','ce','ses','vos','elle','son','sa','comme','tout','aussi','bien','faire','peut','être','très','sans','même'],
  es: ['el','los','las','que','para','con','una','es','por','su','este','esta','del','se','más','como','pero','sus','al','lo','tiene','también','puede','hacer','todo','cuando','muy','sin','sobre','entre','ya','hay','desde','está','cada'],
  de: ['der','die','das','und','ist','für','mit','den','sie','auf','nicht','ein','eine','des','im','dem','zu','von','werden','auch','sich','bei','oder','wir','aber','wenn','kann','haben','mehr','wie','nach','über','nur','aus','durch','einen','einer','zum','zur','sind'],
  it: ['il','di','che','per','con','una','non','sono','questo','della','del','le','si','più','come','anche','alla','nel','gli','dei','delle','essere','hanno','questa','tra','ma','dal','ai','sul','nella'],
  pt: ['os','um','uma','não','com','para','por','mais','como','seu','sua','dos','das','em','ao','pelo','isso','você','tem','ser','foi','pela','são','muito','quando','também','já','ou','na','da'],
  nl: ['de','het','een','van','voor','met','niet','dat','dit','zijn','worden','ook','naar','maar','bij','uit','deze','wordt','heeft','hebben','kan','meer','als','dan','wat','onze','je'],
  pl: ['nie','się','jest','dla','na','że','ale','jak','po','przez','tego','być','są','oraz','tym','przy','czy','może','tylko','już','bardzo'],
  sv: ['och','att','det','som','för','med','inte','den','är','av','på','har','till','ett','om','ska','kan','från','vi','du','eller','men','efter','vid'],
  no: ['og','det','som','ikke','den','er','av','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','etter','ved','også'],
  da: ['og','det','som','ikke','den','er','af','på','har','til','et','om','skal','kan','fra','vi','du','eller','men','efter','ved','også'],
  fi: ['ja','on','ei','se','että','ovat','tämä','mutta','kun','myös','voi','ole','sen','joka','niin','kuin','jos','vain','mitä'],
  ro: ['și','este','pentru','care','din','pe','cu','nu','mai','sau','sunt','această','acest','dar','după','până','fost','poate','fiecare']
};
const LANG_SETS = Object.fromEntries(
  Object.entries(LANG_WORDS).map(([lang, words]) => [lang, new Set(words)])
);
function detectArticleLanguage(articleText) {
  if (/[؀-ۿ]/.test(articleText)) return 'ar';
  if (/[぀-ヿｦ-ﾟ]/.test(articleText)) return 'ja';
  if (/[가-힯]/.test(articleText)) return 'ko';
  if (/[一-鿿]/.test(articleText)) return 'zh';

  const words = articleText.slice(0, 20000).toLowerCase().split(/[^a-zß-ÿĀ-ſȘ-ț]+/);
  let best = 'en', bestN = 0;
  for (const lang in LANG_SETS) {
    const set = LANG_SETS[lang];
    let n = 0;
    for (const w of words) {
      if (set.has(w)) n++;
    }
    if (n > bestN) { bestN = n; best = lang; }
  }
  // Weak signal (very short or mixed text): default to English
  if (best !== 'en' && bestN < 10) return 'en';
  return best;
}

// Cache keys must not fragment on marketing/tracking query params: every Google
// Ads click mints a unique ?gclid=..., and newsletter links add utm_* - each
// variant was getting its own full AI scan of identical page content (one page
// was scanned 8 times in a day this way). Also drops valueless params like
// Planet Fintech's "?com" comment-view suffix, and the #fragment. Remaining
// real params (e.g. WordPress ?p=123 routing) are kept, sorted for stability.
// preview/print are here for the same reason as the tracking params above,
// not because they're tracking-related: Planet Fintech's CMS generates
// ?preview=1 and ?print=1 links to the same article body, and each was
// getting its own separate cache entry and its own full AI scan - one
// article was charged 4 times in an hour purely from its preview link.
const TRACKING_PARAM_EXACT = new Set([
  'gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'twclid', 'igshid',
  'gbraid', 'wbraid', 'ref', 'ref_src', 's_kwcid', 'mkt_tok', '_hsenc', '_hsmi',
  'preview', 'print'
]);
function normalizePageUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw);
    u.hash = '';
    // www./no-www and trailing-slash/no-trailing-slash are the same page to
    // every real site (both resolve, neither redirects on most WordPress-
    // style setups) but were previously treated as two separate cache
    // entries - each variant paying for its own fresh scan the first time
    // it's hit, even though it's identical content.
    u.hostname = u.hostname.replace(/^www\./i, '');
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (/^(utm_|mc_|pk_|piwik_|gad_)/i.test(k) || TRACKING_PARAM_EXACT.has(k.toLowerCase())) continue;
      if (v === '') continue;
      keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    u.search = keep.length ? '?' + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    return u.toString();
  } catch {
    return raw;
  }
}

// Truncates at the last full sentence within maxLen, so expert descriptions
// in the prompt never cut off mid-word/mid-thought. Falls back to a word
// boundary when the text is one long sentence.
function truncateAtSentence(text, maxLen) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastEnd > maxLen * 0.4) return slice.slice(0, lastEnd + 1);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice) + '...';
}

// Converts a 2-letter ISO 3166-1 country code to its flag emoji by combining
// two Regional Indicator Symbols (U+1F1E6 = 'A', sequential from there) -
// the standard technique renderers use to compose flag emoji from any pair
// of letters, no lookup table of ~200 flags needed. Falls back to a plain
// globe when the code is missing/malformed (readerCountry not resolved).
function countryCodeToFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  const points = code.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...points);
}

// Posts a Slack notification for a page that showed experts to a reader -
// either from a fresh AI scan (🔍, costs tokens) or served straight from
// cache (⚡, free) - so cost and cache health are both visible in one feed.
// Only called when matches were actually shown; silent on 0-match events
// to avoid spamming the channel with every no-match news article.
// Deliberately stays on #introlinq-general (SLACK_WEBHOOK_URL) - this is
// the high-volume "constant matching" noise, not a real event; see
// notifyPublisherWentLive above and the other API files for what moved to
// #introlinq-notifications (SLACK_NOTIFICATIONS_WEBHOOK_URL).
async function postSlackNotification(sql, { publisher, page_url, page_title, matchCount, readerCountry, cached, costUsd }) {
  if (!process.env.SLACK_WEBHOOK_URL || matchCount === 0) return;
  let pubName = publisher || '/app';
  if (publisher) {
    const [pubRow] = await sql`SELECT name FROM publishers WHERE slug = ${publisher} LIMIT 1`.catch(() => [null]);
    if (pubRow?.name) pubName = pubRow.name;
  }
  const countryLabel = readerCountry ? (COUNTRY_NAMES[readerCountry] || readerCountry) : 'Unknown';
  const countryFlag = countryCodeToFlag(readerCountry);
  const title = page_title ? page_title.slice(0, 80) : (page_url ? page_url.slice(0, 80) : 'homepage demo');
  const urlLine = (!publisher && page_url) ? `\n${page_url}` : '';
  const icon = cached ? '⚡' : '🔍';
  const costLabel = cached
    ? 'from cache, no AI cost'
    : (costUsd > 0 ? `fresh scan, ~£${(costUsd * USD_TO_GBP).toFixed(4)}` : 'fresh scan');
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${icon} *${pubName}* · *${matchCount} expert${matchCount !== 1 ? 's' : ''} matched* (${costLabel}) · ${countryFlag} ${countryLabel}\n_${title}_${urlLine}` })
  }).catch(() => {});
}

// Upserts a scan result. `confirmed` follows a small state machine (see the
// column comment in ensureCacheTable): a positive result is always trusted
// immediately; a negative result only becomes permanent on its second
// negative scan, 24h+ after the first. Matches are slimmed to
// {phrase, reason, credential?, expert_id} - expert details are hydrated
// live at serve time (see hydrateMatches), never stored.
// content_hash uses COALESCE(new, old) rather than a blind overwrite: a
// write with no hash (an older caller, or the hash genuinely failed to
// compute) must never blank out a hash a PREVIOUS write already established
// - that would silently disable the content-drift check for this row
// forever, with nothing to ever re-enable it.
async function upsertCacheResult(sql, { pageUrl, countryCode, publisher, matches, contentHash }) {
  const slim = slimMatches(matches);
  const hasMatch = matches.length > 0;
  // A positive result whose entries couldn't be slimmed (no expert ids -
  // shouldn't happen) is unusable: stored as-is it would hydrate to zero on
  // every read and trigger a re-scan loop, and stored as a negative it would
  // be a false "no experts fit this page" verdict. Skip the write entirely.
  if (hasMatch && slim.length === 0) return;
  await sql`
    INSERT INTO match_cache (page_url, country_code, publisher, result, has_match, confirmed, content_hash)
    VALUES (${pageUrl}, ${countryCode}, ${publisher || ''}, ${JSON.stringify({ matches: slim })}, ${hasMatch}, ${hasMatch}, ${contentHash || null})
    ON CONFLICT (page_url, country_code, publisher) DO UPDATE SET
      result = EXCLUDED.result,
      has_match = EXCLUDED.has_match,
      content_hash = COALESCE(EXCLUDED.content_hash, match_cache.content_hash),
      confirmed = CASE
        WHEN EXCLUDED.has_match = true THEN true
        WHEN match_cache.has_match = false AND match_cache.confirmed = true THEN true
        WHEN match_cache.has_match = false AND match_cache.confirmed = false AND match_cache.cached_at <= NOW() - INTERVAL '24 hours' THEN true
        ELSE false
      END,
      cached_at = NOW()
  `.catch(() => {});
}

// Folds ONE quick/chunk piece's DOM-verified matches into the page's cache entry
// the instant that piece renders - merged with whatever's already there, not a
// blind overwrite (a naive upsertCacheResult call here would REPLACE the cache
// with just this piece's matches and silently lose an earlier piece's). This is
// what stops an abandoned page-view from throwing away a genuinely good, already-
// paid-for match: previously, caching only happened after the WHOLE page-view
// (quick + every chunk) survived long enough for the client to merge and report
// everything at once - if the reader closed the tab before that, the match was
// found, cost money, and was then discarded, and the next visitor re-paid for the
// same page from scratch. Only called with matches the widget already confirmed
// actually highlight in the live DOM (see widget.js) - a chunk finding nothing
// says nothing about the rest of the article, so it must never write a negative
// verdict; only the full end-of-visit report (which saw every chunk) may confirm
// a true page-wide "no match".
async function mergeMatchesIntoCache(sql, { pageUrl, publisher, contentHash, newMatches }) {
  if (!pageUrl || !newMatches || newMatches.length === 0) return;
  const [existing] = await sql`
    SELECT result FROM match_cache
    WHERE page_url = ${pageUrl} AND publisher = ${publisher || ''} AND country_code = ${GLOBAL_CACHE_COUNTRY}
  `.catch(() => [null]);
  const existingMatches = existing?.result?.matches || [];
  const seen = new Set(existingMatches.map(m => m.expert_id ?? m.expert?.id).filter(id => id != null));
  const merged = existingMatches.concat(newMatches.filter(m => {
    const id = m.expert_id ?? m.expert?.id;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
  await upsertCacheResult(sql, { pageUrl, countryCode: GLOBAL_CACHE_COUNTRY, publisher, matches: merged, contentHash }).catch(() => {});
}

// Lightweight sibling of handleReport: caches one piece's already-rendered
// matches and nothing else - no match_logs row, no Slack, no publisher-activity
// bump. Those all stay exclusively tied to the one final consolidated report per
// page-view (handleReport), so impression counts and notifications are unaffected
// by how many of these partial calls fire.
async function handlePartialCache(req, res) {
  const { publisher, matches } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  const contentHash = typeof req.body.content_hash === 'string' ? req.body.content_hash.slice(0, 64) : null;
  if (!page_url || !Array.isArray(matches) || matches.length === 0) {
    return res.status(200).json({ ok: true });
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    await ensureCacheTable(sql);
    await mergeMatchesIntoCache(sql, { pageUrl: page_url, publisher, contentHash, newMatches: matches });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}

async function ensureCacheTable(sql) {
  if (cacheTableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS match_cache (
    id SERIAL PRIMARY KEY,
    page_url TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT '',
    publisher TEXT NOT NULL DEFAULT '',
    result JSONB NOT NULL,
    has_match BOOLEAN NOT NULL,
    cached_at TIMESTAMPTZ DEFAULT NOW()
  )`.catch(() => {});
  await sql`ALTER TABLE match_cache ADD COLUMN IF NOT EXISTS publisher TEXT NOT NULL DEFAULT ''`.catch(() => {});
  // A "no match" verdict is trusted at temperature 0.7, which can occasionally
  // land on 0 matches for a page that reliably matched many times before - a
  // single scan shouldn't permanently hide a page over one AI roll. The FIRST
  // negative scan is cached but unconfirmed (still served for 24h, so repeat
  // traffic doesn't cause repeat scans); only a SECOND negative scan after
  // that 24h window promotes it to permanent. DEFAULT true so existing rows
  // (written before this column existed) keep their current behavior exactly
  // as-is rather than all re-triggering re-scans at once.
  await sql`ALTER TABLE match_cache ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT true`.catch(() => {});
  // Hash of the article text the cached result was computed FROM (sent by the
  // widget). Lets an edited article at the same URL invalidate itself: a
  // mismatch is treated as a cache miss and rescanned. NULL (old rows, old
  // widget copies that don't send a hash) means "no check possible" - serve.
  await sql`ALTER TABLE match_cache ADD COLUMN IF NOT EXISTS content_hash TEXT`.catch(() => {});
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_key`.catch(() => {});
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_publisher_key`.catch(() => {});
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS match_cache_unique ON match_cache(page_url, country_code, publisher)`.catch(() => {});
  cacheTableReady = true;
}

let scanLocksTableReady = false;

async function ensureScanLocksTable(sql) {
  if (scanLocksTableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS scan_locks (
    page_url TEXT NOT NULL,
    publisher TEXT NOT NULL DEFAULT '',
    country_code TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (page_url, publisher, country_code)
  )`.catch(() => {});
  scanLocksTableReady = true;
}

// Atomically claims the right to run a background scan for this exact page, so
// a burst of visitors hitting the same brand-new (or just-changed) page within
// the same few seconds triggers exactly ONE scan instead of one per visitor.
// The INSERT ... ON CONFLICT ... RETURNING pattern is what makes this safe
// under concurrency: Postgres serializes conflicting writes to the same row,
// so of several simultaneous callers only one's UPDATE can see started_at as
// still "stale enough" to satisfy the WHERE clause and get a row back -
// everyone else's write matches nothing and they get an empty result back,
// with no explicit locking needed. The 2-minute staleness window is a literal
// here, not a template variable, for the same INTERVAL-syntax reason
// documented on SCAN_CAP_LIMIT above - it comfortably exceeds the slowest
// realistic single-article scan (vercel.json caps this function at 60s), so a
// genuinely crashed or timed-out attempt self-heals instead of leaving the
// page permanently unscannable.
async function claimScanLock(sql, { pageUrl, publisher, countryCode }) {
  const rows = await sql`
    INSERT INTO scan_locks (page_url, publisher, country_code, started_at)
    VALUES (${pageUrl}, ${publisher || ''}, ${countryCode}, NOW())
    ON CONFLICT (page_url, publisher, country_code) DO UPDATE
      SET started_at = NOW()
      WHERE scan_locks.started_at < NOW() - INTERVAL '2 minutes'
    RETURNING 1
  `.catch(() => []);
  return rows.length > 0;
}

async function releaseScanLock(sql, { pageUrl, publisher, countryCode }) {
  await sql`
    DELETE FROM scan_locks WHERE page_url = ${pageUrl} AND publisher = ${publisher || ''} AND country_code = ${countryCode}
  `.catch(() => {});
}

// Client has already merged results from the quick pass + all article chunks.
// Persist the final set (cache + log + Slack) without any further AI calls.
async function handleReport(req, res) {
  const { publisher, page_title, matches, complete, cost_usd } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  const contentHash = typeof req.body.content_hash === 'string' ? req.body.content_hash.slice(0, 64) : null;
  if (!page_url || !Array.isArray(matches)) {
    return res.status(400).json({ error: 'Missing page_url or matches' });
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const ip = getClientIp(req);

    await ensureCacheTable(sql);

    // A 0-match result only means "no experts here" if every chunk actually ran -
    // if some chunk requests failed (a transient API error, a timeout), 0 matches
    // is a partial-failure artifact. Caching that as has_match:false would wrongly
    // freeze the page as a permanent non-match. `complete` must be EXPLICITLY true:
    // older cached widget.js clients don't send it at all, and their zero-match
    // reports can't distinguish failure from no-match, so they never get to write
    // a negative cache entry (their positive results still cache fine).
    const scanWasComplete = complete === true;
    if (matches.length > 0 || scanWasComplete) {
      await upsertCacheResult(sql, { pageUrl: page_url, countryCode: GLOBAL_CACHE_COUNTRY, publisher, matches, contentHash });
    }

    await ensureLogTable(sql);

    const phrases = matches.map(m => m.phrase);
    const expertNames = matches.map(m => m.expert?.name).filter(Boolean);
    const expertBookingUrls = matches.map(m => m.expert?.booking_url || null);
    const preview = (page_title || page_url || '').slice(0, 120);

    const noMatchLogReason = matches.length === 0
      ? (scanWasComplete ? 'No matches found across article' : 'Partial scan failure - some chunks did not respond, not cached')
      : null;

    const reportCostUsd = typeof cost_usd === 'number' ? cost_usd : 0;

    if (!matchLogsBotColumnsReady) {
      await ensureBotColumns(sql, 'match_logs');
      matchLogsBotColumnsReady = true;
    }
    const isBot = await isBotHit(req, sql, 'match_logs', { ip, publisher, page_url });

    await sql`
      INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, country_code, cost_usd, ip, is_bot)
      VALUES (${publisher || null}, ${preview}, ${phrases}, ${expertNames}, ${expertBookingUrls}, ${matches.length}, ${page_url}, ${noMatchLogReason}, ${readerCountry || null}, ${reportCostUsd}, ${ip || null}, ${isBot})
    `.catch(() => {});
    await markPublisherActivity(sql, publisher);

    if (!isBot) {
      await postSlackNotification(sql, { publisher, page_url, page_title, matchCount: matches.length, readerCountry, cached: false, costUsd: reportCostUsd });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false });
  }
}

// A cache HIT is served (and logged/Slack-notified) the instant it's
// hydrated, with no confirmation that the widget actually managed to
// highlight anything - unlike a fresh scan, whose report always reflects
// what really rendered. If the cached phrases no longer exist verbatim in
// the live DOM (the page changed enough that wording drifted, even if
// content_hash didn't catch it - e.g. an old entry from before content_hash
// was populated), the widget silently shows nothing while the log still
// says "N found", and nothing was ever in place to notice or recover. This
// lets the widget report that back so the entry is thrown away instead of
// failing the same way for every subsequent visitor indefinitely.
async function handleStaleCache(req, res) {
  const { publisher } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  if (!page_url) return res.status(200).json({ ok: true });
  try {
    const sql = neon(process.env.DATABASE_URL);
    // Only positive entries have a rendering-failure mode (nothing to
    // highlight on a negative). The 2-minute floor on cached_at stops a
    // burst of reports for the same entry (several tabs, a bad actor) from
    // forcing back-to-back rescans - a genuine failure from a separate
    // later visitor will comfortably clear it.
    await sql`
      DELETE FROM match_cache
      WHERE page_url = ${page_url}
        AND publisher = ${publisher || ''}
        AND country_code = ${GLOBAL_CACHE_COUNTRY}
        AND has_match = true
        AND cached_at < NOW() - INTERVAL '2 minutes'
    `.catch(() => {});
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: true });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // report/partialCache are dead paths as of the background-scan redesign
  // (the current widget.js never sends either) - kept only for backward
  // compatibility with any not-yet-updated cached copy of the old widget
  // still fetching quick/chunk-style requests out in the wild. staleCache is
  // very much still live - the current widget still sends it on a drifted
  // cache hit (see widget.js's postScan).
  if (req.body && req.body.report === true) {
    return handleReport(req, res);
  }
  if (req.body && req.body.staleCache === true) {
    return handleStaleCache(req, res);
  }
  if (req.body && req.body.partialCache === true) {
    return handlePartialCache(req, res);
  }

  const { article, page_title, lang } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  // Hash of the article text, computed once by the widget and sent with the
  // request. Compared against the hash stored with the cached result - see
  // the mismatch check below - to detect an article edited at the same URL.
  const contentHash = typeof req.body.content_hash === 'string' ? req.body.content_hash.slice(0, 64) : null;
  if (!article || article.trim().length < 50) {
    return res.status(400).json({ error: 'Article text is too short' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const { publisher } = req.body;
    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const ip = getClientIp(req);

    if (page_url) await ensureCacheTable(sql);

    // Publisher config and the cache lookup have no data dependency - run
    // them in parallel. The experts list is deliberately NOT fetched here
    // anymore: a cache hit only needs the handful of experts it actually
    // references (loadExpertsByIds, below), not the whole active roster.
    // Fetching everyone unconditionally on every request - hit or miss - was
    // the actual driver behind a 5GB/month Neon egress warning: a typical
    // cached page references ~6 experts but was paying to fetch all ~127.
    // The full roster (loadExperts) is only ever fetched further down, and
    // only when a fresh AI scan is genuinely about to run.
    //
    // Cache rules: one entry per page, shared by every reader everywhere -
    // country no longer affects the cache key (see GLOBAL_CACHE_COUNTRY) or
    // the match itself. Positives live until the publisher's settings
    // change or an admin recrawl - an expert re-sync does NOT invalidate
    // them anymore. Profile edits flow into cached pages through live
    // hydration, and unpublished/blocked experts are filtered out at serve
    // time (see hydrateMatches), so there's nothing about a sync that a
    // cached page needs a re-scan for. New-supply discovery (a new partner
    // whose experts might match previously scanned pages) is a deliberate,
    // manual recrawl - not an automatic sitewide invalidation. Unconfirmed
    // negatives are trusted 24h, confirmed ones are permanent until an
    // admin recrawls the publisher.
    // Must exist before the SELECT below reads it - a bare column-missing
    // Postgres error there gets swallowed by that query's own .catch(),
    // which reads as "publisher not found" and silently zeroes out matches
    // for every publisher until something else happens to create the column.
    if (!discoveryCueColumnReady) {
      await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS discovery_cue_enabled BOOLEAN DEFAULT true`.catch(() => {});
      discoveryCueColumnReady = true;
    }
    if (!scanCapColumnReady) {
      await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS scan_cap_override BOOLEAN NOT NULL DEFAULT false`.catch(() => {});
      scanCapColumnReady = true;
    }
    const [pubRows, cachedRows] = await Promise.all([
      publisher
        ? sql`SELECT match_power, match_sensitivity, widget_color, accent_color, widget_size, highlight_style, discovery_cue_enabled, scan_cap_override, COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners FROM publishers WHERE slug = ${publisher} AND active = true LIMIT 1`.catch(() => [null])
        : Promise.resolve([null]),
      page_url
        ? sql`
            SELECT result, has_match, content_hash FROM match_cache
            WHERE page_url = ${page_url}
              AND publisher = ${publisher || ''}
              AND country_code = ${GLOBAL_CACHE_COUNTRY}
              AND (
                has_match = true
                OR (has_match = false AND (confirmed = true OR cached_at > NOW() - INTERVAL '24 hours'))
              )
              AND cached_at > NOW() - INTERVAL '1 year'
            ORDER BY has_match DESC
            LIMIT 1
          `.catch(() => [null])
        : Promise.resolve([null]),
    ]);

    const pub = pubRows[0];
    if (publisher && !pub) {
      // Publisher deactivated or unknown - don't serve the widget
      return res.status(200).json({ matches: [] });
    }

    let maxMatches = 3;
    let sensitivityInstruction = 'Match on broader topic overlap. If the expert\'s field is relevant to the section, include them. Prefer more matches over fewer.';
    let pubConfig = { color: '#e6a820', accent: '#e6a820', size: 'medium', highlightStyle: 'fill', discoveryCue: true };
    let enabledPartners = null; // null = homepage demo

    if (pub) {
      const powerMap = { light: 2, moderate: 4, heavy: 10, unlimited: 15 };
      maxMatches = powerMap[pub.match_power] ?? 4;
      const sensitivityMap = {
        strict: 'The match must be very specific and actionable. Only match if the expert\'s expertise directly addresses the exact challenge described. A weak match is worse than no match.',
        balanced: 'Match when there is clear value to the reader. The connection should be meaningful but does not need to be hyper-specific.',
        open: 'Match on broader topic overlap. If the expert\'s field is relevant to the section, include them. Prefer more matches over fewer.',
      };
      sensitivityInstruction = sensitivityMap[pub.match_sensitivity] ?? sensitivityMap.balanced;
      pubConfig = { color: pub.widget_color || '#e6a820', accent: pub.accent_color || '#e6a820', size: pub.widget_size || 'medium', highlightStyle: pub.highlight_style || 'fill', discoveryCue: pub.discovery_cue_enabled !== false };
      enabledPartners = pub.enabled_partners || ['openintro'];
    }

    // widget2.js experiment - explicit opt-in only, so this can never affect
    // a real publisher's widget.js traffic. Cache-read-only (see
    // handleMultiVariant's own comment) and returns here, before any of the
    // normal single-expert cache-serve/fresh-scan flow below runs.
    if (req.body.variant === 'multi') {
      const result = await handleMultiVariant(sql, { publisher, page_url, page_title, readerCountry, ip, req, pubConfig, enabledPartners });
      return res.status(200).json(result);
    }

    const cached = cachedRows[0];
    // The article was EDITED at the same URL since it was scanned: the cached
    // verdict (positive or negative) describes text that no longer exists,
    // so treat it as a miss and rescan. Only enforceable when both sides
    // have a hash - old cache rows and old cached widget.js copies don't.
    const contentChanged = cached && cached.content_hash && contentHash && cached.content_hash !== contentHash;
    if (cached && !contentChanged) {
      // A null return means the referenced-experts fetch itself failed (not
      // "zero experts") or the cached answer no longer has any surviving
      // experts - fall through to the fresh-scan path below rather than
      // serving a false empty result.
      if (await tryServeFromCache(res, sql, { cached, enabledPartners, publisher, page_url, page_title, readerCountry, ip, pubConfig, req })) return;
    }

    // A cached answer exists but looks stale (hash drifted) AND this exact
    // IP is already hammering this exact page - rather than pay for another
    // AI rescan on every repeat hit (the same cost pattern that burned real
    // money on challenges-tn before its rotating-ad-widget hash issue was
    // fixed - this is a backstop for any OTHER, not-yet-diagnosed source of
    // hash instability), serve the last known-good answer instead. A
    // genuinely new, never-before-scanned page (cached === null) is NEVER
    // short-circuited this way, no matter how bursty - first discovery of
    // real content always gets a real scan. Known-good crawlers skip this
    // check entirely and always get a fresh scan, since accuracy matters
    // more for a bot that might represent this content to someone else's
    // audience, and legitimate crawlers don't hammer one URL like this.
    if (cached && contentChanged && !isAllowlistedCrawler(req)) {
      const isBot = isKnownCrawlerIp(ip) || (await isBurstTraffic(sql, 'match_logs', { ip, publisher, page_url }));
      if (isBot) {
        if (await tryServeFromCache(res, sql, { cached, enabledPartners, publisher, page_url, page_title, readerCountry, ip, pubConfig, stale: true, req })) return;
      }
    }

    // New-publisher scan cap: once a non-exempt publisher has scanned this
    // many pages within the rolling window (any verdict - a "no match" scan
    // still cost real money), pause further fresh scans for them until the
    // window rolls forward or an admin lifts it. Doesn't cache this outcome
    // as a real answer - a page that hit the cap gets retried for real the
    // next time it's visited after room frees up, not permanently written
    // off as "no match". Only reachable here (not for a normal cache hit or
    // the stale-cache short-circuit above), so already-cached pages are
    // never affected.
    if (pub && !pub.scan_cap_override) {
      const capCheck = await sql`SELECT COUNT(*)::int AS n FROM match_cache
        WHERE publisher = ${publisher} AND cached_at > NOW() - INTERVAL '30 days'`;
      if (capCheck[0].n >= SCAN_CAP_LIMIT) {
        return res.status(200).json({ matches: [], config: pubConfig, capped: true });
      }
    }

    // Reaching here means a fresh scan is genuinely warranted (cache miss,
    // content changed, or the cached answer emptied out) - but nobody waits
    // for it anymore. Claim the exclusive right to run it for this exact
    // page, respond immediately either way, and only the winner of that claim
    // actually calls Anthropic - in the background, after the response is
    // already on the wire. The reader whose visit triggers this never sees
    // the result of their own visit; by the time anyone else arrives, the
    // page is already cached. See claimScanLock's comment for why a burst of
    // simultaneous visitors to the same new page still only costs one scan.
    if (!page_url) {
      // No page_url means no page identity to hang a background scan or a
      // lock on - nothing to do.
      return res.status(200).json({ matches: [], config: pubConfig });
    }
    await ensureScanLocksTable(sql);
    const claimed = await claimScanLock(sql, { pageUrl: page_url, publisher, countryCode: GLOBAL_CACHE_COUNTRY });

    res.status(200).json({ matches: [], config: pubConfig, pending: true });
    // The widget successfully reached us either way (claimed the scan or not) -
    // that's the real-world signal this is meant to catch. Awaited so it
    // reliably lands even though the function may return right after (see the
    // !claimed branch below) - see the comment on this function for why.
    await markPublisherActivity(sql, publisher);

    if (!claimed) return; // another request already owns this page's scan

    try {
      // THIS is where the full active roster is actually needed, as the AI's
      // candidate pool. Any failure from here on is background work nobody's
      // waiting on - caught below and logged, never touching `res` again.
      const allExperts = await loadExperts(sql);
      if (!allExperts) return;

      // Filter by group: real publishers see their enabled providers only; homepage demo sees non-demo experts
      let experts = [...allExperts].filter(e =>
        enabledPartners
          ? enabledPartners.includes(e.provider_slug || 'openintro')
          : !e.is_demo_provider
      );

      if (experts.length === 0) return;

      // Fairness without randomness: rotate the (id-ordered) list by a daily
      // offset, so no expert permanently owns the top positions the model
      // attends to most - but within any given day the order is identical
      // across all requests/instances, keeping the prompt prefix cacheable.
      // (The old same-country-first sort is gone: it silently reordered the
      // list per reader, defeating caching, without ever telling the model
      // that order mattered. The reader's country is now stated explicitly in
      // the prompt instead.)
      const rotation = Math.floor(Date.now() / 86400000) % experts.length;
      experts = experts.slice(rotation).concat(experts.slice(0, rotation));

      // bio is a hand-crafted credential one-liner (dense signal); the old
      // description_long.slice(0,150) usually cut off mid-word before reaching
      // any credentials. Include both: bio + description truncated at a
      // sentence boundary. Price dropped - it never informs the match decision
      // and cost tokens on every expert.
      const expertsList = experts.map(e => {
        const role = [e.position, e.company].filter(Boolean).join(' at ');
        const langs = (e.languages || []).join(', ');
        // Trimmed from 400 - highlights (below) now carry more of the dense-
        // signal weight this used to shoulder alone, so the long-form
        // description doesn't need as much room.
        const desc = truncateAtSentence(e.description_long || '', 250);
        const services = (e.services || []).slice(0, 3).join('; ');
        // Curated, pre-summarized achievement bullets - denser matching
        // signal per token than freeform description text. Capped at 4 for
        // the same reason services is capped at 3: unbounded per-expert
        // content scales badly across the whole roster in one prompt.
        const highlights = (e.highlights || []).slice(0, 4).join('; ');
        const about = [e.bio, desc].filter(Boolean).join(' - ');
        return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''} | Languages: ${langs} | About: ${about}${highlights ? ` | Highlights: ${highlights}` : ''} | Services: ${services}`;
      }).join('\n\n');

      // Detect once per scan - there's only one scan per page-view now, so no
      // need to trust a widget-precomputed value across multiple requests the
      // way the old quick/chunk split did.
      const articleLangCode = (lang && LANG_NAMES[lang]) ? lang : detectArticleLanguage(article);
      const articleLangName = LANG_NAMES[articleLangCode] || 'English';

      // Only mention other languages when the article is actually non-English:
      // naming "vous/Sie" in the prompt for English articles made the model
      // occasionally swap words ("If vous need...") or answer in French/German.
      const languageInstruction = articleLangCode === 'en'
        ? 'The article is in English. Write every "reason" field entirely in natural English. Expert names, company names, or bios may be in other languages - ignore that; the reason must be 100% English.'
        : `The article is in ${articleLangName}. Strongly prioritise experts who speak ${articleLangName}. Write every "reason" field entirely in ${articleLangName} - never mix languages within a sentence. Use formal address, never informal.`;

      // The prompt is split into two blocks so Anthropic prompt caching can
      // work: the static block (instructions + the full experts list - the
      // vast bulk of the tokens) is byte-identical for every scan of the
      // same publisher on the same day, so it's cached (ttl: '1h', re-warmed
      // by any request within that hour) and re-billed at ~10% on a hit.
      // Everything per-request (article text, its language, match count, the
      // shuffled opener/closer styles) lives in the dynamic block AFTER the
      // cache breakpoint. Anything added to the static block must be stable
      // per publisher+day or it silently kills the cache hit rate.
      const staticPrompt = `You are the matching engine for IntroLinq, a platform that connects blog READERS with experts they can book a 1:1 call with.

Your job: identify moments in the article where a reader - someone trying to learn, make a decision, or solve a problem - would benefit from a personal consultation with a specific expert. ${sensitivityInstruction}

Criteria for a valid match:
1. The reader faces a specific, actionable challenge or decision - not just reading about a topic
2. The expert's expertise is a clear fit for that challenge (not just the same broad field)
3. A 1:1 call with this expert would genuinely help the reader take action

Match how-to articles, guides, and educational content where the reader is actively trying to do something. Return 0 matches for pure news, press releases, or company announcements where the reader is passively informed.

NEVER match:
- News articles, press releases, or company announcements
- CEO or executive quotes about their own strategy
- Funding rounds, valuations, or investor names
- Statistics being reported, not explained
- Phrases where a company describes what it is doing (not what the reader needs to do)
- Vague keyword overlap where the expert's services don't clearly fit the specific moment
- Alerts or warnings that inform the reader of a risk or event without asking them to decide anything right now (e.g. "cyberattacks are rising", a rating agency's verdict on a country, a regulator's ruling) - being informed of something is not the same as facing a decision

THE TEST FOR NEWS VS A REAL MATCH: ask whose problem the sentence is actually about. If the one making a decision or taking action is a company, government, agency, or other third party - and the reader is simply being told about it - this is news, even when the topic (finance, tech, cybersecurity, hiring...) overlaps with an expert's field. A valid match requires the READER to be the one who needs to act, not a spectator to someone else's. Real examples of news that must NOT match, despite already violating the rules above: a company reorganizing an internal division, a rating agency maintaining a country's credit rating, a startup's funding round, a manufacturer confirming a joint venture, a vendor's report that a category of attack or risk is rising. Every one of these describes something happening TO or BY someone else, with the reader as a bystander - matching them is exactly the failure mode this rule exists to prevent.

DOMAIN FIT - this rule overrides everything above, including the matching sensitivity: an expert is only a valid match if their own field of work covers the reader's SPECIFIC problem. Never connect a generalist business expert to a specialist topic through a chain of reasoning. Real examples of forbidden stretches: a negotiation coach matched to "responding to Google reviews", a financial-modeling advisor matched to "tracking SEO metrics", a brand designer matched to "choosing profile photos for a business listing" - each sounds clever but the expert does not actually work in that field, and a reader who books the wrong specialist loses trust in every future suggestion. The test: would this expert themselves list the reader's problem as something they help clients with? If none of the available experts genuinely work in the article's domain, return fewer matches or zero - zero is a correct and common answer, not a failure. Sensitivity controls how many GOOD matches to return, never whether a bad match is acceptable.

IMPORTANT: Never use an em dash (—) or en dash (–) anywhere in the "reason" text. Use a plain hyphen with spaces ( - ) instead, or just rephrase as separate sentences.

IMPORTANT: Keep each "reason" to at most 30 words (one or two short sentences). This is a length limit only - the STYLE of each reason must follow its assigned opening approach and closing approach from the numbered lists provided with the article.

IMPORTANT: The name you write inside each "reason" MUST be the exact same expert whose ID you put in "expert_id" for that match. Double-check you are not naming a different expert from the list by mistake.

ALTERNATES: when OTHER experts from the list are ALSO a genuinely strong fit for the same challenge (passing every rule above, including domain fit), add up to 2 of them to that match's "alternates" array, each with their own complete "reason" written to the same standards and naming that alternate expert. Alternates are interchangeable candidates for the same phrase - the reader is shown exactly one of them - so each reason must stand entirely on its own. Never repeat an expert anywhere in your response: every expert_id across all matches AND all alternates must be unique. Most matches have no genuine alternates - an empty or omitted "alternates" array is the normal case, and a weak alternate is worse than none.

Available experts:
${expertsList}`;

      // No reader-country hint in the prompt: the match this scan produces
      // gets cached globally and shown identically to every country, so
      // biasing it toward whichever reader happened to trigger the scan
      // would just be arbitrary noise, not a real signal about the audience.
      const titleLine = page_title ? `Article title: ${String(page_title).slice(0, 150)}\n\n` : '';

      // The card shows the expert's credential one-liner above the reason. For
      // non-English articles it would appear in English next to a translated
      // reason, so the model translates it per match; English articles skip
      // this entirely and the widget falls back to the stored bio (no extra
      // output tokens for the common case).
      const wantsCredential = articleLangCode !== 'en';
      const credentialInstruction = wantsCredential
        ? `\nFor each match, also include a "credential" field: the expert's one-line track record (the first sentence of their About) faithfully translated into ${articleLangName}. Keep all numbers, currency amounts, and company names exactly as they are. Translate only - no embellishment, no additions.\n`
        : '';
      const credentialSchema = wantsCredential
        ? `,"credential":"the expert's one-line track record translated into ${articleLangName}"`
        : '';

      const dynamicPrompt = `IMPORTANT: ${languageInstruction}
${credentialInstruction}
${titleLine}Return up to ${maxMatches} matches.

For each match's "reason", use a DIFFERENT one of these opening approaches — assign them in order to the matches you return (first match uses approach 1, second uses approach 2, etc.), and never reuse an approach or fall back to a generic "As a first-time founder..." opener regardless of what these approaches say:
${pickReasonOpeners(Math.max(maxMatches, 6)).map((o, i) => `${i + 1}. ${o}`).join('\n')}

Each "reason" must also END with a soft call-to-action inviting the reader to actually talk to the expert - assign these closing approaches in order the same way (first match uses closer 1, second uses closer 2, etc.), never reusing one or defaulting to the same "We suggest talking to..." on every match:
${pickReasonClosers(Math.max(maxMatches, 6)).map((c, i) => `${i + 1}. ${c}`).join('\n')}

Article:
${article.slice(0, 60000)}

Return only valid JSON, no other text:
{"matches":[{"phrase":"exact substring from article","expert_id":1,"reason":"One sentence speaking directly to the reader in second person, opening with the specific challenge rather than a generic reader description - e.g. 'Negotiating your first term sheet without giving away too much equity is tricky - Phil has backed 200+ startups and can walk you through it.'"${credentialSchema},"alternates":[{"expert_id":2,"reason":"same standards, naming THIS expert"${credentialSchema}}]}],"no_match_reason":"Only include this field when matches is empty. One short phrase explaining why - e.g. 'News article', 'Product announcement', 'Company profile / press release', 'No actionable reader challenge identified', 'Pure statistics reporting'"}}`;

      // Response is already sent - nothing here races a live visitor anymore,
      // so this just needs to fit inside vercel.json's 60s function ceiling.
      // 50s leaves headroom for the cache write, cost log, and Slack call
      // that follow.
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(50000),
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          // Budgets sized for matches PLUS their alternates (each alternate is
          // another full reason sentence) - undersized budgets truncate the
          // JSON mid-output and the salvage regex can only recover part of it.
          max_tokens: maxMatches <= 4 ? 1536 : maxMatches <= 10 ? 3072 : 4096,
          // 0.7 was set to fix repetitive "As a first-time founder..." openers,
          // before REASON_OPENERS/REASON_CLOSERS existed to assign style
          // deterministically per match. That variety no longer depends on
          // temperature, so high temperature was only adding noise to the
          // match/no-match judgment itself - the same article could swing from
          // 19 matches to 0 between runs. Lowered for a more consistent verdict
          // while keeping enough variation that phrasing doesn't feel robotic.
          temperature: 0.3,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: dynamicPrompt }
            ]
          }]
        })
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('Anthropic API error:', err);
        return;
      }

      const aiResult = await response.json();
      // Cache effectiveness is invisible without this: cache_read_input_tokens
      // should be large (the whole static block) on all but the first scan
      // of a publisher+day. If it's persistently 0, something reintroduced
      // per-request bytes into the static block.
      console.log('[ai-usage]', 'background', JSON.stringify(aiResult.usage || {}));
      const text = aiResult.content?.[0]?.text || '{"matches":[]}';

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { matches: [] };
        } catch {
          // Output was truncated mid-JSON: salvage the complete match objects
          const objs = [...text.matchAll(/\{[^{}]*"phrase"[^{}]*\}/g)]
            .map(m => { try { return JSON.parse(m[0]); } catch { return null; } })
            .filter(Boolean);
          parsed = { matches: objs };
        }
      }

      const expertMap = Object.fromEntries(experts.map(e => [e.id, e]));
      const seenExperts = new Set();
      const enriched = (parsed.matches || [])
        .filter(m => m.phrase && expertMap[m.expert_id])
        .filter(m => { if (seenExperts.has(m.expert_id)) return false; seenExperts.add(m.expert_id); return true; })
        .map(m => {
          const expert = expertMap[m.expert_id];
          const reason = stripEmDash(fixReasonName(m.reason, expert, experts));
          const out = { phrase: m.phrase, reason, expert };
          // Translated credential line for non-English articles (see
          // credentialInstruction). Flows through cache so serve-time
          // hydration can show it; the widget falls back to the stored
          // English bio when absent (English articles, old cache entries).
          if (typeof m.credential === 'string' && m.credential.trim()) {
            out.credential = stripEmDash(m.credential.trim()).slice(0, 220);
          }
          // Interchangeable candidates for the same phrase (see the ALTERNATES
          // prompt rule) - ride along through the cache so serve-time rotation
          // can pick any surviving candidate per visit. Same validation as
          // primaries: real expert, globally unique, reason names its own expert.
          const alts = (Array.isArray(m.alternates) ? m.alternates : [])
            .filter(a => a && expertMap[a.expert_id] && typeof a.reason === 'string')
            .filter(a => { if (seenExperts.has(a.expert_id)) return false; seenExperts.add(a.expert_id); return true; })
            .slice(0, 2)
            .map(a => {
              const altOut = { expert_id: a.expert_id, reason: stripEmDash(fixReasonName(a.reason, expertMap[a.expert_id], experts)) };
              if (typeof a.credential === 'string' && a.credential.trim()) {
                altOut.credential = stripEmDash(a.credential.trim()).slice(0, 220);
              }
              return altOut;
            });
          if (alts.length > 0) out.alts = alts;
          return out;
        });

      const costUsd = usageCostUSD(aiResult.usage);
      // Real money Anthropic already charged for the instant this line runs -
      // logged unconditionally, independent of everything below it succeeding.
      await logAiCall(sql, { publisher, pageUrl: page_url, callType: 'background', usage: aiResult.usage, costUsd });
      await upsertCacheResult(sql, { pageUrl: page_url, countryCode: GLOBAL_CACHE_COUNTRY, publisher, matches: enriched, contentHash });

      // No match_logs row here, deliberately: nobody actually saw this scan's
      // result - the reader who triggered it already got the empty `pending`
      // response above. match_logs.match_count is an IMPRESSION count
      // elsewhere in this codebase (the admin dashboard sums it as
      // impressions shown to readers), and logging one here would count
      // something nobody saw. The next real visitor hits this now-populated
      // cache and logs a normal impression through the existing
      // tryServeFromCache path, same as always. Slack still gets the same
      // "a scan just happened" visibility it always has, gated by the same
      // bot check as every other fresh-scan notification.
      const isBot = await isBotHit(req, sql, 'match_logs', { ip, publisher, page_url });
      if (!isBot) {
        await postSlackNotification(sql, { publisher, page_url, page_title, matchCount: enriched.length, readerCountry, cached: false, costUsd });
      }
    } catch (err) {
      console.error(err);
    } finally {
      await releaseScanLock(sql, { pageUrl: page_url, publisher, countryCode: GLOBAL_CACHE_COUNTRY });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
