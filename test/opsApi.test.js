import test from 'node:test';
import assert from 'node:assert/strict';
import { planAssignments } from '../src/opsApi.js';
import { mockProposals } from '../src/simulation/mockAllocator.js';

// Mirrors the shape buildInput() returns.
const INPUT = {
  date: '2026-11-14',
  propertyId: 'DEMO',
  propertyName: 'Hotel Demo',
  reservations: [
    {
      reservationId: 'AAA-1', bookingId: 'AAA', unitGroup: 'Double', unitGroupId: 'DEMO-DBL',
      arrival: '2026-11-14', departure: '2026-11-16', adults: 2,
      guestComment: 'Je suis en fauteuil roulant, chambre accessible.',
      candidates: [
        { id: 'u-acc', name: 'G.004', unitGroupId: 'DEMO-DBL', condition: 'Clean', occupiedNow: false, attributes: ['Ground floor', 'Accessible'] },
        { id: 'u-top', name: '3.001', unitGroupId: 'DEMO-DBL', condition: 'Clean', occupiedNow: false, attributes: ['Floor 3', 'Garden view'] },
      ],
    },
    {
      reservationId: 'BBB-1', bookingId: 'BBB', unitGroup: 'Double', unitGroupId: 'DEMO-DBL',
      arrival: '2026-11-14', departure: '2026-11-16', adults: 2,
      guestComment: '', candidates: [
        { id: 'u-top', name: '3.001', unitGroupId: 'DEMO-DBL', condition: 'Clean', occupiedNow: false, attributes: ['Floor 3'] },
      ],
    },
  ],
};

test('a unit outside the reservation candidates is refused', () => {
  const { toApply, rejected } = planAssignments(INPUT, [{ reservationId: 'AAA-1', unitId: 'u-elsewhere' }]);
  assert.equal(toApply.length, 0);
  assert.match(rejected[0].error, /hors des candidates/);
});

test('a reservation not arriving on that date is refused', () => {
  const { toApply, rejected } = planAssignments(INPUT, [{ reservationId: 'ZZZ-9', unitId: 'u-acc' }]);
  assert.equal(toApply.length, 0);
  assert.match(rejected[0].error, /absente des arrivées/);
});

test('the same unit cannot be assigned twice in one batch', () => {
  const { toApply, rejected } = planAssignments(INPUT, [
    { reservationId: 'AAA-1', unitId: 'u-top' },
    { reservationId: 'BBB-1', unitId: 'u-top' },
  ]);
  assert.equal(toApply.length, 1);
  assert.equal(toApply[0].reservationId, 'AAA-1');
  assert.match(rejected[0].error, /déjà attribuée/);
});

test('a valid pair is passed through with the room name resolved', () => {
  const { toApply, rejected } = planAssignments(INPUT, [{ reservationId: 'AAA-1', unitId: 'u-acc' }]);
  assert.equal(rejected.length, 0);
  assert.deepEqual(toApply, [{ reservationId: 'AAA-1', unitId: 'u-acc', unitName: 'G.004' }]);
});

test('malformed entries are rejected rather than crashing', () => {
  const { toApply, rejected } = planAssignments(INPUT, [null, {}, { reservationId: 'AAA-1' }]);
  assert.equal(toApply.length, 0);
  assert.equal(rejected.length, 3);
});

test('the stand-in allocator honours an explicit attribute request', () => {
  const { assignments, source } = mockProposals(INPUT);
  assert.equal(source, 'mock');
  const wheelchair = assignments.find((a) => a.reservationId === 'AAA-1');
  assert.equal(wheelchair.unitId, 'u-acc', 'the accessible room must win for a wheelchair request');
  assert.equal(wheelchair.needsHumanReview, false);
});

test('the stand-in allocator never proposes one room twice', () => {
  const { assignments } = mockProposals(INPUT);
  const used = assignments.filter((a) => a.unitId).map((a) => a.unitId);
  assert.equal(used.length, new Set(used).size);
});

test('the stand-in flags a request it cannot satisfy', () => {
  const onlyStreet = {
    ...INPUT,
    reservations: [{
      ...INPUT.reservations[0],
      guestComment: 'Je suis en fauteuil roulant, chambre accessible.',
      candidates: [{ id: 'u1', name: '1.002', unitGroupId: 'DEMO-DBL', condition: 'Clean', occupiedNow: false, attributes: ['Floor 1', 'Street view'] }],
    }],
  };
  const { assignments } = mockProposals(onlyStreet);
  assert.equal(assignments[0].needsHumanReview, true);
  assert.match(assignments[0].reason, /Accessible/);
});

test('the stand-in honours a room named in the comment when it is free', () => {
  const named = {
    ...INPUT,
    reservations: [{ ...INPUT.reservations[0], guestComment: 'Même chambre que l’année dernière, la 3.001.' }],
  };
  const { assignments } = mockProposals(named);
  assert.equal(assignments[0].unitId, 'u-top');
  assert.equal(assignments[0].needsHumanReview, false);
});

test('a named room that is not free falls back and asks for a human', () => {
  const named = {
    ...INPUT,
    reservations: [{ ...INPUT.reservations[0], guestComment: 'Je veux la chambre 9.999 comme l’an dernier.' }],
  };
  const { assignments } = mockProposals(named);
  assert.ok(assignments[0].unitId, 'a fallback room is still proposed');
  assert.equal(assignments[0].needsHumanReview, true);
  assert.match(assignments[0].reason, /9\.999/);
});
