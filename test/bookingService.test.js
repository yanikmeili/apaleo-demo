// Validation rules of the booking service (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APALEO_CLIENT_ID = 'test-id';
process.env.APALEO_CLIENT_SECRET = 'test-secret';

const { validateStay, validateBookingRequest, ValidationError, todayIso } = await import('../src/bookingService.js');

const plus = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test('valid stay returns nights', () => {
  const s = validateStay({ arrival: plus(3), departure: plus(5), adults: '2' });
  assert.equal(s.nights, 2);
  assert.equal(s.adults, 2);
});

test('rejects past arrival, inverted dates, bad adults, bad format', () => {
  const cases = [
    [{ arrival: '2020-01-01', departure: plus(2), adults: 1 }, 'arrival'],
    [{ arrival: plus(5), departure: plus(5), adults: 1 }, 'departure'],
    [{ arrival: plus(5), departure: plus(3), adults: 1 }, 'departure'],
    [{ arrival: plus(5), departure: plus(6), adults: 0 }, 'adults'],
    [{ arrival: plus(5), departure: plus(6), adults: 1.5 }, 'adults'],
    [{ arrival: '30/10/2026', departure: plus(6), adults: 1 }, 'arrival'],
    [{ arrival: todayIso(), departure: plus(40), adults: 1 }, 'departure'],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => validateStay(input), (e) => e instanceof ValidationError && e.field === field, JSON.stringify(input));
  }
});

test('booking request requires guest fields and a valid email, trims comment', () => {
  const base = { arrival: plus(5), departure: plus(6), adults: 2, ratePlanId: 'PAR-FLEX-DBL', firstName: ' Ada ', lastName: 'Lovelace', email: 'ada@example.com', comment: '  calme  ' };
  const ok = validateBookingRequest(base);
  assert.equal(ok.firstName, 'Ada');
  assert.equal(ok.comment, 'calme');
  assert.throws(() => validateBookingRequest({ ...base, email: 'nope' }), (e) => e.field === 'email');
  assert.throws(() => validateBookingRequest({ ...base, lastName: '' }), (e) => e.field === 'lastName');
  assert.throws(() => validateBookingRequest({ ...base, ratePlanId: '' }), (e) => e.field === 'ratePlanId');
  assert.throws(() => validateBookingRequest({ ...base, comment: 'x'.repeat(1001) }), (e) => e.field === 'comment');
});
