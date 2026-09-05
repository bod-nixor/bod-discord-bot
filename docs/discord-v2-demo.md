# Nixor Corporate '26 Discord v2 demo

This branch contains the demo implementation for guild `1545706528152223814`.

## Compatibility rule

Schema v2 is opt-in. The existing verification behavior for legacy servers remains in `app.js` and is still used whenever the Sheet API response does not contain `schemaVersion: 2`.

Legacy flow remains:

1. Sheet API returns `name`, `nicknamePrefix`, and `roleId`.
2. Bot applies the nickname prefix.
3. Bot adds the single returned role.

Only a v2 API response enters the new reconciliation code. The current v2 server is `1545706528152223814`.

Run `npm test` before deploying changes. The compatibility test asserts that both the v2 route and the old `nicknamePrefix` / `roleId` path remain present.

## What guild setup creates

Global roles:

- Verified
- Executive
- Volunteer
- Member of Board
- Chairperson
- Admin
- Position roles from the guild config

For every selected entity it also creates:

- `<Entity>`
- `<Entity> — Executive`
- `<Entity> — Volunteer`

And one category with four channels:

- `#<entity>-team`
- `#<entity>-board`
- `#<entity>-admin`
- `#<entity>-volunteers`

Base permissions are:

| Channel | Entity Executive | Chairperson | Admin | Entity Volunteer |
| --- | --- | --- | --- | --- |
| team | write | no access | no access | no access |
| board | write | write | no access | no access |
| admin | write | write | write | no access |
| volunteers | write | no access | no access | write |

Assigned Members of Board are not granted global channel access. V2 verification applies direct member access to both the `board` and `admin` channels of only their assigned entities.

## Safe demo flow

First inspect a small subset without changing Discord:

```bash
npm run guild:setup -- --guild 1545706528152223814 --entities NCS,NLX --plan
```

Then apply only that subset:

```bash
npm run guild:setup -- --guild 1545706528152223814 --entities NCS,NLX --apply
```

After the demo is accepted, run the full setup:

```bash
npm run guild:setup -- --guild 1545706528152223814 --plan
npm run guild:setup -- --guild 1545706528152223814 --apply
```

The setup command is idempotent: it reuses roles/categories/channels with the expected names and reconciles bot-managed role overwrites. It does not delete unknown roles or channels. Existing member-specific permission overwrites are preserved by guild setup.

## V2 verification

The Sheet API v2 response has the form:

```json
{
  "schemaVersion": 2,
  "found": true,
  "serverId": "1545706528152223814",
  "person": {
    "email": "person@nixorcollege.edu.pk",
    "name": "Person Name",
    "studentId": "20270000",
    "campus": "NCC"
  },
  "assignments": [
    {
      "relationship": "Executive",
      "entity": "NCS",
      "position": "CRM",
      "source": "exec_database"
    },
    {
      "relationship": "Volunteer",
      "entity": "NLX",
      "position": null,
      "source": "discord_assignments"
    }
  ]
}
```

The bot derives all desired managed roles, compares them with the member's current managed roles, adds missing roles, removes stale managed roles, and leaves unrelated/manual roles untouched.

Examples:

- NCS Executive / CRM -> `Verified`, `Executive`, `NCS`, `NCS — Executive`, `CRM`
- NCS Executive + NLX Volunteer -> all of the above plus `Volunteer`, `NLX`, `NLX — Volunteer`
- Member of Board assigned NCS + NLX -> `Verified`, `Member of Board`, `NCS`, `NLX`, plus direct access to both entities' `board` and `admin` channels
- Admin -> `Verified`, `Admin`

Invalid entities, positions, or relationship shapes fail closed rather than guessing permissions.

## Google Apps Script deployment

The backward-compatible Apps Script source is stored at:

`google-apps-script/Code.gs`

It preserves the existing server-sheet/config lookup for legacy servers and only invokes the v2 lookup for a server explicitly marked active with schema version 2 in `discord_servers`.

The v2 API reads:

- `exec database` for active Executive assignments
- `discord_assignments` for Volunteer / Member of Board / Chairperson / Admin assignments
- `discord_people` and `students` for identity resolution
- `discord_entities` and `discord_positions` for validation

The bound Apps Script project must be updated with `google-apps-script/Code.gs` and its web-app deployment updated before v2 verification can work. Merely changing spreadsheet cells does not redeploy Apps Script code.

## Required environment

The setup and verification code uses the existing bot credentials and accepts either:

- `DISCORD_BOT_TOKEN`
- `DISCORD_TOKEN`

Existing OAuth variables and `SCRIPT_API_URL` remain unchanged.

The bot role must have `Manage Roles`, `Manage Channels`, and `Manage Nicknames`, and it must sit above every managed role.

## Configuration

The Discord-side organisational structure is data-driven from:

`config/guilds/1545706528152223814.json`

The setup and verification logic contain no hardcoded entity names, position names, or generated Discord role/channel IDs.

## Next layer

After v2 verification is tested with real demo users, add the generic dynamic-space engine used by `/channel create` and `/channel manage` for event chats and cross-entity announcement portals.
