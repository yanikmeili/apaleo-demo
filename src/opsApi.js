// Backend for the Apaleo UI integration ("Préparer une démo" / "Attribution des chambres").
//
// Every write to Apaleo happens here, never in the browser, and goes through the same
// guards the CLI uses: the simulator and the cleanup run as the existing scripts, so the
// marker filter and the "refuse if anything unmarked shows up" rule are not duplicated.
import express from 'express';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';
import { apaleo, assignUnit, ApaleoError } from './apaleoClient.js';
import { buildInput, propertyInfo } from './allocationAgent.js';
import { mockProposals } from './simulation/mockAllocator.js';

// ---------------------------------------------------------------------------
// Guarding the write routes
//
// Two independent checks, because neither is sufficient alone:
//   * the shared password is the real gate — anyone with the tunnel URL would
//     otherwise reach buttons that write into a live PMS;
//   * the accountCode check is what Apaleo's guide asks for: the page is told which
//     account the viewer is signed into, and a value that is not ours means the page
//     is embedded somewhere it should not be. A browser can omit or forge it, so it
//     narrows the attack surface rather than closing it — hence the password.
// ---------------------------------------------------------------------------
const WRITE_PASSWORD = process.env.OPS_WRITE_PASSWORD || '';

/** Constant-time comparison over digests, so differing lengths do not leak. */
function secretMatches(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

let expectedAccountCode = process.env.OPS_ACCOUNT_CODE || null;
async function accountCode() {
  if (!expectedAccountCode) {
    const account = await apaleo.get('/account/v1/accounts/current');
    expectedAccountCode = account?.code || null;
  }
  return expectedAccountCode;
}

/** Applied to every mutating route. Reads stay open; see the README. */
async function requireWriteAuth(req, res, next) {
  try {
    if (!WRITE_PASSWORD) {
      return res.status(503).json({
        error: 'Les actions d’écriture sont désactivées : OPS_WRITE_PASSWORD n’est pas défini sur le serveur.',
        code: 'no_password_configured',
      });
    }
    if (!secretMatches(req.get('x-ops-password'), WRITE_PASSWORD)) {
      log.warn('ops.auth.rejected', { path: req.path, reason: 'password' });
      return res.status(401).json({ error: 'Mot de passe incorrect.', code: 'bad_password' });
    }
    // Apaleo appends accountCode to the embedded page's URL; the page forwards it.
    // Absent means the page is being used outside Apaleo, which the password already covers.
    const given = req.get('x-ops-account');
    if (given) {
      const expected = await accountCode();
      if (expected && given !== expected) {
        log.warn('ops.auth.rejected', { path: req.path, reason: 'account', given });
        return res.status(403).json({ error: `Cette page est réservée au compte ${expected}.`, code: 'wrong_account' });
      }
    }
    next();
  } catch (err) { next(err); }
}

// Properties the UI may never write to, whatever their status.
const DENY = new Set((process.env.OPS_DENY_PROPERTIES || 'PAR').split(',').map((s) => s.trim()).filter(Boolean));

/**
 * Decides what may be written, from Apaleo's own freshly-loaded view of the date.
 * Pure and network-free so the guards can be tested without touching Apaleo: a unit id
 * coming from the browser counts only if it is still among that reservation's candidates,
 * and no unit may be used twice in one batch.
 *
 * @param {object} input     the object returned by buildInput()
 * @param {Array}  approved  [{ reservationId, unitId }] as sent by the page
 */
export function planAssignments(input, approved) {
  const byRes = new Map(input.reservations.map((r) => [r.reservationId, r]));
  const used = new Set();
  const toApply = [];
  const rejected = [];

  for (const item of approved) {
    const reservationId = String(item?.reservationId || '');
    const unitId = String(item?.unitId || '');
    const r = byRes.get(reservationId);
    if (!r) { rejected.push({ reservationId, applied: false, error: 'Réservation absente des arrivées de cette date.' }); continue; }
    const unit = r.candidates.find((c) => c.id === unitId);
    if (!unit) { rejected.push({ reservationId, applied: false, error: 'Chambre hors des candidates de cette réservation.' }); continue; }
    if (used.has(unitId)) { rejected.push({ reservationId, applied: false, error: `Chambre ${unit.name} déjà attribuée dans ce lot.` }); continue; }
    used.add(unitId);
    toApply.push({ reservationId, unitId, unitName: unit.name });
  }
  return { toApply, rejected };
}

const router = express.Router();
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

class OpsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A property is writable only if Apaleo reports it as a Test property and it is not
 * on the deny list. Checked server-side on every mutating call — the browser's choice
 * is never trusted.
 */
async function assertWritable(propertyId) {
  if (!propertyId || !/^[A-Z0-9_-]{1,20}$/i.test(propertyId)) throw new OpsError(400, 'propertyId manquant ou invalide');
  if (DENY.has(propertyId.toUpperCase())) throw new OpsError(403, `${propertyId} est protégée : le simulateur ne peut pas y écrire.`);
  let property;
  try {
    property = await apaleo.get(`/inventory/v1/properties/${encodeURIComponent(propertyId)}`);
  } catch (err) {
    if (err instanceof ApaleoError && err.status === 404) throw new OpsError(404, `Propriété ${propertyId} introuvable.`);
    throw err;
  }
  if (property.status !== 'Test') {
    throw new OpsError(403, `${propertyId} est en statut « ${property.status} ». Seules les propriétés Test sont modifiables.`);
  }
  return property;
}

// ---------------------------------------------------------------------------
// Jobs: the simulator takes minutes, so it runs detached and the page polls.
// ---------------------------------------------------------------------------
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function startJob({ kind, propertyId, args }) {
  const id = randomUUID();
  const job = { id, kind, propertyId, status: 'running', startedAt: Date.now(), lines: [], result: null, error: null };
  jobs.set(id, job);

  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, APALEO_PROPERTY_ID: propertyId },
  });
  let buffer = '';
  const onChunk = (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      // Drop the client's own request log; it is noise in an operator UI.
      if (/"msg":"apaleo\.|"msg":"http"/.test(line)) continue;
      const text = line.replace(/\s+$/, '');
      if (text) job.lines.push(text);
    }
    if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  child.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.finishedAt = Date.now();
    if (code !== 0) job.error = job.lines.slice(-6).join('\n') || `code de sortie ${code}`;
    log.info('ops.job.finished', { id, kind, propertyId, code, durationMs: job.finishedAt - job.startedAt });
    setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref?.();
  });
  log.info('ops.job.started', { id, kind, propertyId });
  return job;
}

