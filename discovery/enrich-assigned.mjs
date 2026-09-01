// One-off Apollo enrichment scoped to specific outreach helpers' UNTOUCHED
// leads (status = 'discovered') that still have no contact_email.
//
// "Untouched" == candidate_publishers.status = 'discovered' (the "Untouched"
// bucket label in outreach/index.html). Default helpers: Mark, Tim, Max.
//
// Two-step Apollo flow (same as discovery/enrich.js):
//   1. People Search  - free, no credits. Finds a person at the domain.
//   2. People Match    - costs 1 Apollo credit *only when an email is
//                        actually revealed*. Skipped entirely in --dry-run.
//
// Usage:
//   node discovery/enrich-assigned.mjs                 dry run (free), preview only
//   node discovery/enrich-assigned.mjs --live          actually reveal + write emails
//   node discovery/enrich-assigned.mjs --live --limit 20
//   node discovery/enrich-assigned.mjs --users Mark,Tim
//   node discovery/enrich-assigned.mjs --retry-not-found   also re-try rows Apollo
//                                                          previously found no person for
//
// By default, rows whose contact_status is already 'not_found' are skipped
// (Apollo's People Search returned nothing last time - re-running is free but
// almost never changes). Rows with contact_status NULL or 'no_email' or
// 'error' are always retried.

import { pathToFileURL } from 'node:url';
import { sql } from './lib/db.js';
import { searchPerson, revealEmail, isRealEmail, isRedactedName, titlesForRow } from './lib/apollo.js';

function parseArgs(argv) {
  const args = { live: false, limit: null, users: ['Mark', 'Tim', 'Max'], retryNotFound: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') args.live = true;
    else if (argv[i] === '--retry-not-found') args.retryNotFound = true;
    else if (argv[i] === '--limit') args.limit = parseInt(argv[i + 1], 10) || null;
    else if (argv[i] === '--users') args.users = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureColumns() {
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_first_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_last_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_email TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_title TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_status TEXT`;
}

async function main() {
  const { live, limit, users, retryNotFound } = parseArgs(process.argv.slice(2));
  await ensureColumns();

  const helpers = await sql`
    SELECT id, name FROM outreach_users WHERE name = ANY(${users})
  `;
  if (helpers.length === 0) {
    console.error(`No outreach_users match: ${users.join(', ')}`);
    process.exit(1);
  }
  const helperIds = helpers.map((h) => h.id);
  console.log(`Helpers: ${helpers.map((h) => `${h.name} (#${h.id})`).join(', ')}`);
  console.log(`Mode: ${live ? 'LIVE - will spend Apollo credits on revealed emails' : 'DRY RUN - no credits, no DB writes'}`);
  console.log(`Skipping prior 'not_found' rows: ${retryNotFound ? 'no (--retry-not-found)' : 'yes'}\n`);

  const rows = await sql`
    SELECT cp.id, cp.domain, cp.company_name, cp.team_size, cp.contact_status,
           u.name AS assignee
    FROM candidate_publishers cp
    JOIN outreach_users u ON u.id = cp.assigned_to
    WHERE cp.assigned_to = ANY(${helperIds})
      AND cp.status = 'discovered'
      AND (cp.contact_email IS NULL OR cp.contact_email = '')
      AND (${retryNotFound} OR cp.contact_status IS DISTINCT FROM 'not_found')
    ORDER BY u.name, cp.id
    LIMIT ${limit ?? 100000}
  `;

  console.log(`${rows.length} untouched lead(s) with no email to process.\n`);
  if (rows.length === 0) return;

  const stats = {};
  for (const h of helpers) stats[h.name] = { found: 0, noEmail: 0, notFound: 0, error: 0 };

  for (const row of rows) {
    const s = stats[row.assignee];
    const titles = titlesForRow(row);
    const tag = `[${row.assignee}] ${row.domain}`;
    try {
      const person = await searchPerson(row.domain, titles);

      if (!person) {
        s.notFound++;
        console.log(`${tag} - no person found (${titles.join(', ')})`);
        if (live) await sql`UPDATE candidate_publishers SET contact_status = 'not_found' WHERE id = ${row.id}`;
        await sleep(300);
        continue;
      }

      if (!live) {
        console.log(`${tag} - would reveal: ${person.first_name} ${person.last_name} (${person.title || 'no title'})`);
        await sleep(300);
        continue;
      }

      const enriched = await revealEmail(person, row.domain);
      const email = enriched.email;
      let firstName = enriched.first_name || person.first_name || null;
      let lastName = enriched.last_name || null;
      const title = enriched.title || person.title || null;
      if (isRedactedName(firstName, lastName)) { firstName = null; lastName = null; }
      const contactName = firstName ? (lastName ? `${firstName} ${lastName}` : firstName) : null;

      if (isRealEmail(email)) {
        s.found++;
        console.log(`${tag} - ${contactName || '(no name)'} <${email}>`);
        await sql`
          UPDATE candidate_publishers
          SET contact_first_name = ${firstName}, contact_last_name = ${lastName},
              contact_name = COALESCE(contact_name, ${contactName}),
              contact_email = ${email},
              contact_title = ${title}, contact_status = 'found'
          WHERE id = ${row.id}
        `;
      } else {
        s.noEmail++;
        console.log(`${tag} - found ${contactName || '(no name)'} but no email`);
        await sql`
          UPDATE candidate_publishers
          SET contact_first_name = ${firstName}, contact_last_name = ${lastName},
              contact_name = COALESCE(contact_name, ${contactName}),
              contact_title = ${title}, contact_status = 'no_email'
          WHERE id = ${row.id}
        `;
      }
    } catch (err) {
      s.error++;
      console.error(`${tag} - FAILED: ${err.message}`);
      if (live) await sql`UPDATE candidate_publishers SET contact_status = 'error' WHERE id = ${row.id}`.catch(() => {});
    }
    await sleep(300);
  }

  console.log('\n=== Summary ===');
  for (const [name, s] of Object.entries(stats)) {
    console.log(`${name}: ${s.found} email found, ${s.noEmail} person-but-no-email, ${s.notFound} no person, ${s.error} error`);
  }
  if (!live) {
    const previewable = rows.length - Object.values(stats).reduce((a, s) => a + s.notFound, 0);
    console.log(`\nDry run only. ~${previewable} lead(s) have a person Apollo could try to reveal.`);
    console.log(`Re-run with --live to reveal emails (up to ~${previewable} Apollo credits, 1 per email actually returned).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
