import fs from 'fs/promises';
import path from 'path';

const API_ROOT = 'https://discord.com/api/v10';
const ROLE_OVERWRITE_TYPE = 0;
const MEMBER_OVERWRITE_TYPE = 1;
const TEXT_CHANNEL_TYPE = 0;
const CATEGORY_TYPE = 4;

const PERMISSIONS = {
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};

const READ_ACCESS =
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.READ_MESSAGE_HISTORY;

const WRITE_ACCESS =
  READ_ACCESS |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ATTACH_FILES;

const BASE_DENY = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES;
const SPACE_TOPIC_PREFIX = 'nixor-space:v1:';

class ChannelSpaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelSpaceError';
    this.userSafe = true;
  }
}

const clean = (value) => (value == null ? '' : String(value).trim());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function optionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

function roleOverwrite(id, allow = 0n, deny = 0n) {
  return {
    id: String(id),
    type: ROLE_OVERWRITE_TYPE,
    allow: allow.toString(),
    deny: deny.toString(),
  };
}

function memberOverwrite(id, allow = 0n, deny = 0n) {
  return {
    id: String(id),
    type: MEMBER_OVERWRITE_TYPE,
    allow: allow.toString(),
    deny: deny.toString(),
  };
}

function dedupeOverwrites(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    byKey.set(`${entry.type}:${entry.id}`, entry);
  }
  return [...byKey.values()];
}

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

async function loadGuildConfig(guildId) {
  const configPath = path.resolve(process.cwd(), 'config', 'guilds', `${guildId}.json`);
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    throw new ChannelSpaceError(`Managed channel creation is not configured for this server.`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new ChannelSpaceError('The server channel configuration is invalid.');
  }

  if (Number(config.schemaVersion) !== 2 || String(config.guildId) !== String(guildId)) {
    throw new ChannelSpaceError('Managed channel creation is not enabled for this server.');
  }

  return config;
}

function uniqueRoleMap(roles) {
  const map = new Map();
  const duplicates = new Set();
  for (const role of roles) {
    if (map.has(role.name)) duplicates.add(role.name);
    map.set(role.name, role);
  }
  if (duplicates.size) {
    throw new ChannelSpaceError(`Duplicate Discord role names must be resolved first: ${[...duplicates].join(', ')}`);
  }
  return map;
}

function roleNamesForMember(roles, memberRoleIds) {
  const ids = new Set((memberRoleIds || []).map(String));
  return new Set(roles.filter((role) => ids.has(String(role.id))).map((role) => role.name));
}

function entityMap(config) {
  const map = new Map();
  for (const entity of config.entities || []) {
    for (const token of [entity.key, entity.name, entity.slug]) {
      map.set(String(token).toLowerCase(), entity);
    }
  }
  return map;
}

export function normalizeChannelName(value) {
  const normalized = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]+/g, '')
    .replace(/[ _]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);

  if (!normalized) {
    throw new ChannelSpaceError('Channel name must contain at least one letter or number.');
  }
  return normalized;
}

export function parseMemberIds(value) {
  if (!value) return [];
  const matches = String(value).match(/\d{15,22}/g) || [];
  return [...new Set(matches)];
}

function parseEntityTokens(value, config) {
  if (!value) return [];
  const lookup = entityMap(config);
  const result = [];
  const seen = new Set();

  for (const token of String(value).split(',')) {
    const raw = token.trim();
    if (!raw) continue;
    const entity = lookup.get(raw.toLowerCase());
    if (!entity) {
      throw new ChannelSpaceError(`Unknown entity: ${raw}.`);
    }
    if (!seen.has(entity.key)) {
      seen.add(entity.key);
      result.push(entity);
    }
  }

  return result;
}

function findCategory(channels, name) {
  const matches = channels.filter(
    (channel) => channel.type === CATEGORY_TYPE && channel.name === name,
  );
  if (matches.length > 1) {
    throw new ChannelSpaceError(`More than one category named ${name} exists.`);
  }
  return matches[0] || null;
}

