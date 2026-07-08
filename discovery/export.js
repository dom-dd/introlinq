// Exports candidate_publishers (and, once built, their contacts) to a CSV
// file you can open in Excel/Sheets or import into Google Sheets manually.
//
// Usage: node discovery/export.js [output-path]

import { sql } from './lib/db.js';
import fs from 'node:fs';

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const outPath = process.argv[2] || 'discovery/candidates.csv';

  const rows = await sql`
    SELECT domain, homepage_url, title, snippet, lead_type, service_keyword, team_size, status,
           priority_score, estimated_monthly_visits, country, language, discovery_query, created_at
    FROM candidate_publishers
    ORDER BY lead_type NULLS LAST, priority_score DESC NULLS LAST, created_at DESC
  `;

  const headers = ['domain', 'homepage_url', 'title', 'snippet', 'lead_type', 'service_keyword', 'team_size', 'status', 'priority_score', 'estimated_monthly_visits', 'country', 'language', 'discovery_query', 'created_at'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Exported ${rows.length} candidates to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
