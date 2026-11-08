// One command for a demo morning: server, tunnel, and the Apaleo tab repointed at
// the fresh tunnel URL.
//
//   npm run demo:up      start everything and update the Apaleo tab
//   npm run demo:down    stop the server and the tunnel
//
// A Cloudflare quick tunnel gets a new hostname on every start, so the UI integration
// has to be rewritten each time — that is the whole reason this script exists.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { config } from '../src/config.js';
import { listUiIntegrations, updateUiIntegration, createUiIntegration, ApaleoError } from '../src/apaleoClient.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUN_DIR = path.join(repoRoot, '.demo');
const BIN_DIR = path.join(repoRoot, 'bin');
const CLOUDFLARED = path.join(BIN_DIR, 'cloudflared');
const PORT = config.port;
const TARGET = process.env.OPS_UI_TARGET || 'AccountMenuApps';
const INTEGRATION_CODE = 'SkylifeDemoTools';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, text) => console.log(`\n  ${n}. ${text}`);
const ok = (text) => console.log(`     ✓ ${text}`);
const fail = (text) => { console.error(`\n  ✗ ${text}\n`); process.exit(1); };

fs.mkdirSync(RUN_DIR, { recursive: true });

// ── 1. preflight ────────────────────────────────────────────────────────────
step(1, 'Vérifications');
if (!process.env.OPS_WRITE_PASSWORD) {
  fail('OPS_WRITE_PASSWORD n’est pas défini dans .env.\n    Sans lui, « Remplir », « Nettoyer » et « Appliquer » seront refusés.');
}
ok('mot de passe d’écriture configuré');

if (!fs.existsSync(CLOUDFLARED)) {
  console.log('     cloudflared absent, téléchargement…');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  const tgz = path.join(BIN_DIR, 'cloudflared.tgz');
  const dl = spawnSync('curl', ['-sL', '-o', tgz, url], { stdio: 'inherit' });
  if (dl.status !== 0) fail('téléchargement de cloudflared impossible');
  spawnSync('tar', ['xzf', tgz, '-C', BIN_DIR], { stdio: 'inherit' });
  fs.rmSync(tgz, { force: true });
  if (!fs.existsSync(CLOUDFLARED)) fail('cloudflared introuvable après extraction');
  fs.chmodSync(CLOUDFLARED, 0o755);
}
ok(`cloudflared présent (${CLOUDFLARED.replace(repoRoot + '/', '')})`);

// ── 2. server ───────────────────────────────────────────────────────────────
step(2, `Serveur sur le port ${PORT} (propriété ${config.apaleo.propertyId})`);
const already = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false);
if (already) {
  ok('déjà en route, réutilisé');
} else {
  const serverLog = fs.openSync(path.join(RUN_DIR, 'server.log'), 'a');
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot, detached: true, stdio: ['ignore', serverLog, serverLog],
    env: { ...process.env },
  });
  server.unref();
  fs.writeFileSync(path.join(RUN_DIR, 'server.pid'), String(server.pid));
  let up = false;
  for (let i = 0; i < 30 && !up; i += 1) {
    await sleep(500);
    up = await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) fail(`le serveur n’a pas démarré — voir ${path.join(RUN_DIR, 'server.log')}`);
  ok(`démarré (pid ${server.pid})`);
}

// ── 3. tunnel ───────────────────────────────────────────────────────────────
step(3, 'Tunnel HTTPS');
const tunnelLogPath = path.join(RUN_DIR, 'tunnel.log');
fs.writeFileSync(tunnelLogPath, '');
const tunnelLog = fs.openSync(tunnelLogPath, 'a');
const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
  cwd: repoRoot, detached: true, stdio: ['ignore', tunnelLog, tunnelLog],
});
tunnel.unref();
fs.writeFileSync(path.join(RUN_DIR, 'tunnel.pid'), String(tunnel.pid));

let base = null;
for (let i = 0; i < 40 && !base; i += 1) {
  await sleep(1000);
  const found = fs.readFileSync(tunnelLogPath, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (found) base = found[0];
}
if (!base) fail(`pas d’URL de tunnel après 40 s — voir ${tunnelLogPath}`);
ok(`ouvert : ${base}`);

const pageUrl = `${base}/ops`;
let reachable = false;
for (let i = 0; i < 20 && !reachable; i += 1) {
  await sleep(1000);
  reachable = await fetch(pageUrl, { signal: AbortSignal.timeout(8000) })
    .then(async (r) => r.ok && /Outils de démo/.test(await r.text())).catch(() => false);
}
if (!reachable) fail(`${pageUrl} ne répond pas encore. Le tunnel est ouvert mais la page n’est pas servie.`);
ok('page servie et reconnue à travers le tunnel');

// ── 4. Apaleo tab ───────────────────────────────────────────────────────────
step(4, 'Onglet Apaleo');
const body = {
  code: INTEGRATION_CODE,
  label: 'Outils de démo',
  labelTranslations: { en: 'Demo tools', de: 'Demo-Werkzeuge' },
  sourceUrl: pageUrl,
  sourceType: 'Public',
};
try {
  const existing = await listUiIntegrations().catch(() => null);
  const items = existing?.uiIntegrations || existing?.integrations || (Array.isArray(existing) ? existing : []);
  const mine = items.find((i) => i.code === INTEGRATION_CODE || String(i.id).endsWith(INTEGRATION_CODE.toUpperCase()));
  if (mine) {
    await updateUiIntegration(TARGET, mine.id, body);
    ok(`mis à jour (${mine.id})`);
  } else {
    const created = await createUiIntegration(TARGET, body);
    ok(`créé (${created?.id ?? 'id non renvoyé'})`);
  }
} catch (err) {
  if (err instanceof ApaleoError && err.status === 403) {
    fail('le client OAuth n’a pas la permission integration.ui_integrations.create/manage');
  }
  throw err;
}

// ── done ────────────────────────────────────────────────────────────────────
console.log(`
  ──────────────────────────────────────────────────────────────
  Prêt.

  Apaleo      app.apaleo.com → menu Apps → « Outils de démo »
  Page        ${pageUrl}
  Propriété   ${config.apaleo.propertyId}
  Mot de passe des actions d’écriture : ${process.env.OPS_WRITE_PASSWORD}

  Pour tout arrêter :  npm run demo:down
  ──────────────────────────────────────────────────────────────
`);
