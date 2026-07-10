import { neon } from '@neondatabase/serverless';

let logTableReady = false;
let cacheTableReady = false;
let expertsCache = null;
let expertsCacheTime = 0;
const EXPERTS_TTL = 5 * 60 * 1000;

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
  logTableReady = true;
}

// A cache hit still counts as an impression (log) and, when it actually
// showed experts, a Slack ping. Shared by every cache-serving path - this
// block used to be copy-pasted three times with drifting details.
function logCachedImpression(sql, { publisher, page_url, page_title, matches, readerCountry }) {
  const phrases = matches.map(m => m.phrase);
  const expertNames = matches.map(m => m.expert?.name).filter(Boolean);
  const expertBookingUrls = matches.map(m => m.expert?.booking_url || null);
  sql`INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, country_code)
    VALUES (${publisher || null}, '[cached]', ${phrases}, ${expertNames}, ${expertBookingUrls}, ${matches.length}, ${page_url}, ${readerCountry || null})
  `.catch(() => {});
  postSlackNotification(sql, { publisher, page_url, page_title, matchCount: matches.length, readerCountry, cached: true }).catch(() => {});
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
const TRACKING_PARAM_EXACT = new Set([
  'gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'twclid', 'igshid',
  'gbraid', 'wbraid', 'ref', 'ref_src', 's_kwcid', 'mkt_tok', '_hsenc', '_hsmi'
]);
function normalizePageUrl(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw);
    u.hash = '';
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

// Posts a Slack notification for a page that showed experts to a reader -
// either from a fresh AI scan (🔍, costs tokens) or served straight from
// cache (⚡, free) - so cost and cache health are both visible in one feed.
// Only called when matches were actually shown; silent on 0-match events
// to avoid spamming the channel with every no-match news article.
async function postSlackNotification(sql, { publisher, page_url, page_title, matchCount, readerCountry, cached }) {
  if (!process.env.SLACK_WEBHOOK_URL || matchCount === 0) return;
  let pubName = publisher || '/app';
  if (publisher) {
    const [pubRow] = await sql`SELECT name FROM publishers WHERE slug = ${publisher} LIMIT 1`.catch(() => [null]);
    if (pubRow?.name) pubName = pubRow.name;
  }
  const countryLabel = readerCountry ? (COUNTRY_NAMES[readerCountry] || readerCountry) : 'Unknown';
  const title = page_title ? page_title.slice(0, 80) : (page_url ? page_url.slice(0, 80) : 'homepage demo');
  const urlLine = (!publisher && page_url) ? `\n${page_url}` : '';
  const icon = cached ? '⚡' : '🔍';
  const costLabel = cached ? 'from cache, no AI cost' : 'fresh scan';
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${icon} *${pubName}* · *${matchCount} expert${matchCount !== 1 ? 's' : ''} found* (${costLabel}) · 🌍 ${countryLabel}\n_${title}_${urlLine}` })
  }).catch(() => {});
}

// Upserts a scan result. `confirmed` follows a small state machine (see the
// column comment in ensureCacheTable): a positive result is always trusted
// immediately; a negative result only becomes permanent on its second
// negative scan, 24h+ after the first.
async function upsertCacheResult(sql, { pageUrl, countryCode, publisher, matches }) {
  const hasMatch = matches.length > 0;
  await sql`
    INSERT INTO match_cache (page_url, country_code, publisher, result, has_match, confirmed)
    VALUES (${pageUrl}, ${countryCode}, ${publisher || ''}, ${JSON.stringify({ matches })}, ${hasMatch}, ${hasMatch})
    ON CONFLICT (page_url, country_code, publisher) DO UPDATE SET
      result = EXCLUDED.result,
      has_match = EXCLUDED.has_match,
      confirmed = CASE
        WHEN EXCLUDED.has_match = true THEN true
        WHEN match_cache.has_match = false AND match_cache.confirmed = true THEN true
        WHEN match_cache.has_match = false AND match_cache.confirmed = false AND match_cache.cached_at <= NOW() - INTERVAL '24 hours' THEN true
        ELSE false
      END,
      cached_at = NOW()
  `.catch(() => {});
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
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_key`.catch(() => {});
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_publisher_key`.catch(() => {});
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS match_cache_unique ON match_cache(page_url, country_code, publisher)`.catch(() => {});
  cacheTableReady = true;
}

// Fast pre-check so already-scanned pages skip the quick+chunk AI scan entirely
async function handleCheckCache(req, res) {
  const { publisher } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  if (!page_url) return res.status(200).json({ cacheHit: false });
  try {
    const sql = neon(process.env.DATABASE_URL);
    let pubConfig = { color: '#e6a820', accent: '#e6a820', size: 'medium' };
    if (publisher) {
      const [pub] = await sql`SELECT widget_color, accent_color, widget_size FROM publishers WHERE slug = ${publisher} AND active = true LIMIT 1`.catch(() => [null]);
      if (!pub) return res.status(200).json({ cacheHit: false });
      pubConfig = { color: pub.widget_color || '#e6a820', accent: pub.accent_color || '#e6a820', size: pub.widget_size || 'medium' };
    }

    await ensureCacheTable(sql);

    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const cacheCountry = readerCountry || 'XX';

    // Positive entries are per-country (expert selection/ordering can differ)
    // and invalidated by an expert re-sync on ANY provider - with multiple
    // partners supplying experts, a second partner's sync must refresh
    // cached matches too, not just openintro's. Negative entries hit for
    // EVERY country - a "no match" verdict doesn't depend on where the
    // reader is - and are trusted for 24h unconfirmed, or permanently once
    // confirmed by a second negative scan (see upsertCacheResult).
    const [cached] = await sql`
      SELECT result FROM match_cache
      WHERE page_url = ${page_url}
        AND publisher = ${publisher || ''}
        AND (country_code = ${cacheCountry} OR has_match = false)
        AND (
          (has_match = true AND cached_at > (SELECT COALESCE(MAX(last_synced_at), 'epoch'::timestamptz) FROM providers))
          OR (has_match = false AND (confirmed = true OR cached_at > NOW() - INTERVAL '24 hours'))
        )
        AND cached_at > NOW() - INTERVAL '1 year'
      ORDER BY has_match DESC
      LIMIT 1
    `.catch(() => [null]);

    if (!cached) return res.status(200).json({ cacheHit: false });

    const cachedMatches = cached.result.matches || [];
    logCachedImpression(sql, { publisher, page_url, page_title: null, matches: cachedMatches, readerCountry });

    return res.status(200).json({ cacheHit: true, matches: cachedMatches, config: pubConfig });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ cacheHit: false });
  }
}

