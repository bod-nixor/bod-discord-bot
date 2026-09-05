# Managed channel spaces

Schema-v2 guilds can create temporary/private working channels through `/channel create` without giving members Discord's native Manage Channels permission.

## Categories

- Entity-owned channels are created inside the entity's existing category.
- Board-owned channels are created inside `BOARD PORTALS`.
- Admin-owned channels are created inside `ADMIN PORTALS`.

The category names come from the guild config (`portalCategories`) rather than application logic.

## Authorization

- Entity scope: an executive of that entity can create it. Admin and Chairperson can also create/support entity spaces.
- Board scope: Member of Board can create channels only for entities currently assigned to them. Board assignment is inferred from their direct access to the standard `<entity>-board` channel, which is reconciled by schema-v2 verification. Chairperson can create Board channels across all entities.
- Admin scope: Admin or Chairperson can create it.

Users never receive Discord Manage Channels permission; the bot performs the mutation after checking organisational roles.

## Access rules

- `@everyone` is denied View Channel and Send Messages on every managed space.
- The creator always has write access.
- Entity audiences can include the selected entities' executives and/or volunteers.
- Specific verified Discord members can be included with the `members` option.
- `read_only:true` keeps creator/management write access but makes the selected audience read-only.
- Chairperson always sees Board portal channels.
- Admin and Chairperson always see Admin portal channels.

For Entity scope, explicitly selected people must be affiliated with that entity unless the creator is Admin or Chairperson.

## Examples

Entity event channel with selected volunteers:

`/channel create scope:Entity name:ncs-event entity:NCS members:@Volunteer1 @Volunteer2`

Board availability announcement to all of the Board member's assigned entity executive teams:

`/channel create scope:Board name:availability read_only:true`

Board portal limited to selected assigned entities:

`/channel create scope:Board name:availability entities:NCS,NLX read_only:true`

Admin announcement to two entity executive teams:

`/channel create scope:Admin name:transport-update entities:NCS,NLX read_only:true`

Include all volunteers of the selected entity/entities only when intentionally needed:

`include_volunteers:true`

## Metadata

Managed channels carry a compact `nixor-space:v1` metadata record in the channel topic with the scope, creator, target entities, read-only flag, and creation timestamp. This allows later `/channel manage` and archive functionality without using GitHub as transactional runtime storage.
