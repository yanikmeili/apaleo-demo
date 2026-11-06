// Applies a simulation plan to Apaleo, throttled, with a backdating probe up front.
//
// Every write is marked so `simulate:clean` can find it again:
//   reservation.externalCode = "SIMULATION-ENTRETIEN-<runId>-<seq>"
//   charge/payment.receipt   = "SIMULATION-ENTRETIEN-<runId>"
//   rate plan code           = "SIMULATION_ENTRETIEN"   (hyphen is rejected by the API)
import { config } from '../config.js';
import { ApaleoError, createBooking, cancelReservation, checkInReservation, getReservation, listReservations, listAvailableUnitsForReservation, assignUnit, checkOutReservation,
  listFolios, createFolio, postFolioCharge, postFolioPayment, moveFolioCharges, closeFolio, createInvoice,
  listRatePlans, getRatePlan, createRatePlan, listUnitGroups, apaleo } from '../apaleoClient.js';
import { MARKER, SIM_RATE_PLAN_CODE } from './plan.js';

/** Ids are "<propertyId>-<code>-<unitGroupCode>", so they must follow the property. */
export const simRatePlanIdFor = (propertyId) => `${propertyId}-${SIM_RATE_PLAN_CODE}-FAMILY`;
export const SIM_RATE_PLAN_ID = simRatePlanIdFor(config.apaleo.propertyId);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sequential throttle: one call at a time, `delayMs` between calls, so we stay well under the 429 threshold. */
export function makeThrottle(delayMs) {
  let last = 0;
  return async (fn) => {
    const wait = Math.max(0, last + delayMs - Date.now());
    if (wait) await sleep(wait);
    try {
      return await fn();
    } finally {
      last = Date.now();
    }
  };
}

/**
 * Rooms already taken per unit group per day, from reservations that are NOT ours.
 * Without this the plan treats the hotel as empty and oversells: "The unit group is
 * already fully booked". Residue from earlier runs cannot be deleted, so it must be
 * counted rather than wished away.
 */
export async function fetchExistingOccupancy({ propertyId, today, horizonDays, unitGroups }) {
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + (horizonDays + 2) * 86400000).toISOString().slice(0, 10);
  const occupied = {};
  for (const g of unitGroups) occupied[g.id] = new Array(horizonDays + 2).fill(0);
  for (let page = 1; ; page += 1) {
    const res = await listReservations({
      propertyIds: propertyId, dateFilter: 'Stay', from: `${today}T00:00:00Z`, to: `${to}T00:00:00Z`,
      status: ['Confirmed', 'InHouse'], pageSize: 500, pageNumber: page,
    });
    const batch = res?.reservations || [];
    for (const r of batch) {
      const gid = r.unitGroup?.id;
      if (!occupied[gid]) continue;
      const a = Math.round((Date.parse(r.arrival.slice(0, 10)) - Date.parse(today)) / 86400000);
      const d = Math.round((Date.parse(r.departure.slice(0, 10)) - Date.parse(today)) / 86400000);
      for (let x = Math.max(0, a); x < d && x <= horizonDays; x += 1) occupied[gid][x] += 1;
    }
    if (batch.length < 500) break;
  }
  return occupied;
}

export async function fetchInventory(propertyId, { throttle = (fn) => fn() } = {}) {
  const groups = await listUnitGroups({ propertyId });
  const plans = await listRatePlans({ propertyId });
  // The list endpoint omits restrictions and bookingPeriods, so each plan is fetched
  // in full: those two fields decide whether a booking is accepted at all.
  const detailed = [];
  for (const p of plans.ratePlans || []) {
    const d = await throttle(() => getRatePlan(p.id));
    detailed.push({
      id: d.id, code: d.code, unitGroupId: d.unitGroup?.id,
      restrictions: d.restrictions || {}, bookingPeriods: d.bookingPeriods || [],
      // Restrictions are inherited down the pricing chain, so the base must be known.
      baseRatePlanId: d.pricingRule?.baseRatePlan?.id || null,
    });
  }
  return {
    unitGroups: (groups.unitGroups || []).map((g) => ({ id: g.id, code: g.code, name: g.name, memberCount: g.memberCount, maxPersons: g.maxPersons })),
    ratePlans: detailed,
    ratePlanIds: new Set(detailed.map((p) => p.id)),
  };
}

