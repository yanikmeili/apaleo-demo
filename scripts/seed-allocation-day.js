// Prepares one day for the room-allocation demo: frees enough rooms, then seeds the
// commented arrivals the agent has to reason about.
//
//   node scripts/seed-allocation-day.js --date 2026-11-14            # dry-run
//   node scripts/seed-allocation-day.js --date 2026-11-14 --apply
//
// The simulator only comments about one arrival in ten, so a given day usually has
// none worth showing. Rather than raise that rate everywhere, the demo day is staged:
// uncommented filler is cancelled to make room, and the cases are booked in its place,
// which keeps the day's occupancy roughly where the curve put it.
import { config } from '../src/config.js';
import { createBooking, listReservations, cancelReservation } from '../src/apaleoClient.js';
import { MARKER } from '../src/simulation/plan.js';
import { ALLOCATION_CASES, CASE_DEMAND } from '../src/simulation/allocationCases.js';
import { makeThrottle } from '../src/simulation/run.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const P = config.apaleo.propertyId;
const NIGHTS = Number(opt('nights', '2'));

const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const arrival = opt('date', plusDays(new Date().toISOString().slice(0, 10), 4));
const departure = plusDays(arrival, NIGHTS);
const today = new Date().toISOString().slice(0, 10);
const throttle = makeThrottle(400);

if (arrival <= today) {
  console.error(`\n  ${arrival} n'est pas dans le futur : une arrivée passée est refusée par Apaleo.\n`);
  process.exit(1);
}

console.log(`\n  Journée d'attribution — ${P} · ${arrival} → ${departure}${APPLY ? '' : '  (dry-run)'}\n`);

// --- 1. free enough rooms -----------------------------------------------------
const page = async (q) => { const o = []; for (let p = 1; ; p += 1) { const r = await listReservations({ ...q, pageSize: 500, pageNumber: p }); const b = r?.reservations || []; o.push(...b); if (b.length < 500) break; } return o; };
const all = await page({ propertyIds: P });

const overlapping = all.filter((r) =>
  String(r.externalCode || '').startsWith(MARKER)
  && r.status === 'Confirmed'
  && r.arrival.slice(0, 10) > today
  && !(r.guestComment || '').trim()
  && r.arrival.slice(0, 10) < departure && r.departure.slice(0, 10) > arrival);

const toCancel = [];
for (const [group, count] of Object.entries(CASE_DEMAND)) {
  const pick = overlapping.filter((r) => r.unitGroup?.id === `${P}-${group}`).slice(0, count);
  toCancel.push(...pick);
  if (pick.length < count) console.log(`  ⚠ ${group} : seulement ${pick.length} réservation(s) libérable(s) sur ${count} souhaitée(s)`);
}
// Never touch anything that is not ours.
if (toCancel.some((r) => !String(r.externalCode || '').startsWith(MARKER))) {
  console.error('\n  ABANDON : une cible ne porte pas le marqueur.\n');
  process.exit(1);
}
console.log(`  Remplissage sans commentaire à annuler : ${toCancel.length}`);

if (APPLY) {
  let done = 0;
  for (const r of toCancel) {
    try { await throttle(() => cancelReservation(r.id)); done += 1; }
    catch (err) { console.log(`    ✗ ${r.id} ${err.message}`); }
  }
  console.log(`  annulées : ${done}/${toCancel.length}`);
}

// --- 2. seed the cases --------------------------------------------------------
console.log(`\n  Cas à semer : ${ALLOCATION_CASES.length} réservations commentées`);
const runId = `alloc-${arrival.replace(/-/g, '')}`;
let seq = 0;
let created = 0;

for (const [lastName, group, adults, comment, extra = 0] of ALLOCATION_CASES) {
  const guest = { firstName: 'Test', lastName: `Agent-${lastName}`, email: `agent.${lastName.toLowerCase()}@example.com` };
  const reservations = Array.from({ length: 1 + extra }, () => {
    seq += 1;
    return {
      arrival,
      departure,
      adults,
      channelCode: config.apaleo.channelCode,
      primaryGuest: guest,
      guaranteeType: 'Prepayment',
      guestComment: comment,
      // Marked like everything else, so simulate:clean can take them away again.
      externalCode: `${MARKER}-${runId}-${String(seq).padStart(4, '0')}`,
      timeSlices: Array.from({ length: NIGHTS }, () => ({ ratePlanId: `${P}-NONREF-${group}` })),
    };
  });
  if (!APPLY) {
    console.log(`    [dry-run] ${guest.lastName.padEnd(20)} ${1 + extra} × ${group}  « ${comment.slice(0, 50)} »`);
    continue;
  }
  try {
    const booking = await throttle(() => createBooking({ booker: guest, comment: `${MARKER} ${runId}`, reservations }, `${runId}-${lastName}`));
    created += reservations.length;
    console.log(`    ${guest.lastName.padEnd(20)} ${booking.id}  ${booking.reservationIds.map((r) => r.id).join(', ')}`);
  } catch (err) {
    console.log(`    ✗ ${guest.lastName} ${err.status ?? ''} ${err.message}`);
  }
}

console.log(APPLY
  ? `\n  ${created} réservations commentées créées pour le ${arrival}.\n`
  : `\n  Dry-run : rien n'a été écrit. Ajouter --apply.\n`);
