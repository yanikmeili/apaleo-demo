// Creates (or repairs) a disposable property cloned from a template property, so the
// simulator can be debugged without polluting a property that holds real data.
//
//   node scripts/provision-property.js --from PAR --to DEMO [--dry-run]
//
// Three things the clone endpoint does NOT do, and this script does:
//   1. The source must be flagged isTemplate; the flag is set and restored around the call.
//   2. The clone copies unit groups and rate plans but NO units — they are recreated,
//      attributes included (attribute definitions are account-level, so ids carry over).
//   3. The clone copies rate plan structure but NO prices, so every booking would fail
//      with "Not all time periods have rates set". Prices are copied onto the base plan;
//      the derived plans follow through their pricingRule.
import { apaleo, listUnits, listRatePlans, getRatePlan } from '../src/apaleoClient.js';

const argv = process.argv.slice(2);
const val = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const FROM = val('from', 'PAR');
const TO = val('to', 'DEMO');
const DRY = argv.includes('--dry-run');
const RATE_DAYS = Number(val('days', '45'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`  ${m}`);
console.log(`\n  Provisionnement ${TO} depuis ${FROM}${DRY ? '  (dry-run)' : ''}\n`);

const src = await apaleo.get(`/inventory/v1/properties/${FROM}`);
let target = await apaleo.get(`/inventory/v1/properties/${TO}`).catch(() => null);

// --- 1. clone ---------------------------------------------------------------
if (target) {
  say(`propriété ${TO} déjà présente (statut ${target.status}) — étapes de réparation uniquement`);
} else if (DRY) {
  say(`[dry-run] clonerait ${FROM} → ${TO}`);
} else {
  await apaleo.patch(`/inventory/v1/properties/${FROM}`, [{ op: 'replace', path: '/isTemplate', value: true }]);
  try {
    await apaleo.post(`/inventory/v1/property-actions/${FROM}/clone`, {
      code: TO,
      name: { en: `Hotel ${TO}`, de: `Hotel ${TO}` },
      description: { en: 'Disposable property for simulator runs.', de: 'Wegwerf-Property für Simulationsläufe.' },
      companyName: src.companyName,
      managingDirectors: src.managingDirectors,
      commercialRegisterEntry: src.commercialRegisterEntry,
      taxId: src.taxId,
      location: src.location,
      paymentTerms: { en: 'Payment on check-in', de: 'Zahlung bei Anreise' },
      timeZone: src.timeZone,
      currencyCode: src.currencyCode,
      defaultCheckInTime: '15:00:00',
      defaultCheckOutTime: '11:00:00',
    });
    say(`cloné ${FROM} → ${TO}`);
  } finally {
    // Restore the flag whatever happened: a property left as a template behaves differently.
    await apaleo.patch(`/inventory/v1/properties/${FROM}`, [{ op: 'replace', path: '/isTemplate', value: false }]);
    say(`${FROM} → isTemplate restauré à false`);
  }
  target = await apaleo.get(`/inventory/v1/properties/${TO}`);
}

// --- 2. units ----------------------------------------------------------------
const existing = (await listUnits({ propertyId: TO }).catch(() => null))?.units || [];
if (existing.length) {
  say(`${existing.length} unités déjà présentes sur ${TO} — rien à créer`);
} else {
  const source = ((await listUnits({ propertyId: FROM }))?.units || []).sort((a, b) => a.name.localeCompare(b.name));
  const payload = source.map((u) => ({
    propertyId: TO,
    name: u.name,
    // Supported languages here are en / de / it, with en and de mandatory; "fr" is
    // rejected with "Description has unsupported translations".
    description: (() => {
      const d = u.description;
      if (d && typeof d === 'object' && !Array.isArray(d)) return { en: d.en || u.name, de: d.de || d.en || u.name };
      const text = typeof d === 'string' && d.trim() ? d : u.name;
      return { en: text, de: text };
    })(),
    unitGroupId: (u.unitGroup?.id || '').replace(new RegExp(`^${FROM}-`), `${TO}-`),
    maxPersons: u.maxPersons,
    condition: u.condition || 'Clean',
    attributes: (u.attributes || []).map((a) => ({ id: a.id })),
  }));
  const tagged = payload.filter((p) => p.attributes.length).length;
  say(`${payload.length} unités à créer (dont ${tagged} avec attributs)`);
  if (!DRY) {
    const res = await apaleo.post('/inventory/v1/units/bulk', { units: payload });
    say(`créées : ${(res?.ids || []).length}`);
  }
}

// --- 3. rates ----------------------------------------------------------------
const from = new Date().toISOString().slice(0, 10);
const to = new Date(Date.now() + RATE_DAYS * 864e5).toISOString().slice(0, 10);
const plans = (await listRatePlans({ propertyId: TO }))?.ratePlans || [];
const bases = [];
for (const p of plans) {
  const d = await getRatePlan(p.id);
  if (!d.pricingRule) bases.push(d.id);
  await sleep(200);
}
say(`plans de base à tarifer : ${bases.join(', ') || '(aucun)'}`);

for (const baseId of bases) {
  const counterpart = baseId.replace(new RegExp(`^${TO}-`), `${FROM}-`);
  const srcRates = await apaleo.get(`/rateplan/v1/rate-plans/${counterpart}/rates`, { from, to }).catch(() => null);
  if (!srcRates) { say(`⚠ pas de contrepartie ${counterpart} — ${baseId} laissé sans tarif`); continue; }
  const priceByDate = new Map();
  for (const r of srcRates.rates || []) if (r.price?.amount != null) priceByDate.set(r.from.slice(0, 10), r.price);
  const periods = (await apaleo.get(`/rateplan/v1/rate-plans/${baseId}/rates`, { from, to }))?.rates || [];
  const already = periods.filter((p) => p.price?.amount != null).length;
  if (already === periods.length && periods.length) { say(`${baseId} déjà tarifé (${already} nuits)`); continue; }
  const fallback = [...priceByDate.values()][0];
  if (!fallback) { say(`⚠ ${counterpart} n'a aucun prix — ${baseId} laissé sans tarif`); continue; }
  // The two properties can have different check-in/out times, so the target's own
  // period boundaries are kept and only the amounts are copied across.
  // A period that has already begun is rejected with "Cannot modify rates in the past",
  // which day-use plans hit as soon as their slot has started today.
  const now = Date.now();
  const future = periods.filter((p) => Date.parse(p.from) > now);
  const skipped = periods.length - future.length;
  const rates = future.map((p) => ({ from: p.from, to: p.to, price: priceByDate.get(p.from.slice(0, 10)) || fallback }));
  if (!rates.length) { say(`${baseId} : aucune période à venir à tarifer${skipped ? ` (${skipped} déjà commencées)` : ''}`); continue; }
  say(`${baseId} : ${rates.length} nuits à charger depuis ${counterpart}${skipped ? ` (${skipped} période(s) passée(s) ignorée(s))` : ''}`);
  if (!DRY) { await apaleo.put(`/rateplan/v1/rate-plans/${baseId}/rates`, { rates }); say(`  ✓ chargé`); }
}

console.log(`\n  ${DRY ? 'Dry-run terminé.' : `${TO} prête.`}  Lancer : APALEO_PROPERTY_ID=${TO} npm run simulate\n`);