const publicJob = (j) => ({
  id: j.id, kind: j.kind, propertyId: j.propertyId, status: j.status,
  lines: j.lines, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt ?? null,
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------
router.get('/config', wrap(async (req, res) => {
  res.json({ writesEnabled: Boolean(WRITE_PASSWORD), accountCode: await accountCode().catch(() => null) });
}));

router.get('/properties', wrap(async (req, res) => {
  const list = await apaleo.get('/inventory/v1/properties', { pageSize: 100 });
  const properties = (list?.properties || [])
    .map((p) => ({
      id: p.id,
      // The list endpoint returns `name` as a plain string; the detail endpoint returns
      // a localized object. Handle both rather than printing the id twice.
      name: (typeof p.name === 'string' ? p.name : p.name?.en || p.name?.de) || p.id,
      status: p.status,
      isArchived: Boolean(p.isArchived),
      writable: p.status === 'Test' && !DENY.has(String(p.id).toUpperCase()),
      deniedReason: DENY.has(String(p.id).toUpperCase())
        ? 'protégée'
        : p.status !== 'Test' ? `statut ${p.status}` : null,
    }))
    .filter((p) => !p.isArchived)
    .sort((a, b) => Number(b.writable) - Number(a.writable) || a.id.localeCompare(b.id));
  // Prefer the property this server is configured for, when it is writable.
  const configured = properties.find((p) => p.writable && p.id === config.apaleo.propertyId);
  res.json({ properties, defaultPropertyId: (configured ?? properties.find((p) => p.writable))?.id ?? null });
}));

// ---------------------------------------------------------------------------
// Tab 1 — prepare a demo
// ---------------------------------------------------------------------------
router.get('/sim/plan', wrap(async (req, res) => {
  const propertyId = String(req.query.propertyId || '');
  await assertWritable(propertyId);
  const scale = String(req.query.scale || '1');
  const out = await runToCompletion(['scripts/simulate.js', '--dry-run', '--json', '--scale', scale], propertyId);
  const marker = out.indexOf('__PLAN_JSON__');
  if (marker < 0) throw new OpsError(502, `Le simulateur n'a pas renvoyé de plan.\n${out.slice(-400)}`);
  res.json(JSON.parse(out.slice(marker + '__PLAN_JSON__'.length).split('\n')[0]));
}));

function runToCompletion(args, propertyId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: { ...process.env, APALEO_PROPERTY_ID: propertyId } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new OpsError(502, out.slice(-600) || `code ${code}`))));
  });
}

