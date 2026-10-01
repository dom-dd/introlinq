// Prints tab names and header/sample rows for a Google Sheet, so we can
// match an export script's output columns to what GMass already expects.
//
// Usage: node discovery/inspect-sheet.js <sheet-url-or-id>

import { getSheetsClient, extractSheetId } from './lib/sheets.js';

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node discovery/inspect-sheet.js <sheet-url-or-id>');
  const spreadsheetId = extractSheetId(input);

  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  console.log(`Spreadsheet: ${meta.data.properties.title}\n`);

  for (const tab of meta.data.sheets) {
    const title = tab.properties.title;
    console.log(`--- Tab: "${title}" (gid=${tab.properties.sheetId}, ${tab.properties.gridProperties.rowCount} rows x ${tab.properties.gridProperties.columnCount} cols) ---`);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${title}'!1:3` });
    const rows = res.data.values || [];
    rows.forEach((row, i) => console.log(`  row ${i + 1}:`, row));
    console.log('');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
