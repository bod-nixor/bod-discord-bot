import fs from 'fs/promises';

async function read(path) {
  return fs.readFile(path, 'utf8');
}

async function write(path, value) {
  await fs.writeFile(path, value, 'utf8');
}

function replaceOnce(source, oldValue, newValue, label) {
  if (!source.includes(oldValue)) {
    throw new Error(`Could not patch ${label}: expected source block not found.`);
  }
  return source.replace(oldValue, newValue);
}

async function patchChannelSpaces() {
  const target = 'lib/channel-spaces.js';
  let source = await read(target);
  if (source.includes('export function allowedAudienceRoleNames(config)')) {
    console.log(`${target}: already patched.`);
    return;
  }

  source = replaceOnce(
    source,
    `function requireRole(roleMap, name) {\n  const role = roleMap.get(name);\n  if (!role) {\n    throw new ChannelSpaceError(\`Server setup is incomplete. Missing role: \${name}.\`);\n  }\n  return role;\n}\n`,
    `function requireRole(roleMap, name) {\n  const role = roleMap.get(name);\n  if (!role) {\n    throw new ChannelSpaceError(\`Server setup is incomplete. Missing role: \${name}.\`);\n  }\n  return role;\n}\n\nexport function allowedAudienceRoleNames(config) {\n  return [...new Set([\n    config.roles.executive,\n    config.roles.volunteer,\n    config.roles.memberOfBoard,\n    config.roles.chairperson,\n    config.roles.admin,\n    ...(config.positions || []),\n  ].map(clean).filter(Boolean))];\n}\n\nfunction parseAudienceRoleNames(value, config) {\n  if (!value) return [];\n  const allowed = new Set(allowedAudienceRoleNames(config));\n  const result = [];\n  const seen = new Set();\n\n  for (const raw of String(value).split(',')) {\n    const name = clean(raw);\n    if (!name) continue;\n    if (!allowed.has(name)) {\n      throw new ChannelSpaceError(\`Role cannot be used as a managed channel audience: \${name}.\`);\n    }\n    if (!seen.has(name)) {\n      seen.add(name);\n      result.push(name);\n    }\n  }\n\n  return result;\n}\n`,
    target,
  );

  source = replaceOnce(
    source,
    `function metadataTopic({ scope, ownerId, entities, readOnly }) {\n  const payload = {\n    scope,\n    ownerId: String(ownerId),\n    entities: entities.map((entity) => entity.key),\n    readOnly: Boolean(readOnly),\n    createdAt: new Date().toISOString(),\n  };\n`,
    `function metadataTopic({ scope, ownerId, entities, audienceRoles, readOnly }) {\n  const payload = {\n    scope,\n    ownerId: String(ownerId),\n    entities: entities.map((entity) => entity.key),\n    roles: audienceRoles,\n    readOnly: Boolean(readOnly),\n    createdAt: new Date().toISOString(),\n  };\n`,
    target,
  );

  source = replaceOnce(
    source,
    `function describeAudience({ selectedEntities, includeExecutives, includeVolunteers, explicitMemberIds }) {\n  const pieces = [];\n`,
    `function describeAudience({\n  selectedEntities,\n  includeExecutives,\n  includeVolunteers,\n  audienceRoleNames,\n  explicitMemberIds,\n}) {\n  const pieces = [];\n`,
    target,
  );

  source = replaceOnce(
    source,
    `  if (explicitMemberIds.length) pieces.push(\`\${explicitMemberIds.length} selected member(s)\`);\n  return pieces.length ? pieces.join('; ') : 'private';\n}\n`,
    `  if (audienceRoleNames.length) pieces.push(\`roles: \${audienceRoleNames.join(', ')}\`);\n  if (explicitMemberIds.length) pieces.push(\`\${explicitMemberIds.length} selected member(s)\`);\n  return pieces.length ? pieces.join('; ') : 'private';\n}\n`,
    target,
  );

  source = replaceOnce(
    source,
    `  const entitiesValue = clean(optionValue(options, 'entities'));\n  const membersValue = clean(optionValue(options, 'members'));\n`,
    `  const entitiesValue = clean(optionValue(options, 'entities'));\n  const rolesValue = clean(optionValue(options, 'roles'));\n  const membersValue = clean(optionValue(options, 'members'));\n`,
    target,
  );

  source = replaceOnce(
    source,
    `  const isBoard = callerRoleNames.has(config.roles.memberOfBoard);\n  const audienceAccess = readOnly ? READ_ACCESS : WRITE_ACCESS;\n\n  let category;\n`,
    `  const isBoard = callerRoleNames.has(config.roles.memberOfBoard);\n  const audienceAccess = readOnly ? READ_ACCESS : WRITE_ACCESS;\n  const selectedAudienceRoles = parseAudienceRoleNames(rolesValue, config);\n\n  let category;\n`,
    target,
  );

  source = replaceOnce(
    source,
    `  let callerCanInviteAcrossEntities = isAdmin || isChair;\n  const overwrites = [roleOverwrite(guildId, 0n, BASE_DENY)];\n\n  if (scope === 'entity') {\n`,
    `  let callerCanInviteAcrossEntities = isAdmin || isChair;\n  const overwrites = [roleOverwrite(guildId, 0n, BASE_DENY)];\n\n  // Additional role audiences are intentionally global. For example, CEO/EP\n  // means every verified member holding the global CEO/EP role. Entity-specific\n  // audiences continue to use the scoped Executive/Volunteer role families.\n  for (const roleName of selectedAudienceRoles) {\n    overwrites.push(roleOverwrite(requireRole(roleMap, roleName).id, audienceAccess, 0n));\n  }\n\n  if (scope === 'entity') {\n`,
    target,
  );

  source = replaceOnce(
    source,
    `      if (!selectedEntities.length && !explicitMemberIds.length) {\n        throw new ChannelSpaceError('No assigned Board entities were found for your account.');\n      }\n`,
    `      if (!selectedEntities.length && !explicitMemberIds.length && !selectedAudienceRoles.length) {\n        throw new ChannelSpaceError('Choose at least one assigned entity, role, or person for this Board portal.');\n      }\n`,
    target,
  );

  source = replaceOnce(
    source,
    `      topic: metadataTopic({ scope, ownerId: userId, entities: selectedEntities, readOnly }),\n`,
    `      topic: metadataTopic({\n        scope,\n        ownerId: userId,\n        entities: selectedEntities,\n        audienceRoles: selectedAudienceRoles,\n        readOnly,\n      }),\n`,
    target,
  );

  source = replaceOnce(
    source,
    `      \`Audience: \${describeAudience({ selectedEntities, includeExecutives, includeVolunteers, explicitMemberIds })}\` +\n`,
    `      \`Audience: \${describeAudience({\n        selectedEntities,\n        includeExecutives,\n        includeVolunteers,\n        audienceRoleNames: selectedAudienceRoles,\n        explicitMemberIds,\n      })}\` +\n`,
    target,
  );

  await write(target, source);
  console.log(`${target}: patched role audiences.`);
}