/** Clone an existing rate plan's structure for the FAMILY unit group, which has none. */
export async function ensureSimRatePlan({ propertyId, apply, log }) {
  const simId = simRatePlanIdFor(propertyId);
  // NONREF-DBL carries no minAdvance, unlike FLEX-DBL; a derived plan inherits its
  // base's restrictions, and a 3-day minimum would make FAMILY unbookable on the
  // very days the occupancy curve peaks.
  const baseId = `${propertyId}-NONREF-DBL`;
  const existing = await getRatePlan(simId).catch((e) => {
    if (e instanceof ApaleoError && e.status === 404) return null;
    throw e;
  });
  if (existing) {
    log(`rate plan ${simId} already exists`);
    return simId;
  }
  const base = await getRatePlan(baseId);
  const body = {
    code: SIM_RATE_PLAN_CODE,
    propertyId,
    unitGroupId: `${propertyId}-FAMILY`,
    cancellationPolicyId: base.cancellationPolicy?.id,
    noShowPolicyId: base.noShowPolicy?.id,
    channelCodes: base.channelCodes,
    timeSliceDefinitionId: base.timeSliceDefinition?.id,
    // The code cannot carry a hyphen; the name can, so the readable marker lives here.
    // PAR marks `en` and `de` mandatory (GET /settings/v1/languages), so both must be present.
    // Supported languages are en / de / it; en and de are mandatory. "fr" is rejected
    // on some resources with "has unsupported translations".
    name: { en: `${MARKER} · Family`, de: `${MARKER} · Familie` },
    description: {
      en: 'Simulation-only rate for the Family unit group. Removed by simulate:clean.',
      de: 'Nur für Simulationen angelegter Tarif für die Kategorie Familie. Wird von simulate:clean entfernt.',
    },
    minGuaranteeType: 'Prepayment',
    priceCalculationMode: base.priceCalculationMode || 'Truncate',
    isSubjectToCityTax: base.isSubjectToCityTax ?? true,
    pricingRule: { baseRatePlanId: baseId, type: 'Absolute', value: 60 },
    // The FAMILY group holds up to 4 adults; the API requires a surcharge for every
    // occupancy above the first, otherwise: "Surcharges are missing for adults: 2, 3, 4".
    surcharges: [
      { adults: 2, type: 'Absolute', value: 10 },
      { adults: 3, type: 'Absolute', value: 35 },
      { adults: 4, type: 'Absolute', value: 55 },
    ],
    // A plan with no bookingPeriods is never open for sale: it is created without error,
    // gets rates, and then returns zero offers while every booking fails with
    // "The restrictions of the rate plan are not considered". The base plan's windows
    // are copied so the plan is explicitly bookable, and its restrictions with them,
    // so nothing is left to be inherited implicitly.
    bookingPeriods: (base.bookingPeriods || []).map((p) => ({ from: p.from, to: p.to })),
    restrictions: base.restrictions && Object.keys(base.restrictions).length ? base.restrictions : undefined,
    // Required by the API even though swagger does not list it in `required`.
    // Cloned from the base plan so the revenue lands on the same sub-account.
    // subAccountId is deliberately omitted: the base plan points at a custom
    // sub-account, and custom accounts are disabled on this property.
    accountingConfigs: (base.accountingConfigs || []).map((a) => ({
      vatType: a.vatType,
      serviceType: a.serviceType,
      validFrom: a.validFrom,
    })),
  };
  if (!body.accountingConfigs.length) {
    body.accountingConfigs = [{ vatType: 'Reduced', serviceType: 'Accommodation', validFrom: '1970-01-01' }];
  }
  if (!apply) {
    log(`[dry-run] would create rate plan ${simId} (code ${SIM_RATE_PLAN_CODE}, +60 EUR over ${baseId})`);
    return simId;
  }
  const created = await createRatePlan(body);
  log(`created rate plan ${created.id}`);
  return created.id;
}

