/**
 * Exchanges a Zoho Self Client grant token for a refresh token and writes
 * credentials into .env.
 *
 *   node src/authorize.js --code GRANT            (ID/secret read from .env)
 *   node src/authorize.js --client-id ID --client-secret SECRET --code GRANT
 *
 * The grant token is single use and expires in minutes, so run this right after
 * generating the code in the API console.
 */
import fs from 'node:fs';
import { envFilePath } from './env.js';

// Same file the server reads: $ZOHO_ENV_FILE, else <project>/.env.
const envPath = envFilePath();

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Merges updates into .env, preserving keys we do not manage. */
function writeEnv(updates) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.trim().startsWith(key + '='));
    if (idx !== -1) lines[idx] = key + '=' + value;
    else lines.push(key + '=' + value);
  }
  // Keep the scaffolding keys present so they are easy to fill in later.
  for (const key of [
    'ZOHO_TEAM_ID',
    'ZOHO_PROJECT_ID',
    'ZOHO_DEFAULT_ITEM_TYPE_ID',
    'ZOHO_DEFAULT_PRIORITY_ID',
  ]) {
    if (!lines.some((l) => l.trim().startsWith(key + '='))) lines.push(key + '=');
  }

  fs.writeFileSync(envPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', {
    mode: 0o600,
  });
}

const EXCHANGE_HINTS = {
  invalid_code:
    'The grant token expired (they last ~10 min) or was already used. Generate a new one.',
  invalid_client:
    'Client ID/secret mismatch, or the Self Client was created in a different data center.',
  invalid_client_secret: 'The client secret does not match the client ID.',
};

async function main() {
  // Client ID/secret may already sit in .env, so only the grant code has to be
  // passed on the command line. Flags still win over the file.
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Unparseable .env: fall through and rely on flags.
    }
  }

  const tld = arg('tld', process.env.ZOHO_TLD || 'in');
  const clientId = arg('client-id', process.env.ZOHO_CLIENT_ID);
  const clientSecret = arg('client-secret', process.env.ZOHO_CLIENT_SECRET);
  const code = arg('code');

  if (!clientId || !clientSecret || !code) {
    const missing = [
      !clientId && 'client ID',
      !clientSecret && 'client secret',
      !code && 'grant code',
    ].filter(Boolean);
    console.error('Missing: ' + missing.join(', ') + '\n');
    console.error('Put ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env, then:');
    console.error('  node src/authorize.js --code GRANT_CODE\n');
    console.error('Or pass everything explicitly:');
    console.error(
      '  node src/authorize.js --client-id ID --client-secret SECRET --code GRANT [--tld in]',
    );
    return 2;
  }

  const tokenUrl = 'https://accounts.zoho.' + tld + '/oauth/v2/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('Token endpoint returned non-JSON (HTTP ' + res.status + '):');
    console.error(text.slice(0, 600));
    return 1;
  }

  // Zoho signals failure with an "error" field on an HTTP 200.
  if (json.error || !json.refresh_token) {
    console.error('Exchange failed: ' + (json.error ?? 'no refresh_token in response'));
    if (EXCHANGE_HINTS[json.error]) {
      console.error(
        json.error === 'invalid_client'
          ? EXCHANGE_HINTS.invalid_client + ' Expected accounts.zoho.' + tld + '.'
          : EXCHANGE_HINTS[json.error],
      );
    }
    if (!json.error) console.error(JSON.stringify(json, null, 2));
    return 1;
  }

  writeEnv({
    ZOHO_TLD: tld,
    ZOHO_CLIENT_ID: clientId,
    ZOHO_CLIENT_SECRET: clientSecret,
    ZOHO_REFRESH_TOKEN: json.refresh_token,
  });

  console.log('Refresh token saved to ' + envPath);
  console.log('Scopes granted: ' + (json.scope ?? '(not reported)'));
  console.log('Next: npm run selftest -- --live');
  return 0;
}

// Set exitCode rather than calling process.exit(): an abrupt exit while the
// fetch socket is still closing trips a libuv assertion on Windows.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('Unexpected failure: ' + (err?.message ?? err));
    process.exitCode = 1;
  },
);