async function patchCommands() {
  const target = 'commands.js';
  let source = await read(target);
  const start = source.indexOf('const CHANNEL_COMMAND = {');
  const end = source.indexOf('const SETUP_VERIFICATION = {', start);
  if (start < 0 || end < 0) throw new Error(`Could not patch ${target}: channel command markers not found.`);

  const replacement = `const CHANNEL_COMMAND = {\n  name: 'channel',\n  description: 'Create and manage private Corporate channels',\n  type: 1,\n  integration_types: [0],\n  contexts: [0],\n  options: [\n    {\n      type: 1,\n      name: 'create',\n      description: 'Open the guided channel setup',\n    },\n  ],\n};\n\n`;

  source = source.slice(0, start) + replacement + source.slice(end);
  await write(target, source);
  console.log(`${target}: replaced command options with guided setup.`);
}

async function patchApp() {
  const target = 'app.js';
  let source = await read(target);
  if (source.includes("from './lib/channel-wizard.js'")) {
    console.log(`${target}: already patched.`);
    return;
  }

  source = replaceOnce(
    source,
    `import { channelCommandErrorMessage, handleChannelCommand } from './lib/channel-spaces.js';\n`,
    `import {\n  channelWizardErrorMessage,\n  handleChannelWizardComponent,\n  handleChannelWizardModal,\n  isChannelWizardCustomId,\n  startChannelWizard,\n} from './lib/channel-wizard.js';\n`,
    target,
  );

  const channelStart = source.indexOf("    if (name === 'channel') {");
  const setupStart = source.indexOf("    if (name === 'setup-verification') {", channelStart);
  if (channelStart < 0 || setupStart < 0) {
    throw new Error(`Could not patch ${target}: channel handler markers not found.`);
  }

  const channelHandler = `    if (name === 'channel') {\n      if (!ensureGuildContext(guildId, res)) {\n        return;\n      }\n\n      const subcommand = data.options?.[0];\n      if (subcommand?.name !== 'create') {\n        return res.send({\n          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n          data: {\n            content: 'Unknown channel action.',\n            flags: InteractionResponseFlags.EPHEMERAL,\n          },\n        });\n      }\n\n      try {\n        const response = await startChannelWizard({\n          guildId,\n          userId: member?.user?.id,\n          memberRoleIds: member?.roles ?? [],\n          token: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN,\n        });\n        return res.send(response);\n      } catch (err) {\n        console.error('Could not start channel wizard:', err);\n        return res.send({\n          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n          data: {\n            content: channelWizardErrorMessage(err),\n            flags: InteractionResponseFlags.EPHEMERAL,\n          },\n        });\n      }\n    }\n\n`;

  source = source.slice(0, channelStart) + channelHandler + source.slice(setupStart);

  source = replaceOnce(
    source,
    `    const { custom_id: customId } = data;\n    const { member, guild_id: guildId } = req.body;\n\n    if (customId === 'verify_google_init') {\n`,
    `    const { custom_id: customId } = data;\n    const { member, guild_id: guildId } = req.body;\n\n    if (isChannelWizardCustomId(customId)) {\n      try {\n        const response = await handleChannelWizardComponent({\n          guildId,\n          userId: member?.user?.id,\n          data,\n        });\n        return res.send(response);\n      } catch (err) {\n        console.error('Channel wizard component failed:', err);\n        return res.send({\n          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n          data: {\n            content: channelWizardErrorMessage(err),\n            flags: InteractionResponseFlags.EPHEMERAL,\n          },\n        });\n      }\n    }\n\n    if (customId === 'verify_google_init') {\n`,
    target,
  );

  source = replaceOnce(
    source,
    `  console.error('unknown interaction type', type);\n`,
    `  // Discord interaction type 5 is a modal submission. Keep this numeric so\n  // the runtime remains compatible with the currently installed interactions package.\n  if (type === 5 && isChannelWizardCustomId(data?.custom_id)) {\n    const { member, guild_id: guildId } = req.body;\n    try {\n      const response = await handleChannelWizardModal({\n        guildId,\n        userId: member?.user?.id,\n        memberRoleIds: member?.roles ?? [],\n        data,\n        token: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN,\n      });\n      return res.send(response);\n    } catch (err) {\n      console.error('Channel wizard modal failed:', err);\n      return res.send({\n        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n        data: {\n          content: channelWizardErrorMessage(err),\n          flags: InteractionResponseFlags.EPHEMERAL,\n        },\n      });\n    }\n  }\n\n  console.error('unknown interaction type', type);\n`,
    target,
  );

  await write(target, source);
  console.log(`${target}: integrated guided channel wizard.`);
}

