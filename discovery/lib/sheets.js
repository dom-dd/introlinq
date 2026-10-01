import { google } from 'googleapis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const { GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET, GOOGLE_SHEETS_REFRESH_TOKEN } = process.env;

export function getSheetsClient() {
  if (!GOOGLE_SHEETS_CLIENT_ID || !GOOGLE_SHEETS_CLIENT_SECRET || !GOOGLE_SHEETS_REFRESH_TOKEN) {
    throw new Error('Google Sheets OAuth env vars missing (GOOGLE_SHEETS_CLIENT_ID/SECRET/REFRESH_TOKEN) - set them in discovery/.env.local for local scripts, or in Vercel env vars for the deployed app.');
  }
  const oauth2Client = new google.auth.OAuth2(GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_SHEETS_REFRESH_TOKEN });
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

export function extractSheetId(urlOrId) {
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : urlOrId;
}

// Creates the tab (with a header row) if it doesn't exist yet, or writes
// the header row into an existing-but-blank tab. Safe to call before every
// append - no-ops once the tab is already set up.
export async function ensureTabWithHeader(sheets, spreadsheetId, tabName, headerRow) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
    return;
  }

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!1:1` });
  if (!existing.data.values || !existing.data.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headerRow] },
    });
  }
}

export async function appendRow(sheets, spreadsheetId, tabName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}
