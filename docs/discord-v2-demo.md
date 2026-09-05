# Nixor Corporate '26 Discord v2 demo

This branch contains the first runnable setup layer for guild `1545706528152223814`.

## What it creates

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

Assigned Members of Board are intentionally not granted globally. Their per-entity access will be applied by the verification/sync layer so a Board member can be assigned to only the entities they supervise. They will receive both the entity's `board` and `admin` channels.

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

The command is idempotent: it reuses roles/categories/channels with the expected names and reconciles the bot-managed permission overwrites. It does not delete unknown roles or channels. Existing member-specific permission overwrites are preserved, which is required for per-entity Member of Board assignments.

## Required environment

The setup command uses the existing bot credentials and accepts either:

- `DISCORD_BOT_TOKEN`
- `DISCORD_TOKEN`

The bot role must have `Manage Roles` and `Manage Channels`, and it must sit above every role the bot needs to assign later.

## Configuration

The organisational structure is data-driven from:

`config/guilds/1545706528152223814.json`

The setup logic contains no hardcoded entity names, position names, or Discord role/channel IDs.

## Next demo layer

The next implementation step is verification reconciliation:

1. Google Sheet API returns all assignments for the verified email.
2. Bot derives the required global/entity/scoped/position roles.
3. Bot adds missing managed roles and removes stale managed roles without touching unrelated roles.
4. Member of Board entity assignments add direct access to that entity's `board` and `admin` channels.
5. Dynamic `/channel create` and `/channel manage` use the same assignment model for event chats and cross-entity portals.
