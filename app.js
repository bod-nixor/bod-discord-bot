import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import fetch from 'node-fetch';
import { execFile } from 'child_process';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';
import { reconcileV2Verification } from './lib/verification-v2.js';
import { channelCommandErrorMessage, handleChannelCommand } from './lib/channel-spaces.js';

const GOOGLE_AUTH_SCOPES = ['openid', 'email', 'profile'];
const GOOGLE_REDIRECT_URI = 'https://discord.nixorcorporate.com/auth/callback';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const DISCORD_MESSAGE_LIMIT = 2000;
const SCRIPT_CONFIG_PATH = path.resolve(process.cwd(), 'config', 'scripts.json');
let scriptConfigWriteLock = Promise.resolve();

const getStateSecret = () => {
  const secret = process.env.OAUTH_STATE_SECRET;

  if (!secret) {
    console.error('Missing OAUTH_STATE_SECRET');
  }

  return secret;
};

const signOAuthState = (encodedPayload) => {
  const secret = getStateSecret();

  if (!secret) {
    return null;
  }

  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
};

const verifyOAuthState = (state) => {
  const secret = getStateSecret();

  if (!secret) {
    return { valid: false, reason: 'Missing state secret' };
  }

  if (!state.includes('.')) {
    return { valid: false, reason: 'Malformed state' };
  }

  const [encodedPayload, providedSignature] = state.split('.');

  if (!encodedPayload || !providedSignature) {
    return { valid: false, reason: 'Incomplete state' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  const signaturesMatch =
    providedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));

  if (!signaturesMatch) {
    return { valid: false, reason: 'State signature mismatch' };
  }

  let payload;

  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (err) {
    console.error('Failed to parse verified state payload:', err);
    return { valid: false, reason: 'Invalid state payload' };
  }

  if (!payload.userId || !payload.guildId) {
    return { valid: false, reason: 'State missing Discord context' };
  }

  if (!payload.exp || Date.now() > payload.exp) {
    return { valid: false, reason: 'State expired' };
  }

  return { valid: true, payload };
};

const truncateMessage = (message) => {
  if (!message) {
    return '';
  }
  if (message.length <= DISCORD_MESSAGE_LIMIT) {
    return message;
  }
  const suffix = '\n...(truncated)';
  return `${message.slice(0, DISCORD_MESSAGE_LIMIT - suffix.length)}${suffix}`;
};

const loadScriptConfig = async () => {
  try {
    const rawConfig = await fs.readFile(SCRIPT_CONFIG_PATH, 'utf8');
    return JSON.parse(rawConfig);
  } catch (err) {
    console.error('Failed to load script config:', err);
    return null;
  }
};

const withScriptConfigLock = async (fn) => {
  const release = scriptConfigWriteLock;
  let releaseNext;
  scriptConfigWriteLock = new Promise((resolve) => {
    releaseNext = resolve;
  });
  await release;
  try {
    return await fn();
  } finally {
    releaseNext();
  }
};

