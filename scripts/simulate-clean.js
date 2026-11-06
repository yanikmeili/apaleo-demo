// Removes everything the simulator created, and only that.
//
//   npm run simulate:clean -- --dry-run   list what would be removed
//   npm run simulate:clean                remove it
//
// Source of truth is the API itself: reservations whose externalCode starts with
// SIMULATION-ENTRETIEN. The local manifests in .sim-runs/ are only a cross-check.
//
// Apaleo has no DELETE for reservations. A reservation can only be cancelled while it
// is Confirmed with a future arrival; InHouse and CheckedOut ones are permanent and are
// reported as such rather than silently skipped.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { listReservations, getReservation, cancelReservation, checkOutReservation, listInvoices, cancelInvoice, getRatePlan, deleteRatePlan, apaleo, ApaleoError } from '../src/apaleoClient.js';
import { MARKER } from '../src/simulation/plan.js';
import { makeThrottle, simRatePlanIdFor } from '../src/simulation/run.js';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
// --reset wipes ALL transactional data on the property in one call. It does not know
// about markers, so it is only allowed on a property that holds nothing but ours.
const RESET = argv.includes('--reset');
const i = argv.indexOf('--delay');
const DELAY = i >= 0 ? Number(argv[i + 1]) : 400;
const throttle = makeThrottle(DELAY);

console.log(`\n  Nettoyage ${MARKER} — propriété ${config.apaleo.propertyId}`);
console.log(`  ${DRY_RUN ? 'DRY-RUN — aucune écriture' : 'MODE RÉEL'}\n`);

