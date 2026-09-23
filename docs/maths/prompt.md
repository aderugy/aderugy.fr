# Prompt — Webapp d'apprentissage : Probabilités & Statistiques

> Ce document est la source de vérité des specs. Toute décision d'architecture
> qui le contredit doit d'abord le modifier.

**Journal des amendements**

| date | § | amendement | origine |
|---|---|---|---|
| 2026-09-09 | 4, 5 | `contentStatus` n'est plus stocké dans `graph.yaml` : il est dérivé du système de fichiers au chargement. Le type `Node` conserve le champ, seule sa provenance change. | décision D2, validée |
| 2026-09-09 | 4 | `estimatedHours` vaut 0 sur `domain` et `topic` ; la valeur affichée est la somme des descendants. | décision D3 |
| 2026-09-09 | 4 | Les arêtes `requires` ne relient que des `concept`. Un `topic` est disponible dès qu'un de ses concepts l'est. | décision D5 |
| 2026-09-09 | 3, 7 | Dérogation bornée : la V0 est livrée en châssis, sans cours rédigé hors `notation.mdx`. La session suivante rédige `analyse-reelle` sans ajouter de fonctionnalité. | décision D7, demandée |
| 2026-09-09 | 8 | Graphe rendu en SVG sur mesure ; `dagre` reste côté outillage. | décision D8 |
| 2026-09-09 | 9 | Corps en CMU Serif (Latin Modern Roman n'existe pas en web avec une couverture française complète). | décision D9 |
| 2026-09-09 | 8 | Docker Compose adopté : trois services (app, dev, tools), sortie Next autonome. Justifié par le module natif better-sqlite3. | décision D13, demandée |
| 2026-09-10 | 4 | `ReviewCard` porte un champ `ref` : l'ancre de la section d'origine. | décision D1, appliquée |
| 2026-09-10 | 7 | V1 livrée : FSRS, tentatives, déblocage automatique, recherche, Pyodide. | demandée |
| 2026-09-10 | 7, 9 | V2 livrée. Graphiques à l'encre, jamais de palette catégorielle ; un seul widget, celui qui a du contenu ; l'export PDF est une feuille de style d'impression. | décisions D21 à D24, demandée |

---

## 1. Rôle et mission

Tu es à la fois l'architecte logiciel et l'auteur pédagogique d'une application web
personnelle dont l'objectif est de me faire passer d'un niveau lycée à un niveau
expert en probabilités et statistiques.

Deux livrables indissociables :

1. **Une webapp** qui structure, présente et suit l'apprentissage.
2. **Le contenu pédagogique lui-même** — cours, exercices, corrections, projets —
   rédigé nœud par nœud, à la qualité d'un bon manuel universitaire.

L'application n'a aucune valeur sans le contenu. Ne construis jamais du châssis
pour du contenu qui n'existe pas.

## 2. Contexte utilisateur

- Utilisateur unique, étudiant en école d'ingénieur (majeure IA / data science).
- Stack maîtrisée : TypeScript, Next.js, Tailwind, Go, Python, Docker.
- Bases déjà acquises en probas-stats : lois usuelles, MLE, information de Fisher,
  intervalles de confiance, vecteurs gaussiens, fonctions caractéristiques.
  Le parcours démarre malgré tout au niveau 0 pour combler les trous, mais
  l'application doit permettre de **marquer un nœud comme déjà acquis après
  validation par un test de sortie**, sans le parcourir.
- Rythme visé : 10 à 15 h par semaine sur plusieurs années.
- Usage principal sur desktop, consultation ponctuelle sur mobile.

## 3. Principe directeur

**L'application se construit au fur et à mesure de l'apprentissage.**

Ce n'est pas un produit à livrer d'un bloc. À chaque session, un ou plusieurs
nœuds passent de « vide » à « rédigé », et l'application gagne éventuellement une
fonctionnalité si le nœud en cours l'exige. Corollaires :

- **Le contenu prime sur les fonctionnalités.** Une nouvelle feature ne se
  justifie que si un nœud concret en a besoin maintenant.
- **Aucune abstraction anticipée.** Pas de système de plugins, pas de couche
  générique tant que trois cas réels ne l'exigent pas.
- **Le schéma de données peut évoluer.** Prévoir des migrations, pas un schéma
  figé « définitif ».
- **Chaque session laisse le dépôt dans un état fonctionnel** : build vert,
  contenu cohérent, pas de nœud à moitié rédigé publié comme complet.

## 4. Modèle de données

Le parcours est un **graphe orienté acyclique**, pas un arbre : un nœud peut avoir
plusieurs prérequis issus de branches différentes (les martingales dépendent de
l'espérance conditionnelle *et* des modes de convergence). L'arborescence
hiérarchique n'est qu'une vue de lecture par-dessus le DAG.

```ts
type NodeKind = "domain" | "topic" | "concept";
// domain  : niveau 0-6, conteneur macro
// topic   : bloc de 5-20 h (ex. "Chaînes de Markov")
// concept : unité atomique évaluable (ex. "Récurrence et transience")

type Node = {
  id: string;              // slug stable, ex. "markov-recurrence"
  kind: NodeKind;
  title: string;
  parentId: string | null; // vue hiérarchique
  requires: string[];      // arêtes du DAG — prérequis réels, concept -> concept
  unlocks?: string[];      // dérivé, non stocké
  estimatedHours: number;  // 0 sur domain/topic, où la valeur affichée est la somme
  tags: string[];          // "mesure", "asymptotique", "bayésien", "calculatoire"
  contentStatus: "empty" | "draft" | "published"; // dérivé du système de fichiers,
                                                  // absent de content/graph.yaml
};

type Course = {
  nodeId: string;
  body: string;            // MDX
  references: Reference[]; // manuel + chapitre + pages
};

type Exercise = {
  id: string;
  nodeId: string;
  kind: "calcul" | "preuve" | "simulation" | "contre-exemple" | "qcm";
  difficulty: 1 | 2 | 3 | 4 | 5;
  statement: string;       // MDX
  hints: string[];         // révélables un par un
  solution: string;        // MDX, révélable
  sourceRef?: Reference;   // si tiré d'un manuel
};

type Project = {
  id: string;
  nodeIds: string[];       // couvre plusieurs nœuds
  brief: string;           // MDX : question, données, livrable attendu
  acceptanceCriteria: string[];
  deliverableUrl?: string; // lien vers le dépôt / notebook rendu
};

type Attempt = {
  exerciseId: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: "resolu-seul" | "resolu-avec-indice" | "echec" | "abandonne";
  minutesSpent: number;
  note: string;            // ce qui a bloqué — champ le plus précieux du modèle
};

type ReviewCard = {         // révision espacée, algorithme FSRS
  id: string;
  nodeId: string;
  ref: string;              // ancre de la section du cours dont la carte provient
  front: string;
  back: string;
  stability: number;
  difficulty: number;
  due: Date;
  reps: number;
  lapses: number;
};

type NodeProgress = {
  nodeId: string;
  state: "locked" | "available" | "in-progress" | "learned" | "mastered";
  masteredAt: Date | null;
};
```

**Règles de progression** — à implémenter explicitement, pas à l'intuition :

- `available` : tous les nœuds de `requires` sont au moins `learned`.
- `learned` : cours lu **et** au moins 70 % des exercices de difficulté ≤ 3
  réussis, dont la moitié sans indice.
- `mastered` : `learned` **et** au moins un exercice de difficulté 4-5 réussi
  **et** les cartes de révision du nœud ont une stabilité FSRS > 21 jours.
- Un nœud `mastered` peut retomber en `learned` si les révisions échouent.
  La maîtrise se perd, l'application doit le montrer.

## 5. Le graphe initial (seed)

Le graphe complet est dans `content/graph.yaml` : 240 nœuds (8 domaines,
40 topics, 192 concepts), 342 arêtes de prérequis. Aucun contenu rédigé, donc
tous les concepts sont `empty` — statut dérivé de l'absence de `course.mdx`.
Les identifiants sont des slugs stables et ne changent plus jamais.

Structure des niveaux (détail dans `content/graph.yaml`) :

- **Niveau 0 — Prérequis mathématiques** : analyse réelle, algèbre linéaire,
  calcul multivarié et optimisation, combinatoire, outillage Python.
- **Niveau 1 — Probabilités élémentaires** : modèle probabiliste, variables
  discrètes, variables continues, caractéristiques, vecteurs aléatoires,
  théorèmes limites en version intuitive.
- **Niveau 2 — Statistique inférentielle** : description et échantillonnage,
  estimation ponctuelle, estimation par intervalle, tests d'hypothèses,
  régression linéaire, comparaisons multiples et plans d'expérience.
- **Niveau 3 — Probabilités à la mesure** : théorie de la mesure, modes de
  convergence, outils analytiques, espérance conditionnelle, martingales.
- **Niveau 4 — Statistique mathématique** : théorie de l'estimation, théorie des
  tests, théorie de la décision, statistique bayésienne, GLM.
- **Niveau 5 — Processus stochastiques** : chaînes de Markov, Poisson et files
  d'attente, mouvement brownien, séries temporelles.
- **Niveau 6 — Spécialisations** (en choisir 2-3) : apprentissage statistique,
  grande dimension, inférence causale, bayésien computationnel, non
  paramétrique, domaines applicatifs. Granularité volontairement plus grossière,
  à redécouper au moment du choix.
- **Transverse** (dès le niveau 1, non bloquant) : programmation et simulation,
  méthodologie, projets sur données réelles.

Les arêtes `requires` traversent les niveaux et ne relient que des `concept`.
`scripts/validate_graph.py` vérifie l'acyclicité, les références et la hiérarchie.

## 6. Rubrique de contenu (obligatoire pour chaque nœud `concept`)

Un cours suit toujours cette structure. Elle n'est pas indicative. Chaque section
porte une **ancre stable** (`## 6. Pièges {#pieges}`) pour que les cartes de
révision puissent pointer vers leur source.

1. **Position dans le graphe** `{#position}` — d'où l'on vient, à quoi cela sert
   plus loin, en trois phrases maximum.
2. **Le problème** `{#probleme}` — la question concrète que la notion résout,
   posée avant toute définition. Jamais de définition sans motivation préalable.
3. **Construction** `{#construction}` — définitions et énoncés, en notation
   standard et cohérente sur tout le corpus.
4. **Intuition** `{#intuition}` — la reformulation qu'on donnerait au tableau.
   Distincte du formalisme, jamais fusionnée avec lui.
5. **Démonstrations** `{#demonstrations}` — complètes à partir du niveau 3, avec
   les étapes non triviales explicitées. Aucun « on montre facilement que ».
6. **Contre-exemples et pièges** `{#pieges}` — au moins un cas où l'hypothèse
   retirée fait tomber le résultat. Section obligatoire.
7. **Vérification par simulation** `{#simulation}` — un extrait Python exécutable
   qui illustre ou valide numériquement le résultat.
8. **Liens** `{#liens}` — les autres nœuds du graphe mobilisés ou éclairés.
9. **Références** `{#references}` — manuel, chapitre, pages. Toujours vérifiables.

**Exercices** : 8 à 15 par nœud `concept`, répartis sur les cinq difficultés, avec
au moins un exercice de type `preuve` et un de type `simulation` à partir du
niveau 3. Chaque exercice a 2-3 indices gradués et une correction rédigée.

**Projets** : un par nœud `topic` majeur. Format imposé — question de recherche,
jeu de données réel identifié, modélisation, validation, rédaction courte des
conclusions et de leurs limites.

## 7. Fonctionnalités par phase

**V0 — utilisable dès la première session**

- Visualisation du graphe : vue arborescente lisible + vue DAG (dépendances).
- Page de nœud : cours rendu en MDX avec LaTeX, exercices, état de progression.
- Marquage manuel de la progression et journal de session (durée, note libre).
- Contenu du premier `topic` du niveau 0 entièrement rédigé.

**V1 — quand le volume le justifie**

- Révision espacée FSRS avec cartes attachées aux nœuds.
- Suivi des tentatives d'exercices, avec le champ « ce qui a bloqué ».
- Déblocage automatique selon les règles de progression.
- Recherche plein texte sur cours et exercices.
- Exécution Python dans le navigateur (Pyodide, web worker).

**V2 — livrée**

- Tableau de bord : heures par niveau, taux de réussite par tag, courbe d'oubli
  (prévue, pas mesurée), charge de révision à 30 jours.
- Détection des nœuds fragiles : majorité de réussites avec indice, cartes en
  rechute, stabilité retombée sous le seuil sur un nœud acquis.
- Widgets interactifs : `Convergence`, utilisable depuis n'importe quel `.mdx`.
  Les trois autres viendront avec les nœuds qu'ils illustrent.
- Export du corpus en PDF : `/corpus` plus une feuille de style d'impression.

Toute fonctionnalité hors de ces listes doit être justifiée par un nœud en cours.

## 8. Stack technique

- **Next.js (App Router) + TypeScript + Tailwind.**
- **Contenu en fichiers**, pas en base : MDX avec frontmatter YAML, versionné.
- **Rendu mathématique : KaTeX** via `remark-math` / `rehype-katex`.
- **État utilisateur en SQLite** (`better-sqlite3` + Drizzle ORM), migrations versionnées.
- **Graphe** : layout DAG (`dagre` ou `elkjs`) au-dessus de React Flow, ou D3 sur mesure.
- **Python navigateur : Pyodide** en web worker, avec NumPy/SciPy/matplotlib.
- **Tests** : Vitest sur la logique de progression et l'ordonnanceur FSRS.
- Pas d'authentification, pas de multi-utilisateur, pas de déploiement cloud.
- **Docker Compose** : `app` en production sur `:3000`, `dev` avec rechargement
  à chaud sur `:3001`, `tools` pour l'outillage. Voir la décision D13.

**Structure de fichiers**

```
/content/{domain}/{topic}/{concept}/
    course.mdx
    exercises/*.mdx
    cards.yaml
/content/projects/*.mdx
/content/graph.yaml        ← nœuds et arêtes, source de vérité du DAG
/content/notation.mdx      ← conventions de notation
/src/app/                  ← routes
/src/lib/progression/      ← règles d'état, testées
/src/lib/fsrs/             ← ordonnanceur, testé
/src/components/
/db/migrations/
/docs/                     ← prompt, design, décisions
/scripts/                  ← validation du graphe
```

## 9. Direction visuelle

Voir `docs/design.md` pour le plan complet. Contraintes fermes du brief :

- **La couleur est une variable, pas un ornement.** Elle encode l'état de
  maîtrise et rien d'autre.
- **La typographie doit s'accorder à KaTeX.** Ligne de base et couleur d'encre
  communes. Longueur de ligne sous 80 caractères.
- **Le graphe est le héros de la page d'accueil.**
- Zéro animation non déclenchée par une action.
- Accessibilité : focus clavier visible, contrastes suffisants,
  `prefers-reduced-motion` respecté, lisible jusqu'au mobile.

À éviter : fond crème avec serif à fort contraste et accent terracotta ; noir
profond avec un unique accent vert acide ; cartes arrondies identiques à ombre
grise ; eyebrows en capitales espacées ; méta-informations jointes par des points
médians ; flèche « → » ajoutée aux libellés de boutons.

## 10. Conventions de rédaction

- **Langue : français**, terminologie mathématique française, avec le terme
  anglais entre parenthèses à la première occurrence lorsqu'il domine la
  littérature (« vraisemblance (*likelihood*) »).
- **Notation cohérente sur tout le corpus**, fixée dans `/content/notation.mdx`.
- **Pas de flatterie pédagogique.** Ni « c'est très simple », ni « il suffit de
  remarquer ». Si une étape est difficile, le dire et la détailler.
- **Aucune référence inventée.** Auteur, ouvrage, chapitre. En cas de doute sur
  la pagination, citer le chapitre seul. En cas de doute sur l'existence de la
  référence, ne pas la citer.
- Tout résultat non démontré doit être signalé comme admis, avec l'endroit où la
  démonstration se trouve.

## 11. Boucle de travail (à chaque session)

1. Demander quel nœud est visé, ou le proposer d'après l'état du graphe.
2. Rédiger le contenu du nœud selon la rubrique de la section 6.
3. N'ajouter du code que si ce nœud exige une capacité qui manque.
4. Vérifier : build vert, rendu KaTeX correct, code Python des simulations
   réellement exécuté et non seulement écrit, tests de progression au vert.
5. Commit avec un message décrivant le nœud rédigé, pas le fichier modifié.
6. Terminer par un point court : ce qui est rédigé, ce qui manque, quel nœud est
   le prochain candidat logique dans le DAG.

## 12. Critères d'acceptation

L'application est réussie si, un an après le démarrage :

- Le graphe reflète fidèlement les dépendances réelles et sert à décider quoi
  apprendre ensuite.
- Le corpus rédigé est relisible seul, sans l'application, comme un manuel.
- Les révisions font remonter les notions oubliées avant que je m'en aperçoive.
- Le journal des tentatives montre où je bloque de façon récurrente.
- Aucune fonctionnalité construite n'est restée inutilisée.

## 13. Hors périmètre

Multi-utilisateur, comptes, partage social, gamification (badges, séries,
points), génération automatique de cours par appel LLM à l'exécution,
application mobile native, déploiement public. Si l'une de ces idées paraît utile
en cours de route, la proposer d'abord — ne pas l'implémenter.

## 14. Première session — fait

1. Graphe complet dans `content/graph.yaml`, arêtes incluses. ✔ relu et validé.
2. Plan de design dans `docs/design.md`. ✔
3. Mode révision : décision D1 dans `docs/decisions.md`. ✔ validée.

V0 livrée le 2026-09-09 : graphe (vue carte et vue arborescente), page de nœud
avec rendu MDX + KaTeX, marquage manuel de la progression, journal de session,
SQLite migré, 26 tests sur les règles de progression.

V1 livrée le 2026-09-10 : révision espacée FSRS-4.5 avec file entrelacée sur
tout le corpus, suivi des tentatives d'exercices avec le champ « ce qui a
bloqué », déblocage automatique alimenté par les preuves réelles, recherche
plein texte par section, exécution Python dans le navigateur. 52 tests.

Premier concept rédigé : `suites-reelles` — cours en neuf sections, onze
exercices sur les cinq difficultés, onze cartes de révision.

V2 livrée le 2026-09-10 : tableau de bord (heures par niveau, charge de
révision, courbe d'oubli, réussite par tag), détection des nœuds fragiles,
premier widget interactif, export PDF par impression de `/corpus`. 76 tests.

Reste à livrer sur le topic `analyse-reelle` : `limites-continuite`,
`derivation-taylor`, `integration-riemann`, `series-numeriques`,
`suites-series-fonctions`.
