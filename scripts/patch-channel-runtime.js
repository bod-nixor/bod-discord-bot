import fs from 'fs/promises';
import path from 'path';

const appPath = path.resolve(process.cwd(), 'app.js');
let source = await fs.readFile(appPath, 'utf8');

const importLine = "import { reconcileV2Verification } from './lib/verification-v2.js';";
const channelImport = "import { channelCommandErrorMessage, handleChannelCommand } from './lib/channel-spaces.js';";

if (!source.includes(channelImport)) {
  if (!source.includes(importLine)) {
    throw new Error('Could not find the v2 verification import in app.js.');
  }
  source = source.replace(importLine, `${importLine}\n${channelImport}`);
}

const marker = "    if (name === 'setup-verification') {";
const handlerMarker = "    if (name === 'channel') {";

if (!source.includes(handlerMarker)) {
  if (!source.includes(marker)) {
    throw new Error('Could not find setup-verification command handler in app.js.');
  }

  const handler = `    if (name === 'channel') {\n      if (!ensureGuildContext(guildId, res)) {\n        return;\n      }\n\n      const subcommand = data.options?.[0];\n      const userId = member?.user?.id;\n\n      try {\n        const result = await handleChannelCommand({\n          guildId,\n          userId,\n          memberRoleIds: member?.roles ?? [],\n          subcommand: subcommand?.name,\n          options: subcommand?.options ?? [],\n          token: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN,\n        });\n\n        return res.send({\n          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n          data: {\n            content: result.message,\n            flags: InteractionResponseFlags.EPHEMERAL,\n          },\n        });\n      } catch (err) {\n        console.error('Managed channel command failed:', err);\n        return res.send({\n          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,\n          data: {\n            content: channelCommandErrorMessage(err),\n            flags: InteractionResponseFlags.EPHEMERAL,\n          },\n        });\n      }\n    }\n\n`;

  source = source.replace(marker, `${handler}${marker}`);
}

await fs.writeFile(appPath, source, 'utf8');
console.log('app.js channel runtime patch applied.');
