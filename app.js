import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';

const ROLE_MAP = {
  Staff: '1443010837055934474',
  Board: '1443010472474316990',
  TA: '1443010450202820699',
  Student: '1443010418942410842',
};

const GOOGLE_AUTH_SCOPES = ['openid', 'email', 'profile'];
const GOOGLE_REDIRECT_URI = 'https://discord.nixorcorporate.com/auth/callback';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

if (name === 'restart-kairos') {
      // Get the token so we can edit the message later
      const { token } = req.body;
      
      // --- SECURITY CHECK ---
      // Make sure this logic matches what worked for you (checking User ID or Role)
      const hasAccess =
        guildId === '1442961521922543750' &&
        member?.roles?.includes('1442988775268417688');

      if (!hasAccess) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'â›” You are not authorized',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      // 1. Send the IMMEDIATE public message (No Ephemeral flag)
      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'ðŸ”„ Triggering restart script...',
        },
      });

      // 2. Execute the script
      exec('/home/nixorc5/start-kairos.sh', async (error, stdout, stderr) => {
        if (error) {
          console.error('Error executing restart script:', error);
          // Optional: Edit message to show error if script fails
          return;
        }

        // 3. Script finished? Edit the original message to say Success
        try {
            await DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, {
                method: 'PATCH',
                body: {
                    content: 'ðŸ”„ Triggering restart script...\nâœ… **Restart successful!**',
                },
            });
        } catch (err) {
            console.error('Error editing interaction response:', err);
        }
      });

      return;
    }
    
    if (name === 'check-kairos') {
      const { token } = req.body;

      // --- SECURITY CHECK (Same as restart) ---
      const hasAccess =
        guildId === '1442961521922543750' &&
        member?.roles?.includes('1442988775268417688');

      if (!hasAccess) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '⛔ Not authorized.', flags: 64 },
        });
      }

      // 1. Send immediate "Thinking" message
      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '🔎 Checking system status...' },
      });

      // 2. Define the Checks
      const checkInternal = (cmd) => {
        return new Promise((resolve) => {
          exec(cmd, (error) => {
            // grep returns error code 1 if not found, 0 if found
            resolve(!error); 
          });
        });
      };

      const checkExternal = async (url) => {
        try {
          // Set a 5-second timeout so the bot doesn't hang
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          
          return response.status >= 200 && response.status < 500;
        } catch (e) {
          return false;
        }
      };

      // 3. Run all checks in parallel
      const [tunnelProcess, pythonProcess, websitePublic, socketPublic] = await Promise.all([
        checkInternal('pgrep -f "kairos-ws.yaml"'),
        checkInternal('pgrep -f "ws_server.py"'),
        // Check the signoff page
        checkExternal('https://kairos.nixorcorporate.com/signoff/'),
        // Check Socket.io specifically via polling (Works for WSS)
        checkExternal('https://kairos.nixorcorporate.com/websocket/socket.io/?EIO=4&transport=polling')
      ]);

      // 4. Format the results
      const statusMsg = [
        `**System Status Report**`,
        `---------------------------`,
        `**Internal Processes (cPanel)**`,
        `${tunnelProcess ? '✅' : '❌'} Cloudflare Tunnel (Process)`,
        `${pythonProcess ? '✅' : '❌'} Python Server (Process)`,
        ``,
        `**External Access (Public URL)**`,
        `${websitePublic ? '✅' : '❌'} Website (HTTPS)`,
        `${socketPublic ? '✅' : '❌'} Websocket (WSS/Socket.io)`,
      ].join('\n');

      // 5. Update the message
      try {
        await DiscordRequest(`webhooks/${process.env.APP_ID}/${token}/messages/@original`, {
          method: 'PATCH',
          body: { content: statusMsg },
        });
      } catch (err) {
        console.error('Failed to update status message:', err);
      }
      return;
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

    const sheetResponse = await fetch(`${process.env.SCRIPT_API_URL}?email=${encodeURIComponent(userInfo.email)}`);
    const sheetData = await sheetResponse.json();

    if (!sheetResponse.ok || sheetData?.found === false) {
      return res.send('<html><body>Email not found in database.</body></html>');
    }

    const roleId = ROLE_MAP[sheetData.role];
    const authHeader = `Bot ${process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN}`;

    if (sheetData.name) {
      const nicknameResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nick: sheetData.name }),
      });

      if (!nicknameResponse.ok) {
        console.error('Failed to update nickname:', await nicknameResponse.text());
      }
    }

    if (roleId) {
      const roleResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
        method: 'PUT',
        headers: { Authorization: authHeader },
      });

      if (!roleResponse.ok) {
        console.error('Failed to assign role:', await roleResponse.text());
      }
    }

    return res.send('<html><body>Verification Successful! You can close this.</body></html>');
  } catch (err) {
    console.error('Verification flow failed:', err);
    return res.status(500).send('An error occurred during verification.');
  }
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
