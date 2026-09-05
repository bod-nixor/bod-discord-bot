import { spawnSync } from 'child_process';
import path from 'path';

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const guildId = getArg('--guild');
const apply = args.includes('--apply');
const plan = args.includes('--plan') || !apply;
const entities = getArg('--entities');

if (!guildId) {
  console.error('Usage: npm run guild:v2 -- --guild <guild-id> [--entities NCS,NLX] [--plan|--apply]');
  process.exit(1);
}

function run(script, extraArgs = []) {
  const scriptPath = path.resolve(process.cwd(), script);
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const modeArg = apply ? '--apply' : '--plan';
const guildArgs = ['--guild', guildId, modeArg];
if (entities) guildArgs.push('--entities', entities);

console.log(`\n=== Schema v2 ${apply ? 'APPLY' : 'PLAN'}: roles + entity channels ===\n`);
run('scripts/setup-guild.js', guildArgs);

console.log(`\n=== Schema v2 ${apply ? 'APPLY' : 'PLAN'}: Board/Admin portal categories ===\n`);
run('scripts/setup-portals.js', ['--guild', guildId, modeArg]);

console.log(`\nSchema v2 ${plan ? 'plan' : 'setup'} complete.`);