async function patchTests() {
  const target = 'tests/channel-spaces.test.js';
  let source = await read(target);
  if (source.includes("safe global audience roles exclude Verified")) {
    console.log(`${target}: already patched.`);
    return;
  }

  source = replaceOnce(
    source,
    `import {\n  deriveBoardAssignedEntityKeys,\n`,
    `import {\n  allowedAudienceRoleNames,\n  deriveBoardAssignedEntityKeys,\n`,
    target,
  );

  source += `\n\ntest('safe global audience roles exclude Verified and include Board/position roles', () => {\n  const config = {\n    roles: {\n      verified: 'Verified',\n      executive: 'Executive',\n      volunteer: 'Volunteer',\n      memberOfBoard: 'Member of Board',\n      chairperson: 'Chairperson',\n      admin: 'Admin',\n    },\n    positions: ['CEO/EP', 'CFO'],\n  };\n\n  const roles = allowedAudienceRoleNames(config);\n  assert.equal(roles.includes('Verified'), false);\n  assert.equal(roles.includes('Member of Board'), true);\n  assert.equal(roles.includes('CEO/EP'), true);\n});\n`;

  await write(target, source);
  console.log(`${target}: added role-audience regression test.`);
}

async function main() {
  await patchChannelSpaces();
  await patchCommands();
  await patchApp();
  await patchTests();
  console.log('Guided channel wizard patch applied.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
