// Room allocation agent (phase 2).
//
// Pipeline:  load arrivals without a unit -> load free units per reservation (with attributes)
//            -> one model call returning strict JSON -> backend validation -> (optional) assign.
// The model only proposes. The backend checks every proposal against Apaleo data before
// writing, and never touches dates, category, price, payment or cancellation.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { log } from './logger.js';
import { listReservations, listAvailableUnitsForReservation, assignUnit } from './apaleoClient.js';

const PROPERTY_TZ_OFFSET = '+01:00'; // Europe/Paris in winter; only used to bound the day filter

export const RULES = `You are the room allocation assistant of Hotel Paris. You receive tomorrow's arrivals that still
have no room, each with the guest's free-text comment, and for each one the list of rooms that are
free for the whole stay in the booked category. Pick the best room for each reservation.

Rules (non-negotiable):
1. Only choose a room from the candidate list of that reservation. Never change category, dates or price.
2. One room per reservation; never give the same room to two reservations.
3. Reservations that share a bookingId, or whose comments ask for rooms next to each other, must be handled
   together: rooms with consecutive numbers on the same floor are adjacent; "Connecting" rooms have a door to
   the adjacent room with the next/previous number (e.g. 1.005 and 1.006).
4. If no candidate satisfies the request, choose the closest available option AND set needsHumanReview to true,
   explaining what could not be satisfied.
5. If the comment is ambiguous or contradictory, do not guess: set unitId to null and needsHumanReview to true.
6. If the guest asks for a specific room that is not in their candidate list, it is not available: pick the most
   similar room, set needsHumanReview to true and say so.
7. If the comment is empty or says nothing special, do not invent a preference: pick any suitable room and
   say "no particular request".
8. Accessibility, noise, baby and medical needs take priority over view preferences.
9. "reason" is one short sentence in French, written for the reception team.

Room attribute meanings: Ground floor / Floor 1 / Floor 2 / Floor 3; Garden view = courtyard side, away from
the street; Street view = on the street; Quiet = courtyard side and away from the elevator and lobby;
Near elevator = few steps from elevator and stairs; Accessible = step-free, wide door, roll-in shower;
Connecting = door to the adjacent room; Corner = end of corridor; King, Bath, Private pool = room features.
Light: higher floors and garden side get the most daylight.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reservationId: { type: 'string' },
          unitId: { type: ['string', 'null'], description: 'Candidate unit id, or null to leave unassigned' },
          reason: { type: 'string' },
          needsHumanReview: { type: 'boolean' },
        },
        required: ['reservationId', 'unitId', 'reason', 'needsHumanReview'],
        additionalProperties: false,
      },
    },
  },
  required: ['assignments'],
  additionalProperties: false,
};

const plusDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function tomorrowIso() {
  return plusDays(new Date().toISOString().slice(0, 10), 1);
}

// ---------------------------------------------------------------------------
// 1 + 2. Load data from Apaleo
// ---------------------------------------------------------------------------
export async function loadArrivalsWithoutUnit(date) {
  const res = await listReservations({
    propertyIds: [config.apaleo.propertyId],
    dateFilter: 'Arrival',
    from: `${date}T00:00:00${PROPERTY_TZ_OFFSET}`,
    to: `${plusDays(date, 1)}T00:00:00${PROPERTY_TZ_OFFSET}`,
    status: ['Confirmed'],
    expand: ['booker'],
  });
  return (res?.reservations || []).filter((r) => !r.unit?.id && !r.isUnitAssignmentLocked);
}

export async function loadCandidates(reservation) {
  const res = await listAvailableUnitsForReservation(reservation.id, { unitGroupId: reservation.unitGroup.id });
  return (res?.units || [])
    .filter((u) => !u.status?.isOccupied)
    .map((u) => ({
      id: u.id,
      name: u.name,
      unitGroupId: u.unitGroup?.id,
      condition: u.status?.condition,
      attributes: (u.attributes || []).map((a) => a.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the model needs, and nothing more (no names, no emails). */
export async function buildInput(date) {
  const arrivals = await loadArrivalsWithoutUnit(date);
  const reservations = [];
  for (const r of arrivals) {
    reservations.push({
      reservationId: r.id,
      bookingId: r.bookingId,
      unitGroup: r.unitGroup?.name,
      unitGroupId: r.unitGroup?.id,
      arrival: r.arrival?.slice(0, 10),
      departure: r.departure?.slice(0, 10),
      adults: r.adults,
      children: (r.childrenAges || []).length,
      guestComment: (r.guestComment || '').trim(),
      candidates: await loadCandidates(r),
    });
  }
  return { date, propertyId: config.apaleo.propertyId, reservations };
}

// ---------------------------------------------------------------------------
// 3. Ask the model (strict JSON)
// ---------------------------------------------------------------------------
export async function proposeAssignments(input, { client = new Anthropic({ apiKey: config.anthropic.apiKey }) } = {}) {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example)');
  const started = Date.now();
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    system: RULES,
    messages: [{ role: 'user', content: `Arrivals for ${input.date} at ${input.propertyId}:\n\n${JSON.stringify(input.reservations, null, 1)}` }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  log.info('anthropic.request', { model: response.model, stop: response.stop_reason, durationMs: Date.now() - started, in: response.usage?.input_tokens, out: response.usage?.output_tokens });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Model declined the request (${response.stop_details?.category || 'no category'})`);
  }
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return JSON.parse(text).assignments;
}

