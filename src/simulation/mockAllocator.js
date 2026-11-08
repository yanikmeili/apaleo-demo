// Stand-in for the model, used while the real agent is not wired up.
//
// It consumes the SAME input as the real agent (buildInput: real reservations, real
// guest comments, real candidate rooms read from Apaleo) and returns the SAME shape
// the model is asked to return, so swapping it for proposeAssignments() is a one-line
// change. Only the reasoning is fake — rule-based keyword matching instead of a model.
//
// Everything it returns is tagged source: "mock" so the UI can say so plainly.

/** [regex on the guest comment, required attribute, short French justification] */
const RULES = [
  [/fauteuil|handicap|accessib|mobilit/i, 'Accessible', 'chambre accessible de plain-pied'],
  [/b[ée]b[ée]|berceau|lit b[ée]b[ée]|nourrisson/i, 'Quiet', 'chambre calme pour un séjour avec un bébé'],
  [/ascenseur/i, 'Near elevator', 'à quelques pas de l’ascenseur'],
  [/calme|silenc|dors mal|bruit|sommeil|tardive|2h|nuit/i, 'Quiet', 'côté cour, à l’écart du bruit'],
  [/communicante|c[ôo]te [àa] c[ôo]te|adjacent|voisine/i, 'Connecting', 'chambres communicantes'],
  [/vue|belle vue|panorama|anniversaire|romantique/i, 'Garden view', 'vue sur le jardin'],
  [/[ée]tage [ée]lev|dernier [ée]tage|lumi[èe]re|hauteur/i, 'Floor 3', 'étage élevé et lumineux'],
  [/vertige/i, 'Floor 2', 'étage intermédiaire, ni trop bas ni trop haut'],
  [/parking|voiture/i, 'Ground floor', 'rez-de-chaussée, proche de l’entrée'],
  [/baignoire|bain/i, 'Bath', 'chambre avec baignoire'],
];

/** "la 2.009" / "chambre 1.014" -> "2.009" */
function requestedRoom(comment) {
  const m = String(comment || '').match(/\b(\d|G)\.\d{3}\b/);
  return m ? m[0] : null;
}

function scoreUnit(unit, wanted) {
  let score = 0;
  for (const attr of wanted) if (unit.attributes.includes(attr)) score += 10;
  if (unit.condition === 'Clean') score += 2;
  if (!unit.occupiedNow) score += 1;
  return score;
}

/**
 * @param {object} input  the object returned by buildInput()
 * @returns {{assignments: Array, source: 'mock'}}
 */
export function mockProposals(input) {
  const used = new Set();
  const assignments = [];

  // Reservations sharing a bookingId are handled together, as the real rules require.
  const order = [...input.reservations].sort((a, b) => String(a.bookingId).localeCompare(String(b.bookingId)));

  for (const r of order) {
    const comment = (r.guestComment || '').trim();
    const free = r.candidates.filter((c) => !used.has(c.id));

    if (!free.length) {
      assignments.push({
        reservationId: r.reservationId,
        unitId: null,
        reason: 'Plus aucune chambre libre dans cette catégorie après les attributions précédentes.',
        needsHumanReview: true,
      });
      continue;
    }

    // A room named in the comment wins outright when it is actually free.
    const named = requestedRoom(comment);
    if (named) {
      const exact = free.find((c) => c.name === named);
      if (exact) {
        used.add(exact.id);
        assignments.push({
          reservationId: r.reservationId,
          unitId: exact.id,
          reason: `Chambre ${exact.name} demandée nommément et disponible.`,
          needsHumanReview: false,
        });
      } else {
        const fallback = free[0];
        used.add(fallback.id);
        assignments.push({
          reservationId: r.reservationId,
          unitId: fallback.id,
          reason: `La chambre ${named} demandée n’est pas libre sur ces dates ; ${fallback.name} proposée à la place.`,
          needsHumanReview: true,
        });
      }
      continue;
    }

    if (!comment) {
      const pick = free.find((c) => c.condition === 'Clean') || free[0];
      used.add(pick.id);
      assignments.push({
        reservationId: r.reservationId,
        unitId: pick.id,
        reason: 'Aucune demande particulière ; chambre disponible attribuée.',
        needsHumanReview: false,
      });
      continue;
    }

    const matched = RULES.filter(([re]) => re.test(comment));
    const wanted = matched.map(([, attr]) => attr);
    const ranked = [...free].sort((a, b) => scoreUnit(b, wanted) - scoreUnit(a, wanted));
    const best = ranked[0];
    const satisfied = wanted.filter((attr) => best.attributes.includes(attr));
    const missed = wanted.filter((attr) => !best.attributes.includes(attr));

    used.add(best.id);
    const why = matched
      .filter(([, attr]) => satisfied.includes(attr))
      .map(([, , text]) => text)
      .join(', ');

    assignments.push({
      reservationId: r.reservationId,
      unitId: best.id,
      reason: missed.length
        ? `${best.name} retenue${why ? ` (${why})` : ''}, mais la demande « ${missed.join(', ')} » n’a pas pu être satisfaite parmi les chambres libres.`
        : `${best.name} : ${why || 'correspond à la demande'}.`,
      needsHumanReview: missed.length > 0,
    });
  }

  // Restore the caller's original ordering.
  const byId = new Map(assignments.map((a) => [a.reservationId, a]));
  return {
    source: 'mock',
    assignments: input.reservations.map((r) => byId.get(r.reservationId)).filter(Boolean),
  };
}
