import { neon } from '@neondatabase/serverless';

let tableReady = false;
let cacheTableReady = false;
let expertsCache = null;
let expertsCacheTime = 0;
const EXPERTS_TTL = 5 * 60 * 1000;

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
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_key`.catch(() => {});
  await sql`ALTER TABLE match_cache DROP CONSTRAINT IF EXISTS match_cache_page_url_country_code_publisher_key`.catch(() => {});
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS match_cache_unique ON match_cache(page_url, country_code, publisher)`.catch(() => {});
  cacheTableReady = true;
}

// Fast pre-check so already-scanned pages skip the quick+chunk AI scan entirely
async function handleCheckCache(req, res) {
  const { publisher, page_url } = req.body;
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
    const [lastSync] = await sql`SELECT last_synced_at FROM providers WHERE slug = 'openintro' LIMIT 1`.catch(() => [null]);
    const lastSyncedAt = lastSync?.last_synced_at || new Date(0);

    const [cached] = await sql`
      SELECT result FROM match_cache
      WHERE page_url = ${page_url}
        AND country_code = ${cacheCountry}
        AND publisher = ${publisher || ''}
        AND ((has_match = false AND cached_at > NOW() - INTERVAL '7 days') OR cached_at > ${lastSyncedAt})
        AND cached_at > NOW() - INTERVAL '1 year'
      LIMIT 1
    `.catch(() => [null]);

    if (!cached) return res.status(200).json({ cacheHit: false });

    const cachedMatches = cached.result.matches || [];
    const phrases = cachedMatches.map(m => m.phrase);
    const expertNames = cachedMatches.map(m => m.expert?.name).filter(Boolean);
    const expertBookingUrls = cachedMatches.map(m => m.expert?.booking_url || null);
    sql`INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, country_code)
      VALUES (${publisher || null}, '[cached]', ${phrases}, ${expertNames}, ${expertBookingUrls}, ${cachedMatches.length}, ${page_url}, ${readerCountry || null})
    `.catch(() => {});

    return res.status(200).json({ cacheHit: true, matches: cachedMatches, config: pubConfig });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ cacheHit: false });
  }
}

