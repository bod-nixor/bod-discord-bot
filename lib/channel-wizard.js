import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  channelCommandErrorMessage,
  deriveBoardAssignedEntityKeys,
  handleChannelCommand,
} from './channel-spaces.js';

const API_ROOT = 'https://discord.com/api/v10';
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_DIR = path.join(os.tmpdir(), 'nixor-discord-channel-wizard');

const RESPONSE_MESSAGE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;
const RESPONSE_MODAL = 9;

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const COMPONENT_STRING_SELECT = 3;
const COMPONENT_TEXT_INPUT = 4;
const COMPONENT_USER_SELECT = 5;

const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 2;
const BUTTON_SUCCESS = 3;
const BUTTON_DANGER = 4;

const EPHEMERAL = 1 << 6;
const CUSTOM_PREFIX = 'ncw';

class ChannelWizardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelWizardError';
    this.userSafe = true;
  }
}

const clean = (value) => (value == null ? '' : String(value).trim());

async function discordRequest(token, endpoint) {
  const response = await fetch(`${API_ROOT}/${endpoint}`, {
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${endpoint} failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function loadGuildConfig(guildId) {
  const configPath = path.resolve(process.cwd(), 'config', 'guilds', `${guildId}.json`);
  let raw;

  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new ChannelWizardError('Guided channel creation is not configured for this server.');
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new ChannelWizardError('The channel configuration for this server is invalid.');
  }

  if (Number(config.schemaVersion) !== 2 || String(config.guildId) !== String(guildId)) {
    throw new ChannelWizardError('Guided channel creation is not enabled for this server.');
  }

  return config;
}

function memberRoleNames(roles, memberRoleIds) {
  const ids = new Set((memberRoleIds || []).map(String));
  return new Set(roles.filter((role) => ids.has(String(role.id))).map((role) => role.name));
}

function audienceRoleNames(config) {
  return [...new Set([
    config.roles.executive,
    config.roles.volunteer,
    config.roles.memberOfBoard,
    config.roles.chairperson,
    config.roles.admin,
    ...(config.positions || []),
  ].map(clean).filter(Boolean))];
}

async function buildCreationContext({ guildId, userId, memberRoleIds, token }) {
  if (!token) throw new ChannelWizardError('Discord bot token is unavailable.');

  const config = await loadGuildConfig(guildId);
  const [roles, channels] = await Promise.all([
    discordRequest(token, `guilds/${guildId}/roles`),
    discordRequest(token, `guilds/${guildId}/channels`),
  ]);

  const names = memberRoleNames(roles, memberRoleIds);
  const isAdmin = names.has(config.roles.admin);
  const isChair = names.has(config.roles.chairperson);
  const isBoard = names.has(config.roles.memberOfBoard);
  const allEntityKeys = (config.entities || []).map((entity) => entity.key);
  const executiveEntityKeys = (config.entities || [])
    .filter((entity) => names.has(`${entity.name} — Executive`))
    .map((entity) => entity.key);
  const boardEntityKeys = isChair
    ? allEntityKeys
    : [...deriveBoardAssignedEntityKeys(config, channels, userId)];

  const scopes = [];
  if (isChair || isAdmin || executiveEntityKeys.length) scopes.push('entity');
  if (isChair || isBoard) scopes.push('board');
  if (isChair || isAdmin) scopes.push('admin');

  if (!scopes.length) {
    throw new ChannelWizardError('Your current Corporate roles do not allow you to create managed channels.');
  }

  return {
    config,
    scopes,
    entityKeysByScope: {
      entity: isChair || isAdmin ? allEntityKeys : executiveEntityKeys,
      board: boardEntityKeys,
      admin: isChair || isAdmin ? allEntityKeys : [],
    },
    audienceRoles: audienceRoleNames(config),
  };
}

function sessionPath(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

async function writeSession(session) {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const target = sessionPath(session.id);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(session)}\n`, 'utf8');
  await fs.rename(temp, target);
}

async function deleteSession(sessionId) {
  await fs.unlink(sessionPath(sessionId)).catch(() => {});
}

async function readSession(sessionId, guildId, userId) {
  let session;
  try {
    session = JSON.parse(await fs.readFile(sessionPath(sessionId), 'utf8'));
  } catch {
    throw new ChannelWizardError('This channel setup session has expired. Run /channel create again.');
  }

  if (Date.now() > Number(session.expiresAt || 0)) {
    await deleteSession(sessionId);
    throw new ChannelWizardError('This channel setup session has expired. Run /channel create again.');
  }

  if (String(session.guildId) !== String(guildId) || String(session.userId) !== String(userId)) {
    throw new ChannelWizardError('This channel setup belongs to another Discord account.');
  }

  return session;
}

async function pruneExpiredSessions() {
  let entries;
  try {
    entries = await fs.readdir(SESSION_DIR);
  } catch {
    return;
  }

  await Promise.all(entries.slice(0, 100).map(async (entry) => {
    if (!entry.endsWith('.json')) return;
    const target = path.join(SESSION_DIR, entry);
    try {
      const session = JSON.parse(await fs.readFile(target, 'utf8'));
      if (Date.now() > Number(session.expiresAt || 0)) await fs.unlink(target);
    } catch {
      await fs.unlink(target).catch(() => {});
    }
  }));
}

function customId(sessionId, action) {
  return `${CUSTOM_PREFIX}:${sessionId}:${action}`;
}

function parseCustomId(value) {
  const [prefix, sessionId, action] = clean(value).split(':');
  if (prefix !== CUSTOM_PREFIX || !sessionId || !action) return null;
  return { sessionId, action };
}

function scopeLabel(scope) {
  if (scope === 'entity') return 'Entity';
  if (scope === 'board') return 'Board Portal';
  if (scope === 'admin') return 'Admin Portal';
  return scope;
}

function entityAudienceLabel(value) {
  if (value === 'executives') return 'Entity executives';
  if (value === 'volunteers') return 'Entity volunteers';
  if (value === 'both') return 'Executives + volunteers';
  return 'Neither';
}

function entityOptions(session) {
  const allowed = new Set(session.allowedEntityKeys || []);
  return (session.entities || [])
    .filter((entity) => allowed.has(entity.key))
    .map((entity) => ({
      label: entity.name,
      value: entity.key,
      default: (session.entityKeys || []).includes(entity.key),
    }));
}

function roleOptions(session) {
  const selected = new Set(session.roleNames || []);
  const orgRoleNames = new Set([
    'Executive',
    'Volunteer',
    'Member of Board',
    'Chairperson',
    'Admin',
  ]);

  return (session.audienceRoles || []).slice(0, 25).map((name) => ({
    label: name,
    value: name,
    description: orgRoleNames.has(name) ? 'Organisational role' : 'Position role',
    default: selected.has(name),
  }));
}

function setupSummary(session, warning = '') {
  const entityText = session.entityKeys?.length ? session.entityKeys.join(', ') : 'None selected';
  const roleText = session.roleNames?.length ? session.roleNames.join(', ') : 'None selected';
  const memberText = session.memberIds?.length ? `${session.memberIds.length} selected` : 'None selected';
  const warningText = warning ? `\n\n⚠️ ${warning}` : '';

  return [
    '**Create managed channel**',
    `**Owner:** ${scopeLabel(session.scope)}`,
    `**Entities:** ${entityText}`,
    `**Entity audience:** ${entityAudienceLabel(session.entityAudience)}`,
    `**Additional roles:** ${roleText}`,
    `**Specific people:** ${memberText}`,
    `**Audience access:** ${session.readOnly ? 'Read-only' : 'Read + write'}`,
    '',
    'Use the menus below, then press **Continue** to enter the channel name.',
    'Additional roles are global. For example, selecting **CEO/EP** gives every member with the CEO/EP role access.',
  ].join('\n') + warningText;
}

function setupComponents(session) {
  const rows = [];
  const entities = entityOptions(session);

  if (entities.length) {
    rows.push({
      type: COMPONENT_ACTION_ROW,
      components: [{
        type: COMPONENT_STRING_SELECT,
        custom_id: customId(session.id, 'entities'),
        placeholder: session.scope === 'entity'
          ? 'Choose the entity that owns this channel'
          : 'Optional: choose audience entities',
        min_values: session.scope === 'entity' ? 1 : 0,
        max_values: session.scope === 'entity' ? 1 : Math.min(entities.length, 16),
        options: entities,
      }],
    });
  }

  rows.push({
    type: COMPONENT_ACTION_ROW,
    components: [{
      type: COMPONENT_STRING_SELECT,
      custom_id: customId(session.id, 'entityaud'),
      placeholder: 'Entity-team audience',
      min_values: 1,
      max_values: 1,
      options: [
        { label: 'Executives', value: 'executives', default: session.entityAudience === 'executives' },
        { label: 'Volunteers', value: 'volunteers', default: session.entityAudience === 'volunteers' },
        { label: 'Executives + Volunteers', value: 'both', default: session.entityAudience === 'both' },
        { label: 'Neither — roles/people only', value: 'none', default: session.entityAudience === 'none' },
      ],
    }],
  });

  rows.push({
    type: COMPONENT_ACTION_ROW,
    components: [{
      type: COMPONENT_STRING_SELECT,
      custom_id: customId(session.id, 'roles'),
      placeholder: 'Optional: add Board/Admin/position roles',
      min_values: 0,
      max_values: Math.min((session.audienceRoles || []).length, 10),
      options: roleOptions(session),
    }],
  });

  rows.push({
    type: COMPONENT_ACTION_ROW,
    components: [{
      type: COMPONENT_USER_SELECT,
      custom_id: customId(session.id, 'members'),
      placeholder: 'Optional: add specific verified people',
      min_values: 0,
      max_values: 10,
    }],
  });

  rows.push({
    type: COMPONENT_ACTION_ROW,
    components: [
      {
        type: COMPONENT_BUTTON,
        custom_id: customId(session.id, 'rw'),
        label: 'Read + write',
        style: session.readOnly ? BUTTON_SECONDARY : BUTTON_SUCCESS,
      },
      {
        type: COMPONENT_BUTTON,
        custom_id: customId(session.id, 'ro'),
        label: 'Read-only',
        style: session.readOnly ? BUTTON_SUCCESS : BUTTON_SECONDARY,
      },
      {
        type: COMPONENT_BUTTON,
        custom_id: customId(session.id, 'continue'),
        label: 'Continue',
        style: BUTTON_PRIMARY,
      },
      {
        type: COMPONENT_BUTTON,
        custom_id: customId(session.id, 'cancel'),
        label: 'Cancel',
        style: BUTTON_DANGER,
      },
    ],
  });

  if (rows.length > 5) {
    throw new ChannelWizardError('This guided setup has too many controls for Discord.');
  }

  return rows;
}

function updateResponse(session, warning = '') {
  return {
    type: RESPONSE_UPDATE_MESSAGE,
    data: {
      content: setupSummary(session, warning),
      components: setupComponents(session),
    },
  };
}

function modalResponse(session) {
  return {
    type: RESPONSE_MODAL,
    data: {
      custom_id: customId(session.id, 'name'),
      title: `Create ${scopeLabel(session.scope)} channel`.slice(0, 45),
      components: [{
        type: COMPONENT_ACTION_ROW,
        components: [{
          type: COMPONENT_TEXT_INPUT,
          custom_id: 'channel_name',
          label: 'Channel name',
          style: 1,
          min_length: 1,
          max_length: 90,
          required: true,
          placeholder: 'e.g. board-ceo-portal',
        }],
      }],
    },
  };
}

function modalTextValue(data, customIdValue) {
  for (const row of data?.components || []) {
    for (const component of row.components || []) {
      if (component.custom_id === customIdValue) return clean(component.value);
    }
  }
  return '';
}

function option(name, value) {
  return { name, value };
}

function creationOptions(session, channelName) {
  const includeExecutives = ['executives', 'both'].includes(session.entityAudience);
  const includeVolunteers = ['volunteers', 'both'].includes(session.entityAudience);
  const options = [
    option('scope', session.scope),
    option('name', channelName),
    option('include_executives', includeExecutives),
    option('include_volunteers', includeVolunteers),
    option('read_only', Boolean(session.readOnly)),
  ];

  if (session.scope === 'entity' && session.entityKeys?.[0]) {
    options.push(option('entity', session.entityKeys[0]));
  } else if (session.entityKeys?.length) {
    options.push(option('entities', session.entityKeys.join(',')));
  }

  if (session.roleNames?.length) options.push(option('roles', session.roleNames.join(',')));
  if (session.memberIds?.length) options.push(option('members', session.memberIds.join(',')));

  return options;
}

export async function startChannelWizard({ guildId, userId, memberRoleIds, token }) {
  if (!guildId || !userId) throw new ChannelWizardError('Could not resolve your Discord server membership.');

  await pruneExpiredSessions();
  const context = await buildCreationContext({ guildId, userId, memberRoleIds, token });
  const id = crypto.randomBytes(9).toString('base64url');
  const session = {
    id,
    guildId: String(guildId),
    userId: String(userId),
    expiresAt: Date.now() + SESSION_TTL_MS,
    scopes: context.scopes,
    entities: context.config.entities || [],
    entityKeysByScope: context.entityKeysByScope,
    audienceRoles: context.audienceRoles,
    scope: null,
    allowedEntityKeys: [],
    entityKeys: [],
    entityAudience: 'executives',
    roleNames: [],
    memberIds: [],
    readOnly: false,
  };

  await writeSession(session);

  return {
    type: RESPONSE_MESSAGE,
    data: {
      content: '**Create managed channel**\nChoose who owns the channel. The rest of the setup will be guided.',
      flags: EPHEMERAL,
      components: [{
        type: COMPONENT_ACTION_ROW,
        components: [{
          type: COMPONENT_STRING_SELECT,
          custom_id: customId(id, 'scope'),
          placeholder: 'Choose channel owner',
          min_values: 1,
          max_values: 1,
          options: context.scopes.map((scope) => ({ label: scopeLabel(scope), value: scope })),
        }],
      }],
    },
  };
}

export async function handleChannelWizardComponent({ guildId, userId, data }) {
  const parsed = parseCustomId(data?.custom_id);
  if (!parsed) throw new ChannelWizardError('Unknown channel setup control.');

  const session = await readSession(parsed.sessionId, guildId, userId);
  const values = (data?.values || []).map(clean).filter(Boolean);

  if (parsed.action === 'scope') {
    const scope = values[0];
    if (!session.scopes.includes(scope)) {
      throw new ChannelWizardError('You are not allowed to create that type of channel.');
    }
    session.scope = scope;
    session.allowedEntityKeys = session.entityKeysByScope[scope] || [];
    session.entityKeys = [];
    session.entityAudience = 'executives';
    session.roleNames = [];
    session.memberIds = [];
    session.readOnly = false;
    await writeSession(session);
    return updateResponse(session);
  }

  if (!session.scope) {
    throw new ChannelWizardError('Choose the channel owner first.');
  }

  if (parsed.action === 'entities') {
    const allowed = new Set(session.allowedEntityKeys || []);
    if (values.some((value) => !allowed.has(value))) {
      throw new ChannelWizardError('One or more selected entities are outside your allowed scope.');
    }
    if (session.scope === 'entity' && values.length !== 1) {
      throw new ChannelWizardError('Entity channels must belong to exactly one entity.');
    }
    session.entityKeys = [...new Set(values)];
  } else if (parsed.action === 'entityaud') {
    const value = values[0];
    if (!['executives', 'volunteers', 'both', 'none'].includes(value)) {
      throw new ChannelWizardError('Invalid entity audience selection.');
    }
    session.entityAudience = value;
  } else if (parsed.action === 'roles') {
    const allowed = new Set(session.audienceRoles || []);
    if (values.some((value) => !allowed.has(value))) {
      throw new ChannelWizardError('One or more selected roles cannot be used as a channel audience.');
    }
    session.roleNames = [...new Set(values)];
  } else if (parsed.action === 'members') {
    session.memberIds = [...new Set(values.filter((value) => value !== String(userId)))].slice(0, 10);
  } else if (parsed.action === 'rw') {
    session.readOnly = false;
  } else if (parsed.action === 'ro') {
    session.readOnly = true;
  } else if (parsed.action === 'cancel') {
    await deleteSession(session.id);
    return {
      type: RESPONSE_UPDATE_MESSAGE,
      data: { content: 'Channel setup cancelled.', components: [] },
    };
  } else if (parsed.action === 'continue') {
    if (session.scope === 'entity' && session.entityKeys.length !== 1) {
      return updateResponse(session, 'Choose the entity that owns this channel before continuing.');
    }

    if (
      session.scope === 'board' &&
      !session.entityKeys.length &&
      !session.roleNames.length &&
      !session.memberIds.length
    ) {
      return updateResponse(session, 'Choose at least one entity, role, or person for this Board portal.');
    }

    await writeSession(session);
    return modalResponse(session);
  } else {
    throw new ChannelWizardError('Unknown channel setup action.');
  }

  await writeSession(session);
  return updateResponse(session);
}

export async function handleChannelWizardModal({ guildId, userId, data, memberRoleIds, token }) {
  const parsed = parseCustomId(data?.custom_id);
  if (!parsed || parsed.action !== 'name') {
    throw new ChannelWizardError('Unknown channel setup form.');
  }

  const session = await readSession(parsed.sessionId, guildId, userId);
  const channelName = modalTextValue(data, 'channel_name');
  if (!channelName) throw new ChannelWizardError('Channel name is required.');

  try {
    const result = await handleChannelCommand({
      guildId,
      userId,
      memberRoleIds,
      subcommand: 'create',
      options: creationOptions(session, channelName),
      token,
    });

    await deleteSession(session.id);
    return {
      type: RESPONSE_MESSAGE,
      data: {
        content: result.message,
        flags: EPHEMERAL,
      },
    };
  } catch (err) {
    return {
      type: RESPONSE_MESSAGE,
      data: {
        content: `${channelCommandErrorMessage(err)}\n\nReturn to the setup message to adjust the options and try again.`,
        flags: EPHEMERAL,
      },
    };
  }
}

export function channelWizardErrorMessage(err) {
  if (err?.userSafe) return err.message;
  return 'Could not continue the guided channel setup. Please contact an admin if the problem continues.';
}

export function isChannelWizardCustomId(value) {
  return clean(value).startsWith(`${CUSTOM_PREFIX}:`);
}
