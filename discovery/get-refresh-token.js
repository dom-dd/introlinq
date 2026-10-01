// One-time setup: exchanges a Google login for a refresh token that lets
// export-to-sheets.js (or similar) write to Google Sheets unattended,
// without a service account key (blocked by org policy on this project).
//
// Usage: npm run sheets-auth
// Opens a URL to approve in your browser, then saves the refresh token
// straight into discovery/.env.local.

import { google } from 'googleapis';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env.local');
dotenv.config({ path: envPath });

const { GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET } = process.env;
if (!GOOGLE_SHEETS_CLIENT_ID || !GOOGLE_SHEETS_CLIENT_SECRET) {
  throw new Error('GOOGLE_SHEETS_CLIENT_ID / GOOGLE_SHEETS_CLIENT_SECRET not set in discovery/.env.local');
}

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

async function main() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const oauth2Client = new google.auth.OAuth2(GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_CLIENT_SECRET, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\nOpen this URL, log in as dom@introlinq.com, and approve access:\n');
  console.log(authUrl);
  console.log('\nWaiting for you to approve in the browser...\n');

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.end(error ? 'Authorization failed, check the terminal.' : 'Authorized — you can close this tab.');
      server.close();
      if (error) reject(new Error(error));
      else resolve(code);
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned — revoke prior access at https://myaccount.google.com/permissions and rerun.');
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const updated = envContent.includes('GOOGLE_SHEETS_REFRESH_TOKEN=')
    ? envContent.replace(/GOOGLE_SHEETS_REFRESH_TOKEN=.*/g, `GOOGLE_SHEETS_REFRESH_TOKEN=${tokens.refresh_token}`)
    : `${envContent.trimEnd()}\nGOOGLE_SHEETS_REFRESH_TOKEN=${tokens.refresh_token}\n`;
  fs.writeFileSync(envPath, updated, 'utf8');

  console.log('Saved GOOGLE_SHEETS_REFRESH_TOKEN to discovery/.env.local');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