router.post('/sim/run', requireWriteAuth, wrap(async (req, res) => {
  const propertyId = String(req.body?.propertyId || '');
  await assertWritable(propertyId);
  const scale = String(req.body?.scale ?? '1');
  const job = startJob({ kind: 'simulate', propertyId, args: ['scripts/simulate.js', '--scale', scale] });
  res.status(202).json(publicJob(job));
}));

router.post('/sim/clean', requireWriteAuth, wrap(async (req, res) => {
  const propertyId = String(req.body?.propertyId || '');
  await assertWritable(propertyId);
  const job = startJob({ kind: 'clean', propertyId, args: ['scripts/simulate-clean.js'] });
  res.status(202).json(publicJob(job));
}));

router.get('/jobs/:id', wrap(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) throw new OpsError(404, 'Job inconnu ou expiré.');
  res.json(publicJob(job));
}));

// ---------------------------------------------------------------------------
// Tab 2 — room allocation
// ---------------------------------------------------------------------------
router.get('/allocation/proposals', wrap(async (req, res) => {
  const propertyId = String(req.query.propertyId || '');
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new OpsError(400, 'date attendue au format YYYY-MM-DD');
  const property = await propertyInfo(propertyId).catch(() => { throw new OpsError(404, `Propriété ${propertyId} introuvable.`); });

  const input = await buildInput(date, propertyId);
  // The real agent is not wired up yet: same input, same output shape, rule-based reasoning.
  const { assignments, source } = mockProposals(input);

  const byRes = new Map(input.reservations.map((r) => [r.reservationId, r]));
  const rows = assignments.map((a) => {
    const r = byRes.get(a.reservationId);
    const unit = r.candidates.find((c) => c.id === a.unitId) || null;
    return {
      reservationId: a.reservationId,
      bookingId: r.bookingId,
      unitGroup: r.unitGroup,
      arrival: r.arrival,
      departure: r.departure,
      adults: r.adults,
      guestComment: r.guestComment,
      unitId: a.unitId,
      unitName: unit?.name ?? null,
      unitAttributes: unit?.attributes ?? [],
      candidateCount: r.candidates.length,
      reason: a.reason,
      needsHumanReview: Boolean(a.needsHumanReview),
    };
  });
  // Cases needing a human come first, as the brief asks.
  rows.sort((a, b) => Number(b.needsHumanReview) - Number(a.needsHumanReview) || String(a.unitName).localeCompare(String(b.unitName)));

  res.json({
    source,                       // "mock" — the page shows a banner while this is set
    propertyId,
    propertyName: property.name,
    date,
    totals: { rows: rows.length, needsReview: rows.filter((r) => r.needsHumanReview).length, withComment: rows.filter((r) => r.guestComment).length },
    rows,
  });
}));

/**
 * Assigns only the rows the operator approved, and re-derives the truth from Apaleo
 * first: a unit id coming from the browser is accepted only if it is still among that
 * reservation's own candidates, and no unit may be used twice.
 */
router.post('/allocation/apply', requireWriteAuth, wrap(async (req, res) => {
  const propertyId = String(req.body?.propertyId || '');
  const date = String(req.body?.date || '');
  const approved = Array.isArray(req.body?.approved) ? req.body.approved : [];
  await assertWritable(propertyId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new OpsError(400, 'date attendue au format YYYY-MM-DD');
  if (!approved.length) throw new OpsError(400, 'Aucune ligne validée.');

  const input = await buildInput(date, propertyId);
  const { toApply, rejected } = planAssignments(input, approved);

  const results = [...rejected];
  for (const item of toApply) {
    try {
      await assignUnit(item.reservationId, item.unitId);
      results.push({ reservationId: item.reservationId, unitName: item.unitName, applied: true });
    } catch (err) {
      results.push({ reservationId: item.reservationId, unitName: item.unitName, applied: false, error: err.message });
    }
  }
  log.info('ops.allocation.applied', { propertyId, date, requested: approved.length, applied: results.filter((r) => r.applied).length });
  res.json({ applied: results.filter((r) => r.applied).length, total: approved.length, results });
}));

// ---------------------------------------------------------------------------
router.use((err, req, res, next) => {
  if (err instanceof OpsError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ApaleoError) {
    log.error('ops.apaleo_error', { status: err.status, path: err.path, message: err.message });
    return res.status(err.status && err.status < 500 ? err.status : 502).json({ error: err.message });
  }
  log.error('ops.unhandled', { message: err.message });
  res.status(500).json({ error: 'Erreur interne' });
});

export default router;
