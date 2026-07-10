// Apollo.io API client for finding the right contact person at each lead's
// domain. Two-step process:
//   1. People Search (free, no credits) - finds a person at the domain
//      matching a title filter, but does NOT return a usable email.
//   2. People Match / Enrichment (costs 1 credit per revealed email) -
//      takes the person found in step 1 and reveals their real email.
// Splitting these lets enrich.js run search-only in --dry-run mode to
// preview matches before spending any credits.

const SEARCH_ENDPOINT = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const MATCH_ENDPOINT = 'https://api.apollo.io/api/v1/people/match';

function authHeaders() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error('APOLLO_API_KEY is not set. Copy discovery/.env.local.example to discovery/.env.local and fill it in.');
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey
  };
}

// Finds the best-matching person at `domain` for the given list of job
// titles. Returns the top match or null. Free - does not consume credits.
export async function searchPerson(domain, titles) {
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      q_organization_domains_list: [domain],
      person_titles: titles,
      page: 1,
      per_page: 1
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apollo search error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const people = data.people || data.contacts || [];
  return people[0] || null;
}

// Reveals the real email for a person already found via searchPerson.
// Consumes 1 Apollo credit if an email is successfully returned.
export async function revealEmail(person, domain) {
  const res = await fetch(MATCH_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      id: person.id,
      first_name: person.first_name,
      last_name: person.last_name,
      domain,
      reveal_personal_emails: true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apollo match error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.person || data;
}

// Placeholder emails Apollo returns when a real one isn't unlocked/available.
export function isRealEmail(email) {
  if (!email) return false;
  return !/email_not_unlocked|not_unlocked@/i.test(email);
}

// Apollo returns "Re"/"Dacted" (splitting the word "Redacted") as a
// placeholder name for privacy-protected contacts, seen on some large/
// well-known organizations. Not a real person - treat as no match.
export function isRedactedName(firstName, lastName) {
  return /^re$/i.test(firstName || '') && /^dacted$/i.test(lastName || '');
}

// Picks which job titles to search for based on team_size (from
// classify.js). Only called for lead_type: 'publisher' - enrich.js doesn't
// enrich vendor/competitor/unclear leads.
export function titlesForRow(row) {
  if (row.team_size === 'solo') {
    return ['Founder', 'Owner', 'Editor', 'Writer'];
  }
  if (row.team_size === 'large-team') {
    return ['Editor in Chief', 'Content Lead', 'Editor', 'Content Manager'];
  }
  // small-team or unclear
  return ['Editor', 'Content Manager', 'Blog Editor', 'Founder', 'CEO'];
}
