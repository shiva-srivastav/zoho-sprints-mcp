#!/usr/bin/env node
/**
 * Fails if anything that would be committed (or published) contains a Zoho
 * credential. Prints file:line and the kind of match, never the secret itself.
 *
 *   npm run check-secrets            files git would commit (tracked + untracked, minus ignored)
 *   npm run check-secrets -- --staged   only the staged versions (used by the pre-commit hook)
 *
 * Detection:
 *   - the literal values of every secret in your real env file
 *   - Zoho token shapes (1000.<hex32>.<hex32>) and client-ID shapes (1000.<A-Z0-9>{30})
 *   - credential files themselves (.env, .token-cache.json) being tracked
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, envFilePath } from '../src/env.js';

const staged = process.argv.includes('--staged');

const FORBIDDEN_FILES = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.token-cache\.json/];
const PATTERNS = [
  ['Zoho OAuth token', /\b1000\.[0-9a-f]{32}\.[0-9a-f]{32}\b/],
  ['Zoho client ID', /\b1000\.[A-Z0-9]{30}\b/],
];
const SECRET_KEYS = [
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_ACCESS_TOKEN',
];

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function candidateFiles() {
  try {
    const out = staged
      ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
      : git('ls-files', '--cached', '--others', '--exclude-standard', '-z');
    return out.split('\0').filter(Boolean);
  } catch {
    // Not a git repo yet: walk the tree, skipping what .gitignore would skip.
    const skip = new Set(['node_modules', '.git', '.env', '.token-cache.json']);
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (skip.has(e.name) || e.name.endsWith('.tmp') || e.name.endsWith('.log')) continue;
        const rel = dir ? dir + '/' + e.name : e.name;
        if (e.isDirectory()) walk(rel);
        else files.push(rel);
      }
    })('');
    return files;
  }
}

function readCandidate(rel) {
  if (staged) return git('show', ':' + rel);
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Literal secret values from the real env file and token cache. */
function knownSecrets() {
  const secrets = [];
  const envFile = envFilePath();
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#\s]+)"?/);
      if (m && SECRET_KEYS.includes(m[1]) && m[2].length >= 8) secrets.push([m[1], m[2]]);
    }
  }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(ROOT, '.token-cache.json'), 'utf8'));
    if (cache.token) secrets.push(['cached access token', cache.token]);
  } catch {}
  return secrets;
}

const files = candidateFiles();
const secrets = knownSecrets();
const problems = [];

for (const rel of files) {
  const posix = rel.replace(/\\/g, '/');
  if (FORBIDDEN_FILES.some((re) => re.test(posix))) {
    problems.push(posix + ': credential file must not be committed (check .gitignore)');
    continue;
  }
  let text;
  try {
    text = readCandidate(rel);
  } catch {
    continue; // deleted or unreadable
  }
  if (text.includes('\0')) continue; // binary

  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, value] of secrets) {
      if (line.includes(value)) problems.push(posix + ':' + (i + 1) + ': contains your ' + label);
    }
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) problems.push(posix + ':' + (i + 1) + ': looks like a ' + label);
    }
  });
}

if (problems.length) {
  console.error('Secret check FAILED:\n  ' + [...new Set(problems)].join('\n  '));
  console.error('\nRemove the value (use .env), then re-run. If a secret was ever pushed, rotate it');
  console.error('in the Zoho API console - deleting the commit is not enough.');
  process.exitCode = 1;
} else {
  console.log(
    'Secret check passed: ' + files.length + ' file(s) scanned' +
      (staged ? ' (staged)' : '') + ', ' + secrets.length + ' known secret value(s) checked.',
  );
}
