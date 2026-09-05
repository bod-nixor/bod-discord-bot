import 'dotenv/config';
import { getRPSChoices } from './game.js';
import { capitalize, InstallGlobalCommands } from './utils.js';

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Command containing options
const CHALLENGE_COMMAND = {
  name: 'challenge',
  description: 'Challenge to a match of rock paper scissors',
  options: [
    {
      type: 3,
      name: 'object',
      description: 'Pick your object',
      required: true,
      choices: createCommandChoices(),
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

const EXECUTE_COMMAND = {
  name: 'execute',
  description: 'Run a configured script',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Script key to run',
      required: true,
    },
  ],
};

const ADMIN_SCRIPT_COMMAND = {
  name: 'admin-script',
  description: 'Manage script execution config',
  type: 1,
  integration_types: [0],
  contexts: [0],
  default_member_permissions: '8',
  options: [
    {
      type: 1,
      name: 'add',
      description: 'Add a script definition',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Script key',
          required: true,
        },
        {
          type: 3,
          name: 'script',
          description: 'Script filename (.sh)',
          required: true,
        },
        {
          type: 3,
          name: 'allowed_roles',
          description: 'Comma-separated role IDs',
          required: true,
        },
        {
          type: 3,
          name: 'allowed_guilds',
          description: 'Comma-separated guild IDs',
          required: false,
        },
        {
          type: 5,
          name: 'ephemeral',
          description: 'Respond ephemerally',
          required: false,
        },
        {
          type: 3,
          name: 'description',
          description: 'Description for /execute',
          required: false,
        },
        {
          type: 4,
          name: 'timeout_ms',
          description: 'Execution timeout in milliseconds',
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: 'update',
      description: 'Update a script definition',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Script key',
          required: true,
        },
        {
          type: 3,
          name: 'script',
          description: 'Script filename (.sh)',
          required: false,
        },
        {
          type: 3,
          name: 'allowed_roles',
          description: 'Comma-separated role IDs',
          required: false,
        },
        {
          type: 3,
          name: 'allowed_guilds',
          description: 'Comma-separated guild IDs',
          required: false,
        },
        {
          type: 5,
          name: 'ephemeral',
          description: 'Respond ephemerally',
          required: false,
        },
        {
          type: 3,
          name: 'description',
          description: 'Description for /execute',
          required: false,
        },
        {
          type: 4,
          name: 'timeout_ms',
          description: 'Execution timeout in milliseconds',
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: 'delete',
      description: 'Delete a script definition',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Script key',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: 'list',
      description: 'List configured scripts',
      options: [
        {
          type: 3,
          name: 'filter',
          description: 'Filter by script name',
          required: false,
        },
      ],
    },
  ],
};

const CHANNEL_COMMAND = {
  name: 'channel',
  description: 'Create managed private Corporate channels',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 1,
      name: 'create',
      description: 'Create an entity, Board, or Admin channel',
      options: [
        {
          type: 3,
          name: 'scope',
          description: 'Who owns this channel',
          required: true,
          choices: [
            { name: 'Entity', value: 'entity' },
            { name: 'Board', value: 'board' },
            { name: 'Admin', value: 'admin' },
          ],
        },
        {
          type: 3,
          name: 'name',
          description: 'Channel name',
          required: true,
        },
        {
          type: 3,
          name: 'entity',
          description: 'Entity key for Entity scope, e.g. NCS',
          required: false,
        },
        {
          type: 3,
          name: 'entities',
          description: 'Board/Admin audience entities, comma-separated, e.g. NCS,NLX',
          required: false,
        },
        {
          type: 5,
          name: 'include_executives',
          description: 'Give the selected entity executive teams access (default: yes)',
          required: false,
        },
        {
          type: 5,
          name: 'include_volunteers',
          description: 'Give all volunteers of selected entities access (default: no)',
          required: false,
        },
        {
          type: 3,
          name: 'members',
          description: 'Optional Discord user mentions or IDs separated by spaces/commas',
          required: false,
        },
        {
          type: 5,
          name: 'read_only',
          description: 'Audience can read but only the creator/management can send',
          required: false,
        },
      ],
    },
  ],
};

const SETUP_VERIFICATION = {
  name: 'setup-verification',
  description: 'Post the Google verification button',
  type: 1,
  integration_types: [0],
  contexts: [0],
  default_member_permissions: '8',
};

const ALL_COMMANDS = [
  TEST_COMMAND,
  CHALLENGE_COMMAND,
  EXECUTE_COMMAND,
  ADMIN_SCRIPT_COMMAND,
  CHANNEL_COMMAND,
  SETUP_VERIFICATION,
];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
