// One-off import of an Apollo.io contacts export (blogger/journalist leads) into
// candidate_publishers. Unlike discover.js's SerpAPI pipeline, these rows already
// carry a real contact (name, email, LinkedIn) - the CSV is the "who", the domain
// in the Website column is the "what". Upsert is intentionally non-destructive:
// existing rows (already curated through the normal outreach pipeline) only get
// their gaps filled in (missing contact/social fields), never their status touched.
//
// Usage: node discovery/import-apollo.js <path-to-csv>

import { sql } from './lib/db.js';
import fs from 'node:fs';

const csvPath = process.argv[2];
if (!csvPath) {
  throw new Error('Usage: node discovery/import-apollo.js <path-to-csv>');
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
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

async function ensureColumns() {
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS person_linkedin_url TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS twitter_url TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS facebook_url TEXT`;
}

async function main() {
  await ensureColumns();

  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(raw);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const dataRows = rows.slice(1).filter((r) => r.length === header.length);

  const seen = new Map(); // domain -> row (first occurrence wins within this CSV)
  let noDomain = 0, dupesInFile = 0;

  for (const r of dataRows) {
    const domain = domainFromUrl(r[idx['Website']]);
    if (!domain) { noDomain++; continue; }
    if (seen.has(domain)) { dupesInFile++; continue; }
    seen.set(domain, r);
  }

  console.log(`Parsed ${dataRows.length} rows: ${seen.size} unique domains, ${noDomain} with no usable website, ${dupesInFile} duplicate domains within the file.`);

  let inserted = 0, updated = 0;

  for (const [domain, r] of seen) {
    const firstName = (r[idx['First Name']] || '').trim();
    const lastName = (r[idx['Last Name']] || '').trim();
    const contactName = [firstName, lastName].filter(Boolean).join(' ') || null;
    const contactEmail = (r[idx['Email']] || '').trim() || null;
    const companyName = (r[idx['Company Name']] || '').trim() || null;
    const title = (r[idx['Title']] || '').trim() || null;
    const keywords = (r[idx['Keywords']] || '').trim();
    const snippet = keywords ? keywords.slice(0, 500) : null;
    const personLinkedin = (r[idx['Person Linkedin Url']] || '').trim() || null;
    const companyLinkedin = (r[idx['Company Linkedin Url']] || '').trim() || null;
    const twitterUrl = (r[idx['Twitter Url']] || '').trim() || null;
    const facebookUrl = (r[idx['Facebook Url']] || '').trim() || null;
    const homepageUrl = 'https://' + domain;

    const result = await sql`
      INSERT INTO candidate_publishers (
        domain, homepage_url, title, snippet, contact_name, contact_email, company_name,
        person_linkedin_url, company_linkedin_url, twitter_url, facebook_url,
        status, discovery_source
      )
      VALUES (
        ${domain}, ${homepageUrl}, ${title}, ${snippet}, ${contactName}, ${contactEmail}, ${companyName},
        ${personLinkedin}, ${companyLinkedin}, ${twitterUrl}, ${facebookUrl},
        'discovered', 'apollo_import'
      )
      ON CONFLICT (domain) DO UPDATE SET
        contact_name = COALESCE(candidate_publishers.contact_name, EXCLUDED.contact_name),
        contact_email = COALESCE(candidate_publishers.contact_email, EXCLUDED.contact_email),
        company_name = COALESCE(candidate_publishers.company_name, EXCLUDED.company_name),
        person_linkedin_url = COALESCE(candidate_publishers.person_linkedin_url, EXCLUDED.person_linkedin_url),
        company_linkedin_url = COALESCE(candidate_publishers.company_linkedin_url, EXCLUDED.company_linkedin_url),
        twitter_url = COALESCE(candidate_publishers.twitter_url, EXCLUDED.twitter_url),
        facebook_url = COALESCE(candidate_publishers.facebook_url, EXCLUDED.facebook_url)
      RETURNING (xmax = 0) AS is_insert
    `;
    if (result[0]?.is_insert) inserted++; else updated++;
  }

  console.log(`\nDone. ${inserted} new candidates inserted, ${updated} existing candidates enriched with contact/social info.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
