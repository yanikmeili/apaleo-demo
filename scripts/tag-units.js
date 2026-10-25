// One-off setup for phase 2: give every PAR unit a coherent set of attributes so the
// allocation agent has something to reason about. Dry-run by default; --apply writes.
//
// Scheme (deterministic from the unit name "<floor>.<number>"):
//   floor      G -> Ground floor, 1 -> Floor 1, 2 -> Floor 2, 3 -> Floor 3
//   view       odd number -> Garden view (courtyard side), even -> Street view
//   elevator   numbers 1 and 2 on each floor are next to the elevator/stairs
//   quiet      garden side AND number >= 5 (away from elevator, lobby and street)
//   accessible G.002, G.004, G.006 (step-free, wide door, ground floor near lobby)
//   connecting pairs of adjacent Double rooms: 1.005/1.006, 1.013/1.014, 2.015/2.016, G.014/G.015
//   corner     first and last room of each floor
//   bed/bath   King for Double & Family rooms, Bath for Double rooms with number % 4 == 0
//   pool       Private pool for the Park View penthouse 3.001
import { config } from '../src/config.js';
import { apaleo, listUnits, listUnitAttributes, patchUnit } from '../src/apaleoClient.js';

const APPLY = process.argv.includes('--apply');

const NEW_ATTRIBUTES = [
  { name: 'Ground floor', description: 'Room on the ground floor (no stairs or elevator needed)' },
  { name: 'Quiet', description: 'Courtyard side, away from the elevator and the street' },
  { name: 'Near elevator', description: 'A few steps from the elevator and the stairs' },
  { name: 'Accessible', description: 'Step-free access, wide door, roll-in shower' },
  { name: 'Connecting', description: 'Has a connecting door to the adjacent room (same floor, next number)' },
];

const CONNECTING = new Set(['1.005', '1.006', '1.013', '1.014', '2.015', '2.016', 'G.014', 'G.015']);
const ACCESSIBLE = new Set(['G.002', 'G.004', 'G.006']);

function planFor(unit, lastNumberOnFloor) {
  const [floor, numStr] = unit.name.split('.');
  const n = Number(numStr);
  const group = unit.unitGroup?.id;
  const tags = new Set();

  tags.add({ G: 'Ground floor', 1: 'Floor 1', 2: 'Floor 2', 3: 'Floor 3' }[floor]);
  tags.add(n % 2 === 1 ? 'Garden view' : 'Street view');
  if (n <= 2) tags.add('Near elevator');
  if (n % 2 === 1 && n >= 5) tags.add('Quiet');
  if (floor === '3' && n === 1) tags.add('Quiet'); // park-side penthouse
  if (ACCESSIBLE.has(unit.name)) tags.add('Accessible');
  if (CONNECTING.has(unit.name)) tags.add('Connecting');
  if (n === 1 || n === lastNumberOnFloor[floor]) tags.add('Corner');
  if (group === 'PAR-DBL' || group === 'PAR-FAMILY') tags.add('King');
  if (group === 'PAR-DBL' && n % 4 === 0) tags.add('Bath');
  if (unit.name === '3.001') tags.add('Private pool');
  return [...tags];
}

async function ensureAttributes(existing) {
  const byName = new Map(existing.map((a) => [a.name, a]));
  for (const attr of NEW_ATTRIBUTES) {
    if (byName.has(attr.name)) continue;
    if (!APPLY) {
      console.log(`[dry-run] would create attribute "${attr.name}"`);
      byName.set(attr.name, { id: `(new:${attr.name})`, name: attr.name });
      continue;
    }
    const created = await apaleo.post('/inventory/v1/unit-attributes', attr);
    console.log(`created attribute "${attr.name}" -> ${created.id}`);
    byName.set(attr.name, { id: created.id, name: attr.name });
  }
  return byName;
}

const { units = [] } = (await listUnits({ propertyId: config.apaleo.propertyId })) || {};
const { unitAttributes = [] } = (await listUnitAttributes()) || {};
const attrs = await ensureAttributes(unitAttributes);

const lastNumberOnFloor = {};
for (const u of units) {
  const [floor, num] = u.name.split('.');
  lastNumberOnFloor[floor] = Math.max(lastNumberOnFloor[floor] || 0, Number(num));
}

let changed = 0;
for (const u of units.sort((a, b) => a.name.localeCompare(b.name))) {
  const wanted = planFor(u, lastNumberOnFloor);
  const current = (u.attributes || []).map((a) => a.name).sort();
  const same = JSON.stringify(current) === JSON.stringify([...wanted].sort());
  console.log(`${u.name.padEnd(6)} ${(u.unitGroup?.id || "").padEnd(11)} ${wanted.join(', ')}${same ? '  (unchanged)' : ''}`);
  if (same) continue;
  changed += 1;
  if (!APPLY) continue;
  const value = wanted.map((name) => {
    const a = attrs.get(name);
    if (!a) throw new Error(`Unknown attribute ${name}`);
    return { id: a.id };
  });
  await patchUnit(u.id, [{ op: 'replace', path: '/attributes', value }]);
}

console.log(`\n${units.length} units, ${changed} to update. ${APPLY ? 'Applied.' : 'Dry-run: re-run with --apply to write to Apaleo.'}`);
