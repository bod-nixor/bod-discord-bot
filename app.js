import 'dotenv/config';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { exec } from 'child_process';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';

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
            content: '⛔ You are not authorized',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      // 1. Send the IMMEDIATE public message (No Ephemeral flag)
      res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '🔄 Triggering restart script...',
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
                    content: '🔄 Triggering restart script...\n✅ **Restart successful!**',
                },
            });
        } catch (err) {
            console.error('Error editing interaction response:', err);
        }
      });

      return;
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
