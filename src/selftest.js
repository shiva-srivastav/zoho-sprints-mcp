/**
 * Self-test: spawns the server over stdio, lists tools, and with --live
 * exercises every read tool against the real API. Pass --create to also
 * create a throwaway backlog item.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');
const doCreate = process.argv.includes('--create');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'index.js')],
  env: process.env,
  stderr: 'inherit',
});

const client = new Client({ name: 'selftest', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools (' + tools.length + '):');
for (const t of tools) {
  const required = t.inputSchema?.required ?? [];
  console.log('  - ' + t.name + (required.length ? '  required: ' + required.join(', ') : ''));
}

async function call(name, args = {}, limit = 700) {
  const res = await client.callTool({ name, arguments: args });
  const tag = res.isError ? 'ERROR' : 'OK';
  console.log('\n--- ' + name + ' [' + tag + '] ---');
  console.log(res.content?.[0]?.text?.slice(0, limit));
  return res;
}

if (live) {
  await call('list_projects');
  await call('list_sprints');
  await call('list_item_meta', {}, 1200);
  await call('list_items', { range: 3 });
  await call('list_users');
  if (doCreate) {
    await call('create_item', { name: 'MCP verification item (safe to delete)' });
  }
}

await client.close();
process.exit(0);