function findStandardBoardChannel(config, channels, entity) {
  const category = findCategory(channels, entity.name);
  if (!category) return null;
  const expectedName = `${entity.slug}-board`;
  const matches = channels.filter(
    (channel) =>
      channel.type === TEXT_CHANNEL_TYPE &&
      channel.parent_id === category.id &&
      channel.name === expectedName,
  );
  if (matches.length > 1) {
    throw new ChannelSpaceError(`Duplicate #${expectedName} channels exist in ${entity.name}.`);
  }
  return matches[0] || null;
}

export function deriveBoardAssignedEntityKeys(config, channels, userId) {
  const result = new Set();

  for (const entity of config.entities || []) {
    const boardChannel = findStandardBoardChannel(config, channels, entity);
    if (!boardChannel) continue;
    const hasDirectBoardAccess = (boardChannel.permission_overwrites || []).some(
      (overwrite) =>
        Number(overwrite.type) === MEMBER_OVERWRITE_TYPE &&
        String(overwrite.id) === String(userId),
    );
    if (hasDirectBoardAccess) result.add(entity.key);
  }

  return result;
}

function requireRole(roleMap, name) {
  const role = roleMap.get(name);
  if (!role) {
    throw new ChannelSpaceError(`Server setup is incomplete. Missing role: ${name}.`);
  }
  return role;
}

function audienceRoleOverwrites({
  selectedEntities,
  roleMap,
  includeExecutives,
  includeVolunteers,
  access,
}) {
  const result = [];
  for (const entity of selectedEntities) {
    if (includeExecutives) {
      result.push(roleOverwrite(requireRole(roleMap, `${entity.name} — Executive`).id, access, 0n));
    }
    if (includeVolunteers) {
      result.push(roleOverwrite(requireRole(roleMap, `${entity.name} — Volunteer`).id, access, 0n));
    }
  }
  return result;
}

async function validateExplicitMembers({
  token,
  guildId,
  memberIds,
  roleMap,
  entity,
  callerCanInviteAcrossEntities,
}) {
  if (!memberIds.length) return;

  const verifiedRole = requireRole(roleMap, 'Verified');
  const entityRole = entity ? requireRole(roleMap, entity.name) : null;

  for (const memberId of memberIds) {
    let target;
    try {
      target = await discordRequest(token, `guilds/${guildId}/members/${memberId}`);
    } catch (err) {
      throw new ChannelSpaceError(`Could not find Discord member ${memberId} in this server.`);
    }

    const targetRoles = new Set((target.roles || []).map(String));
    if (!targetRoles.has(String(verifiedRole.id))) {
      throw new ChannelSpaceError(`Every explicitly added member must already be Verified.`);
    }

    if (entity && !callerCanInviteAcrossEntities && !targetRoles.has(String(entityRole.id))) {
      throw new ChannelSpaceError(`Entity-created channels can only add people affiliated with ${entity.name}.`);
    }
  }
}

