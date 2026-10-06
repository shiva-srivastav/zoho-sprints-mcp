/**
 * Locates and loads the credentials file.
 *
 * Secrets never belong in an MCP client's config (claude_desktop_config.json,
 * ~/.codex/config.toml, .mcp.json): those files get shared, synced and pasted
 * into issues. Instead every entry point loads one dotenv file:
 *
 *   1. $ZOHO_ENV_FILE, when set — lets credentials live outside the repo.
 *   2. <project>/.env otherwise (gitignored).
 *
 * Real environment variables still win over the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function envFilePath(env = process.env) {
  return env.ZOHO_ENV_FILE ? path.resolve(env.ZOHO_ENV_FILE) : path.join(ROOT, '.env');
}

/** Loads the env file if present. Returns its path, or null when absent. */
export function loadEnv() {
  const file = envFilePath();
  if (!fs.existsSync(file)) return null;
  // loadEnvFile does not override variables that are already set.
  process.loadEnvFile(file);
  return file;
}
