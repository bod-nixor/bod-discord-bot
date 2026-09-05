import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const API_ROOT = 'https://discord.com/api/v10';
const ROLE_TYPE = 0;
const CATEGORY_TYPE = 4;

const PERMISSIONS = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};

const TEXT_ACCESS =
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.READ_MESSAGE_HISTORY;

const TEXT_DENY = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES;

const args = process.argv.slice(2);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const guildId = getArg('--guild');
const apply = args.includes('--apply');
const planOnly = args.includes('--plan') || !apply;
const entityFilter = getArg('--entities');

if (!guildId) {
  console.error('Usage: npm run guild:setup -- --guild <guild-id> [--entities NCS,NLX] [--plan|--apply]');
  process.exit(1);
}

const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN or DISCORD_TOKEN is required to inspect or update Discord.');
  process.exit(1);
}

const configPath = path.resolve(process.cwd(), 'config', 'guilds', `${guildId}.json`);
let config;
try {
  config = JSON.parse(await fs.readFile(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load ${configPath}:`, err.message);
  process.exit(1);
}

if (String(config.guildId) !== String(guildId)) {
  console.error(`Config guildId ${config.guildId} does not match requested guild ${guildId}.`);
  process.exit(1);
}

const verificationChannelName = String(config.verificationChannel?.name || '').trim();

const requestedEntityKeys = entityFilter
  ? new Set(entityFilter.split(',').map((value) => value.trim()).filter(Boolean))
  : null;

const entities = requestedEntityKeys
  ? config.entities.filter((entity) => requestedEntityKeys.has(entity.key))
  : config.entities;

if (requestedEntityKeys) {
  const found = new Set(entities.map((entity) => entity.key));
  const missing = [...requestedEntityKeys].filter((key) => !found.has(key));
  if (missing.length) {
    console.error(`Unknown entity key(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordRequest(endpoint, options = {}) {
  const url = `${API_ROOT}/${endpoint}`;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const response = await fetch(url, {
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

const roleNameForEntityExecutive = (entity) => `${entity.name} — Executive`;
const roleNameForEntityVolunteer = (entity) => `${entity.name} — Volunteer`;

function desiredRoleNames() {
  const names = [
    config.roles.verified,
    config.roles.executive,
    config.roles.volunteer,
    config.roles.memberOfBoard,
    config.roles.chairperson,
    config.roles.admin,
    ...config.positions,
  ];

  for (const entity of entities) {
    names.push(entity.name, roleNameForEntityExecutive(entity), roleNameForEntityVolunteer(entity));
  }

  return [...new Set(names)];
}

function duplicatesByName(items) {
  const map = new Map();
  for (const item of items) {
    const list = map.get(item.name) || [];
    list.push(item);
    map.set(item.name, list);
  }
  return [...map.entries()].filter(([, list]) => list.length > 1);
}

function overwrite(id, type, allow = 0n, deny = 0n) {
  return { id, type, allow: allow.toString(), deny: deny.toString() };
}

function mergeManagedOverwrites(existing, managedIds, desired) {
  const desiredIds = new Set(desired.map((entry) => String(entry.id)));
  const preserved = (existing || []).filter((entry) => {
    const id = String(entry.id);
    if (desiredIds.has(id)) return false;
    return !managedIds.has(id);
  });
  return [...preserved, ...desired];
}

function verificationChannelDesiredOverwrites(roleMap) {
  const everyoneId = guildId;
  const verifiedRole = roleMap.get(config.roles.verified);
  if (!verifiedRole) {
    throw new Error(`Verification channel requires managed role: ${config.roles.verified}`);
  }

  // This channel is intentionally fully managed. @everyone can see it until
  // verification, then the Verified role hides it. Do not preserve other role
  // or member overwrites here, because an explicit allow could make the channel
  // visible again to a verified user.
  return [
    overwrite(everyoneId, ROLE_TYPE, PERMISSIONS.VIEW_CHANNEL, 0n),
    overwrite(verifiedRole.id, ROLE_TYPE, 0n, PERMISSIONS.VIEW_CHANNEL),
  ];
}

function entityChannelDesiredOverwrites(entity, roleMap, existing = []) {
  const everyoneId = guildId;
  const entityExecId = roleMap.get(roleNameForEntityExecutive(entity)).id;
  const entityVolunteerId = roleMap.get(roleNameForEntityVolunteer(entity)).id;
  const chairId = roleMap.get(config.roles.chairperson).id;
  const adminId = roleMap.get(config.roles.admin).id;

  const managedIds = new Set([everyoneId, entityExecId, entityVolunteerId, chairId, adminId]);

  const base = [
    overwrite(everyoneId, ROLE_TYPE, 0n, TEXT_DENY),
    overwrite(entityExecId, ROLE_TYPE, TEXT_ACCESS, 0n),
  ];

  return {
    team: mergeManagedOverwrites(existing, managedIds, base),
    board: mergeManagedOverwrites(existing, managedIds, [
      ...base,
      overwrite(chairId, ROLE_TYPE, TEXT_ACCESS, 0n),
    ]),
    admin: mergeManagedOverwrites(existing, managedIds, [
      ...base,
      overwrite(chairId, ROLE_TYPE, TEXT_ACCESS, 0n),
      overwrite(adminId, ROLE_TYPE, TEXT_ACCESS, 0n),
    ]),
    volunteers: mergeManagedOverwrites(existing, managedIds, [
      ...base,
      overwrite(entityVolunteerId, ROLE_TYPE, TEXT_ACCESS, 0n),
    ]),
  };
}

async function getGuildState() {
  const [roles, channels] = await Promise.all([
    discordRequest(`guilds/${guildId}/roles`),
    discordRequest(`guilds/${guildId}/channels`),
  ]);
  return { roles, channels };
}

async function ensureRoles(state) {
  const names = desiredRoleNames();
  const duplicateRoles = duplicatesByName(state.roles).filter(([name]) => names.includes(name));
  if (duplicateRoles.length) {
    throw new Error(`Duplicate managed role names exist: ${duplicateRoles.map(([name]) => name).join(', ')}`);
  }

  const roleMap = new Map(state.roles.map((role) => [role.name, role]));
  const missing = names.filter((name) => !roleMap.has(name));

  if (missing.length) {
    console.log(`Roles to create (${missing.length}):`);
    for (const name of missing) console.log(`  + ${name}`);
  } else {
    console.log('Roles: already in sync.');
  }

  if (planOnly) return roleMap;

  for (const name of missing) {
    const created = await discordRequest(`guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name, permissions: '0', hoist: false, mentionable: false },
    });
    roleMap.set(name, created);
    console.log(`Created role: ${name}`);
  }
  return roleMap;
}

async function ensureVerificationChannel(state, roleMap) {
  if (!verificationChannelName) return;

  const matches = state.channels.filter(
    (channel) => channel.type === 0 && channel.name === verificationChannelName,
  );

  if (matches.length > 1) {
    throw new Error(`More than one text channel named #${verificationChannelName} exists.`);
  }

  const desiredOverwrites = verificationChannelDesiredOverwrites(roleMap);
  const channel = matches[0];

  if (!channel) {
    console.log(`Verification channel to create: #${verificationChannelName}`);
    if (!planOnly) {
      await discordRequest(`guilds/${guildId}/channels`, {
        method: 'POST',
        body: {
          name: verificationChannelName,
          type: 0,
          permission_overwrites: desiredOverwrites,
        },
      });
      console.log(`Created verification channel: #${verificationChannelName}`);
    }
    return;
  }

  console.log(`Verification channel exists: #${verificationChannelName}`);
  if (!planOnly) {
    await discordRequest(`channels/${channel.id}`, {
      method: 'PATCH',
      body: { permission_overwrites: desiredOverwrites },
    });
    console.log(`Synced unverified-only permissions: #${verificationChannelName}`);
  }
}

async function ensureEntityStructure(state, roleMap) {
  const channels = [...state.channels];

  for (const entity of entities) {
    const categories = channels.filter((channel) => channel.type === CATEGORY_TYPE && channel.name === entity.name);
    if (categories.length > 1) {
      throw new Error(`More than one category named ${entity.name}. Resolve duplicates before running setup.`);
    }

    let category = categories[0];
    if (!category) {
      console.log(`Category to create: ${entity.name}`);
      if (!planOnly) {
        category = await discordRequest(`guilds/${guildId}/channels`, {
          method: 'POST',
          body: { name: entity.name, type: CATEGORY_TYPE },
        });
        channels.push(category);
        console.log(`Created category: ${entity.name}`);
      }
    } else {
      console.log(`Category exists: ${entity.name}`);
    }

    for (const channelSpec of config.standardChannels) {
      const channelName = `${entity.slug}-${channelSpec.suffix}`;
      const matches = channels.filter(
        (channel) => channel.type === 0 && channel.name === channelName && (!category || channel.parent_id === category.id),
      );

      if (matches.length > 1) {
        throw new Error(`More than one text channel named #${channelName} exists in ${entity.name}.`);
      }

      let channel = matches[0];
      if (!channel) {
        console.log(`  Channel to create: #${channelName}`);
        if (!planOnly) {
          const desiredByKey = entityChannelDesiredOverwrites(entity, roleMap, []);
          channel = await discordRequest(`guilds/${guildId}/channels`, {
            method: 'POST',
            body: {
              name: channelName,
              type: 0,
              parent_id: category.id,
              permission_overwrites: desiredByKey[channelSpec.key],
            },
          });
          channels.push(channel);
          console.log(`  Created #${channelName}`);
        }
      } else {
        console.log(`  Channel exists: #${channelName}`);
        if (!planOnly) {
          const desiredByKey = entityChannelDesiredOverwrites(entity, roleMap, channel.permission_overwrites || []);
          await discordRequest(`channels/${channel.id}`, {
            method: 'PATCH',
            body: {
              parent_id: category.id,
              permission_overwrites: desiredByKey[channelSpec.key],
            },
          });
          console.log(`  Synced permissions: #${channelName}`);
        }
      }
    }
  }
}

async function main() {
  console.log(`${apply ? 'APPLY' : 'PLAN'} — ${config.name} (${guildId})`);
  console.log(`Entities: ${entities.map((entity) => entity.key).join(', ')}`);
  if (planOnly) console.log('No Discord changes will be made.');

  const state = await getGuildState();
  const roleMap = await ensureRoles(state);

  if (planOnly) {
    const simulatedRoleMap = new Map(roleMap);
    let fakeId = 900000000000000000n;
    for (const name of desiredRoleNames()) {
      if (!simulatedRoleMap.has(name)) {
        simulatedRoleMap.set(name, { id: String(fakeId++), name });
      }
    }
    await ensureVerificationChannel(state, simulatedRoleMap);
    await ensureEntityStructure(state, simulatedRoleMap);
  } else {
    await ensureVerificationChannel(state, roleMap);
    await ensureEntityStructure(state, roleMap);
  }

  console.log(planOnly ? 'Plan complete.' : 'Guild setup complete.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