// Client has already merged results from the quick pass + all article chunks.
// Persist the final set (cache + log + Slack) without any further AI calls.
async function handleReport(req, res) {
  const { publisher, page_url, page_title, matches, complete } = req.body;
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
      await sql`
        INSERT INTO match_cache (page_url, country_code, publisher, result, has_match)
        VALUES (${page_url}, ${cacheCountry}, ${publisher || ''}, ${JSON.stringify({ matches })}, ${matches.length > 0})
        ON CONFLICT (page_url, country_code, publisher) DO UPDATE SET result = EXCLUDED.result, has_match = EXCLUDED.has_match, cached_at = NOW()
      `.catch(() => {});
    }

    if (!tableReady) {
      await sql`CREATE TABLE IF NOT EXISTS match_logs (id SERIAL PRIMARY KEY, publisher TEXT, article_preview TEXT, phrases TEXT[], expert_names TEXT[], match_count INT, created_at TIMESTAMPTZ DEFAULT NOW())`;
      tableReady = true;
    }
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS page_url TEXT`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS expert_booking_urls TEXT[]`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS no_match_reason TEXT`.catch(() => {});
    await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS country_code TEXT`.catch(() => {});

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

    if (process.env.SLACK_WEBHOOK_URL && matches.length > 0) {
      let pubName = publisher || '/app';
      if (publisher) {
        const [pubRow] = await sql`SELECT name FROM publishers WHERE slug = ${publisher} LIMIT 1`.catch(() => [null]);
        if (pubRow?.name) pubName = pubRow.name;
      }
      const countryLabel = readerCountry ? (COUNTRY_NAMES[readerCountry] || readerCountry) : 'Unknown';
      const title = page_title ? page_title.slice(0, 80) : page_url.slice(0, 80);
      const urlLine = (!publisher && page_url) ? `\n${page_url}` : '';
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🔍 *${pubName}* · *${matches.length} expert${matches.length !== 1 ? 's' : ''} found* · 🌍 ${countryLabel}\n_${title}_${urlLine}` })
      }).catch(() => {});
    }

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

  const { article, page_url, page_title, quick, chunk, lang } = req.body;
  if (!article || article.trim().length < 50) {
    return res.status(400).json({ error: 'Article text is too short' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Look up publisher settings if a publisher slug was provided
    const { publisher } = req.body;
    let maxMatches = 3;
    let sensitivityInstruction = 'Match on broader topic overlap. If the expert\'s field is relevant to the section, include them. Prefer more matches over fewer.';

    let pubConfig = { color: '#e6a820', accent: '#e6a820', size: 'medium' };

    let enabledPartners = null; // null = homepage demo

    if (publisher) {
      const [pub] = await sql`SELECT match_power, match_sensitivity, widget_color, accent_color, widget_size, COALESCE(enabled_partners, ARRAY['openintro']) AS enabled_partners FROM publishers WHERE slug = ${publisher} AND active = true LIMIT 1`.catch(() => [null]);
      if (!pub) {
        // Publisher deactivated or unknown - don't serve the widget
        return res.status(200).json({ matches: [] });
      }
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

    // Quick pass scans only the article intro for a fast first paint; cap matches so the
    // small token budget can't truncate the JSON. Chunk passes cover the rest of the
    // article; the client merges everything and reports it once.
    if (quick && !chunk) maxMatches = Math.min(maxMatches, 3);
    // Cap per-chunk matches: generation time scales with output tokens, and an
    // uncapped "unlimited" (15) budget made single chunks take 17-19s. Several
    // chunks each contributing up to 8 still yields 20+ unique experts after the
    // client dedupes, at roughly half the per-request latency.
    if (chunk) maxMatches = Math.min(maxMatches, 8);

    const readerCountry = (req.headers['x-vercel-ip-country'] || '').toUpperCase();
    const cacheCountry = readerCountry || 'XX'; // 'XX' = unknown country, avoids empty-string NULL issue in cache

    // Check match cache (keyed by page_url + country, valid until last expert sync)
    if (page_url && !quick && !chunk) {
      await ensureCacheTable(sql);

      const [lastSync] = await sql`SELECT last_synced_at FROM providers WHERE slug = 'openintro' LIMIT 1`.catch(() => [null]);
      const lastSyncedAt = lastSync?.last_synced_at || new Date(0);

      const [cached] = await sql`
        SELECT result FROM match_cache
        WHERE page_url = ${page_url}
          AND country_code = ${cacheCountry}
          AND publisher = ${publisher || ''}
          AND ((has_match = false AND cached_at > NOW() - INTERVAL '7 days') OR cached_at > ${lastSyncedAt})
          AND cached_at > NOW() - INTERVAL '1 year'
        LIMIT 1
      `.catch(() => [null]);

      if (cached) {
        const cachedMatches = cached.result.matches || [];
        // Still log impression even on cache hit
        const phrases = cachedMatches.map(m => m.phrase);
        const expertNames = cachedMatches.map(m => m.expert?.name).filter(Boolean);
        const expertBookingUrls = cachedMatches.map(m => m.expert?.booking_url || null);
        sql`INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, country_code)
          VALUES (${publisher}, '[cached]', ${phrases}, ${expertNames}, ${expertBookingUrls}, ${cachedMatches.length}, ${page_url}, ${readerCountry || null})
        `.catch(() => {});
        return res.status(200).json({ matches: cachedMatches, config: pubConfig, cached: true });
      }
    }

    const now = Date.now();
    if (!expertsCache || now - expertsCacheTime > EXPERTS_TTL) {
      expertsCache = await sql`
        SELECT e.id, e.name, e.bio, e.description_long, e.photo_url, e.position, e.company,
               e.topics, e.services, e.languages, e.price_from, e.price_currency,
               e.booking_url, e.location_country,
               p.name AS provider_name, p.slug AS provider_slug, p.logo_url AS provider_logo_url, p.website_url AS provider_website_url,
               COALESCE(p.is_demo, false) AS is_demo_provider
        FROM experts e
        LEFT JOIN providers p ON p.id = e.provider_id
        WHERE e.active = true
        ORDER BY RANDOM()
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

    // Sort experts: same country first
    experts = experts.sort((a, b) => {
      const aMatch = readerCountry && (a.location_country || '').toUpperCase().includes(readerCountry) ? 0 : 1;
      const bMatch = readerCountry && (b.location_country || '').toUpperCase().includes(readerCountry) ? 0 : 1;
      return aMatch - bMatch;
    });

    if (experts.length === 0) {
      return res.status(200).json({ matches: [] });
    }

    const expertsList = experts.map(e => {
      const role = [e.position, e.company].filter(Boolean).join(' at ');
      const langs = (e.languages || []).join(', ');
      const desc = e.description_long || e.bio || '';
      const services = (e.services || []).slice(0, 3).join('; ');
      return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''} | Languages: ${langs} | From £${e.price_from}/session | About: ${desc.slice(0, 150)} | Services: ${services}`;
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

    const prompt = `You are the matching engine for IntroLinq, a platform that connects blog READERS with experts they can book a 1:1 call with.

Your job: identify moments in the article where a reader - someone trying to learn, make a decision, or solve a problem - would benefit from a personal consultation with a specific expert. ${sensitivityInstruction}

Criteria for a valid match:
1. The reader faces a specific, actionable challenge or decision - not just reading about a topic
2. The expert's expertise is a clear fit for that challenge (not just the same broad field)
3. A 1:1 call with this expert would genuinely help the reader take action

Return up to ${maxMatches} matches for how-to articles, guides, and educational content where the reader is actively trying to do something. Return 0 for pure news, press releases, or company announcements where the reader is passively informed.

NEVER match:
- News articles, press releases, or company announcements
- CEO or executive quotes about their own strategy
- Funding rounds, valuations, or investor names
- Statistics being reported, not explained
- Phrases where a company describes what it is doing (not what the reader needs to do)
- Vague keyword overlap where the expert's services don't clearly fit the specific moment

IMPORTANT: ${languageInstruction}

IMPORTANT: Never use an em dash (—) or en dash (–) anywhere in the "reason" text. Use a plain hyphen with spaces ( - ) instead, or just rephrase as separate sentences.

IMPORTANT: Keep each "reason" to ONE sentence of at most 25 words. Punchy beats thorough - name the challenge, name the expert's relevant strength, stop.

IMPORTANT: The name you write inside each "reason" MUST be the exact same expert whose ID you put in "expert_id" for that match. Double-check you are not naming a different expert from the list by mistake.

For each match's "reason", use a DIFFERENT one of these opening approaches — assign them in order to the matches you return (first match uses approach 1, second uses approach 2, etc.), and never reuse an approach or fall back to a generic "As a first-time founder..." opener regardless of what these approaches say:
${pickReasonOpeners(Math.max(maxMatches, 6)).map((o, i) => `${i + 1}. ${o}`).join('\n')}

Available experts:
${expertsList}

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
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI matching failed' });
    }

    const aiResult = await response.json();
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
        await sql`
          INSERT INTO match_cache (page_url, country_code, publisher, result, has_match)
          VALUES (${page_url}, ${cacheCountry}, ${publisher || ''}, ${JSON.stringify({ matches: enriched })}, ${enriched.length > 0})
          ON CONFLICT (page_url, country_code, publisher) DO UPDATE SET result = EXCLUDED.result, has_match = EXCLUDED.has_match, cached_at = NOW()
        `.catch(() => {});
      })(),
      (async () => {
        if (!tableReady) {
          await sql`CREATE TABLE IF NOT EXISTS match_logs (id SERIAL PRIMARY KEY, publisher TEXT, article_preview TEXT, phrases TEXT[], expert_names TEXT[], match_count INT, created_at TIMESTAMPTZ DEFAULT NOW())`;
          tableReady = true;
        }
        await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS page_url TEXT`.catch(() => {});
        await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS expert_booking_urls TEXT[]`.catch(() => {});
        await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS no_match_reason TEXT`.catch(() => {});
        await sql`ALTER TABLE match_logs ADD COLUMN IF NOT EXISTS country_code TEXT`.catch(() => {});
        await sql`
          INSERT INTO match_logs (publisher, article_preview, phrases, expert_names, expert_booking_urls, match_count, page_url, no_match_reason, country_code)
          VALUES (${publisher}, ${preview}, ${phrases}, ${expertNames}, ${expertBookingUrls}, ${enriched.length}, ${page_url || null}, ${noMatchReason}, ${readerCountry || null})
        `;
      })(),
      (async () => {
        if (!process.env.SLACK_WEBHOOK_URL || enriched.length === 0) return;
        let pubName = publisher || '/app';
        if (publisher) {
          const [pubRow] = await sql`SELECT name FROM publishers WHERE slug = ${publisher} LIMIT 1`.catch(() => [null]);
          if (pubRow?.name) pubName = pubRow.name;
        }
        const countryLabel = readerCountry ? (COUNTRY_NAMES[readerCountry] || readerCountry) : 'Unknown';
        const title = page_title ? page_title.slice(0, 80) : (page_url ? page_url.slice(0, 80) : 'homepage demo');
        const urlLine = (!publisher && page_url) ? `\n${page_url}` : '';
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `🔍 *${pubName}* · *${enriched.length} expert${enriched.length !== 1 ? 's' : ''} found* · 🌍 ${countryLabel}\n_${title}_${urlLine}` })
        });
      })()
    ]).catch(() => {});
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
