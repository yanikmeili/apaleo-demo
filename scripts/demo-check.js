// Says in one glance whether the demo is actually reachable, which the processes alone
// do not tell you: a revoked quick tunnel leaves cloudflared running and retrying, so
// "the process is up" and "the page is online" are different questions.
//
//   npm run demo:check
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../src/config.js';
import { listUiIntegrations } from '../src/apaleoClient.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = config.port;
const probe = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok, status: res.status };
  } catch (err) { return { ok: false, status: 0, err: err.message }; }
};

console.log(`\n  Diagnostic — propriété ${config.apaleo.propertyId}\n`);

const local = await probe(`http://localhost:${PORT}/ops`);
console.log(`  Serveur local        ${local.ok ? '✓ en ligne' : `✗ injoignable (${local.status || local.err})`}`);

// Match on the command shape, not an absolute path: the binary may have been started
// relatively, and pgrep -f would then miss it and report no tunnel while one is up.
const procs = spawnSync('pgrep', ['-f', 'cloudflared tunnel --url'], { encoding: 'utf8' });
const pids = (procs.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
console.log(`  Processus tunnel     ${pids.length ? `${pids.length} (${pids.join(', ')})` : 'aucun'}`);

const list = await listUiIntegrations().catch(() => null);
const items = list?.uiIntegrations || list?.integrations || (Array.isArray(list) ? list : []);
const mine = items.find((i) => i.code === 'SkylifeDemoTools' || /SKYLIFEDEMOTOOLS$/.test(String(i.id)));
if (!mine) {
  console.log('  Onglet Apaleo        ✗ non déclaré');
} else {
  const pub = await probe(mine.sourceUrl);
  console.log(`  Onglet Apaleo        ✓ déclaré (${mine.id})`);
  console.log(`  URL publique         ${mine.sourceUrl}`);
  console.log(`  Accessible ?         ${pub.ok ? '✓ oui' : `✗ NON (${pub.status || pub.err})`}`);
  if (!pub.ok) {
    console.log(`
  Le tunnel ne répond plus. Les tunnels rapides Cloudflare sont révoqués au bout de
  quelques heures, et cloudflared continue de tourner en réessayant — d'où des
  processus vivants et une page morte.

      npm run demo:up      relance le tunnel et repointe l'onglet`);
  }
}
console.log();
