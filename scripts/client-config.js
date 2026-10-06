#!/usr/bin/env node
/**
 * Prints MCP client configuration for this checkout, with absolute paths
 * filled in. No credentials appear in any of it: the server reads them from
 * its own env file, so client configs stay safe to share.
 *
 *   npm run client-config                 print snippets for every client
 *   npm run client-config -- --install claude   run `claude mcp add` (user scope)
 *   npm run client-config -- --install codex    run `codex mcp add`
 */
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, envFilePath } from '../src/env.js';

const NAME = 'zoho-sprints';
// Forward slashes work on Windows too and avoid escaping in JSON/TOML/shells.
const entry = path.join(ROOT, 'src', 'index.js').replace(/\\/g, '/');
const node = 'node';

function desktopConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? '%APPDATA%', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function run(cmd, args) {
  console.log('> ' + [cmd, ...args].map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
  // npm-installed CLIs are .cmd shims on Windows, which need a shell.
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) console.error(cmd + ' not found on PATH: ' + res.error.message);
  process.exitCode = res.status ?? 1;
}

const i = process.argv.indexOf('--install');
const target = i !== -1 ? process.argv[i + 1] : null;

if (target === 'claude') {
  run('claude', ['mcp', 'add', NAME, '--scope', 'user', '--', node, entry]);
} else if (target === 'codex') {
  run('codex', ['mcp', 'add', NAME, '--', node, entry]);
} else if (target) {
  console.error('Unknown client "' + target + '". Use: --install claude | --install codex');
  process.exitCode = 2;
} else {
  const desktop = { mcpServers: { [NAME]: { command: node, args: [entry] } } };
  console.log(`Credentials are read from: ${envFilePath()}
(none of the snippets below contain secrets)

=== Claude Code ======================================================
claude mcp add ${NAME} --scope user -- ${node} "${entry}"

=== Claude Desktop ===================================================
Settings > Developer > Edit Config, or open:
  ${desktopConfigPath()}
Merge into "mcpServers", then fully quit and restart Claude Desktop:

${JSON.stringify(desktop, null, 2)}

=== OpenAI Codex (CLI, IDE extension and app share this config) =====
codex mcp add ${NAME} -- ${node} "${entry}"

or add to ~/.codex/config.toml:

[mcp_servers.${NAME}]
command = "${node}"
args = ['${entry}']
startup_timeout_sec = 20
tool_timeout_sec = 120
`);
}
