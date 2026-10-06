/**
 * Read-only endpoint explorer. Prints the raw JSON for one GET request.
 *
 *   npm run probe -- team/TEAM_ID/projects/ action=data index=1 range=5
 *
 * {team} and {project} in the path expand to ZOHO_TEAM_ID / ZOHO_PROJECT_ID:
 *
 *   npm run probe -- "team/{team}/projects/{project}/sprints/" action=data index=1 range=10
 */
import { clientFromEnv } from './zoho.js';
import { loadEnv } from './env.js';

loadEnv();

const [rawPath, ...pairs] = process.argv.slice(2);
if (!rawPath) {
  console.error('Usage: npm run probe -- <path after /zsapi/> [key=value ...]');
  process.exitCode = 2;
} else {
  const p = rawPath
    .replace('{team}', process.env.ZOHO_TEAM_ID ?? '')
    .replace('{project}', process.env.ZOHO_PROJECT_ID ?? '');
  const query = Object.fromEntries(pairs.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  try {
    console.log(JSON.stringify(await clientFromEnv().request({ path: p, query }), null, 2));
  } catch (err) {
    console.error(err.message);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    process.exitCode = 1;
  }
}
