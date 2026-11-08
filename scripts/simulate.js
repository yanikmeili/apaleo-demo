// Hotel simulator: fills property PAR with a realistic 21-day booking curve.
//
//   npm run simulate -- --dry-run     show the plan, write nothing
//   npm run simulate                  apply it
//   npm run simulate -- --scale 0.5   half the volume
//   npm run simulate -- --delay 600   slow the calls down further
//
// Everything written is marked SIMULATION-ENTRETIEN and removable with `npm run simulate:clean`.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { buildPlan, occupancyFor, HORIZON_DAYS, MARKER } from '../src/simulation/plan.js';
import { fetchInventory, fetchExistingOccupancy, ensureSimRatePlan, makeThrottle, probeBackdating, applyPlan, simRatePlanIdFor } from '../src/simulation/run.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const DRY_RUN = argv.includes('--dry-run');
// Apaleo refuses a past arrival date on this tenant; --no-backdating previews the
// fallback shape without waiting for the probe to discover it again.
const NO_BACKDATING = argv.includes('--no-backdating');
// --json prints the dry-run plan as one JSON object instead of the text report,
// so the ops UI consumes the same code path the CLI does.
const AS_JSON = argv.includes('--json');
const SCALE = Number(flag('scale', '1'));
const DELAY = Number(flag('delay', '400'));
const SEED = Number(flag('seed', '20261106'));

const today = new Date().toISOString().slice(0, 10);
const now = new Date();
const runId = `${today.replace(/-/g, '')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
const log = (msg) => console.log(msg);

const bar = (pct) => '█'.repeat(Math.round(pct / 3)).padEnd(34, '·');

console.log(`\n  Simulateur d'hôtel — propriété ${config.apaleo.propertyId}`);
console.log(`  marquage ${MARKER}  ·  run ${runId}  ·  seed ${SEED}  ·  scale ${SCALE}`);
console.log(`  ${DRY_RUN ? 'DRY-RUN — aucune écriture dans Apaleo' : 'MODE RÉEL — écriture dans Apaleo'}\n`);

const inventory = await fetchInventory(config.apaleo.propertyId, { throttle: makeThrottle(250) });
const totalRooms = inventory.unitGroups.reduce((s, g) => s + g.memberCount, 0);
console.log(`  Inventaire : ${totalRooms} chambres — ${inventory.unitGroups.map((g) => `${g.memberCount} ${g.code}`).join(', ')}`);

const familyNeedsPlan = inventory.unitGroups.some((g) => g.id.endsWith('-FAMILY'))
  && ![...inventory.ratePlanIds].some((id) => id.endsWith('-FAMILY'));
const simRatePlanId = familyNeedsPlan ? simRatePlanIdFor(config.apaleo.propertyId) : [...inventory.ratePlanIds].find((id) => id.endsWith('-FAMILY'));
if (familyNeedsPlan) console.log(`  FAMILY sans tarif → plan ${simRatePlanIdFor(config.apaleo.propertyId)} ${DRY_RUN ? '(à créer)' : 'sera créé'}`);

const existingOccupancy = await fetchExistingOccupancy({ propertyId: config.apaleo.propertyId, today, horizonDays: HORIZON_DAYS, unitGroups: inventory.unitGroups });
const preTotal = inventory.unitGroups.reduce((s, g) => s + (existingOccupancy[g.id]?.[0] || 0), 0);
console.log(`  Déjà occupé aujourd'hui : ${preTotal}/${totalRooms} chambres (réservations existantes, le plan complète sans survendre)`);

const plan = buildPlan({ today, runId, unitGroups: inventory.unitGroups, ratePlans: inventory.ratePlans, simRatePlanId, scale: SCALE, seed: SEED, allowBackdating: !NO_BACKDATING, existingOccupancy });
const s = plan.summary;

console.log(`\n  ── Courbe d'occupation ──────────────────────────────────────────`);
for (const d of s.perDay) {
  const mark = d.day === 0 ? ' ← aujourd’hui' : '';
  console.log(`  J+${String(d.day).padStart(2)}  ${bar(d.pct)} ${String(d.pct).padStart(3)}%  (cible ${d.target}%)  ${String(d.rooms).padStart(2)}/${s.totalRooms}${mark}`);
}

console.log(`\n  ── Volumétrie ───────────────────────────────────────────────────`);
console.log(`  Réservations        ${s.reservations}`);
console.log(`  Nuitées             ${s.roomNights}`);
console.log(`  Par catégorie       ${Object.entries(s.byGroup).map(([k, v]) => `${k.replace(`${config.apaleo.propertyId}-`, '')} ${v}`).join('  ·  ')}`);
console.log(`  Par rôle            ${Object.entries(s.byRole).map(([k, v]) => `${k} ${v}`).join('  ·  ')}`);
console.log(`  Avec commentaire    ${s.withComment} (${Math.round((s.withComment / s.reservations) * 100)}%)`);
console.log(`  Annulations         ${s.cancellations} (${Math.round((s.cancellations / s.reservations) * 100)}%)`);
console.log(`  Check-ins           ${s.checkIns}`);
console.log(`  Départs du jour     ${s.departures}  (check-out + paiement Cash + facture + clôture)`);
console.log(`  Consommations       ${s.charges}`);
console.log(`  Folios divisés      ${s.splits}`);