// --- reset path --------------------------------------------------------------
if (RESET) {
  const property = await apaleo.get(`/inventory/v1/properties/${encodeURIComponent(config.apaleo.propertyId)}`);
  if (property.status !== 'Test') {
    console.error(`  ✗ REFUS : ${config.apaleo.propertyId} est en statut « ${property.status} ». Le reset exige « Test ».\n`);
    process.exit(1);
  }
  const everything = [];
  for (let page = 1; ; page += 1) {
    const res = await throttle(() => listReservations({ propertyIds: config.apaleo.propertyId, pageSize: 500, pageNumber: page }));
    const batch = res?.reservations || [];
    everything.push(...batch);
    if (batch.length < 500) break;
  }
  const foreign = everything.filter((r) => !String(r.externalCode || '').startsWith(MARKER));
  console.log(`  ${everything.length} réservations sur la propriété, dont ${foreign.length} non marquées`);
  if (foreign.length) {
    console.error(`\n  ✗ REFUS : le reset effacerait ${foreign.length} réservations qui ne viennent pas du simulateur.`);
    console.error(`    Le reset ne distingue pas les données marquées des autres. Utilise le nettoyage normal`);
    console.error(`    (sans --reset) sur cette propriété, ou vise une propriété jetable.\n`);
    for (const r of foreign.slice(0, 5)) console.error(`      ${r.id.padEnd(14)} ${r.status.padEnd(11)} ${r.arrival.slice(0, 10)}`);
    process.exit(1);
  }
  if (DRY_RUN) {
    console.log(`\n  [dry-run] PUT /inventory/v1/property-actions/${config.apaleo.propertyId}/reset`);
    console.log(`  effacerait les ${everything.length} réservations, leurs folios et leurs factures.\n`);
    process.exit(0);
  }
  try {
    await throttle(() => apaleo.put(`/inventory/v1/property-actions/${encodeURIComponent(config.apaleo.propertyId)}/reset`));
  } catch (err) {
    if (err.status === 403) {
      console.error(`\n  ✗ Le client OAuth n'a pas la permission « core.properties.reset ».`);
      console.error(`    Ajoute-la dans le dashboard développeur Apaleo, ou lance le nettoyage normal :`);
      console.error(`      APALEO_PROPERTY_ID=${config.apaleo.propertyId} npm run simulate:clean\n`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`  ✓ reset effectué — ${everything.length} réservations, folios et factures effacés`);
  const simPlanId = simRatePlanIdFor(config.apaleo.propertyId);
  const plan = await getRatePlan(simPlanId).catch(() => null);
  if (plan) {
    await throttle(() => deleteRatePlan(simPlanId)).catch((e) => console.log(`  ⚠ plan tarifaire non supprimé : ${e.message}`));
    console.log(`  ✓ plan tarifaire ${simPlanId} supprimé`);
  }
  const dir = path.join(process.cwd(), '.sim-runs');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) fs.renameSync(path.join(dir, f), path.join(dir, `${f}.cleaned`));
  console.log(`\n  Propriété ${config.apaleo.propertyId} remise à zéro.\n`);
  process.exit(0);
}

// --- find marked reservations ----------------------------------------------
const all = [];
for (let page = 1; ; page += 1) {
  const res = await throttle(() => listReservations({ propertyIds: config.apaleo.propertyId, externalCode: MARKER, pageSize: 500, pageNumber: page }));
  const batch = res?.reservations || [];
  all.push(...batch);
  if (batch.length < 500) break;
}

if (!all.length) {
  console.log(`  Aucune réservation marquée ${MARKER}. Rien à faire.\n`);
  process.exit(0);
}

const byStatus = {};
for (const r of all) (byStatus[r.status] ||= []).push(r);
console.log(`  ${all.length} réservations marquées :`);
for (const [status, list] of Object.entries(byStatus)) console.log(`    ${status.padEnd(12)} ${list.length}`);

// Safety: nothing without the marker may ever be touched.
const unmarked = all.filter((r) => !String(r.externalCode || '').startsWith(MARKER));
if (unmarked.length) {
  console.error(`\n  ✗ ABANDON : ${unmarked.length} réservations sans le marqueur sont remontées du filtre. Aucune écriture.`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const cancellable = all.filter((r) => r.status === 'Confirmed' && r.arrival.slice(0, 10) > today);
const stuck = all.filter((r) => !cancellable.includes(r) && r.status !== 'Canceled');

console.log(`\n  Annulables          ${cancellable.length}  (Confirmed, arrivée future)`);
console.log(`  Non supprimables    ${stuck.length}  (InHouse / CheckedOut / arrivée du jour — Apaleo n'offre aucun DELETE)`);

// --- invoices ---------------------------------------------------------------
const simReservationIds = all.map((r) => r.id);
let invoices = [];
for (let k = 0; k < simReservationIds.length; k += 50) {
  const chunk = simReservationIds.slice(k, k + 50);
  const res = await throttle(() => listInvoices({ reservationIds: chunk, pageSize: 100 }));
  invoices.push(...(res?.invoices || []));
}
const openInvoices = invoices.filter((inv) => inv.status !== 'Canceled');
console.log(`  Factures SIM        ${openInvoices.length}`);

// --- rate plan ---------------------------------------------------------------
const simPlan = await getRatePlan(simRatePlanIdFor(config.apaleo.propertyId)).catch((e) => (e instanceof ApaleoError && e.status === 404 ? null : null));
console.log(`  Plan tarifaire SIM  ${simPlan ? simRatePlanIdFor(config.apaleo.propertyId) : '(absent)'}`);

if (DRY_RUN) {
  console.log(`\n  Détail des annulations prévues :`);
  for (const r of cancellable.slice(0, 15)) console.log(`    ${r.id.padEnd(14)} ${r.arrival.slice(0, 10)} ${r.externalCode}`);
  if (cancellable.length > 15) console.log(`    … et ${cancellable.length - 15} autres`);
  if (stuck.length) {
    console.log(`\n  Resteront en place (non supprimables) :`);
    for (const r of stuck.slice(0, 10)) console.log(`    ${r.id.padEnd(14)} ${r.status.padEnd(11)} ${r.arrival.slice(0, 10)} ${r.externalCode}`);
    if (stuck.length > 10) console.log(`    … et ${stuck.length - 10} autres`);
  }
  console.log(`\n  Dry-run terminé. Rien n'a été écrit.\n`);
  process.exit(0);
}

// --- apply -------------------------------------------------------------------
let cancelled = 0;
const failures = [];
for (const inv of openInvoices) {
  try { await throttle(() => cancelInvoice(inv.id)); } catch (err) { failures.push({ stage: 'invoice', id: inv.id, error: err.message }); }
}
console.log(`\n  Factures annulées   ${openInvoices.length - failures.filter((f) => f.stage === 'invoice').length}/${openInvoices.length}`);

for (const r of cancellable) {
  try { await throttle(() => cancelReservation(r.id)); cancelled += 1; }
  catch (err) { failures.push({ stage: 'reservation', id: r.id, error: err.message, status: err.status }); }
}
console.log(`  Réservations annulées ${cancelled}/${cancellable.length}`);

// An InHouse reservation cannot be cancelled and cannot be deleted, but it CAN be
// checked out — which is what actually frees the room for the next run. Check-out only
// accepts a departure no later than tomorrow, so longer stays are shortened first.
const inHouse = all.filter((r) => r.status === 'InHouse');
if (inHouse.length) {
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  let out = 0;
  let shortened = 0;
  for (const r of inHouse) {
    try {
      if (r.departure.slice(0, 10) > tomorrow) {
        const full = await throttle(() => getReservation(r.id, ['timeSlices']));
        const ratePlanId = full.timeSlices?.[0]?.ratePlan?.id || full.ratePlan?.id;
        const nights = Math.max(1, Math.round((Date.parse(tomorrow) - Date.parse(r.arrival.slice(0, 10))) / 86400000));
        await throttle(() => apaleo.put(`/booking/v1/reservation-actions/${encodeURIComponent(r.id)}/amend`, {
          arrival: r.arrival.slice(0, 10), departure: tomorrow, adults: r.adults,
          timeSlices: Array.from({ length: nights }, () => ({ ratePlanId })),
        }));
        shortened += 1;
      }
      await throttle(() => checkOutReservation(r.id));
      out += 1;
    } catch (err) {
      failures.push({ stage: 'checkout', id: r.id, error: err.message, status: err.status });
    }
  }
  console.log(`  Clients sortis        ${out}/${inHouse.length}${shortened ? ` (${shortened} séjours raccourcis)` : ''}`);
}

if (simPlan) {
  try { await throttle(() => deleteRatePlan(simRatePlanIdFor(config.apaleo.propertyId))); console.log(`  Plan tarifaire supprimé ${simRatePlanIdFor(config.apaleo.propertyId)}`); }
  catch (err) { failures.push({ stage: 'rateplan', id: simRatePlanIdFor(config.apaleo.propertyId), error: err.message, status: err.status }); console.log(`  ⚠ plan tarifaire non supprimé : ${err.message}`); }
}

const dir = path.join(process.cwd(), '.sim-runs');
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    fs.renameSync(path.join(dir, f), path.join(dir, `${f}.cleaned`));
  }
}

if (failures.length) {
  console.log(`\n  ⚠ ${failures.length} échecs :`);
  for (const f of failures.slice(0, 10)) console.log(`    ${f.stage.padEnd(12)} ${f.id} — ${f.status || ''} ${f.error}`);
}
if (stuck.length) {
  console.log(`\n  ⚠ ${stuck.length} réservations marquées restent dans Apaleo (InHouse / CheckedOut).`);
  console.log(`    Apaleo n'offre aucune suppression de réservation ; elles restent identifiables par leur externalCode.`);
}
console.log(`\n  Nettoyage terminé.\n`);
