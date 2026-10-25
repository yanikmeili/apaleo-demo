// Backend validation of model proposals (no network, no model).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APALEO_CLIENT_ID = 'test-id';
process.env.APALEO_CLIENT_SECRET = 'test-secret';

const { validateProposals, renderReport } = await import('../src/allocationAgent.js');

const unit = (id, name, unitGroupId = 'PAR-DBL') => ({ id, name, unitGroupId, condition: 'Clean', attributes: [] });
const input = {
  date: '2026-10-26',
  propertyId: 'PAR',
  reservations: [
    { reservationId: 'A-1', bookingId: 'A', unitGroup: 'Double', unitGroupId: 'PAR-DBL', guestComment: 'calme', candidates: [unit('U1', '1.005'), unit('U2', '1.006')] },
    { reservationId: 'B-1', bookingId: 'B', unitGroup: 'Double', unitGroupId: 'PAR-DBL', guestComment: '', candidates: [unit('U1', '1.005'), unit('U2', '1.006')] },
    { reservationId: 'C-1', bookingId: 'C', unitGroup: 'Single', unitGroupId: 'PAR-SGL', guestComment: 'contradictoire', candidates: [unit('S1', '2.003', 'PAR-SGL')] },
  ],
};

test('valid proposals are accepted, duplicates and foreign units rejected', () => {
  const { decisions, unknown } = validateProposals(input, [
    { reservationId: 'A-1', unitId: 'U1', reason: 'ok', needsHumanReview: false },
    { reservationId: 'B-1', unitId: 'U1', reason: 'same room again', needsHumanReview: false },
    { reservationId: 'C-1', unitId: 'U2', reason: 'wrong category', needsHumanReview: false },
    { reservationId: 'ZZZ-9', unitId: 'U2', reason: 'unknown reservation', needsHumanReview: false },
  ]);
  const [a, b, c] = decisions;
  assert.equal(a.valid, true);
  assert.equal(a.unitName, '1.005');
  assert.equal(a.needsHumanReview, false);
  assert.equal(b.valid, false, 'U1 already used');
  assert.equal(b.needsHumanReview, true);
  assert.equal(c.valid, false, 'U2 is not a candidate of C-1');
  assert.deepEqual(unknown, ['ZZZ-9']);
});

test('null unitId is a valid "leave for a human" decision; missing proposal is flagged', () => {
  const { decisions } = validateProposals(input, [{ reservationId: 'C-1', unitId: null, reason: 'ambigu', needsHumanReview: true }]);
  const c = decisions.find((d) => d.reservationId === 'C-1');
  assert.equal(c.valid, true);
  assert.equal(c.unitId, null);
  assert.equal(c.needsHumanReview, true);
  const a = decisions.find((d) => d.reservationId === 'A-1');
  assert.equal(a.valid, false);
  assert.equal(a.needsHumanReview, true);
});

test('report lists human-review items', () => {
  const { decisions, unknown } = validateProposals(input, [{ reservationId: 'A-1', unitId: 'U1', reason: 'ok', needsHumanReview: false }]);
  const report = renderReport({ date: '2026-10-26', decisions, unknown, apply: false });
  assert.match(report, /DRY-RUN/);
  assert.match(report, /\| A-1 \| Double \| calme \| 1\.005 \| ok \| ✅ proposée \|/);
  assert.match(report, /À vérifier par la réception \(2\)/);
});
