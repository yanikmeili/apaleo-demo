import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, occupancyFor, addDays, isRatePlanEligible, MARKER, SIM_RATE_PLAN_CODE, HORIZON_DAYS } from '../src/simulation/plan.js';

const UNIT_GROUPS = [
  { id: 'DEMO-SGL', code: 'SGL', memberCount: 22 },
  { id: 'DEMO-DBL', code: 'DBL', memberCount: 27 },
  { id: 'DEMO-FAMILY', code: 'FAMILY', memberCount: 2 },
];
// Mirrors the live PAR configuration, including the two restrictions that caused
// 53 rejected bookings on the first run.
const WIDE = [{ from: '2026-10-21T00:00:00+02:00', to: '2027-04-21T00:00:00+02:00' }];
const RATE_PLANS = [
  { id: 'DEMO-FLEX-SGL', unitGroupId: 'DEMO-SGL', restrictions: { minAdvance: { days: 3 }, maxAdvance: { days: 180 } }, bookingPeriods: WIDE },
  { id: 'DEMO-FLEX-DBL', unitGroupId: 'DEMO-DBL', restrictions: { minAdvance: { days: 3 }, maxAdvance: { days: 180 } }, bookingPeriods: WIDE },
  { id: 'DEMO-EARLY-SGL', unitGroupId: 'DEMO-SGL', restrictions: { minAdvance: { months: 2 } }, bookingPeriods: WIDE },
  { id: 'DEMO-IBRKF-DBL', unitGroupId: 'DEMO-DBL', restrictions: {}, bookingPeriods: WIDE },
  { id: 'DEMO-NONREF-SGL', unitGroupId: 'DEMO-SGL', restrictions: { maxAdvance: { days: 180 } }, bookingPeriods: WIDE },
  { id: 'DEMO-NONREF-DBL', unitGroupId: 'DEMO-DBL', restrictions: { maxAdvance: { days: 180 } }, bookingPeriods: WIDE },
  { id: 'DEMO-PROMO-SGL', unitGroupId: 'DEMO-SGL', restrictions: {}, bookingPeriods: [{ from: '2026-11-06T00:00:00+01:00', to: '2026-11-20T00:00:00+01:00' }] },
  { id: 'DEMO-PROMO-DBL', unitGroupId: 'DEMO-DBL', restrictions: {}, bookingPeriods: [{ from: '2026-11-06T00:00:00+01:00', to: '2026-11-20T00:00:00+01:00' }] },
  { id: 'DEMO-DAY-SGL', unitGroupId: 'DEMO-SGL', restrictions: {}, bookingPeriods: WIDE },
];

const make = (over = {}) => buildPlan({
  today: '2026-11-06', runId: '20261106-1200', unitGroups: UNIT_GROUPS,
  ratePlans: RATE_PLANS, simRatePlanId: 'DEMO-SIMULATION_ENTRETIEN-FAMILY', ...over,
});

test('occupancy curve hits the brief: 85% for three days, 40% at D+21', () => {
  assert.equal(occupancyFor(0), 0.85);
  assert.equal(occupancyFor(2), 0.85);
  assert.ok(Math.abs(occupancyFor(21) - 0.4) < 1e-9);
  for (let d = 3; d <= 21; d += 1) assert.ok(occupancyFor(d) <= occupancyFor(d - 1), `day ${d} must not rise`);
});

test('the rate plan code satisfies the API constraint the hyphen version violates', () => {
  assert.match(SIM_RATE_PLAN_CODE, /^[a-zA-Z0-9_]*$/);
  assert.ok(SIM_RATE_PLAN_CODE.length >= 3 && SIM_RATE_PLAN_CODE.length <= 20);
  assert.doesNotMatch(SIM_RATE_PLAN_CODE, /-/);
});

test('every reservation carries the marker in externalCode', () => {
  const plan = make();
  assert.ok(plan.reservations.length > 200);
  for (const r of plan.reservations) assert.ok(r.externalCode.startsWith(MARKER), r.externalCode);
});

test('the same seed produces an identical plan', () => {
  const a = make();
  const b = make();
  assert.deepEqual(a.reservations.map((r) => [r.arrival, r.departure, r.groupId, r.ratePlanId, r.adults]),
    b.reservations.map((r) => [r.arrival, r.departure, r.groupId, r.ratePlanId, r.adults]));
});

test('FLEX is never used inside its 3-day minimum lead time, boundary included', () => {
  for (const r of make().reservations) {
    if (r.ratePlanId.includes('FLEX')) assert.ok(r.arrivalOffset >= 4, `${r.externalCode} books FLEX at D${r.arrivalOffset}`);
  }
});