const writeScriptConfig = async (config) => {
  await fs.mkdir(path.dirname(SCRIPT_CONFIG_PATH), { recursive: true });
  const tempPath = `${SCRIPT_CONFIG_PATH}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, SCRIPT_CONFIG_PATH);
};

const parseCsvList = (value) => {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const resolveScriptPath = (scriptsDir, scriptName) => {
  const resolved = path.resolve(scriptsDir, scriptName);
  const relative = path.relative(scriptsDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
};

const getOptionValue = (options, optionName) =>
  options?.find((option) => option.name === optionName)?.value;

const ensureGuildContext = (guildId, res) => {
  if (guildId) {
    return true;
  }
  res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: 'This command can only be used in a server.',
      flags: InteractionResponseFlags.EPHEMERAL,
    },
  });
  return false;
};

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
// To keep track of our active games
const activeGames = {};

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;
    const { guild_id: guildId, member } = req.body;

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    if (name === 'execute') {
      const { token } = req.body;
      if (!ensureGuildContext(guildId, res)) {
        return;
      }
      const scriptKey = getOptionValue(data.options, 'name');
      if (!scriptKey) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Missing script name.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const scriptConfig = await loadScriptConfig();
      if (!scriptConfig?.commands) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Script configuration is unavailable.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const commandConfig = scriptConfig.commands[scriptKey];
      if (!commandConfig) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `Unknown script "${scriptKey}".`,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      if (commandConfig.allowed_guilds?.length && !commandConfig.allowed_guilds.includes(guildId)) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '⛔ Not authorized for this server.', flags: InteractionResponseFlags.EPHEMERAL },
        });
      }

      const memberRoles = member?.roles ?? [];
      const allowedRoles = commandConfig.allowed_roles ?? [];
      const hasAccess = allowedRoles.some((roleId) => memberRoles.includes(roleId));

      if (!hasAccess) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '⛔ You are not authorized to run this script.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      if (!scriptConfig.scripts_dir) {
        console.error('Script configuration missing scripts_dir.');
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Script configuration is missing scripts_dir.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
      const scriptsDir = scriptConfig.scripts_dir;
      if (commandConfig.script?.includes('/') || commandConfig.script?.includes('\\')) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Invalid script configuration.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
      const scriptPath = resolveScriptPath(scriptsDir, commandConfig.script);

      if (!commandConfig.script || !scriptPath) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Invalid script configuration.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const responseFlags = commandConfig.ephemeral ? InteractionResponseFlags.EPHEMERAL : undefined;
      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `Running ${scriptKey}...`,
          ...(responseFlags ? { flags: responseFlags } : {}),
        },
      });

      const timeoutMs = Number(commandConfig.timeout_ms) || DEFAULT_EXEC_TIMEOUT_MS;
      execFile(
        scriptPath,
        { timeout: timeoutMs, encoding: 'utf8' },
        async (error, stdout, stderr) => {
          let message;
          if (error) {
            console.error(`Script execution failed for ${scriptKey}:`, error);
            const errorDetails = stderr?.trim() || error.message || 'Unknown error';
            message = `❌ ${scriptKey} failed.\n${errorDetails}`;
          } else {
            const output = stdout?.trim() || 'Command completed successfully.';
            message = `✅ ${scriptKey} completed.\n${output}`;
          }

          try {
            await DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, {
              method: 'PATCH',
              body: { content: truncateMessage(message) },
            });
          } catch (err) {
            console.error('Failed to update script execution response:', err);
          }
        }
      );
      return;
    }

    if (name === 'admin-script') {
      if (!ensureGuildContext(guildId, res)) {
        return;
      }
      const subcommand = data.options?.[0];
      const subcommandName = subcommand?.name;
      const options = subcommand?.options ?? [];

      const scriptConfig = await loadScriptConfig();
      if (!scriptConfig) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Script configuration is unavailable.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const superAdminRoles = scriptConfig.super_admin_roles ?? [];
      const memberRoles = member?.roles ?? [];
      const isSuperAdmin = superAdminRoles.some((roleId) => memberRoles.includes(roleId));

      if (!isSuperAdmin) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '⛔ You are not authorized to manage scripts.', flags: InteractionResponseFlags.EPHEMERAL },
        });
      }

      if (!subcommandName) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: 'Missing subcommand.', flags: InteractionResponseFlags.EPHEMERAL },
        });
      }

      return withScriptConfigLock(async () => {
        const latestConfig = (await loadScriptConfig()) || scriptConfig;
        latestConfig.commands = latestConfig.commands ?? {};
        let responseMessage = '';

        if (subcommandName === 'list') {
          const filter = getOptionValue(options, 'filter');
          const entries = Object.entries(latestConfig.commands).filter(([key]) =>
            filter ? key.includes(filter) : true
          );
          if (!entries.length) {
            responseMessage = 'No scripts configured.';
          } else {
            responseMessage = entries
              .map(([key, value]) => `• ${key} — ${value.description || 'No description'}`)
              .join('\n');
          }
        } else if (subcommandName === 'delete') {
          const nameValue = getOptionValue(options, 'name');
          if (!nameValue) {
            responseMessage = 'Missing script name.';
          } else if (!latestConfig.commands[nameValue]) {
            responseMessage = `Script "${nameValue}" does not exist.`;
          } else {
            delete latestConfig.commands[nameValue];
            await writeScriptConfig(latestConfig);
            responseMessage = `Deleted script "${nameValue}".`;
          }
        } else if (subcommandName === 'add' || subcommandName === 'update') {
          const nameValue = getOptionValue(options, 'name');
          if (!nameValue) {
            responseMessage = 'Missing script name.';
          } else if (subcommandName === 'add' && latestConfig.commands[nameValue]) {
            responseMessage = `Script "${nameValue}" already exists.`;
          } else if (subcommandName === 'update' && !latestConfig.commands[nameValue]) {
            responseMessage = `Script "${nameValue}" does not exist.`;
          } else {
            const scriptValue = getOptionValue(options, 'script');
            const allowedRolesValue = getOptionValue(options, 'allowed_roles');
            const allowedGuildsValue = getOptionValue(options, 'allowed_guilds');
            const ephemeralValue = getOptionValue(options, 'ephemeral');
            const descriptionValue = getOptionValue(options, 'description');
            const timeoutValue = getOptionValue(options, 'timeout_ms');

            if (subcommandName === 'add' && !scriptValue) {
              responseMessage = 'Missing script filename.';
            } else if (scriptValue && (scriptValue.includes('/') || scriptValue.includes('\\'))) {
              responseMessage = 'Script filename must not include path separators.';
            } else if (scriptValue && !scriptValue.endsWith('.sh')) {
              responseMessage = 'Script filename must end with .sh.';
            } else {
              const parsedRoles = allowedRolesValue ? parseCsvList(allowedRolesValue) : null;
              if (subcommandName === 'add' && (!parsedRoles || !parsedRoles.length)) {
                responseMessage = 'allowed_roles must be a comma-separated list of role IDs.';
              } else if (parsedRoles && !parsedRoles.length) {
                responseMessage = 'allowed_roles must be a comma-separated list of role IDs.';
              } else {
                const parsedGuilds = allowedGuildsValue ? parseCsvList(allowedGuildsValue) : null;
                if (allowedGuildsValue && parsedGuilds && !parsedGuilds.length) {
                  responseMessage = 'allowed_guilds must be a comma-separated list of guild IDs.';
                } else if (
                  timeoutValue !== undefined &&
                  (!Number.isInteger(timeoutValue) || timeoutValue <= 0)
                ) {
                  responseMessage = 'timeout_ms must be a positive integer.';
                } else {
                  const existing = latestConfig.commands[nameValue] ?? {};
                  const updated = {
                    ...existing,
                    ...(descriptionValue !== undefined ? { description: descriptionValue } : {}),
                    ...(scriptValue ? { script: scriptValue } : {}),
                    ...(parsedRoles ? { allowed_roles: parsedRoles } : {}),
                    ...(parsedGuilds ? { allowed_guilds: parsedGuilds } : {}),
                    ...(ephemeralValue !== undefined ? { ephemeral: Boolean(ephemeralValue) } : {}),
                    ...(timeoutValue !== undefined ? { timeout_ms: timeoutValue } : {}),
                  };

                  latestConfig.commands[nameValue] = updated;
                  await writeScriptConfig(latestConfig);
                  responseMessage =
                    subcommandName === 'add'
                      ? `Added script "${nameValue}".`
                      : `Updated script "${nameValue}".`;
                }
              }
            }
          }
        } else {
          responseMessage = `Unknown subcommand "${subcommandName}".`;
        }

        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: truncateMessage(responseMessage),
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      });
    }

    if (name === 'channel') {
      if (!ensureGuildContext(guildId, res)) {
        return;
      }

      const subcommand = data.options?.[0];
      const userId = member?.user?.id;

      try {
        const result = await handleChannelCommand({
          guildId,
          userId,
          memberRoleIds: member?.roles ?? [],
          subcommand: subcommand?.name,
          options: subcommand?.options ?? [],
          token: process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN,
        });

        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: result.message,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      } catch (err) {
        console.error('Managed channel command failed:', err);
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: channelCommandErrorMessage(err),
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
    }

    if (name === 'setup-verification') {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'Click the button below to verify yourself.',
          components: [
            {
              type: MessageComponentTypes.ACTION_ROW,
              components: [
                {
                  type: MessageComponentTypes.BUTTON,
                  style: ButtonStyleTypes.PRIMARY,
                  label: 'Login with your Nixor Account',
                  custom_id: 'verify_google_init',
                },
              ],
            },
          ],
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id: customId } = data;
    const { member, guild_id: guildId } = req.body;

    if (customId === 'verify_google_init') {
      const userId = member?.user?.id;
      const payload = JSON.stringify({
        userId,
        guildId,
        exp: Date.now() + OAUTH_STATE_TTL_MS,
        nonce: crypto.randomBytes(16).toString('base64url'),
      });

      const encodedPayload = Buffer.from(payload).toString('base64url');
      const signature = signOAuthState(encodedPayload);

      if (!signature) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Verification is not available right now. Please contact an admin.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const statePayload = `${encodedPayload}.${signature}`;

      const oauthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      oauthUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
      oauthUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
      oauthUrl.searchParams.set('response_type', 'code');
      oauthUrl.searchParams.set('scope', GOOGLE_AUTH_SCOPES.join(' '));
      oauthUrl.searchParams.set('state', statePayload);

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `Click here to verify: ${oauthUrl.toString()}`,
          flags: InteractionResponseFlags.EPHEMERAL,
        },
      });
    }

    console.error(`unknown component: ${customId}`);
    return res.status(400).json({ error: 'unknown component' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send('Missing code or state.');
  }

  const stateValidation = verifyOAuthState(state);

  if (!stateValidation.valid) {
    console.error('Invalid OAuth state:', stateValidation.reason);
    return res.status(400).send('Invalid or expired state.');
  }

  const { userId, guildId } = stateValidation.payload;

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('Google token error:', tokenData);
      return res.status(500).send('Failed to verify with Google.');
    }

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userInfo = await userInfoResponse.json();

    if (!userInfoResponse.ok || !userInfo.email) {
      console.error('Failed to fetch Google user info:', userInfo);
      return res.status(500).send('Failed to fetch Google profile.');
    }

    const sheetResponse = await fetch(
      `${process.env.SCRIPT_API_URL}?email=${encodeURIComponent(userInfo.email)}&serverId=${encodeURIComponent(
        guildId
      )}`
    );
    const sheetData = await sheetResponse.json();

    if (!sheetResponse.ok || sheetData?.found === false) {
      return res.send('<html><body>Email not found in database.</body></html>');
    }

    // Schema v2 is explicitly opt-in. Legacy responses continue through the
    // original nicknamePrefix + roleId implementation below unchanged.
    if (Number(sheetData?.schemaVersion) === 2) {
      const v2Token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
      const result = await reconcileV2Verification({
        guildId,
        userId,
        sheetData,
        token: v2Token,
      });

      const redactedUserId =
        process.env.NODE_ENV === 'production'
          ? crypto.createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 8)
          : userId || 'unknown';
      console.log(
        `V2 verification reconciled for user ${redactedUserId} in guild ${guildId}: ` +
          `${result.rolesAdded} role(s) added, ${result.rolesRemoved} removed.`,
      );

      return res.send('<html><body>Verification Successful! You can close this.</body></html>');
    }

    const authHeader = `Bot ${process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN}`;

    if (sheetData.name) {
      const nicknamePrefix = sheetData.nicknamePrefix ?? '';
      let fullNickname = `${nicknamePrefix ? `${nicknamePrefix} ` : ''}${sheetData.name}`;

      if (fullNickname.length > 32) {
        fullNickname = fullNickname.substring(0, 32);
      }

      const nicknameResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nick: fullNickname }),
      });

      if (!nicknameResponse.ok) {
        console.error('Failed to update nickname:', await nicknameResponse.text());
      }
    }

    const redactedUserId =
      process.env.NODE_ENV === 'production'
        ? crypto.createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 8)
        : userId || 'unknown';

    if (sheetData.roleId) {
      const roleResponse = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${sheetData.roleId}`,
        {
        method: 'PUT',
        headers: { Authorization: authHeader },
        }
      );

      if (!roleResponse.ok) {
        console.error(
          `Failed to assign role for user ${redactedUserId} in guild ${guildId}:`,
          await roleResponse.text()
        );
      }
    } else {
      console.warn(
        `No roleId provided for user ${redactedUserId} in guild ${guildId}; skipping role assignment.`
      );
    }

    return res.send('<html><body>Verification Successful! You can close this.</body></html>');
  } catch (err) {
    console.error('Verification flow failed:', err);
    return res.status(500).send('An error occurred during verification.');
  }
});

const startServer = async () => {
  const config = await loadScriptConfig();
  if (!config) {
    console.warn('Script configuration unavailable at startup; /execute and /admin-script commands will fail.');
  } else if (!config.scripts_dir) {
    console.error('Script configuration missing scripts_dir; exiting.');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log('Listening on port', PORT);
  });
};

startServer();