// ---------------------------------------------------------------------------
// Booking payload
// ---------------------------------------------------------------------------
function bookingPayload(reservations, runId) {
  const first = reservations[0];
  return {
    booker: first.guest,
    comment: `${MARKER} ${runId}`,
    reservations: reservations.map((r) => ({
      arrival: r.arrival,
      departure: r.departure,
      adults: r.adults,
      channelCode: config.apaleo.channelCode,
      primaryGuest: r.guest,
      externalCode: r.externalCode,
      ...(r.comment ? { guestComment: r.comment } : {}),
      timeSlices: Array.from({ length: r.nights }, () => ({ ratePlanId: r.ratePlanId })),
    })),
  };
}

/** Pair up some same-room-type, same-date reservations so bookings are not all single-room. */
export function groupIntoBookings(reservations) {
  const buckets = new Map();
  for (const r of reservations) {
    const key = `${r.groupId}|${r.arrival}|${r.departure}|${r.role}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const bookings = [];
  for (const list of buckets.values()) {
    let i = 0;
    while (i < list.length) {
      // Pair roughly every fourth candidate; the rest stay single-room bookings.
      const pair = list.length - i >= 2 && list[i].seq % 4 === 0;
      bookings.push(pair ? [list[i], list[i + 1]] : [list[i]]);
      i += pair ? 2 : 1;
    }
  }
  return bookings.sort((a, b) => a[0].seq - b[0].seq);
}

// ---------------------------------------------------------------------------
// Probe: can we create a reservation whose arrival is in the past?
// ---------------------------------------------------------------------------
export async function probeBackdating({ plan, throttle, log }) {
  const candidate = plan.reservations.find((r) => r.arrivalOffset < 0);
  if (!candidate) return { supported: false, reason: 'plan contains no past arrival' };
  try {
    const created = await throttle(() => createBooking(bookingPayload([candidate], plan.runId), `sim-probe-${plan.runId}`));
    const reservationId = created?.reservationIds?.[0]?.id;
    log(`probe accepted: arrival ${candidate.arrival} (D${candidate.arrivalOffset}) -> ${reservationId}`);
    return { supported: true, reservationId, seq: candidate.seq, externalCode: candidate.externalCode };
  } catch (err) {
    const detail = err instanceof ApaleoError ? `${err.status} ${err.message}` : err.message;
    log(`probe refused: ${detail}`);
    return { supported: false, reason: detail };
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
export async function applyPlan({ plan, throttle, log, probeResult }) {
  const created = new Map(); // seq -> reservationId
  const failures = [];
  const receipt = `${MARKER}-${plan.runId}`;

  if (probeResult?.supported && probeResult.seq) created.set(probeResult.seq, probeResult.reservationId);

  // --- bookings ------------------------------------------------------------
  const bookings = groupIntoBookings(plan.reservations.filter((r) => !created.has(r.seq)));
  log(`creating ${bookings.length} bookings for ${plan.reservations.length} reservations…`);
  let done = 0;
  for (const group of bookings) {
    try {
      const res = await throttle(() => createBooking(bookingPayload(group, plan.runId), `sim-${plan.runId}-${group[0].seq}`));
      (res?.reservationIds || []).forEach((rid, i) => { if (group[i]) created.set(group[i].seq, rid.id); });
    } catch (err) {
      failures.push({ stage: 'booking', seq: group.map((r) => r.seq), error: err.message, status: err.status });
    }
    done += 1;
    if (done % 25 === 0) log(`  …${done}/${bookings.length} bookings`);
  }
  log(`created ${created.size}/${plan.reservations.length} reservations (${failures.length} failures)`);

  // --- assign + check-in ---------------------------------------------------
  const toCheckIn = plan.reservations.filter((r) => r.checkIn && created.has(r.seq));
  log(`assigning units and checking in ${toCheckIn.length} reservations…`);
  const checkedIn = [];
  for (const r of toCheckIn) {
    const id = created.get(r.seq);
    // Assigning a unit after the property's check-in time already moves the reservation
    // to InHouse, which makes the explicit check-in call return 422. Neither call's
    // status code is therefore a reliable signal — the reservation's own status is.
    let lastError = null;
    try {
      // AvailableUnitItemModel exposes `id` at the top level and the occupancy flag
      // under `status.isOccupied` — not `unit.id` / `isOccupied`.
      const avail = await throttle(() => listAvailableUnitsForReservation(id));
      const candidates = (avail?.units || []).filter((u) => u.id && !u.status?.isOccupied && !u.status?.maintenanceType);
      const chosen = candidates.find((u) => u.status?.condition === 'Clean') || candidates[0];
      if (chosen) await throttle(() => assignUnit(id, chosen.id));
    } catch (err) { lastError = err; }
    try {
      await throttle(() => checkInReservation(id));
    } catch (err) { lastError = err; }
    let state = null;
    try { state = await throttle(() => getReservation(id)); } catch (err) { lastError = err; }
    if (state && (state.status === 'InHouse' || state.status === 'CheckedOut')) {
      checkedIn.push({ seq: r.seq, id, role: r.role, unit: state.unit?.name || null });
    } else {
      failures.push({ stage: 'checkin', seq: r.seq, id, status: lastError?.status, error: lastError?.message || `status ${state?.status}` });
    }
  }
  log(`checked in ${checkedIn.length}/${toCheckIn.length}`);

  // --- folio charges -------------------------------------------------------
  const folioOf = new Map(); // seq -> folioId
  const chargesBySeq = new Map();
  for (const c of plan.charges) {
    if (!chargesBySeq.has(c.seq)) chargesBySeq.set(c.seq, []);
    chargesBySeq.get(c.seq).push(c);
  }
  const chargeTargets = [...chargesBySeq.keys()].filter((s) => checkedIn.some((c) => c.seq === s));
  log(`posting charges on ${chargeTargets.length} folios…`);
  let chargeCount = 0;
  for (const seq of chargeTargets) {
    const id = created.get(seq);
    try {
      const folios = await throttle(() => listFolios({ reservationIds: id }));
      const folio = (folios.folios || [])[0];
      if (!folio) { failures.push({ stage: 'folio-lookup', seq, id, error: 'no folio returned' }); continue; }
      folioOf.set(seq, folio.id);
      for (const c of chargesBySeq.get(seq)) {
        await throttle(() => postFolioCharge(folio.id, {
          name: c.name,
          amount: { amount: c.amount, currency: 'EUR' },
          serviceType: c.serviceType,
          vatType: c.vatType || 'Reduced',
          quantity: c.quantity,
          receipt,
        }));
        chargeCount += 1;
      }
    } catch (err) {
      failures.push({ stage: 'charge', seq, id, error: err.message, status: err.status });
    }
  }
  log(`posted ${chargeCount} charges`);

  // --- split folios --------------------------------------------------------
  const splitsDone = [];
  for (const split of plan.splits) {
    const id = created.get(split.seq);
    const sourceFolio = folioOf.get(split.seq);
    if (!id || !sourceFolio) continue;
    try {
      const second = await throttle(() => createFolio({
        reservationId: id,
        debitor: {
          firstName: split.secondPayer.firstName,
          name: split.secondPayer.lastName,
          email: split.secondPayer.email,
          address: split.secondPayer.address,
          reference: receipt,
        },
      }));
      const detail = await throttle(() => apaleo.get(`/finance/v1/folios/${encodeURIComponent(sourceFolio)}`));
      const movable = (detail.charges || []).filter((c) => c.receipt === receipt).map((c) => c.id);
      if (movable.length) {
        await throttle(() => moveFolioCharges(sourceFolio, {
          targetFolioId: second.id,
          reason: `${MARKER}: split between two payers`,
          chargeIds: movable.slice(0, Math.max(1, Math.floor(movable.length / 2))),
        }));
      }
      splitsDone.push({ seq: split.seq, sourceFolio, targetFolio: second.id, moved: movable.length });
    } catch (err) {
      failures.push({ stage: 'split', seq: split.seq, error: err.message, status: err.status });
    }
  }
  log(`split ${splitsDone.length} folios`);

  // --- departures: checkout, settle, invoice, close ------------------------
  const departures = plan.reservations.filter((r) => r.role === 'departure-today' && created.has(r.seq));
  log(`checking out ${departures.length} departures…`);
  const departed = [];
  for (const r of departures) {
    const id = created.get(r.seq);
    const step = {};
    try {
      await throttle(() => checkOutReservation(id));
      step.checkedOut = true;
      const folios = await throttle(() => listFolios({ reservationIds: id }));
      const folio = (folios.folios || [])[0];
      if (!folio) throw new Error('no folio after checkout');
      const detail = await throttle(() => apaleo.get(`/finance/v1/folios/${encodeURIComponent(folio.id)}`));
      // An unsettled folio reports a NEGATIVE balance (payments minus charges),
      // so the amount to collect is its absolute value.
      const due = Math.abs(detail.balance?.amount ?? 0);
      if (due > 0) {
        await throttle(() => postFolioPayment(folio.id, { method: 'Cash', amount: { amount: due, currency: detail.balance?.currency || 'EUR' }, receipt }));
        step.paid = due;
      }
      // The invoice debitor must carry a full address. Set it on the folio rather than
      // relying on it propagating from the reservation's primary guest.
      const addr = r.guest.address;
      if (addr) {
        await throttle(() => apaleo.patch(`/finance/v1/folios/${encodeURIComponent(folio.id)}`, [
          { op: 'replace', path: '/debitor', value: { firstName: r.guest.firstName, name: r.guest.lastName, address: addr } },
        ]));
      }
      const invoice = await throttle(() => createInvoice({ folioId: folio.id, languageCode: 'fr' }));
      step.invoice = invoice?.id ?? invoice?.number ?? true;
      // Creating the invoice already closes the folio; closing again is a 422, not a failure.
      await throttle(() => closeFolio(folio.id)).catch((e) => {
        if (!/closed folio or closing in progress/i.test(e.message)) step.closeSkipped = e.message;
      });
      step.closed = !step.closeSkipped;
      departed.push({ seq: r.seq, id, ...step });
    } catch (err) {
      failures.push({ stage: 'departure', seq: r.seq, id, step, error: err.message, status: err.status });
    }
  }
  log(`completed ${departed.length}/${departures.length} departures`);

  // --- cancellations -------------------------------------------------------
  const toCancel = plan.reservations.filter((r) => r.cancel && created.has(r.seq));
  log(`cancelling ${toCancel.length} reservations…`);
  let cancelled = 0;
  for (const r of toCancel) {
    const id = created.get(r.seq);
    try {
      await throttle(() => cancelReservation(id));
      cancelled += 1;
    } catch (err) {
      failures.push({ stage: 'cancel', seq: r.seq, id, error: err.message, status: err.status });
    }
  }
  log(`cancelled ${cancelled}/${toCancel.length}`);

  return {
    runId: plan.runId,
    createdCount: created.size,
    reservationIds: Object.fromEntries(created),
    checkedIn: checkedIn.length,
    charges: chargeCount,
    splits: splitsDone,
    departures: departed,
    cancelled,
    failures,
  };
}
