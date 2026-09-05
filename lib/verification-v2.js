import fs from 'fs/promises';
import path from 'path';

const API_ROOT = 'https://discord.com/api/v10';
const CATEGORY_TYPE = 4;
const TEXT_CHANNEL_TYPE = 0;
const MEMBER_OVERWRITE_TYPE = 1;

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

const RELATIONSHIP_CONFIG_KEYS = {
  Executive: 'executive',
  Volunteer: 'volunteer',
  'Member of Board': 'memberOfBoard',
  Chairperson: 'chairperson',
  Admin: 'admin',
};

const ENTITY_SCOPED_RELATIONSHIPS = new Set(['Executive', 'Volunteer', 'Member of Board']);

const clean = (value) => (value == null ? '' : String(value).trim());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordRequest(token, endpoint, options = {}) {
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

export async function loadV2GuildConfig(guildId) {
  const configPath = path.resolve(process.cwd(), 'config', 'guilds', `${guildId}.json`);
  let raw;

  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    throw new Error(`V2 guild config is unavailable for ${guildId}: ${err.message}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`V2 guild config is invalid JSON for ${guildId}: ${err.message}`);
  }

  if (Number(config.schemaVersion) !== 2 || String(config.guildId) !== String(guildId)) {
    throw new Error(`V2 guild config does not match guild ${guildId}.`);
  }

  return config;
}

export function managedRoleNames(config) {
  const names = new Set([
    config.roles.verified,
    config.roles.executive,
    config.roles.volunteer,
    config.roles.memberOfBoard,
    config.roles.chairperson,
    config.roles.admin,
    ...(config.positions || []),
  ]);

  for (const entity of config.entities || []) {
    names.add(entity.name);
    names.add(`${entity.name} — Executive`);
    names.add(`${entity.name} — Volunteer`);
  }

  return names;
}

export function validateAndDeriveV2(config, sheetData) {
  if (Number(sheetData?.schemaVersion) !== 2) {
    throw new Error('Expected a schemaVersion 2 verification payload.');
  }

  const personName = clean(sheetData?.person?.name);
  if (!personName) {
    throw new Error('V2 verification payload is missing person.name.');
  }

  if (!Array.isArray(sheetData.assignments) || sheetData.assignments.length === 0) {
    throw new Error('V2 verification payload contains no assignments.');
  }

  const entityMap = new Map((config.entities || []).map((entity) => [entity.key, entity]));
  const positions = new Set(config.positions || []);
  const desiredRoles = new Set([config.roles.verified]);
  const boardEntities = new Set();
  const normalizedAssignments = [];

  for (const rawAssignment of sheetData.assignments) {
    const relationship = clean(rawAssignment?.relationship);
    const entityKey = clean(rawAssignment?.entity);
    const position = clean(rawAssignment?.position);
    const roleConfigKey = RELATIONSHIP_CONFIG_KEYS[relationship];

    if (!roleConfigKey || !config.roles[roleConfigKey]) {
      throw new Error(`Unsupported relationship in v2 payload: ${relationship || '(blank)'}.`);
    }

    const requiresEntity = ENTITY_SCOPED_RELATIONSHIPS.has(relationship);
    if (requiresEntity && !entityKey) {
      throw new Error(`${relationship} assignment is missing an entity.`);
    }
    if (!requiresEntity && entityKey) {
      throw new Error(`${relationship} assignment must not specify an entity.`);
    }

    let entity = null;
    if (entityKey) {
      entity = entityMap.get(entityKey);
      if (!entity) {
        throw new Error(`Unknown entity in v2 payload: ${entityKey}.`);
      }
      desiredRoles.add(entity.name);
    }

    if (position && relationship !== 'Executive') {
      throw new Error(`Only Executive assignments may specify a position (${relationship}: ${position}).`);
    }
    if (position && !positions.has(position)) {
      throw new Error(`Unknown position in v2 payload: ${position}.`);
    }

    desiredRoles.add(config.roles[roleConfigKey]);

    if (relationship === 'Executive') {
      desiredRoles.add(`${entity.name} — Executive`);
      if (position) desiredRoles.add(position);
    } else if (relationship === 'Volunteer') {
      desiredRoles.add(`${entity.name} — Volunteer`);
    } else if (relationship === 'Member of Board') {
      boardEntities.add(entity.key);
    }

    normalizedAssignments.push({ relationship, entity: entityKey || null, position: position || null });
  }

  return {
    personName,
    desiredRoles,
    boardEntities,
    normalizedAssignments,
  };
}

function buildUniqueRoleMap(roles, managedNames) {
  const byName = new Map();

  for (const role of roles) {
    if (!managedNames.has(role.name)) continue;
    if (byName.has(role.name)) {
      throw new Error(`Duplicate managed Discord role name: ${role.name}.`);
    }
    byName.set(role.name, role);
  }

  return byName;
}

function standardBoardChannels(config, channels) {
  const categoriesByName = new Map();
  for (const channel of channels) {
    if (channel.type !== CATEGORY_TYPE) continue;
    const existing = categoriesByName.get(channel.name) || [];
    existing.push(channel);
    categoriesByName.set(channel.name, existing);
  }

  const result = new Map();

  for (const entity of config.entities || []) {
    const categories = categoriesByName.get(entity.name) || [];
    if (categories.length > 1) {
      throw new Error(`Duplicate category named ${entity.name}; cannot reconcile Board access safely.`);
    }
    if (categories.length === 0) continue;

    const category = categories[0];
    const boardName = `${entity.slug}-board`;
    const adminName = `${entity.slug}-admin`;
    const boardMatches = channels.filter(
      (channel) => channel.type === TEXT_CHANNEL_TYPE && channel.parent_id === category.id && channel.name === boardName,
    );
    const adminMatches = channels.filter(
      (channel) => channel.type === TEXT_CHANNEL_TYPE && channel.parent_id === category.id && channel.name === adminName,
    );

    if (boardMatches.length > 1 || adminMatches.length > 1) {
      throw new Error(`Duplicate standard Board/Admin channel in ${entity.name}.`);
    }

    result.set(entity.key, {
      board: boardMatches[0] || null,
      admin: adminMatches[0] || null,
    });
  }

  return result;
}

function hasMemberOverwrite(channel, userId) {
  return Boolean(
    channel?.permission_overwrites?.some(
      (overwrite) => String(overwrite.id) === String(userId) && Number(overwrite.type) === MEMBER_OVERWRITE_TYPE,
    ),
  );
}

async function reconcileBoardChannelAccess({ token, config, channels, userId, boardEntities }) {
  const byEntity = standardBoardChannels(config, channels);

  for (const entityKey of boardEntities) {
    const target = byEntity.get(entityKey);
    if (!target?.board || !target?.admin) {
      throw new Error(
        `Board access cannot be applied for ${entityKey}: run guild setup for that entity first.`,
      );
    }
  }

  let granted = 0;
  let removed = 0;

  for (const entity of config.entities || []) {
    const target = byEntity.get(entity.key);
    if (!target) continue;

    const shouldHaveBoardAccess = boardEntities.has(entity.key);

    for (const channel of [target.board, target.admin]) {
      if (!channel) continue;

      if (shouldHaveBoardAccess) {
        await discordRequest(token, `channels/${channel.id}/permissions/${userId}`, {
          method: 'PUT',
          body: {
            type: MEMBER_OVERWRITE_TYPE,
            allow: TEXT_ACCESS.toString(),
            deny: '0',
          },
        });
        granted += 1;
      } else if (hasMemberOverwrite(channel, userId)) {
        await discordRequest(token, `channels/${channel.id}/permissions/${userId}`, {
          method: 'DELETE',
        });
        removed += 1;
      }
    }
  }

  return { granted, removed };
}

export async function reconcileV2Verification({ guildId, userId, sheetData, token }) {
  if (!token) throw new Error('Discord bot token is unavailable.');

  const config = await loadV2GuildConfig(guildId);
  const derived = validateAndDeriveV2(config, sheetData);
  const allManagedNames = managedRoleNames(config);

  const [roles, member, channels] = await Promise.all([
    discordRequest(token, `guilds/${guildId}/roles`),
    discordRequest(token, `guilds/${guildId}/members/${userId}`),
    discordRequest(token, `guilds/${guildId}/channels`),
  ]);

  const roleMap = buildUniqueRoleMap(roles, allManagedNames);
  const missingDesiredRoles = [...derived.desiredRoles].filter((name) => !roleMap.has(name));
  if (missingDesiredRoles.length) {
    throw new Error(
      `V2 server setup is incomplete. Missing role(s): ${missingDesiredRoles.join(', ')}. Run guild setup first.`,
    );
  }

  // Preflight required Board channels before changing any member roles.
  const boardChannelMap = standardBoardChannels(config, channels);
  for (const entityKey of derived.boardEntities) {
    const target = boardChannelMap.get(entityKey);
    if (!target?.board || !target?.admin) {
      throw new Error(`V2 server setup is incomplete for ${entityKey}: Board/Admin channel is missing.`);
    }
  }

  const currentRoleIds = new Set((member.roles || []).map(String));
  const managedRoleIds = new Set([...roleMap.values()].map((role) => String(role.id)));
  const desiredRoleIds = new Set([...derived.desiredRoles].map((name) => String(roleMap.get(name).id)));

  const toAdd = [...desiredRoleIds].filter((roleId) => !currentRoleIds.has(roleId));
  const toRemove = [...currentRoleIds].filter(
    (roleId) => managedRoleIds.has(roleId) && !desiredRoleIds.has(roleId),
  );

  for (const roleId of toAdd) {
    await discordRequest(token, `guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'PUT' });
  }

  for (const roleId of toRemove) {
    await discordRequest(token, `guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' });
  }

  const boardAccess = await reconcileBoardChannelAccess({
    token,
    config,
    channels,
    userId,
    boardEntities: derived.boardEntities,
  });

  const nickname = derived.personName.slice(0, 32);
  let nicknameUpdated = false;

  try {
    await discordRequest(token, `guilds/${guildId}/members/${userId}`, {
      method: 'PATCH',
      body: { nick: nickname },
    });
    nicknameUpdated = true;
  } catch (err) {
    // Match legacy verification behaviour: nickname hierarchy/permission
    // failures must not undo or fail otherwise-successful verification.
    console.warn(
      `V2 verification could not update nickname for user ${userId} in guild ${guildId}: ${err.message}`,
    );
  }

  return {
    nickname,
    nicknameUpdated,
    rolesAdded: toAdd.length,
    rolesRemoved: toRemove.length,
    boardChannelGrants: boardAccess.granted,
    boardChannelRemovals: boardAccess.removed,
    assignments: derived.normalizedAssignments,
  };
}
