// The commented arrivals that make the allocation demo worth watching: each one is a
// request the agent has to reason about, not just a room to hand out.
// [lastName, unit group code, adults, comment, extra reservations in the same booking]
export const ALLOCATION_CASES = [
  ['Bebe', 'DBL', 2, 'Nous venons avec un bébé, on aimerait être loin de la rue et proche de l’ascenseur.'],
  ['Anniversaire', 'DBL', 2, 'Anniversaire de mariage, si possible la plus belle vue.'],
  ['Famille', 'DBL', 2, 'Deux familles, on voudrait des chambres côte à côte.', 1],
  ['Sommeil', 'SGL', 1, 'Je dors très mal, la chambre la plus calme possible.'],
  ['Nuit', 'SGL', 1, 'Arrivée vers 2h du matin, pas de bruit dans le couloir svp.'],
  ['Fauteuil', 'DBL', 2, 'Je suis en fauteuil roulant, chambre accessible.'],
  ['Enfants', 'DBL', 2, 'Chambre communicante pour mes deux enfants.', 1],
  ['Vertige', 'DBL', 2, 'Étage élevé, j’ai le vertige mais j’adore la lumière.'],
  ['Habitue', 'DBL', 2, 'Même chambre que l’année dernière, la 2.009.'],
  ['Neutre', 'SGL', 1, 'Rien de spécial, merci !'],
];

/** Rooms each category needs free for the cases above to have real choices. */
export const CASE_DEMAND = ALLOCATION_CASES.reduce((acc, [, group, , , extra = 0]) => {
  acc[group] = (acc[group] || 0) + 1 + extra;
  return acc;
}, {});
