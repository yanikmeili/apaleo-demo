// Registers the operator pages as an Apaleo UI integration. Dry-run by default.
//
//   node scripts/register-ui-integration.js --url https://xxx.trycloudflare.com   # dry-run
//   node scripts/register-ui-integration.js --url https://xxx... --apply
//   node scripts/register-ui-integration.js --list
//   node scripts/register-ui-integration.js --delete <id> --apply
//
// The UI-integration API lives on https://integration.apaleo.com, not api.apaleo.com.
// Apaleo refuses a non-HTTPS sourceUrl and any URL resolving to a private (RFC-1918)
// address, so localhost cannot be registered — hence the tunnel.
import { listUiIntegrations, createUiIntegration, deleteUiIntegration, ApaleoError, INTEGRATION_URL } from '../src/apaleoClient.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const APPLY = argv.includes('--apply');
const TARGET = opt('target', 'AccountMenuApps');
const PATH = opt('path', '/ops');

const VALID_TARGETS = new Set(['DashboardPropertyContext', 'DashboardAccountContext', 'ReservationDetailsTab',
  'BookingDetailsTab', 'GuestDetailsDialog', 'PropertyMenuReports', 'PropertyMenuApps', 'AccountMenuApps', 'CompanyDetailsTab']);

const show = (list) => {
  const items = list?.uiIntegrations || list?.integrations || (Array.isArray(list) ? list : []);
  if (!items.length) return console.log('  (aucune intégration déclarée)');
  for (const i of items) console.log(`  ${String(i.id).padEnd(26)} ${String(i.target || TARGET).padEnd(24)} ${i.label}\n    ${i.sourceUrl}`);
};

if (argv.includes('--list')) {
  console.log(`\nIntégrations déclarées sur ${INTEGRATION_URL} :`);
  show(await listUiIntegrations());
  console.log();
  process.exit(0);
}

const delId = opt('delete', null);
if (delId) {
  console.log(`\nSuppression de ${delId} (${TARGET})${APPLY ? '' : ' — dry-run'}`);
  if (!APPLY) { console.log('  rien fait. Ajouter --apply pour supprimer.\n'); process.exit(0); }
  await deleteUiIntegration(TARGET, delId);
  console.log('  supprimée.\n');
  process.exit(0);
}

// --- create ------------------------------------------------------------------
const base = opt('url', '');
if (!base) {
  console.error('\n  --url manquant. Exemple :\n    node scripts/register-ui-integration.js --url https://xxx.trycloudflare.com\n');
  process.exit(1);
}
if (!VALID_TARGETS.has(TARGET)) {
  console.error(`\n  Target inconnu : ${TARGET}\n  Valeurs acceptées : ${[...VALID_TARGETS].join(', ')}\n`);
  process.exit(1);
}

let url;
try { url = new URL(PATH, base); } catch { console.error(`\n  URL invalide : ${base}\n`); process.exit(1); }
if (url.protocol !== 'https:') {
  console.error(`\n  Apaleo exige HTTPS. Reçu : ${url.protocol}//\n  Un tunnel est nécessaire ; http://localhost ne peut pas être déclaré.\n`);
  process.exit(1);
}
if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
  console.error(`\n  ${url.hostname} est une adresse privée ; Apaleo les refuse (RFC-1918).\n`);
  process.exit(1);
}

const body = {
  code: 'SkylifeDemoTools',
  label: 'Outils de démo',
  labelTranslations: { en: 'Demo tools', de: 'Demo-Werkzeuge' },
  sourceUrl: url.toString(),
  sourceType: 'Public',
};

console.log(`\n  Cible       ${TARGET}`);
console.log(`  sourceUrl   ${body.sourceUrl}`);
console.log(`  sourceType  ${body.sourceType}`);
console.log(`  label       ${body.label}`);
console.log(`  hôte        ${INTEGRATION_URL}`);

// A page Apaleo cannot load is a broken tab, so check it answers before declaring it.
process.stdout.write('\n  vérification de l’URL… ');
try {
  const res = await fetch(body.sourceUrl, { signal: AbortSignal.timeout(10_000) });
  const html = await res.text();
  console.log(`HTTP ${res.status}, ${html.length} octets${/Outils de démo/.test(html) ? ', page reconnue ✓' : ' ⚠ contenu inattendu'}`);
  if (!res.ok) { console.error('\n  L’URL ne répond pas 200 : rien ne sera déclaré.\n'); process.exit(1); }
} catch (err) {
  console.log('échec');
  console.error(`\n  ${body.sourceUrl} est injoignable (${err.message}).`);
  console.error('  Le tunnel est-il bien ouvert ? Rien ne sera déclaré.\n');
  process.exit(1);
}

if (!APPLY) {
  console.log('\n  Dry-run : rien n’a été déclaré dans Apaleo.');
  console.log('  Pour déclarer : ajouter --apply\n');
  process.exit(0);
}

try {
  const created = await createUiIntegration(TARGET, body);
  console.log(`\n  ✓ déclarée — id ${created?.id ?? '(non renvoyé)'}`);
  console.log(`  Visible dans app.apaleo.com sous le menu Apps du compte.\n`);
} catch (err) {
  if (err instanceof ApaleoError && err.status === 403) {
    console.error('\n  ✗ 403 — le client OAuth n’a pas la permission « integration.ui_integrations.create ».');
    console.error('    À ajouter dans le dashboard développeur Apaleo pour cette application.\n');
    process.exit(1);
  }
  throw err;
}
