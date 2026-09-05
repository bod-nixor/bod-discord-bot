import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedAudienceRoleNames,
  deriveBoardAssignedEntityKeys,
  normalizeChannelName,
  parseMemberIds,
} from '../lib/channel-spaces.js';

test('normalizes managed channel names safely', () => {
  assert.equal(normalizeChannelName('  NCS Event: Fall 2026!  '), 'ncs-event-fall-2026');
  assert.equal(normalizeChannelName('Board_Availability'), 'board-availability');
});

test('parses and deduplicates Discord member mentions and IDs', () => {
  assert.deepEqual(
    parseMemberIds('<@123456789012345678> <@!222222222222222222>,123456789012345678'),
    ['123456789012345678', '222222222222222222'],
  );
});

test('derives Board assignments only from direct Board-channel member overwrites', () => {
  const config = {
    entities: [
      { key: 'NCS', name: 'NCS', slug: 'ncs' },
      { key: 'NLX', name: 'NLX', slug: 'nlx' },
    ],
  };
  const channels = [
    { id: 'cat-ncs', type: 4, name: 'NCS' },
    { id: 'cat-nlx', type: 4, name: 'NLX' },
    {
      id: 'ncs-board',
      type: 0,
      parent_id: 'cat-ncs',
      name: 'ncs-board',
      permission_overwrites: [{ id: '111111111111111111', type: 1, allow: '1', deny: '0' }],
    },
    {
      id: 'nlx-board',
      type: 0,
      parent_id: 'cat-nlx',
      name: 'nlx-board',
      permission_overwrites: [{ id: '999999999999999999', type: 1, allow: '1', deny: '0' }],
    },
  ];

  assert.deepEqual(
    [...deriveBoardAssignedEntityKeys(config, channels, '111111111111111111')],
    ['NCS'],
  );
});


test('safe global audience roles exclude Verified and include Board/position roles', () => {
  const config = {
    roles: {
      verified: 'Verified',
      executive: 'Executive',
      volunteer: 'Volunteer',
      memberOfBoard: 'Member of Board',
      chairperson: 'Chairperson',
      admin: 'Admin',
    },
    positions: ['CEO/EP', 'CFO'],
  };

  const roles = allowedAudienceRoleNames(config);
  assert.equal(roles.includes('Verified'), false);
  assert.equal(roles.includes('Member of Board'), true);
  assert.equal(roles.includes('CEO/EP'), true);
});
