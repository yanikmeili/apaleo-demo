// Stops what demo:up started. The Apaleo tab is left declared on purpose: removing it
// would hide the app from the account, and demo:up repoints it at the next URL anyway.
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUN_DIR = path.join(repoRoot, '.demo');

for (const [name, label] of [['tunnel', 'tunnel'], ['server', 'serveur']]) {
  const file = path.join(RUN_DIR, `${name}.pid`);
  if (!fs.existsSync(file)) { console.log(`  ${label} : aucun pid enregistré`); continue; }
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  ${label} : arrêté (pid ${pid})`);
  } catch (err) {
    console.log(`  ${label} : déjà arrêté (pid ${pid})`);
  }
  fs.rmSync(file, { force: true });
}
console.log('\n  L’onglet Apaleo reste déclaré ; il pointera vers la nouvelle URL au prochain npm run demo:up.\n');
