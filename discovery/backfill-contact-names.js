// One-off backfill: fills in contact_name (what the outreach tab actually
// displays/uses) for leads that already have an email but no name there -
// preferring the real Apollo-researched contact_first_name/contact_last_name
// (a separate pair of columns the outreach tab was never reading) over
// guessing, and only guessing from the email's local-part pattern
// (sam.rushton@... -> Sam) when there's no researched name at all.
//
// Usage: node discovery/backfill-contact-names.js

import { sql } from './lib/db.js';

// Role-based addresses aren't a person - guessing a name from "info@" or
// "support@" would just be wrong, so these are left alone rather than
// producing a nonsense contact_name.
const GENERIC_PREFIXES = new Set([
  'info', 'hello', 'contact', 'support', 'admin', 'team', 'sales', 'help',
  'office', 'enquiries', 'inquiries', 'press', 'media', 'careers', 'jobs',
  'marketing', 'general', 'billing', 'accounts', 'noreply', 'no-reply'
]);

function guessFirstNameFromEmail(email) {
  const local = (email.split('@')[0] || '').toLowerCase();
  if (GENERIC_PREFIXES.has(local)) return null;
  const first = local.split(/[._\-+]/).filter(Boolean)[0];
  if (!first || first.length < 2 || /^\d+$/.test(first)) return null;
  return first[0].toUpperCase() + first.slice(1);
}

async function main() {
  const rows = await sql`
    SELECT id, contact_email, contact_first_name, contact_last_name
    FROM candidate_publishers
    WHERE contact_email IS NOT NULL AND contact_email != ''
      AND (contact_name IS NULL OR contact_name = '')
  `;
  console.log(`Found ${rows.length} lead(s) with an email but no contact_name.`);

  let fromApollo = 0, fromEmail = 0, skipped = 0;
  for (const row of rows) {
    let name = null;
    if (row.contact_first_name) {
      name = row.contact_last_name ? `${row.contact_first_name} ${row.contact_last_name}` : row.contact_first_name;
      fromApollo++;
    } else {
      const guess = guessFirstNameFromEmail(row.contact_email);
      if (guess) {
        name = guess;
        fromEmail++;
      } else {
        skipped++;
        continue;
      }
    }
    await sql`UPDATE candidate_publishers SET contact_name = ${name} WHERE id = ${row.id}`;
  }

  console.log(`\nDone. ${fromApollo} from Apollo research, ${fromEmail} guessed from email pattern, ${skipped} skipped (generic/ambiguous address).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
