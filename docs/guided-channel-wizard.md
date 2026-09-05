# Guided managed-channel creation

`/channel create` now opens an ephemeral guided setup instead of exposing the full channel specification as slash-command arguments.

## Flow

1. Choose the owner/scope: Entity, Board Portal, or Admin Portal.
2. Choose optional entity audiences.
3. Choose how selected entity teams participate: Executives, Volunteers, both, or neither.
4. Choose optional global role audiences such as `Member of Board`, `CEO/EP`, `CFO`, etc.
5. Choose optional specific verified Discord members.
6. Choose whether the audience can write or is read-only.
7. Press Continue, enter the channel name, and submit.

The setup is visible only to the person creating the channel. Wizard sessions are short-lived and stored as temporary host-local files so multiple Passenger workers can continue the same setup without using GitHub as transactional state.

## Role audiences

Role audiences are intentionally global. Selecting `CEO/EP` grants access to every Discord member who currently holds the global `CEO/EP` role. This makes channels such as a Board × CEO portal possible without creating extra Discord roles.

`Verified` is intentionally not available as a role audience. The selectable role list is limited to the v2 organisational roles (`Executive`, `Volunteer`, `Member of Board`, `Chairperson`, `Admin`) and configured position roles.

Entity-scoped access remains separate: choosing NCS + Executives uses the `NCS — Executive` role, while choosing NCS + Volunteers uses `NCS — Volunteer`.

## Authorization

The wizard does not weaken the existing creation rules:

- Entity: creator must be an executive of that entity, Admin, or Chairperson.
- Board: creator must be Member of Board or Chairperson.
- Admin: creator must be Admin or Chairperson.
- Board entity choices are restricted to that Board member's assigned entities; Chairperson can choose any entity.
- Explicitly selected people must already be Verified.

The creator always retains write access. Chairperson retains Board portal management access. Admin and Chairperson retain Admin portal management access.
