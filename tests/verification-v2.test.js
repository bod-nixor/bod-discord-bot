import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { managedRoleNames, validateAndDeriveV2 } from '../lib/verification-v2.js';

const config = {
  schemaVersion: 2,
  guildId: '1545706528152223814',
  roles: {
    verified: 'Verified',
    executive: 'Executive',
    volunteer: 'Volunteer',
    memberOfBoard: 'Member of Board',
    chairperson: 'Chairperson',
    admin: 'Admin',
  },
  entities: [
    { key: 'NCS', name: 'NCS', slug: 'ncs' },
    { key: 'NLX', name: 'NLX', slug: 'nlx' },
    { key: 'NFS', name: 'NFS', slug: 'nfs' },
  ],
  positions: ['CRM', 'CIO'],
};

const payload = (assignments) => ({
  schemaVersion: 2,
  found: true,
  person: { name: 'Demo Person', email: 'demo@nixorcollege.edu.pk' },
  assignments,
});

test('plain executive derives global, entity, scoped and position roles', () => {
  const result = validateAndDeriveV2(
    config,
    payload([{ relationship: 'Executive', entity: 'NCS', position: 'CRM' }]),
  );

  assert.deepEqual(
    new Set(result.desiredRoles),
    new Set(['Verified', 'Executive', 'NCS', 'NCS — Executive', 'CRM']),
  );
  assert.deepEqual(result.boardEntities, new Set());
});

test('executive can volunteer for another entity without leaking scoped access', () => {
  const result = validateAndDeriveV2(
    config,
    payload([
      { relationship: 'Executive', entity: 'NCS', position: 'CRM' },
      { relationship: 'Volunteer', entity: 'NLX', position: null },
    ]),
  );

  assert(result.desiredRoles.has('NCS — Executive'));
  assert(result.desiredRoles.has('NLX — Volunteer'));
  assert(!result.desiredRoles.has('NCS — Volunteer'));
  assert(!result.desiredRoles.has('NLX — Executive'));
});

test('Member of Board assignments track only assigned entities', () => {
  const result = validateAndDeriveV2(
    config,
    payload([
      { relationship: 'Member of Board', entity: 'NCS' },
      { relationship: 'Member of Board', entity: 'NLX' },
    ]),
  );

  assert.deepEqual(result.boardEntities, new Set(['NCS', 'NLX']));
  assert(result.desiredRoles.has('Member of Board'));
  assert(result.desiredRoles.has('NCS'));
  assert(result.desiredRoles.has('NLX'));
  assert(!result.desiredRoles.has('NFS'));
});

test('Admin is global and cannot silently become entity-scoped', () => {
  const result = validateAndDeriveV2(config, payload([{ relationship: 'Admin' }]));
  assert.deepEqual(new Set(result.desiredRoles), new Set(['Verified', 'Admin']));

  assert.throws(
    () => validateAndDeriveV2(config, payload([{ relationship: 'Admin', entity: 'NCS' }])),
    /must not specify an entity/,
  );
});

test('unknown entities and positions fail closed', () => {
  assert.throws(
    () => validateAndDeriveV2(config, payload([{ relationship: 'Volunteer', entity: 'UNKNOWN' }])),
    /Unknown entity/,
  );
  assert.throws(
    () => validateAndDeriveV2(config, payload([{ relationship: 'Executive', entity: 'NCS', position: 'UNKNOWN' }])),
    /Unknown position/,
  );
});

test('managed role set contains all role families used for stale-role cleanup', () => {
  const names = managedRoleNames(config);
  for (const expected of [
    'Verified', 'Executive', 'Volunteer', 'Member of Board', 'Chairperson', 'Admin',
    'NCS', 'NCS — Executive', 'NCS — Volunteer', 'CRM', 'CIO',
  ]) {
    assert(names.has(expected), `missing managed role: ${expected}`);
  }
});

test('legacy verification branch remains present alongside explicit schema v2 routing', async () => {
  const appSource = await fs.readFile(new URL('../app.js', import.meta.url), 'utf8');
  const appsScriptSource = await fs.readFile(new URL('../google-apps-script/Code.gs', import.meta.url), 'utf8');

  assert.match(appSource, /Number\(sheetData\?\.schemaVersion\) === 2/);
  assert.match(appSource, /sheetData\.nicknamePrefix/);
  assert.match(appSource, /sheetData\.roleId/);
  assert.match(appSource, /members\/\$\{userId\}\/roles\/\$\{sheetData\.roleId\}/);

  assert.match(appsScriptSource, /const serverSheet = ss\.getSheetByName\(serverId\)/);
  assert.match(appsScriptSource, /const configSheet = ss\.getSheetByName\("config"\)/);
  assert.match(appsScriptSource, /roleId,/);
  assert.match(appsScriptSource, /nicknamePrefix,/);
});