// Client has already merged results from the quick pass + all article chunks.
// Persist the final set (cache + log + Slack) without any further AI calls.
async function handleReport(req, res) {
  const { publisher, page_title, matches, complete } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  if (!page_url || !Array.isArray(matches)) {
    return res.status(400).json({ error: 'Missing page_url or matches' });
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const cacheCountry = readerCountry || 'XX';

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
      await upsertCacheResult(sql, { pageUrl: page_url, countryCode: cacheCountry, publisher, matches });
    }

    await ensureLogTable(sql);

    const phrases = matches.map(m => m.phrase);
    const expertNames = matches.map(m => m.expert?.name).filter(Boolean);
    const expertBookingUrls = matches.map(m => m.expert?.booking_url || null);
    const preview = (page_title || page_url || '').slice(0, 120);

    const noMatchLogReason = matches.length === 0
      ? (scanWasComplete ? 'No matches found across article' : 'Partial scan failure - some chunks did not respond, not cached')
      : null;

    await sql`
      INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, country_code)
      VALUES (${publisher || null}, ${preview}, ${phrases}, ${expertNames}, ${expertBookingUrls}, ${matches.length}, ${page_url}, ${noMatchLogReason}, ${readerCountry || null})
    `.catch(() => {});

    await postSlackNotification(sql, { publisher, page_url, page_title, matchCount: matches.length, readerCountry, cached: false });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false });
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

  if (req.body && req.body.report === true) {
    return handleReport(req, res);
  }
  if (req.body && req.body.checkCache === true) {
    return handleCheckCache(req, res);
  }

  const { article, page_title, quick, chunk, lang } = req.body;
  const page_url = normalizePageUrl(req.body.page_url);
  if (!article || article.trim().length < 50) {
    return res.status(400).json({ error: 'Article text is too short' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const { publisher } = req.body;
    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const cacheCountry = readerCountry || 'XX'; // 'XX' = unknown country, avoids empty-string NULL issue in cache

    if (page_url) await ensureCacheTable(sql);

    // Publisher config and cache lookup have no data dependency - run them in
    // parallel to cut a serial DB round trip from every scan request. The
    // cache check now runs for quick/chunk requests too (the widget sends
    // page_url on those since the checkCache pre-flight was removed): on a
    // cached page every parallel scan request short-circuits to the stored
    // result for the cost of one DB read, no AI call.
    //
    // Cache rules: positives are per-country and invalidated by an expert
    // re-sync on ANY provider (MAX(last_synced_at) - a second partner's sync
    // must refresh matches too, not just openintro's). Negatives are
    // country-agnostic; unconfirmed ones are trusted 24h, confirmed ones are
    // permanent until an admin recrawls the publisher.
    const [pubRows, cachedRows] = await Promise.all([
      publisher
        ? sql`SELECT match_power, match_sensitivity, widget_color, accent_color, widget_size, COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners FROM publishers WHERE slug = ${publisher} AND active = true LIMIT 1`.catch(() => [null])
        : Promise.resolve([null]),
      page_url
        ? sql`
            SELECT result FROM match_cache
            WHERE page_url = ${page_url}
              AND publisher = ${publisher || ''}
              AND (country_code = ${cacheCountry} OR has_match = false)
              AND (
                (has_match = true AND cached_at > (SELECT COALESCE(MAX(last_synced_at), 'epoch'::timestamptz) FROM providers))
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
    let pubConfig = { color: '#e6a820', accent: '#e6a820', size: 'medium' };
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
      pubConfig = { color: pub.widget_color || '#e6a820', accent: pub.accent_color || '#e6a820', size: pub.widget_size || 'medium' };
      enabledPartners = pub.enabled_partners || ['openintro'];
    }

    const cached = cachedRows[0];
    if (cached) {
      const cachedMatches = cached.result.matches || [];
      // A page-view fans out into one quick + N chunk requests that ALL hit
      // this cache path - only the quick (or a legacy full scan) logs and
      // notifies, so a cached page-view produces exactly one impression log
      // and one Slack message instead of one per parallel request.
      if (!chunk) logCachedImpression(sql, { publisher, page_url, page_title, matches: cachedMatches, readerCountry });
      return res.status(200).json({ matches: cachedMatches, config: pubConfig, cached: true });
    }

    // Quick pass scans only the article intro for a fast first paint; cap matches so the
    // small token budget can't truncate the JSON. Chunk passes cover the rest of the
    // article; the client merges everything and reports it once.
    if (quick && !chunk) maxMatches = Math.min(maxMatches, 3);
    // Cap per-chunk matches: generation time scales with output tokens, and an
    // uncapped "unlimited" (15) budget made single chunks take 17-19s. Several
    // chunks each contributing up to 8 still yields 20+ unique experts after the
    // client dedupes, at roughly half the per-request latency.
    if (chunk) maxMatches = Math.min(maxMatches, 8);

    const now = Date.now();
    if (!expertsCache || now - expertsCacheTime > EXPERTS_TTL) {
      // Stable order, NOT random: the experts block is the bulk of every AI
      // prompt, and Anthropic prompt caching only hits when the prefix is
      // byte-identical across requests. Random per-instance ordering meant no
      // two serverless instances ever shared a cache entry (and the same page
      // could match differently depending on which instance served it).
      // Fairness is handled by a deterministic daily rotation further down.
      expertsCache = await sql`
        SELECT e.id, e.name, e.bio, e.description_long, e.photo_url, e.position, e.company,
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
      if (expertsCache) expertsCacheTime = now;
    }
    if (!expertsCache) {
      // A DB hiccup here must look like a failure to the client, not a
      // successful empty result - otherwise it's indistinguishable from a
      // genuine "no experts matched" and can poison the match cache with a
      // false negative (see widget.js's `complete` tracking in handleReport).
      return res.status(503).json({ error: 'Experts data temporarily unavailable' });
    }
    // Filter by group: real publishers see their enabled providers only; homepage demo sees non-demo experts
    let experts = [...expertsCache].filter(e =>
      enabledPartners
        ? enabledPartners.includes(e.provider_slug || 'openintro')
        : !e.is_demo_provider
    );

    if (experts.length === 0) {
      return res.status(200).json({ matches: [] });
    }

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
      const desc = truncateAtSentence(e.description_long || '', 400);
      const services = (e.services || []).slice(0, 3).join('; ');
      const about = [e.bio, desc].filter(Boolean).join(' - ');
      return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''} | Languages: ${langs} | About: ${about} | Services: ${services}`;
    }).join('\n\n');

    // Trust the widget's language detection (run once on the full article) when
    // provided, so every chunk request agrees — otherwise detect per-request
    // (used by the homepage demo, which doesn't send a pre-detected lang).
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
    // vast bulk of the tokens) is byte-identical for every request of the
    // same publisher on the same day, so it's cached and re-billed at ~10%
    // after the first request. Everything per-request (article text, its
    // language, the reader's country, match count, the shuffled opener/
    // closer styles) lives in the dynamic block AFTER the cache breakpoint.
    // Anything added to the static block must be stable per publisher+day
    // or it silently kills the cache hit rate.
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

DOMAIN FIT - this rule overrides everything above, including the matching sensitivity: an expert is only a valid match if their own field of work covers the reader's SPECIFIC problem. Never connect a generalist business expert to a specialist topic through a chain of reasoning. Real examples of forbidden stretches: a negotiation coach matched to "responding to Google reviews", a financial-modeling advisor matched to "tracking SEO metrics", a brand designer matched to "choosing profile photos for a business listing" - each sounds clever but the expert does not actually work in that field, and a reader who books the wrong specialist loses trust in every future suggestion. The test: would this expert themselves list the reader's problem as something they help clients with? If none of the available experts genuinely work in the article's domain, return fewer matches or zero - zero is a correct and common answer, not a failure. Sensitivity controls how many GOOD matches to return, never whether a bad match is acceptable.

IMPORTANT: Never use an em dash (—) or en dash (–) anywhere in the "reason" text. Use a plain hyphen with spaces ( - ) instead, or just rephrase as separate sentences.

IMPORTANT: Keep each "reason" to at most 30 words (one or two short sentences). This is a length limit only - the STYLE of each reason must follow its assigned opening approach and closing approach from the numbered lists provided with the article.

IMPORTANT: The name you write inside each "reason" MUST be the exact same expert whose ID you put in "expert_id" for that match. Double-check you are not naming a different expert from the list by mistake.

Available experts:
${expertsList}`;

    const countryLine = readerCountry && COUNTRY_NAMES[readerCountry]
      ? `The reader is browsing from ${COUNTRY_NAMES[readerCountry]}. When two experts fit a challenge equally well, prefer the one based in the reader's country.\n\n`
      : '';
    const titleLine = page_title ? `Article title: ${String(page_title).slice(0, 150)}\n\n` : '';

    const dynamicPrompt = `IMPORTANT: ${languageInstruction}

${countryLine}${titleLine}Return up to ${maxMatches} matches.

For each match's "reason", use a DIFFERENT one of these opening approaches — assign them in order to the matches you return (first match uses approach 1, second uses approach 2, etc.), and never reuse an approach or fall back to a generic "As a first-time founder..." opener regardless of what these approaches say:
${pickReasonOpeners(Math.max(maxMatches, 6)).map((o, i) => `${i + 1}. ${o}`).join('\n')}

Each "reason" must also END with a soft call-to-action inviting the reader to actually talk to the expert - assign these closing approaches in order the same way (first match uses closer 1, second uses closer 2, etc.), never reusing one or defaulting to the same "We suggest talking to..." on every match:
${pickReasonClosers(Math.max(maxMatches, 6)).map((c, i) => `${i + 1}. ${c}`).join('\n')}

Article:
${article.slice(0, 10000)}

Return only valid JSON, no other text:
{"matches":[{"phrase":"exact substring from article","expert_id":1,"reason":"One sentence speaking directly to the reader in second person, opening with the specific challenge rather than a generic reader description - e.g. 'Negotiating your first term sheet without giving away too much equity is tricky - Phil has backed 200+ startups and can walk you through it.'"}],"no_match_reason":"Only include this field when matches is empty. One short phrase explaining why - e.g. 'News article', 'Product announcement', 'Company profile / press release', 'No actionable reader challenge identified', 'Pure statistics reporting'"}}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: quick ? 512 : (maxMatches <= 4 ? 1024 : maxMatches <= 10 ? 2048 : 3072),
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
            { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicPrompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI matching failed' });
    }

    const aiResult = await response.json();
    // Cache effectiveness is invisible without this: cache_read_input_tokens
    // should be large (the whole static block) on all but the first request
    // of a publisher+day. If it's persistently 0, something reintroduced
    // per-request bytes into the static block.
    console.log('[ai-usage]', quick ? 'quick' : chunk ? 'chunk' : 'full', JSON.stringify(aiResult.usage || {}));
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
        return { phrase: m.phrase, reason, expert };
      });

    const preview = article.slice(0, 120).replace(/\s+/g, ' ');
    const phrases = enriched.map(m => m.phrase);
    const expertNames = enriched.map(m => m.expert.name);
    const expertBookingUrls = enriched.map(m => m.expert.booking_url || null);
    const noMatchReason = enriched.length === 0 ? (parsed.no_match_reason || null) : null;

    // Respond immediately — client gets result now; function stays alive to finish background work
    res.status(200).json({ matches: enriched, config: pubConfig, no_match_reason: noMatchReason || undefined });

    // Quick and chunk requests skip all of this — the client merges every chunk's
    // results and sends one consolidated report (cache/log/Slack) at the end.
    if (quick || chunk) return;

    // Await keeps the Vercel function alive until DB writes and Slack complete
    await Promise.allSettled([
      (async () => {
        if (!page_url) return;
        await upsertCacheResult(sql, { pageUrl: page_url, countryCode: cacheCountry, publisher, matches: enriched });
      })(),
      (async () => {
        await ensureLogTable(sql);
        await sql`
          INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, country_code)
          VALUES (${publisher}, ${preview}, ${phrases}, ${expertNames}, ${expertBookingUrls}, ${enriched.length}, ${page_url || null}, ${noMatchReason}, ${readerCountry || null})
        `;
      })(),
      postSlackNotification(sql, { publisher, page_url, page_title, matchCount: enriched.length, readerCountry, cached: false })
    ]).catch(() => {});
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
