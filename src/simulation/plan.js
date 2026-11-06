// Deterministic plan builder for the hotel simulator.
//
// Pure: no network. Given today's date and the live inventory, it returns the
// full list of reservations and follow-up actions to apply. The same seed always
// produces the same plan, so `--dry-run` shows exactly what the real run writes.
//
// Marker (validated against swagger):
//   reservation.externalCode  -> no declared maxLength/pattern  -> "SIMULATION-ENTRETIEN-<runId>-<seq>"
//   ratePlan.code             -> maxLength 20, ^[a-zA-Z0-9_]*$  -> "SIMULATION_ENTRETIEN" (hyphen is rejected)

export const MARKER = 'SIMULATION-ENTRETIEN';
export const SIM_RATE_PLAN_CODE = 'SIMULATION_ENTRETIEN';
export const HORIZON_DAYS = 21;
// Rooms a stay may push a later day above its target before it gets shortened.
const SPILL_TOLERANCE = 1;

// Occupancy: 85% on D+0..D+2, then linear down to 40% on D+21.
export function occupancyFor(day) {
  if (day <= 2) return 0.85;
  return 0.85 - (0.45 * (day - 2)) / (HORIZON_DAYS - 2);
}

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
function weighted(rnd, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [value, w] of pairs) {
    r -= w;
    if (r <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Guest data
// ---------------------------------------------------------------------------
const FIRST_NAMES = ['Camille', 'Julien', 'Sophie', 'Marc', 'Élodie', 'Thomas', 'Nathalie', 'Antoine', 'Claire', 'Nicolas',
  'Laure', 'Vincent', 'Hélène', 'Mathieu', 'Sandrine', 'Olivier', 'Céline', 'Guillaume', 'Isabelle', 'Pierre',
  'Anna', 'Lukas', 'Marta', 'Stefan', 'Emma', 'Lucas', 'Chloé', 'Maxime', 'Inès', 'Hugo'];
const LAST_NAMES = ['Durand', 'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Moreau', 'Simon',
  'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'Roux', 'Fournier', 'Girard', 'Bonnet', 'Lambert', 'Fontaine',
  'Schneider', 'Weber', 'Rossi', 'Conti', 'Novak', 'Keller', 'Jansen', 'Silva', 'Moreno', 'Haas'];

const CITIES = [
  ['Lyon', '69003', 'FR'], ['Bordeaux', '33000', 'FR'], ['Lille', '59000', 'FR'], ['Nantes', '44000', 'FR'],
  ['Genève', '1201', 'CH'], ['Bruxelles', '1000', 'BE'], ['Munich', '80331', 'DE'], ['Milan', '20121', 'IT'],
];
const STREETS = ['12 rue des Lilas', '4 avenue Victor Hugo', '28 boulevard Saint-Michel', '7 place du Marché',
  '91 rue de la Gare', '3 impasse des Vignes', '45 cours Lafayette', '18 rue Neuve'];

// ~10% of reservations carry one of these.
const COMMENTS = [
  'Nous venons avec un bébé, une chambre calme loin de la rue serait idéale.',
  'Je dors très mal, merci de prévoir la chambre la plus silencieuse possible.',
  'Anniversaire de mariage, si vous avez une belle vue nous sommes preneurs.',
  'Arrivée tardive vers 23h30, merci de garder la réservation.',
  'Étage élevé si possible, nous aimons la lumière.',
  'Je me déplace en fauteuil roulant, il me faut une chambre accessible.',
  'Deux chambres côte à côte si possible, nous voyageons en famille.',
  'Merci d’éviter une chambre près de l’ascenseur, le bruit me réveille.',
  'Lit bébé nécessaire, merci de confirmer.',
  'Voyage d’affaires, j’aurais besoin d’un bureau correct dans la chambre.',
  'Nous fêtons un départ à la retraite, un petit mot serait apprécié.',
  'Allergie à la plume, merci de prévoir des oreillers synthétiques.',
  'Si une chambre côté cour est libre, nous la préférons.',
  'Arrivée en voiture, une place de parking est-elle possible ?',
  'Dernier étage souhaité, nous apprécions le calme.',
  'Chambre non-fumeur impérative, merci.',
  'Nous repartons tôt le matin, merci de préparer la note la veille.',
  'Séjour en amoureux, une petite attention ferait plaisir.',
  'Je suis sensible au bruit de la climatisation, merci d’en tenir compte.',
  'Première visite à Paris, tout conseil est bienvenu !',
];

function makeGuest(rnd, { withAddress = false } = {}) {
  const firstName = pick(rnd, FIRST_NAMES);
  const lastName = pick(rnd, LAST_NAMES);
  const slug = `${firstName}.${lastName}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z.]/g, '');
  const guest = { firstName, lastName, email: `${slug}@example.com` };
  if (withAddress) {
    const [city, postalCode, countryCode] = pick(rnd, CITIES);
    guest.address = { addressLine1: pick(rnd, STREETS), city, postalCode, countryCode };
  }
  return guest;
}

// ---------------------------------------------------------------------------
// Rate plan selection
// ---------------------------------------------------------------------------
// Rate plan eligibility is read from the live configuration rather than assumed.
// Reading only `restrictions.minAdvance.days` is not enough: PAR-EARLY-SGL carries
// minAdvance { months: 2 }, and PAR-PROMO-* is confined to a bookingPeriod window.
// Getting either wrong produces "The restrictions of the rate plan are not considered".
function leadDaysOf(advance) {
  if (!advance) return null;
  return (advance.days || 0) + (advance.months || 0) * 30 + (advance.hours || 0) / 24;
}

const hasOwnRestrictions = (plan) => Object.keys(plan?.restrictions || {}).length > 0;

/**
 * A derived rate plan that declares NO restrictions of its own falls back to its base
 * plan's — which is why a plan with empty `restrictions` can still be rejected with
 * "The restrictions of the rate plan are not considered". A plan that declares any
 * restriction uses only its own: NONREF-DBL declares maxAdvance and books fine on D+0
 * even though its base FLEX-DBL carries a 3-day minAdvance.
 * `byId` maps rate plan id -> plan; omit it to check a single plan in isolation.
 */
export function isRatePlanEligible(plan, arrival, today, byId = null) {
  const lead = Math.round((Date.parse(`${arrival}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const at = Date.parse(`${arrival}T12:00:00Z`);

  // Resolve which plan's restrictions actually apply.
  const seen = new Set();
  let source = plan;
  while (source && !hasOwnRestrictions(source) && source.baseRatePlanId && byId && !seen.has(source.id)) {
    seen.add(source.id);
    const base = byId.get(source.baseRatePlanId);
    if (!base) break;
    source = base;
  }

  // minAdvance is enforced against the actual booking time, not the calendar day, so an
  // arrival exactly minAdvance days out is rejected when booked late in the day. One
  // day of margin avoids that boundary rather than guessing at the hour.
  const min = leadDaysOf(source?.restrictions?.minAdvance);
  if (min !== null && lead < min + 1) return false;
  const max = leadDaysOf(source?.restrictions?.maxAdvance);
  if (max !== null && lead > max) return false;

  // Booking periods are checked on the plan itself, falling back the same way.
  const periods = (plan.bookingPeriods?.length ? plan.bookingPeriods : source?.bookingPeriods) || [];
  if (periods.length && !periods.some((p) => at >= Date.parse(p.from) && at <= Date.parse(p.to))) return false;
  return true;
}

function ratePlansFor(groupId, arrival, today, ratePlans, simRatePlanId, byId) {
  const eligible = (p) => isRatePlanEligible(p, arrival, today, byId);
  if (groupCode(groupId) === 'FAMILY') {
    const sim = simRatePlanId ? byId?.get(simRatePlanId) : null;
    if (!simRatePlanId) return [];
    // The simulation plan may not be in the inventory yet on a first run; if it is,
    // its inherited restrictions still apply.
    return !sim || eligible(sim) ? [simRatePlanId] : [];
  }
  return ratePlans
    .filter((p) => p.unitGroupId === groupId)
    .filter((p) => !/-DAY-/.test(p.id)) // day-use rates are not overnight stays
    .filter(eligible)
    .map((p) => p.id);
}

/** "DEMO-FAMILY" -> "FAMILY". Unit group ids are "<propertyId>-<code>". */
export const groupCode = (groupId) => String(groupId).split('-').slice(1).join('-');

function adultsFor(rnd, groupId) {
  const code = groupCode(groupId);
  if (code === 'SGL') return 1;
  if (code === 'FAMILY') return weighted(rnd, [[2, 3], [3, 4], [4, 3]]);
  return weighted(rnd, [[1, 2], [2, 8]]);
}

const nightsFor = (rnd) => weighted(rnd, [[1, 25], [2, 35], [3, 20], [4, 12], [5, 8]]);

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {string} opts.today        ISO date
 * @param {string} opts.runId        marker run id
 * @param {Array}  opts.unitGroups   [{ id, memberCount }]
 * @param {Array}  opts.ratePlans   live rate plans [{ id, unitGroupId, restrictions, bookingPeriods }]
 * @param {string} opts.simRatePlanId id the SIM family plan will have (or null)
 * @param {number} opts.scale        volume multiplier
 * @param {number} opts.seed
 * @param {boolean} opts.allowBackdating  false -> no past arrivals (probe fallback)
 */
export function buildPlan({ today, runId, unitGroups, ratePlans, simRatePlanId, scale = 1, seed = 20261106, allowBackdating = true, existingOccupancy = null }) {
  const rnd = mulberry32(seed);
  const reservations = [];
  let seq = 0;

  const sizeOf = Object.fromEntries(unitGroups.map((g) => [g.id, g.memberCount]));
  const idOf = (code) => unitGroups.find((g) => groupCode(g.id) === code)?.id || null;
  const byId = new Map(ratePlans.map((p) => [p.id, p]));
  // occupied[groupId][dayOffset] -> rooms in use. Seeded with what the property already
  // holds, so the plan tops the house up to the target instead of overselling it.
  const occupied = {};
  for (const g of unitGroups) {
    occupied[g.id] = new Array(HORIZON_DAYS + 8).fill(0);
    const pre = existingOccupancy?.[g.id];
    if (pre) for (let d = 0; d < pre.length && d < occupied[g.id].length; d += 1) occupied[g.id][d] = pre[d];
  }
  const preexisting = Object.fromEntries(unitGroups.map((g) => [g.id, (existingOccupancy?.[g.id] || []).slice(0, HORIZON_DAYS + 1)]));

  const hasRoom = (groupId, arrivalOffset, nights) => {
    for (let d = Math.max(0, arrivalOffset); d < arrivalOffset + nights && d <= HORIZON_DAYS; d += 1) {
      if (occupied[groupId][d] >= sizeOf[groupId]) return false;
    }
    return true;
  };

  const add = ({ groupId, arrivalOffset, nights, role, cancel = false, withAddress = false }) => {
    const arrival = addDays(today, arrivalOffset);
    const plans = ratePlansFor(groupId, arrival, today, ratePlans, simRatePlanId, byId);
    if (!plans.length) return null;
    // Every caller goes through this guard, not just the curve fill: overselling here is
    // what Apaleo rejects with "The unit group is already fully booked".
    if (!hasRoom(groupId, arrivalOffset, nights)) return null;
    seq += 1;
    const departure = addDays(today, arrivalOffset + nights);
    const guest = makeGuest(rnd, { withAddress });
    const r = {
      seq,
      externalCode: `${MARKER}-${runId}-${String(seq).padStart(4, '0')}`,
      groupId,
      ratePlanId: pick(rnd, plans),
      arrival,
      departure,
      arrivalOffset,
      nights,
      adults: adultsFor(rnd, groupId),
      guest,
      comment: rnd() < 0.1 ? pick(rnd, COMMENTS) : null,
      role,
      cancel,
    };
    reservations.push(r);
    for (let d = Math.max(0, arrivalOffset); d < arrivalOffset + nights && d <= HORIZON_DAYS; d += 1) {
      occupied[groupId][d] += 1;
    }
    return r;
  };

  // --- 1. In-house guests and today's departures ---------------------------
  // Apaleo refuses a past arrival date ("Cannot set the arrival date to yesterday
  // after check-out time"), so when backdating is unavailable the same scenes are
  // staged from today: guests arrive today, and departures are same-day check-outs
  // of a one-night stay (check-out allows departure up to tomorrow).
  const past = { inHouse: [], departures: [] };
  if (!allowBackdating) {
    const departureMix = [['SGL', Math.round(3 * scale)], ['DBL', Math.round(5 * scale)]];
    for (const [code, n] of departureMix) {
      const groupId = idOf(code);
      for (let i = 0; i < n && groupId; i += 1) {
        const r = add({ groupId, arrivalOffset: 0, nights: 1, role: 'departure-today', withAddress: true });
        if (r) past.departures.push(r.seq);
      }
    }
  }
  if (allowBackdating) {
    const inHouseMix = [['SGL', Math.round(8 * scale)], ['DBL', Math.round(9 * scale)], ['FAMILY', Math.round(1 * scale)]];
    for (const [code, n] of inHouseMix) {
      const groupId = idOf(code);
      for (let i = 0; i < n && groupId; i += 1) {
        const arrivalOffset = -weighted(rnd, [[1, 4], [2, 3], [3, 2], [4, 1]]);
        const nights = -arrivalOffset + weighted(rnd, [[1, 4], [2, 3], [3, 2]]);
        const r = add({ groupId, arrivalOffset, nights, role: 'inhouse' });
        if (r) past.inHouse.push(r.seq);
      }
    }
    const departureMix = [['SGL', Math.round(3 * scale)], ['DBL', Math.round(5 * scale)]];
    for (const [code, n] of departureMix) {
      const groupId = idOf(code);
      for (let i = 0; i < n && groupId; i += 1) {
        const nights = weighted(rnd, [[1, 3], [2, 4], [3, 2]]);
        const r = add({ groupId, arrivalOffset: -nights, nights, role: 'departure-today', withAddress: true });
        if (r) past.departures.push(r.seq);
      }
    }
  }

  // --- 2. Fill the 21-day curve, per unit group ----------------------------
  for (let day = 0; day <= HORIZON_DAYS; day += 1) {
    for (const g of unitGroups) {
      const target = Math.round(sizeOf[g.id] * occupancyFor(day) * scale);
      let guard = 0;
      while (occupied[g.id][day] < target && guard < 200) {
        guard += 1;
        let nights = nightsFor(rnd);
        // Shorten the stay until it fits rather than dropping the reservation, and
        // until it stops pushing later days above their own target: stays spilling out
        // of the three peak days otherwise spike the day right after them.
        const targetOn = (d) => Math.round(sizeOf[g.id] * occupancyFor(d) * scale);
        const overshoots = (n) => {
          for (let d = day + 1; d < day + n && d <= HORIZON_DAYS; d += 1) {
            if (occupied[g.id][d] + 1 > targetOn(d) + SPILL_TOLERANCE) return true;
          }
          return false;
        };
        while (nights > 1 && (!hasRoom(g.id, day, nights) || overshoots(nights))) nights -= 1;
        // Cancellations only where the API allows them: arrival strictly in the future.
        const cancel = day >= 1 && rnd() < 0.05;
        const r = add({ groupId: g.id, arrivalOffset: day, nights, role: day === 0 ? 'arrival-today' : 'pipeline', cancel });
        if (!r) break;
      }
    }
  }

  // --- 3. Today's arrivals to check in -------------------------------------
  const arrivalsToday = reservations.filter((r) => r.role === 'arrival-today' && !r.cancel);
  // Without backdating there are no guests who arrived on an earlier day, so more of
  // today's arrivals are checked in to keep the house visibly occupied.
  const checkInTarget = Math.round((allowBackdating ? 12 : 30) * scale);
  const toCheckIn = arrivalsToday.slice(0, Math.max(1, checkInTarget)).map((r) => r.seq);
  for (const r of reservations) if (toCheckIn.includes(r.seq)) r.checkIn = true;
  for (const r of reservations) if (r.role === 'inhouse' || r.role === 'departure-today') r.checkIn = true;

  // --- 4. Folio activity ----------------------------------------------------
  const stayingSeqs = reservations.filter((r) => r.role === 'inhouse' || r.checkIn).map((r) => r.seq);
  const charges = [];
  for (const s of stayingSeqs) {
    // VAT follows the French rates configured on the property: Reduced = 10% (food,
    // soft drinks), Normal = 20% (alcohol). Aligned on the PAR-BRKF / PAR-DRINK prices.
    if (rnd() < 0.55) charges.push({ seq: s, name: 'Petit-déjeuner', amount: 15, serviceType: 'FoodAndBeverages', vatType: 'Reduced', quantity: weighted(rnd, [[1, 5], [2, 4]]) });
    if (rnd() < 0.4) charges.push({ seq: s, name: 'Bar — boissons', amount: 7.5, serviceType: 'FoodAndBeverages', vatType: 'Normal', quantity: weighted(rnd, [[1, 4], [2, 3], [3, 1]]) });
    if (rnd() < 0.12) charges.push({ seq: s, name: 'Minibar', amount: 9, serviceType: 'FoodAndBeverages', vatType: 'Reduced', quantity: 1 });
  }
  // Split a folio only where it stays open afterwards, so never on a departure.
  const splitCandidates = reservations
    .filter((r) => r.checkIn && r.role !== 'departure-today' && charges.some((c) => c.seq === r.seq))
    .slice(0, 2);
  const splits = splitCandidates.map((r) => ({ seq: r.seq, secondPayer: makeGuest(rnd, { withAddress: true }) }));

  return {
    runId,
    marker: MARKER,
    today,
    seed,
    scale,
    allowBackdating,
    preexisting,
    simRatePlan: simRatePlanId ? { id: simRatePlanId, code: SIM_RATE_PLAN_CODE } : null,
    reservations,
    charges,
    splits,
    summary: summarise(reservations, charges, splits, occupied, sizeOf, unitGroups),
  };
}

function summarise(reservations, charges, splits, occupied, sizeOf, unitGroups) {
  const totalRooms = unitGroups.reduce((s, g) => s + sizeOf[g.id], 0);
  const perDay = [];
  for (let d = 0; d <= HORIZON_DAYS; d += 1) {
    const used = unitGroups.reduce((s, g) => s + occupied[g.id][d], 0);
    perDay.push({ day: d, rooms: used, pct: Math.round((used / totalRooms) * 100), target: Math.round(occupancyFor(d) * 100) });
  }
  const byRole = {};
  const byGroup = {};
  for (const r of reservations) {
    byRole[r.role] = (byRole[r.role] || 0) + 1;
    byGroup[r.groupId] = (byGroup[r.groupId] || 0) + 1;
  }
  return {
    reservations: reservations.length,
    roomNights: reservations.reduce((s, r) => s + r.nights, 0),
    cancellations: reservations.filter((r) => r.cancel).length,
    withComment: reservations.filter((r) => r.comment).length,
    checkIns: reservations.filter((r) => r.checkIn).length,
    departures: reservations.filter((r) => r.role === 'departure-today').length,
    charges: charges.length,
    splits: splits.length,
    byRole,
    byGroup,
    perDay,
    totalRooms,
  };
}
