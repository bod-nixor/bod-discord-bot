import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const API_ROOT = 'https://discord.com/api/v10';
const ROLE_OVERWRITE_TYPE = 0;
const CATEGORY_TYPE = 4;

const PERMISSIONS = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};

const WRITE_ACCESS =
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.READ_MESSAGE_HISTORY;

const BASE_DENY = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES;

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const guildId = getArg('--guild');
const apply = args.includes('--apply');
const planOnly = args.includes('--plan') || !apply;

if (!guildId) {
  console.error('Usage: npm run guild:portals -- --guild <guild-id> [--plan|--apply]');
  process.exit(1);
}

const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN or DISCORD_TOKEN is required.');
  process.exit(1);
}

const configPath = path.resolve(process.cwd(), 'config', 'guilds', `${guildId}.json`);
let config;
try {
  config = JSON.parse(await fs.readFile(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load ${configPath}: ${err.message}`);
  process.exit(1);
}

if (Number(config.schemaVersion) !== 2 || String(config.guildId) !== String(guildId)) {
  console.error(`Guild config does not match schema v2 guild ${guildId}.`);
  process.exit(1);
}

const boardCategoryName = String(config.portalCategories?.board || '').trim();
const adminCategoryName = String(config.portalCategories?.admin || '').trim();
if (!boardCategoryName || !adminCategoryName) {
  console.error('portalCategories.board and portalCategories.admin must be configured.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordRequest(endpoint, options = {}) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    const response = await fetch(`${API_ROOT}/${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 429 && attempts <= 8) {
      const rateLimit = await response.json().catch(() => ({}));
      const retryMs = Math.max(250, Math.ceil(Number(rateLimit.retry_after || 1) * 1000));
      console.log(`Rate limited by Discord; retrying in ${retryMs}ms...`);
      await sleep(retryMs);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${options.method || 'GET'} ${endpoint} failed (${response.status}): ${text}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }
}

function overwrite(id, allow = 0n, deny = 0n) {
  return {
    id: String(id),
    type: ROLE_OVERWRITE_TYPE,
    allow: allow.toString(),
    deny: deny.toString(),
  };
}

function uniqueRoleMap(roles) {
  const map = new Map();
  for (const role of roles) {
    if (map.has(role.name)) {
      throw new Error(`Duplicate role name: ${role.name}`);
    }
    map.set(role.name, role);
  }
  return map;
}

function requireRole(roleMap, name) {
  const role = roleMap.get(name);
  if (!role) {
    throw new Error(`Missing required role: ${name}. Run guild setup first.`);
  }
  return role;
}

function categoryMatches(channels, name) {
  return channels.filter((channel) => channel.type === CATEGORY_TYPE && channel.name === name);
}

async function ensureCategory({ channels, name, overwrites }) {
  const matches = categoryMatches(channels, name);
  if (matches.length > 1) {
    throw new Error(`More than one category named ${name} exists.`);
  }

  let category = matches[0];
  if (!category) {
    console.log(`Category to create: ${name}`);
    if (!planOnly) {
      category = await discordRequest(`guilds/${guildId}/channels`, {
        method: 'POST',
        body: {
          name,
          type: CATEGORY_TYPE,
          permission_overwrites: overwrites,
        },
      });
      channels.push(category);
      console.log(`Created category: ${name}`);
    }
    return;
  }

  console.log(`Category exists: ${name}`);
  if (!planOnly) {
    await discordRequest(`channels/${category.id}`, {
      method: 'PATCH',
      body: { permission_overwrites: overwrites },
    });
    console.log(`Synced permissions: ${name}`);
  }
}

async function main() {
  console.log(`${apply ? 'APPLY' : 'PLAN'} — portal categories for ${config.name} (${guildId})`);
  if (planOnly) console.log('No Discord changes will be made.');

  const [roles, channelsRaw] = await Promise.all([
    discordRequest(`guilds/${guildId}/roles`),
    discordRequest(`guilds/${guildId}/channels`),
  ]);
  const channels = [...channelsRaw];
  const roleMap = uniqueRoleMap(roles);

  const chair = requireRole(roleMap, config.roles.chairperson);
  const admin = requireRole(roleMap, config.roles.admin);

  await ensureCategory({
    channels,
    name: boardCategoryName,
    overwrites: [
      overwrite(guildId, 0n, BASE_DENY),
      overwrite(chair.id, WRITE_ACCESS, 0n),
    ],
  });

  await ensureCategory({
    channels,
    name: adminCategoryName,
    overwrites: [
      overwrite(guildId, 0n, BASE_DENY),
      overwrite(admin.id, WRITE_ACCESS, 0n),
      overwrite(chair.id, WRITE_ACCESS, 0n),
    ],
  });

  console.log(planOnly ? 'Portal plan complete.' : 'Portal setup complete.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
