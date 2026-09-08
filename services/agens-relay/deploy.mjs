import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Secret values are read from private files, never command-line arguments or deployment logs.
const root = fileURLToPath(new URL('.', import.meta.url));
const required = name => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const token = (await readFile(required('VERCEL_TOKEN_FILE'), 'utf8')).trim();
const relayToken = (await readFile(required('RELAY_TOKEN_FILE'), 'utf8')).trim();
const keys = (await readFile(required('AGENS_KEY_FILE'), 'utf8')).trim().split(/\s+/);
const index = Number(required('AGENS_KEY_INDEX'));
if (!Number.isInteger(index) || !keys[index] || relayToken.length < 32) {
  throw new Error('Invalid key index or relay token');
}
const team = required('VERCEL_TEAM_ID');
const files = await Promise.all([
  'api/chat/completions.mjs', 'relay.mjs', 'package.json', 'vercel.json',
].map(async file => ({ file, data: await readFile(root + file, 'utf8') })));
const response = await fetch(`https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(team)}`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'zhiyuan-agens-relay', target: 'production', projectSettings: { framework: null },
    files, env: { AGENS_RELAY_TOKEN: relayToken, AGENS_API_KEY: keys[index] },
  }),
});
const deployment = await response.json();
if (!response.ok) throw new Error(`Deployment rejected: HTTP ${response.status} (${deployment.error?.code})`);
const result = { id: deployment.id, url: deployment.url, team, state: deployment.readyState };
await writeFile(required('DEPLOYMENT_STATE_FILE'), JSON.stringify(result), { mode: 0o600 });
console.log(JSON.stringify(result));