const estCalls = s.reservations + s.checkIns * 2 + s.charges + s.departures * 6 + s.cancellations + s.splits * 3 + 20;
console.log(`\n  Appels API estimés  ~${estCalls} à ${DELAY} ms → ~${Math.round((estCalls * DELAY) / 1000)} s`);

console.log(`\n  ── Échantillon ──────────────────────────────────────────────────`);
for (const r of plan.reservations.slice(0, 8)) {
  console.log(`  ${r.externalCode}  ${r.arrival}→${r.departure}  ${r.groupId.replace(`${config.apaleo.propertyId}-`, '').padEnd(6)} ${r.adults}p  ${r.ratePlanId.padEnd(22)} ${r.role}${r.cancel ? ' [annulée]' : ''}`);
  if (r.comment) console.log(`      « ${r.comment} »`);
}

if (DRY_RUN && AS_JSON) {
  process.stdout.write(`\n__PLAN_JSON__${JSON.stringify({
    propertyId: config.apaleo.propertyId,
    runId, seed: SEED, scale: SCALE, delayMs: DELAY,
    totalRooms: s.totalRooms,
    unitGroups: inventory.unitGroups.map((g) => ({ id: g.id, code: g.code, rooms: g.memberCount })),
    familyNeedsPlan,
    preoccupiedToday: preTotal,
    estimatedCalls: estCalls,
    estimatedSeconds: Math.round((estCalls * DELAY) / 1000),
    summary: s,
  })}\n`);
  process.exit(0);
}

if (DRY_RUN) {
  if (!NO_BACKDATING) {
    console.log(`\n  ⓘ Ce plan suppose la rétrodatation possible. Apaleo la refuse sur ce tenant`);
    console.log(`    (« Cannot set the arrival date to yesterday after check-out time »). La sonde tranche`);
    console.log(`    au lancement ; pour prévisualiser le repli : npm run simulate -- --dry-run --no-backdating`);
  }
  console.log(`\n  Dry-run terminé. Rien n'a été écrit dans Apaleo.`);
  console.log(`  Pour appliquer : npm run simulate${SCALE !== 1 ? ` -- --scale ${SCALE}` : ''}\n`);
  process.exit(0);
}

// --- real run --------------------------------------------------------------
const throttle = makeThrottle(DELAY);
console.log(`\n  ── Application ──────────────────────────────────────────────────`);

if (familyNeedsPlan) await ensureSimRatePlan({ propertyId: config.apaleo.propertyId, apply: true, log: (m) => log(`  ${m}`) });

console.log(`  sonde de rétrodatation…`);
const probe = NO_BACKDATING
  ? { supported: false, reason: '--no-backdating' }
  : await probeBackdating({ plan, throttle, log: (m) => log(`  ${m}`) });

let finalPlan = plan;
if (!probe.supported) {
  console.log(`  ⚠ rétrodatation refusée — repli : arrivées du jour uniquement, pas de clients déjà en séjour`);
  finalPlan = buildPlan({ today, runId, unitGroups: inventory.unitGroups, ratePlans: inventory.ratePlans, simRatePlanId, scale: SCALE, seed: SEED, allowBackdating: false, existingOccupancy });
}

const result = await applyPlan({ plan: finalPlan, throttle, log: (m) => log(`  ${m}`), probeResult: probe });

const dir = path.join(process.cwd(), '.sim-runs');
fs.mkdirSync(dir, { recursive: true });
const manifest = path.join(dir, `${runId}.json`);
fs.writeFileSync(manifest, JSON.stringify({ runId, marker: MARKER, today, seed: SEED, scale: SCALE, backdating: probe.supported, simRatePlanId: familyNeedsPlan ? simRatePlanIdFor(config.apaleo.propertyId) : null, result }, null, 2));

console.log(`\n  ── Résultat ─────────────────────────────────────────────────────`);
console.log(`  Réservations créées ${result.createdCount}/${finalPlan.reservations.length}`);
console.log(`  Check-ins           ${result.checkedIn}`);
console.log(`  Consommations       ${result.charges}`);
console.log(`  Folios divisés      ${result.splits.length}`);
console.log(`  Départs complets    ${result.departures.length}`);
console.log(`  Annulations         ${result.cancelled}`);
console.log(`  Rétrodatation       ${probe.supported ? 'acceptée' : `REFUSÉE — ${probe.reason}`}`);
if (result.failures.length) {
  console.log(`\n  ⚠ ${result.failures.length} échecs :`);
  const byStage = {};
  for (const f of result.failures) (byStage[f.stage] ||= []).push(f);
  for (const [stage, list] of Object.entries(byStage)) {
    console.log(`    ${stage.padEnd(14)} ${list.length} — ex. ${list[0].status || ''} ${list[0].error}`);
  }
}
console.log(`\n  Manifeste : ${manifest}`);
console.log(`  Nettoyage : npm run simulate:clean\n`);
