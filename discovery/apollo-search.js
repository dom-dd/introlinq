// Discovers new candidate publishers via Apollo's People Search + reveal
// (not the domain-scoped lookup enrich.js uses, and not the free-only
// search - confirmed 2026-08-26 that free search returns no domain/email at
// all, only a redacted org name). Reveals a domain (and often a contact
// name/email) for each search hit, one Apollo credit per reveal regardless
// of whether an email comes back. Hard-capped by --credits since this
// spends a real, limited shared monthly budget (also used by OpenIntro).
//
// Reuses the same long-tail topic list from lib/queries.js so this track
// targets the same niches as the free SerpAPI discovery.
//
// Usage: node discovery/apollo-search.js --category "Business & Entrepreneurship" --credits 50 [--dry-run]

import { sql } from './lib/db.js';
import { TOPICS_BY_CATEGORY } from './lib/queries.js';

const PER_PAGE = 10;
const PERSON_TITLES = ['Founder', 'Owner', 'Blogger', 'Editor', 'Writer', 'Content Creator'];
const SEARCH_ENDPOINT = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const MATCH_ENDPOINT = 'https://api.apollo.io/api/v1/people/match';

function parseArgs(argv) {
  const args = { category: 'Business & Entrepreneurship', credits: 50, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--category') args.category = argv[++i];
    if (argv[i] === '--credits') args.credits = parseInt(argv[++i], 10) || args.credits;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error('APOLLO_API_KEY is not set. Add it to discovery/.env.local');
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey };
}

function domainFromUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.') || host.includes(' ')) return null;
    return host;
  } catch {
    return null;
  }
}

async function searchApollo(keyword, page) {
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ q_keywords: keyword, person_titles: PERSON_TITLES, page, per_page: PER_PAGE }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apollo search error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.people || [];
}

// Costs 1 Apollo credit regardless of whether an email is actually returned
// (confirmed 2026-08-26 - domain came back reliably, email did not).
async function revealPerson(person) {
  const res = await fetch(MATCH_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ id: person.id, first_name: person.first_name, reveal_personal_emails: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apollo match error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.person || data;
}

function isRealEmail(email) {
  if (!email) return false;
  return !/email_not_unlocked|not_unlocked@/i.test(email);
}

async function insertCandidate(revealed, discoveryQuery) {
  const domain = domainFromUrl(revealed.organization?.website_url || revealed.organization?.primary_domain);
  if (!domain) return { inserted: false, reason: 'no domain after reveal' };

  const firstName = revealed.first_name || null;
  const lastName = revealed.last_name || null;
  const contactName = firstName ? (lastName ? `${firstName} ${lastName}` : firstName) : null;
  const email = isRealEmail(revealed.email) ? revealed.email : null;
  const title = revealed.organization?.name || null;

  const result = await sql`
    INSERT INTO candidate_publishers (
      domain, homepage_url, title, discovery_query, discovery_source,
      contact_first_name, contact_last_name, contact_name, contact_email, contact_title
    )
    VALUES (
      ${domain}, ${'https://' + domain}, ${title}, ${discoveryQuery}, 'apollo_search',
      ${firstName}, ${lastName}, ${contactName}, ${email}, ${revealed.title || null}
    )
    ON CONFLICT (domain) DO NOTHING
    RETURNING id
  `;
  return { inserted: result.length > 0, domain, hasEmail: !!email };
}

async function main() {
  const { category, credits, dryRun } = parseArgs(process.argv.slice(2));
  const topics = TOPICS_BY_CATEGORY[category];
  if (!topics) {
    throw new Error(`Unknown category "${category}". Valid: ${Object.keys(TOPICS_BY_CATEGORY).join(', ')}`);
  }

  console.log(`Starting. Category: ${category} (${topics.length} topics). Credit budget: ${credits}${dryRun ? ' [DRY RUN - search only, no reveals spent]' : ''}`);

  let spent = 0, newDomains = 0, dupes = 0, noDomain = 0, withEmail = 0;
  let topicIndex = 0;

  while (spent < credits && topicIndex < topics.length) {
    const topic = topics[topicIndex++];
    let people;
    try {
      people = await searchApollo(topic, 1);
    } catch (err) {
      console.error(`[${topic}] search FAILED: ${err.message}`);
      continue;
    }
    if (people.length === 0) {
      console.log(`[${topic}] 0 search results, skipping`);
      continue;
    }

    for (const person of people) {
      if (spent >= credits) break;
      if (dryRun) {
        console.log(`[${topic}] would reveal: ${person.organization?.name} (${person.title})`);
        continue;
      }
      try {
        const revealed = await revealPerson(person);
        spent++;
        const outcome = await insertCandidate(revealed, `apollo:${topic}`);
        if (outcome.inserted) {
          newDomains++;
          if (outcome.hasEmail) withEmail++;
          console.log(`[${spent}/${credits}] [${topic}] +${outcome.domain}${outcome.hasEmail ? ' (with email)' : ''}`);
        } else if (outcome.reason) {
          noDomain++;
          console.log(`[${spent}/${credits}] [${topic}] reveal succeeded but ${outcome.reason}`);
        } else {
          dupes++;
          console.log(`[${spent}/${credits}] [${topic}] ${outcome.domain} already known, skipped`);
        }
      } catch (err) {
        console.error(`[${topic}] reveal FAILED: ${err.message}`);
      }
      await sleep(300);
    }
    await sleep(400);
  }

  console.log(`\nDone. ${spent} credits spent, ${newDomains} new domains added (${withEmail} with a usable email), ${dupes} already known, ${noDomain} revealed but had no usable domain.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