test('cancellations only target reservations the API can cancel (future arrival)', () => {
  for (const r of make().reservations) {
    if (r.cancel) assert.ok(r.arrivalOffset >= 1, `${r.externalCode} cancels an arrival at D${r.arrivalOffset}`);
  }
});

test('departures leave today so check-out stays within the departure<=tomorrow rule', () => {
  const plan = make();
  const departures = plan.reservations.filter((r) => r.role === 'departure-today');
  assert.ok(departures.length > 0);
  for (const r of departures) {
    assert.equal(r.departure, plan.today);
    assert.ok(r.guest.address?.city && r.guest.address?.postalCode && r.guest.address?.countryCode,
      'invoice debitor needs a full address');
  }
});

test('occupancy never exceeds the real room count per category', () => {
  const plan = make();
  const sizes = Object.fromEntries(UNIT_GROUPS.map((g) => [g.id, g.memberCount]));
  const used = {};
  for (const g of UNIT_GROUPS) used[g.id] = new Array(HORIZON_DAYS + 1).fill(0);
  for (const r of plan.reservations) {
    for (let d = Math.max(0, r.arrivalOffset); d < r.arrivalOffset + r.nights && d <= HORIZON_DAYS; d += 1) used[r.groupId][d] += 1;
  }
  for (const g of UNIT_GROUPS) {
    for (let d = 0; d <= HORIZON_DAYS; d += 1) {
      assert.ok(used[g.id][d] <= sizes[g.id], `${g.id} oversold on D+${d}: ${used[g.id][d]}/${sizes[g.id]}`);
    }
  }
});

test('adults stay within each category capacity', () => {
  for (const r of make().reservations) {
    const max = { 'DEMO-SGL': 1, 'DEMO-DBL': 2, 'DEMO-FAMILY': 4 }[r.groupId];
    assert.ok(r.adults >= 1 && r.adults <= max, `${r.groupId} with ${r.adults} adults`);
  }
});

test('comments land on roughly a tenth of reservations', () => {
  const plan = make();
  const ratio = plan.reservations.filter((r) => r.comment).length / plan.reservations.length;
  assert.ok(ratio > 0.05 && ratio < 0.16, `ratio was ${ratio}`);
});

test('the fallback plan contains no past arrival but still stages departures', () => {
  const plan = make({ allowBackdating: false });
  for (const r of plan.reservations) assert.ok(r.arrivalOffset >= 0, `${r.externalCode} arrives at D${r.arrivalOffset}`);
  // Apaleo refuses past arrivals, so departures become same-day check-outs of a
  // one-night stay: departure is tomorrow, which check-out still accepts today.
  const departures = plan.reservations.filter((r) => r.role === 'departure-today');
  assert.ok(departures.length > 0, 'fallback must still produce departures to check out');
  for (const r of departures) {
    assert.equal(r.arrival, plan.today);
    assert.equal(r.departure, addDays(plan.today, 1));
    assert.ok(r.guest.address?.city, 'invoice debitor needs an address');
  }
});

test('FAMILY only ever books the simulation rate plan', () => {
  for (const r of make().reservations) {
    if (r.groupId === 'DEMO-FAMILY') assert.equal(r.ratePlanId, 'DEMO-SIMULATION_ENTRETIEN-FAMILY');
  }
});