// ---------------------------------------------------------------------------
// 4. Validate proposals against Apaleo data (never trust the model blindly)
// ---------------------------------------------------------------------------
export function validateProposals(input, proposals) {
  const byRes = new Map(input.reservations.map((r) => [r.reservationId, r]));
  const used = new Set();
  const decisions = [];

  for (const r of input.reservations) {
    const p = proposals.find((x) => x.reservationId === r.reservationId);
    const d = { reservationId: r.reservationId, bookingId: r.bookingId, unitGroup: r.unitGroup, guestComment: r.guestComment, unitId: null, unitName: null, reason: '', needsHumanReview: true, valid: false };

    if (!p) {
      d.reason = 'Le modèle n’a rien proposé pour cette réservation.';
    } else if (p.unitId === null) {
      d.reason = p.reason;
      d.needsHumanReview = true;
      d.valid = true; // explicit "leave unassigned" is a valid outcome
    } else {
      const unit = r.candidates.find((u) => u.id === p.unitId);
      if (!unit) d.reason = `Chambre proposée (${p.unitId}) absente des chambres libres de la catégorie.`;
      else if (unit.unitGroupId !== r.unitGroupId) d.reason = `Chambre ${unit.name} d’une autre catégorie.`;
      else if (used.has(unit.id)) d.reason = `Chambre ${unit.name} déjà attribuée à une autre arrivée.`;
      else {
        used.add(unit.id);
        Object.assign(d, { unitId: unit.id, unitName: unit.name, reason: p.reason, needsHumanReview: Boolean(p.needsHumanReview), valid: true });
      }
    }
    decisions.push(d);
  }
  // Proposals for unknown reservations are ignored on purpose (never write outside the input set).
  const unknown = proposals.filter((p) => !byRes.has(p.reservationId)).map((p) => p.reservationId);
  return { decisions, unknown };
}

// ---------------------------------------------------------------------------
// 5. Apply (only with --apply) and report
// ---------------------------------------------------------------------------
export async function applyDecisions(decisions) {
  const results = [];
  for (const d of decisions) {
    if (!d.valid || !d.unitId) {
      results.push({ ...d, applied: false });
      continue;
    }
    try {
      await assignUnit(d.reservationId, d.unitId);
      results.push({ ...d, applied: true });
    } catch (err) {
      results.push({ ...d, applied: false, error: err.message });
    }
  }
  return results;
}

export function renderReport({ date, decisions, unknown, apply }) {
  const lines = [`# Attribution des chambres · arrivées du ${date} · ${apply ? 'APPLIQUÉ' : 'DRY-RUN'}`, ''];
  lines.push('| Réservation | Catégorie | Commentaire | Chambre | Raison | Statut |', '|---|---|---|---|---|---|');
  for (const d of decisions) {
    const status = d.error ? `❌ erreur: ${d.error}` : d.needsHumanReview ? '⚠️ à vérifier' : d.applied ? '✅ attribuée' : '✅ proposée';
    lines.push(`| ${d.reservationId} | ${d.unitGroup} | ${esc(d.guestComment) || '—'} | ${d.unitName || '—'} | ${esc(d.reason)} | ${status} |`);
  }
  const review = decisions.filter((d) => d.needsHumanReview || d.error);
  lines.push('', `## À vérifier par la réception (${review.length})`, '');
  for (const d of review) lines.push(`- **${d.reservationId}** ${d.unitName ? `→ ${d.unitName}` : '(non attribuée)'} : ${d.reason}${d.error ? ` — erreur API : ${d.error}` : ''}`);
  if (!review.length) lines.push('- aucun');
  if (unknown.length) lines.push('', `Propositions ignorées (réservations inconnues) : ${unknown.join(', ')}`);
  return lines.join('\n');
}

const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
