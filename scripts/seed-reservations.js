// Phase 2 test set: ~10 reservations arriving on --date (default tomorrow), without a room,
// each with one of the brief's comments. Uses the NONREF rate (no lead-time restriction).
//   node scripts/seed-reservations.js [--date YYYY-MM-DD] [--apply]
import { config } from '../src/config.js';
import { createBooking } from '../src/apaleoClient.js';
import { tomorrowIso } from '../src/allocationAgent.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const i = args.indexOf('--date');
const arrival = i >= 0 ? args[i + 1] : tomorrowIso();
const departure = (() => {
  const d = new Date(`${arrival}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
})();

// [lastName, unit group, adults, comment, extra reservations in the same booking]
const CASES = [
  ['Bebe', 'DBL', 2, 'Nous venons avec un bébé, on aimerait être loin de la rue et proche de l’ascenseur.'],
  ['Anniversaire', 'DBL', 2, 'Anniversaire de mariage, si possible la plus belle vue.'],
  ['Famille', 'DBL', 2, 'Deux familles, on voudrait des chambres côte à côte.', 1],
  ['Sommeil', 'SGL', 1, 'Je dors très mal, la chambre la plus calme possible.'],
  ['Nuit', 'SGL', 1, 'Arrivée vers 2h du matin, pas de bruit dans le couloir svp.'],
  ['Fauteuil', 'DBL', 2, 'Je suis en fauteuil roulant, chambre accessible.'],
  ['Enfants', 'DBL', 2, 'Chambre communicante pour mes deux enfants.', 1],
  ['Vertige', 'DBL', 2, 'Étage élevé, j’ai le vertige mais j’adore la lumière.'],
  ['Habitue', 'DBL', 2, 'Même chambre que l’année dernière, la 2.009.'],
  ['Neutre', 'SGL', 1, 'Rien de spécial, merci !'],
];

console.log(`Seeding ${CASES.length} bookings for ${arrival} → ${departure} at ${config.apaleo.propertyId} ${APPLY ? '' : '(dry-run, add --apply)'}\n`);

for (const [lastName, group, adults, comment, extra = 0] of CASES) {
  const guest = { firstName: 'Test', lastName: `Agent-${lastName}`, email: `agent.${lastName.toLowerCase()}@example.com` };
  const reservation = {
    arrival,
    departure,
    adults,
    channelCode: config.apaleo.channelCode,
    primaryGuest: guest,
    guaranteeType: 'Prepayment',
    guestComment: comment,
    timeSlices: [{ ratePlanId: `PAR-NONREF-${group}` }, { ratePlanId: `PAR-NONREF-${group}` }],
  };
  const payload = { booker: guest, reservations: Array.from({ length: 1 + extra }, () => ({ ...reservation })) };
  if (!APPLY) {
    console.log(`[dry-run] ${guest.lastName}: ${1 + extra} × ${group} "${comment}"`);
    continue;
  }
  const created = await createBooking(payload, `seed-${arrival}-${lastName}`);
  console.log(`${guest.lastName.padEnd(20)} ${created.id}  ${created.reservationIds.map((r) => r.id).join(', ')}  "${comment}"`);
}
