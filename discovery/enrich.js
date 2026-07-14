// Finds the right contact person (name + email) for each classified
// "publisher" lead (not vendor/competitor/unclear), using Apollo: a free
// People Search to find a person matching a role-appropriate title filter,
// then a credit-costing Match call to reveal their real email.
//
// Usage:
//   node discovery/enrich.js --dry-run          preview matches, no credits spent
//   node discovery/enrich.js --limit 20         enrich up to 20 leads (default 20)
//   node discovery/enrich.js --limit 500        larger batch once you trust it
//
// Resumable: only processes rows where contact_status IS NULL, so re-running
// picks up where the last run left off. --dry-run never writes to the
// database, so it's always safe to preview before spending credits.
//
// Also imported by classify.js, which calls enrichPendingPublishers() itself
// right after classifying a batch - so a lead getting marked "publisher"
// automatically cascades into enrichment without a second manual step.

import { pathToFileURL } from 'node:url';
import { sql } from './lib/db.js';
import { searchPerson, revealEmail, isRealEmail, isRedactedName, titlesForRow } from './lib/apollo.js';

function parseArgs(argv) {
  const args = { limit: 20, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[i + 1], 10) || args.limit;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureColumns() {
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_first_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_last_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_email TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_title TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS contact_status TEXT`;
}

// Core enrichment pass, shared by the CLI below and by classify.js's
// auto-cascade. Always scoped to lead_type='publisher' - vendor/competitor/
// unclear leads are never worth an Apollo credit for this campaign.
export async function enrichPendingPublishers({ limit = 20, dryRun = false } = {}) {
  await ensureColumns();

  const rows = await sql`
    SELECT id, domain, lead_type, team_size FROM candidate_publishers
    WHERE lead_type = 'publisher' AND contact_status IS NULL
    ORDER BY id ASC
    LIMIT ${limit}
  `;

  if (rows.length === 0) {
    return { found: 0, notFound: 0, noEmail: 0, processed: 0 };
  }

  console.log(`${dryRun ? 'Previewing (dry-run, no credits spent)' : 'Enriching'} ${rows.length} publisher lead(s)...`);

  let found = 0;
  let notFound = 0;
  let noEmail = 0;

  for (const row of rows) {
    const titles = titlesForRow(row);
    try {
      const person = await searchPerson(row.domain, titles);

      if (!person) {
        notFound++;
        console.log(`[${row.domain}] no person found for titles: ${titles.join(', ')}`);
        if (!dryRun) {
          await sql`UPDATE candidate_publishers SET contact_status = 'not_found' WHERE id = ${row.id}`;
        }
        await sleep(300);
        continue;
      }

      if (dryRun) {
        console.log(`[${row.domain}] would enrich: ${person.first_name} ${person.last_name} (${person.title || 'no title'})`);
        await sleep(300);
        continue;
      }

      // The search result's last_name is obfuscated (e.g. "Mo***d") - only
      // the reveal call below returns the real full name, whether or not
      // an email is actually available.
      const enriched = await revealEmail(person, row.domain);
      const email = enriched.email;
      let firstName = enriched.first_name || person.first_name || null;
      let lastName = enriched.last_name || null;
      const title = enriched.title || person.title || null;

      if (isRedactedName(firstName, lastName)) {
        // Apollo's privacy-redaction placeholder, not a real person.
        firstName = null;
        lastName = null;
      }

      if (isRealEmail(email)) {
        found++;
        console.log(`[${row.domain}] ${firstName} ${lastName} <${email}>`);
        await sql`
          UPDATE candidate_publishers
          SET contact_first_name = ${firstName},
              contact_last_name = ${lastName},
              contact_email = ${email},
              contact_title = ${title},
              contact_status = 'found'
          WHERE id = ${row.id}
        `;
      } else {
        noEmail++;
        console.log(`[${row.domain}] found ${firstName} ${lastName} but no email available`);
        await sql`
          UPDATE candidate_publishers
          SET contact_first_name = ${firstName},
              contact_last_name = ${lastName},
              contact_title = ${title},
              contact_status = 'no_email'
          WHERE id = ${row.id}
        `;
      }
    } catch (err) {
      console.error(`[${row.domain}] FAILED: ${err.message}`);
      if (!dryRun) {
        await sql`UPDATE candidate_publishers SET contact_status = 'error' WHERE id = ${row.id}`;
      }
    }

    await sleep(300);
  }

  return { found, notFound, noEmail, processed: rows.length };
}

async function main() {
  const { limit, dryRun } = parseArgs(process.argv.slice(2));
  const { found, notFound, noEmail, processed } = await enrichPendingPublishers({ limit, dryRun });

  if (processed === 0) {
    console.log('Nothing to enrich - all classified publisher leads already have a contact_status.');
    return;
  }

  if (dryRun) {
    console.log(`\nDry-run done. Re-run without --dry-run to actually reveal emails (uses credits).`);
  } else {
    console.log(`\nDone. ${found} found, ${noEmail} matched but no email, ${notFound} no person found.`);
  }
}

process.on('SIGINT', () => {
  console.log('\nInterrupted - progress is saved. Re-run the same command to resume.');
  process.exit(0);
});

// Only auto-run when executed directly (`node discovery/enrich.js`), not when
// imported by classify.js for the auto-cascade.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