test('addDays walks the calendar in UTC', () => {
  assert.equal(addDays('2026-11-06', 1), '2026-11-07');
  assert.equal(addDays('2026-11-06', -2), '2026-11-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('EARLY is rejected inside its two-month minimum advance', () => {
  const early = RATE_PLANS.find((p) => p.id === 'DEMO-EARLY-SGL');
  assert.equal(isRatePlanEligible(early, '2026-11-20', '2026-11-06'), false);
  assert.equal(isRatePlanEligible(early, '2027-02-01', '2026-11-06'), true);
});

test('PROMO is rejected outside its booking period', () => {
  const promo = RATE_PLANS.find((p) => p.id === 'DEMO-PROMO-DBL');
  assert.equal(isRatePlanEligible(promo, '2026-11-10', '2026-11-06'), true);
  assert.equal(isRatePlanEligible(promo, '2026-11-25', '2026-11-06'), false);
});

test('no reservation books a rate plan its own restrictions forbid', () => {
  const plan = make();
  const byId = Object.fromEntries(RATE_PLANS.map((p) => [p.id, p]));
  for (const r of plan.reservations) {
    const rp = byId[r.ratePlanId];
    if (!rp) continue; // the simulation FAMILY plan carries no restriction
    assert.ok(isRatePlanEligible(rp, r.arrival, plan.today), `${r.externalCode} books ${r.ratePlanId} for ${r.arrival}`);
  }
});

test('day-use rates are never used for an overnight stay', () => {
  for (const r of make().reservations) assert.doesNotMatch(r.ratePlanId, /-DAY-/);
});

test('pre-existing occupancy is subtracted instead of oversold', () => {
  // The hotel is already full on D+0 and D+1 for every category.
  const existingOccupancy = Object.fromEntries(UNIT_GROUPS.map((g) => {
    const arr = new Array(HORIZON_DAYS + 2).fill(0);
    arr[0] = g.memberCount;
    arr[1] = g.memberCount;
    return [g.id, arr];
  }));
  const plan = make({ existingOccupancy });
  const sizes = Object.fromEntries(UNIT_GROUPS.map((g) => [g.id, g.memberCount]));
  const used = Object.fromEntries(UNIT_GROUPS.map((g) => [g.id, new Array(HORIZON_DAYS + 1).fill(0)]));
  for (const r of plan.reservations) {
    for (let d = Math.max(0, r.arrivalOffset); d < r.arrivalOffset + r.nights && d <= HORIZON_DAYS; d += 1) used[r.groupId][d] += 1;
  }
  for (const g of UNIT_GROUPS) {
    for (const d of [0, 1]) {
      assert.equal(used[g.id][d], 0, `${g.id} must add nothing on D+${d} when already full`);
    }
    for (let d = 0; d <= HORIZON_DAYS; d += 1) {
      const total = used[g.id][d] + (existingOccupancy[g.id][d] || 0);
      assert.ok(total <= sizes[g.id], `${g.id} oversold on D+${d}: ${total}/${sizes[g.id]}`);
    }
  }
});

test('a plan declaring no restrictions falls back to its base plan', () => {
  // The simulation FAMILY plan declares nothing of its own, so Apaleo applies its base's.
  const base = { id: 'X-FLEX-DBL', restrictions: { minAdvance: { days: 3 } }, bookingPeriods: [] };
  const derived = { id: 'X-SIM-FAMILY', restrictions: {}, bookingPeriods: [], baseRatePlanId: 'X-FLEX-DBL' };
  const byId = new Map([[base.id, base], [derived.id, derived]]);
  assert.equal(isRatePlanEligible(derived, '2026-11-07', '2026-11-06', byId), false, 'D+1 refused through the base');
  assert.equal(isRatePlanEligible(derived, '2026-11-12', '2026-11-06', byId), true, 'D+6 clears the inherited minAdvance');
  // The day that exactly equals minAdvance is refused: Apaleo measures from the booking
  // time, so a late-evening booking for D+3 falls short of "3 days".
  assert.equal(isRatePlanEligible(derived, '2026-11-09', '2026-11-06', byId), false, 'D+3 is the boundary and must be avoided');
});

test('a plan declaring its own restrictions does NOT inherit the base minAdvance', () => {
  // NONREF-DBL declares maxAdvance only and books fine on D+0, even though FLEX-DBL,
  // the plan it derives its price from, carries a 3-day minAdvance. Inheriting here
  // would empty the three peak days of the curve.
  const base = { id: 'X-FLEX-DBL', restrictions: { minAdvance: { days: 3 } }, bookingPeriods: [] };
  const nonref = { id: 'X-NONREF-DBL', restrictions: { maxAdvance: { days: 180 } }, bookingPeriods: [], baseRatePlanId: 'X-FLEX-DBL' };
  const byId = new Map([[base.id, base], [nonref.id, nonref]]);
  assert.equal(isRatePlanEligible(nonref, '2026-11-06', '2026-11-06', byId), true, 'D+0 must stay bookable');
  assert.equal(isRatePlanEligible(nonref, '2026-11-07', '2026-11-06', byId), true);
});

test('a pricing chain cycle does not hang the eligibility check', () => {
  const a = { id: 'A', restrictions: {}, bookingPeriods: [], baseRatePlanId: 'B' };
  const b = { id: 'B', restrictions: {}, bookingPeriods: [], baseRatePlanId: 'A' };
  const byId = new Map([['A', a], ['B', b]]);
  assert.equal(isRatePlanEligible(a, '2026-11-20', '2026-11-06', byId), true);
});

test('the property time zone offset follows the property, not a frozen constant', async () => {
  const { propertyOffset } = await import('../src/allocationAgent.js');
  // A frozen "+01:00" silently shifts the arrival-day filter in summer and abroad.
  assert.equal(propertyOffset('2026-11-07', 'Europe/Paris'), '+01:00');
  assert.equal(propertyOffset('2026-07-15', 'Europe/Paris'), '+02:00');
  assert.equal(propertyOffset('2026-11-07', 'America/New_York'), '-05:00');
  assert.equal(propertyOffset('2026-11-07', 'UTC'), '+00:00');
  assert.equal(propertyOffset('2026-11-07', 'Not/AZone'), '+00:00');
});
