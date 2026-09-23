/**
 * Ordonnanceur FSRS-4.5.
 *
 * Free Spaced Repetition Scheduler : à chaque révision, on met à jour deux
 * quantités latentes attachées à la carte —
 *
 *   - la **stabilité** S, en jours : le délai au bout duquel la probabilité de
 *     se souvenir est retombée à 90 % ;
 *   - la **difficulté** D, dans [1, 10] : à quel point la carte résiste.
 *
 * La probabilité de se souvenir après t jours est
 * R(t) = (1 + FACTOR · t/S)^DECAY, et l'intervalle proposé est le t qui amène
 * R au niveau de rétention visé.
 *
 * Les poids ci-dessous sont les valeurs publiées par défaut de FSRS-4.5. Ils
 * sont censés être réajustés sur l'historique réel de l'utilisateur — pas
 * avant plusieurs centaines de révisions. Un poids mal recopié ne se verrait
 * pas à l'œil nu : c'est pourquoi les tests portent sur les propriétés
 * qualitatives de l'ordonnanceur (une meilleure note allonge l'intervalle, une
 * carte plus difficile progresse moins, etc.) et non sur des valeurs numériques
 * attendues, qui ne feraient que recopier l'implémentation.
 */

export const W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
] as const;

export const DECAY = -0.5;
/** 19/81 : choisi pour que R(S) = 0.9 exactement. */
export const FACTOR = 19 / 81;

/** Rétention visée. 0,9 est la valeur par défaut de FSRS. */
export const RETENTION_CIBLE = 0.9;

export const S_MIN = 0.01;
export const S_MAX = 36500;
export const D_MIN = 1;
export const D_MAX = 10;
export const INTERVALLE_MAX = 3650;

/** 1 oublié · 2 difficile · 3 correct · 4 facile. */
export type Note = 1 | 2 | 3 | 4;

export type EtatCarte = {
  /** Stabilité en jours. */
  stability: number;
  /** Difficulté dans [1, 10]. */
  difficulty: number;
  /** Échéance, en ISO 8601 (jour). */
  due: string;
  /** Date de la dernière révision, ISO 8601, ou null si jamais révisée. */
  lastReview: string | null;
  reps: number;
  lapses: number;
};

const borne = (x: number, min: number, max: number) =>
  Math.min(max, Math.max(min, x));

const jour = (d: Date) => d.toISOString().slice(0, 10);

const ajouteJours = (d: Date, n: number) =>
  new Date(d.getTime() + n * 86_400_000);

/** Nombre de jours écoulés entre deux dates ISO, jamais négatif. */
export function joursEcoules(depuis: string | null, maintenant: Date): number {
  if (!depuis) return 0;
  const ms = maintenant.getTime() - new Date(depuis).getTime();
  return Math.max(0, ms / 86_400_000);
}

/** Probabilité de se souvenir après `t` jours pour une stabilité `s`. */
export function retrievabilite(t: number, s: number): number {
  if (s <= 0) return 0;
  return Math.pow(1 + (FACTOR * t) / s, DECAY);
}

/**
 * Intervalle, en jours, au bout duquel la rétention descend à `retention`.
 * À retention = 0,9 on retrouve exactement S : c'est la définition de la
 * stabilité, et c'est ce que vérifie le premier test.
 */
export function intervalle(s: number, retention = RETENTION_CIBLE): number {
  const brut = (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return borne(Math.round(brut), 1, INTERVALLE_MAX);
}

export const stabiliteInitiale = (note: Note) =>
  borne(W[note - 1], S_MIN, S_MAX);

/**
 * Difficulté initiale, forme linéaire : D_0(G) = w4 − w5·(G−3).
 *
 * FSRS-5 utilise une forme exponentielle, w4 − e^(w5·(G−1)) + 1, mais avec un
 * autre jeu de poids. Appliquée aux poids de FSRS-4.5 ci-dessus, elle donne
 * D_0(3) ≈ −5{,}5 et D_0(4) ≈ −18, tous deux écrasés à 1 par le bornage : la
 * difficulté devient constante dès qu'une carte est réussie, et le terme
 * (11 − D) de la mise à jour de stabilité se fige. Le bogue est parfaitement
 * silencieux — la révision continue de fonctionner, elle cesse simplement de
 * distinguer les cartes. D'où le test qui vérifie que D_0(2) et D_0(3)
 * tombent strictement à l'intérieur de [1, 10].
 */
export const difficulteInitiale = (note: Note) =>
  borne(W[4] - W[5] * (note - 3), D_MIN, D_MAX);

/** Mise à jour de la difficulté, avec retour à la moyenne vers D_0(facile). */
function prochaineDifficulte(d: number, note: Note): number {
  const apresNote = d - W[6] * (note - 3);
  const retourMoyenne = W[7] * difficulteInitiale(4) + (1 - W[7]) * apresNote;
  return borne(retourMoyenne, D_MIN, D_MAX);
}

function stabiliteApresSucces(
  s: number,
  d: number,
  r: number,
  note: Note,
): number {
  const penaliteDifficile = note === 2 ? W[15] : 1;
  const bonusFacile = note === 4 ? W[16] : 1;
  const gain =
    Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) *
    penaliteDifficile *
    bonusFacile;
  return borne(s * (1 + gain), S_MIN, S_MAX);
}

function stabiliteApresOubli(s: number, d: number, r: number): number {
  const brut =
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r));
  // Un oubli ne doit jamais augmenter la stabilité. FSRS-4.5 ne pose pas ce
  // plafond ; FSRS-5 l'ajoute, et sans lui une carte oubliée après un très
  // long délai peut ressortir avec un intervalle allongé, ce qui est absurde.
  return borne(Math.min(brut, s), S_MIN, S_MAX);
}

/** Première révision d'une carte neuve. */
export function premiereRevision(note: Note, maintenant: Date): EtatCarte {
  const stability = stabiliteInitiale(note);
  const difficulty = difficulteInitiale(note);
  return {
    stability,
    difficulty,
    due: jour(ajouteJours(maintenant, intervalle(stability))),
    lastReview: maintenant.toISOString(),
    reps: 1,
    lapses: note === 1 ? 1 : 0,
  };
}

/**
 * Révision d'une carte déjà vue. Fonction pure : même entrée, même sortie.
 * `maintenant` est passé explicitement pour que les tests soient déterministes.
 */
export function reviser(
  carte: EtatCarte,
  note: Note,
  maintenant: Date,
): EtatCarte {
  if (carte.lastReview === null) return premiereRevision(note, maintenant);

  const t = joursEcoules(carte.lastReview, maintenant);
  const r = retrievabilite(t, carte.stability);
  const difficulty = prochaineDifficulte(carte.difficulty, note);
  const stability =
    note === 1
      ? stabiliteApresOubli(carte.stability, carte.difficulty, r)
      : stabiliteApresSucces(carte.stability, carte.difficulty, r, note);

  return {
    stability,
    difficulty,
    due: jour(ajouteJours(maintenant, intervalle(stability))),
    lastReview: maintenant.toISOString(),
    reps: carte.reps + 1,
    lapses: carte.lapses + (note === 1 ? 1 : 0),
  };
}

/** État d'une carte jamais révisée : due aujourd'hui. */
export function carteNeuve(maintenant: Date): EtatCarte {
  return {
    stability: 0,
    difficulty: 0,
    due: jour(maintenant),
    lastReview: null,
    reps: 0,
    lapses: 0,
  };
}

/** Une carte est à réviser si son échéance est atteinte. */
export const estDue = (carte: EtatCarte, maintenant: Date) =>
  carte.due <= jour(maintenant);