function metadataTopic({ scope, ownerId, entities, readOnly }) {
  const payload = {
    scope,
    ownerId: String(ownerId),
    entities: entities.map((entity) => entity.key),
    readOnly: Boolean(readOnly),
    createdAt: new Date().toISOString(),
  };
  return `${SPACE_TOPIC_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function describeAudience({ selectedEntities, includeExecutives, includeVolunteers, explicitMemberIds }) {
  const pieces = [];
  if (selectedEntities.length) {
    const suffixes = [];
    if (includeExecutives) suffixes.push('executives');
    if (includeVolunteers) suffixes.push('volunteers');
    if (suffixes.length) {
      pieces.push(`${selectedEntities.map((entity) => entity.name).join(', ')} ${suffixes.join(' + ')}`);
    }
  }
  if (explicitMemberIds.length) pieces.push(`${explicitMemberIds.length} selected member(s)`);
  return pieces.length ? pieces.join('; ') : 'private';
}

async function createManagedChannel({ guildId, userId, memberRoleIds, options, token }) {
  if (!token) throw new ChannelSpaceError('Discord bot token is unavailable.');
  if (!userId) throw new ChannelSpaceError('Could not resolve your Discord account.');

  const config = await loadGuildConfig(guildId);
  const scope = clean(optionValue(options, 'scope')).toLowerCase();
  const requestedName = clean(optionValue(options, 'name'));
  const entityValue = clean(optionValue(options, 'entity'));
  const entitiesValue = clean(optionValue(options, 'entities'));
  const membersValue = clean(optionValue(options, 'members'));
  const includeExecutivesOption = optionValue(options, 'include_executives');
  const includeVolunteersOption = optionValue(options, 'include_volunteers');
  const readOnly = Boolean(optionValue(options, 'read_only'));
  const includeExecutives = includeExecutivesOption === undefined ? true : Boolean(includeExecutivesOption);
  const includeVolunteers = includeVolunteersOption === undefined ? false : Boolean(includeVolunteersOption);
  const explicitMemberIds = parseMemberIds(membersValue).filter((id) => id !== String(userId));
  const channelName = normalizeChannelName(requestedName);

  if (!['entity', 'board', 'admin'].includes(scope)) {
    throw new ChannelSpaceError('Scope must be Entity, Board, or Admin.');
  }

  const [roles, channels] = await Promise.all([
    discordRequest(token, `guilds/${guildId}/roles`),
    discordRequest(token, `guilds/${guildId}/channels`),
  ]);

  const roleMap = uniqueRoleMap(roles);
  const callerRoleNames = roleNamesForMember(roles, memberRoleIds);
  const isAdmin = callerRoleNames.has(config.roles.admin);
  const isChair = callerRoleNames.has(config.roles.chairperson);
  const isBoard = callerRoleNames.has(config.roles.memberOfBoard);
  const audienceAccess = readOnly ? READ_ACCESS : WRITE_ACCESS;

  let category;
  let selectedEntities = [];
  let callerCanInviteAcrossEntities = isAdmin || isChair;
  const overwrites = [roleOverwrite(guildId, 0n, BASE_DENY)];

  if (scope === 'entity') {
    const selected = parseEntityTokens(entityValue, config);
    if (selected.length !== 1) {
      throw new ChannelSpaceError('Entity scope requires exactly one entity in the entity option.');
    }
    const entity = selected[0];
    selectedEntities = [entity];
    const entityExecutiveRole = `${entity.name} — Executive`;
    const isEntityExecutive = callerRoleNames.has(entityExecutiveRole);

    if (!isEntityExecutive && !isAdmin && !isChair) {
      throw new ChannelSpaceError(`Only ${entity.name} executives, Admin, or Chairperson can create channels for ${entity.name}.`);
    }

    category = findCategory(channels, entity.name);
    if (!category) {
      throw new ChannelSpaceError(`The ${entity.name} category is missing. Run guild setup first.`);
    }

    overwrites.push(
      ...audienceRoleOverwrites({
        selectedEntities,
        roleMap,
        includeExecutives,
        includeVolunteers,
        access: audienceAccess,
      }),
    );

    await validateExplicitMembers({
      token,
      guildId,
      memberIds: explicitMemberIds,
      roleMap,
      entity,
      callerCanInviteAcrossEntities,
    });
  }

  if (scope === 'board') {
    if (!isBoard && !isChair) {
      throw new ChannelSpaceError('Only Member of Board or Chairperson can create Board portal channels.');
    }

    const boardCategoryName = clean(config.portalCategories?.board);
    if (!boardCategoryName) {
      throw new ChannelSpaceError('Board portal category is not configured.');
    }
    category = findCategory(channels, boardCategoryName);
    if (!category) {
      throw new ChannelSpaceError(`The ${boardCategoryName} category is missing. Run portal setup first.`);
    }

    const assignedKeys = isChair
      ? new Set((config.entities || []).map((entity) => entity.key))
      : deriveBoardAssignedEntityKeys(config, channels, userId);

    if (entitiesValue) {
      selectedEntities = parseEntityTokens(entitiesValue, config);
    } else if (!isChair) {
      selectedEntities = (config.entities || []).filter((entity) => assignedKeys.has(entity.key));
    }

    if (!isChair) {
      const outsideAssignment = selectedEntities.filter((entity) => !assignedKeys.has(entity.key));
      if (outsideAssignment.length) {
        throw new ChannelSpaceError(
          `Board portal audience is outside your assigned entities: ${outsideAssignment.map((entity) => entity.name).join(', ')}.`,
        );
      }
      if (!selectedEntities.length && !explicitMemberIds.length) {
        throw new ChannelSpaceError('No assigned Board entities were found for your account.');
      }
    }

    overwrites.push(roleOverwrite(requireRole(roleMap, config.roles.chairperson).id, WRITE_ACCESS, 0n));
    overwrites.push(
      ...audienceRoleOverwrites({
        selectedEntities,
        roleMap,
        includeExecutives,
        includeVolunteers,
        access: audienceAccess,
      }),
    );

    await validateExplicitMembers({
      token,
      guildId,
      memberIds: explicitMemberIds,
      roleMap,
      entity: null,
      callerCanInviteAcrossEntities: true,
    });
  }

  if (scope === 'admin') {
    if (!isAdmin && !isChair) {
      throw new ChannelSpaceError('Only Admin or Chairperson can create Admin portal channels.');
    }

    const adminCategoryName = clean(config.portalCategories?.admin);
    if (!adminCategoryName) {
      throw new ChannelSpaceError('Admin portal category is not configured.');
    }
    category = findCategory(channels, adminCategoryName);
    if (!category) {
      throw new ChannelSpaceError(`The ${adminCategoryName} category is missing. Run portal setup first.`);
    }

    selectedEntities = parseEntityTokens(entitiesValue, config);
    overwrites.push(roleOverwrite(requireRole(roleMap, config.roles.admin).id, WRITE_ACCESS, 0n));
    overwrites.push(roleOverwrite(requireRole(roleMap, config.roles.chairperson).id, WRITE_ACCESS, 0n));
    overwrites.push(
      ...audienceRoleOverwrites({
        selectedEntities,
        roleMap,
        includeExecutives,
        includeVolunteers,
        access: audienceAccess,
      }),
    );

    await validateExplicitMembers({
      token,
      guildId,
      memberIds: explicitMemberIds,
      roleMap,
      entity: null,
      callerCanInviteAcrossEntities: true,
    });
  }

  const childChannels = channels.filter((channel) => channel.parent_id === category.id);
  if (childChannels.length >= 50) {
    throw new ChannelSpaceError(`${category.name} already has Discord's maximum of 50 channels.`);
  }

  const duplicate = childChannels.find(
    (channel) => channel.type === TEXT_CHANNEL_TYPE && channel.name === channelName,
  );
  if (duplicate) {
    throw new ChannelSpaceError(`A channel named #${channelName} already exists in ${category.name}.`);
  }

  for (const memberId of explicitMemberIds) {
    overwrites.push(memberOverwrite(memberId, audienceAccess, 0n));
  }
  // The creator always retains write access, including for read-only announcement spaces.
  overwrites.push(memberOverwrite(userId, WRITE_ACCESS, 0n));

  const created = await discordRequest(token, `guilds/${guildId}/channels`, {
    method: 'POST',
    body: {
      name: channelName,
      type: TEXT_CHANNEL_TYPE,
      parent_id: category.id,
      topic: metadataTopic({ scope, ownerId: userId, entities: selectedEntities, readOnly }),
      permission_overwrites: dedupeOverwrites(overwrites),
    },
  });

  return {
    channelId: created.id,
    message:
      `Created <#${created.id}> in **${category.name}**. ` +
      `Audience: ${describeAudience({ selectedEntities, includeExecutives, includeVolunteers, explicitMemberIds })}` +
      `${readOnly ? ' (read-only for the audience).' : '.'}`,
  };
}

export async function handleChannelCommand({
  guildId,
  userId,
  memberRoleIds,
  subcommand,
  options,
  token,
}) {
  if (subcommand !== 'create') {
    throw new ChannelSpaceError(`Unknown channel subcommand: ${subcommand || '(missing)'}.`);
  }

  return createManagedChannel({ guildId, userId, memberRoleIds, options, token });
}

export function channelCommandErrorMessage(err) {
  if (err?.userSafe) return err.message;
  return 'Could not create the channel. Please contact an admin if the problem continues.';
}
