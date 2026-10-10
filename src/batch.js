/**
 * Creates a batch of items, waiting out a token-endpoint rate limit first.
 *
 *   npm run batch -- --sprint SPRINT_ID "First item" "Second item"
 *   npm run batch -- --backlog "First item"
 *
 * Options:
 *   --sprint <id>   target sprint; defaults to ZOHO_BACKLOG_ID
 *   --backlog       explicitly target the backlog
 *   --owner <id>    assignee system ID; defaults to ZOHO_DEFAULT_OWNER_ID, else unassigned
 *   --desc <text>   description applied to every item
 */
import { clientFromEnv } from './zoho.js';
import { loadEnv } from './env.js';

loadEnv();

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
}

const sprintOpt = opt('sprint');
const backlogOpt = opt('backlog');
const owner = opt('owner') ?? process.env.ZOHO_DEFAULT_OWNER_ID;
const desc = opt('desc');
const topics = argv.filter((a) => !a.startsWith('--'));

if (!topics.length) {
  console.error('Usage: npm run batch -- [--sprint ID | --backlog] [--owner ID] [--desc TEXT] "Item A" "Item B"');
  process.exit(2);
}

const zoho = clientFromEnv();
const base = 'team/' + process.env.ZOHO_TEAM_ID + '/projects/' + process.env.ZOHO_PROJECT_ID;
const container = backlogOpt
  ? process.env.ZOHO_BACKLOG_ID
  : (sprintOpt ?? process.env.ZOHO_BACKLOG_ID);

if (!container) {
  console.error('No target container. Pass --sprint ID or set ZOHO_BACKLOG_ID.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zoho rate-limits the refresh endpoint; back off until it lets us through.
let ready = false;
for (let attempt = 1; attempt <= 12 && !ready; attempt++) {
  try {
    await zoho.accessToken();
    ready = true;
  } catch (err) {
    console.log('waiting on token (attempt ' + attempt + '): ' + err.message.slice(0, 80));
    if (attempt < 12) await sleep(45_000);
  }
}
if (!ready) {
  console.error('Still rate-limited after ~9 minutes. Try again later.');
  process.exit(1);
}

console.log('target container: ' + container + '\n');
let created = 0;
for (const name of topics) {
  try {
    const d = await zoho.request({
      method: 'POST',
      path: base + '/sprints/' + container + '/item/',
      form: {
        name,
        projitemtypeid: process.env.ZOHO_DEFAULT_ITEM_TYPE_ID,
        projpriorityid: process.env.ZOHO_DEFAULT_PRIORITY_ID,
        description: desc,
        // `users` must be a JSON array even for a single assignee.
        users: owner ? JSON.stringify([owner]) : undefined,
      },
    });
    created++;
    console.log('OK   #' + d.itemNo + '  ' + name);
  } catch (err) {
    console.log(
      'FAIL ' + name + '  HTTP ' + err.status + '  ' + JSON.stringify(err.body).slice(0, 140),
    );
  }
  await sleep(500); // stay clear of per-endpoint throttling
}
console.log('\ncreated ' + created + ' of ' + topics.length);
