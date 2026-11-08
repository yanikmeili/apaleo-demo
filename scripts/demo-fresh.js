// Regenerates the demo data from scratch, in order, on the configured property.
//
//   npm run demo:fresh                    # dry-run: says what it would do
//   npm run demo:fresh -- --apply
//   npm run demo:fresh -- --apply --allocation-date 2026-11-14
//
// Why this exists: the simulator builds its curve around the day it runs. Data made on
// Friday shows Friday's arrivals and in-house guests, so by Tuesday a third of them are
// past their departure date and the planning looks broken. Regenerate on the morning of
// the demo, not before.
//
// Apaleo cannot reset a property (the account lacks core.properties.reset) and cannot
// delete a reservation, so "from scratch" means: cancel everything marked, check the
// remaining guests out with their folios settled, then build again. Cancelled and
// checked-out records stay visible but hold no room.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../src/config.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const SCALE = opt('scale', '1');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const P = config.apaleo.propertyId;

const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ALLOCATION_DATE = opt('allocation-date', plusDays(4));

if (/^PAR$/i.test(P)) {
  console.error(`
  ✗ APALEO_PROPERTY_ID vaut ${P}.

    Cette commande régénère des données de démonstration : elle refuse de s'exécuter
    sur la propriété de production, qui contient de vraies réservations.

    Corrige la ligne dans .env :
        APALEO_PROPERTY_ID=DEMO2

    ou, pour un seul lancement :
        APALEO_PROPERTY_ID=DEMO2 npm run demo:fresh -- --apply
`);
  process.exit(1);
}

const steps = [
  { label: 'Nettoyage (annule le marqué, sort et solde les clients)', args: ['scripts/simulate-clean.js'] },
  { label: `Remplissage de l'hôtel (échelle ${SCALE})`, args: ['scripts/simulate.js', '--scale', SCALE] },
  { label: `Journée d'attribution du ${ALLOCATION_DATE}`, args: ['scripts/seed-allocation-day.js', '--date', ALLOCATION_DATE, '--apply'] },
];

console.log(`\n  Régénération des données — propriété ${P}${APPLY ? '' : '   (dry-run)'}`);
console.log(`  Journée d'attribution visée : ${ALLOCATION_DATE}\n`);

if (!APPLY) {
  for (const [i, s] of steps.entries()) console.log(`  ${i + 1}. ${s.label}\n     node ${s.args.join(' ')}`);
  console.log(`\n  Dry-run : rien n'a été écrit. Ajouter --apply.`);
  console.log(`\n  Durée mesurée sur une propriété déjà pleine : environ 80 minutes.`);
  console.log(`  L'essentiel part dans le nettoyage, qui annule chaque réservation une par une`);
  console.log(`  et solde chaque folio. Sur une propriété vide, compter ~10 minutes.`);
  console.log(`  Pour aller plus vite : --scale 0.5 (moitié moins de réservations).\n`);
  process.exit(0);
}

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: repoRoot, env: { ...process.env } });
  let tail = [];
  const keep = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim() || /"msg":"apaleo\.|"msg":"http"/.test(line)) continue;
      tail.push(line.replace(/\s+$/, ''));
      if (tail.length > 14) tail.shift();
    }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(tail.join('\n') || `code ${code}`))));
});

const started = Date.now();
for (const [i, step] of steps.entries()) {
  console.log(`\n  ── ${i + 1}/${steps.length} · ${step.label} ──`);
  try {
    const tail = await run(step.args);
    for (const line of tail) console.log(`     ${line}`);
  } catch (err) {
    console.error(`\n  ✗ Échec à l'étape ${i + 1}.\n${String(err.message).split('\n').map((l) => `     ${l}`).join('\n')}\n`);
    process.exit(1);
  }
}

console.log(`
  ──────────────────────────────────────────────────────────────
  Données régénérées sur ${P} en ${Math.round((Date.now() - started) / 1000)} s.
  Journée d'attribution prête : ${ALLOCATION_DATE}

  Ensuite :  npm run demo:up
  ──────────────────────────────────────────────────────────────
`);
