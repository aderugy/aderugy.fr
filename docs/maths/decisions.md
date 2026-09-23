# Décisions

Journal des arbitrages. Toute décision qui contredit le prompt doit d'abord le
modifier (§ en-tête du brief) ; celles marquées **à valider** ne sont pas prises.

---

## D1 — Mode révision : séparé ou mêlé ? (réponse au §14.3) — **validée le 2026-09-09**

**Proposition : une seule surface de révision, deux vues distinctes.**
Ni « tout mêlé dans la page de nœud », ni « deux applications côte à côte ».

### Pourquoi ni l'un ni l'autre

Apprendre et réviser ne sont pas la même activité, et ce n'est pas une nuance
d'interface :

| | apprentissage | révision |
|---|---|---|
| qui décide de l'ordre | moi, en lisant le DAG | l'ordonnanceur FSRS |
| portée | un nœud | tout le corpus |
| durée typique | 1 à 3 h | 10 à 20 min |
| déclencheur | une décision | une échéance |

**Tout mêler dans la page de nœud** casse FSRS. L'entrelacement entre nœuds
éloignés est précisément ce qui fait l'efficacité de la répétition espacée ; si
les cartes ne sont accessibles que nœud par nœud, l'ordonnanceur ne choisit plus
rien et je révise par paquets thématiques, ce qui est le mode d'étude le moins
efficace connu. Et la session quotidienne de 15 minutes demanderait de naviguer
dans le graphe pour trouver quoi réviser.

**Tout séparer** produit le défaut classique d'Anki : des cartes coupées de leur
contexte. On finit par mémoriser la formulation de la carte au lieu de la
notion, et un échec ne ramène jamais au cours.

### Ce que je propose concrètement

1. **Une route `/revision` unique**, seul endroit où l'ordonnanceur décide. File
   entrelacée sur tout le corpus, pilotage clavier, aucune navigation possible
   pendant la session. C'est le mode « échauffement » de chaque séance.
2. **La page de nœud n'affiche pas de session de révision, mais un relevé** :
   stabilité de chaque carte, prochaine échéance, historique des rechutes. Ce
   n'est pas décoratif — le §4 fait de la stabilité FSRS une condition de l'état
   `mastered`, il faut donc pouvoir la lire là où l'état est affiché.
3. **Depuis ce relevé, une « révision ciblée »** du seul nœud courant : elle met
   à jour les cartes normalement mais ne consomme pas la file globale. Usage
   réel : je viens de relire un nœud, je veux vérifier immédiatement ce qui reste.
4. **Toute carte échouée dans la file globale affiche l'extrait de la section du
   cours dont elle provient**, avec un lien ancré. C'est le pont qui empêche la
   dérive « carte sans contexte ».

### La conséquence pour aujourd'hui

FSRS n'est pas en V0 (§7), donc la décision ne coûte qu'une route plus tard. En
revanche elle impose **dès la première ligne de contenu** deux choses :

- chaque section d'un `course.mdx` porte une **ancre stable** (`## 6. Pièges
  {#pieges}`), sinon les cartes ne pourront jamais pointer vers leur source ;
- `cards.yaml` porte un champ `ref` obligatoire : `ref: pieges`.

C'est la seule contrainte que cette décision fait peser sur la V0.

---

## D2 — `contentStatus` dérivé du système de fichiers — **validée le 2026-09-09**

Deux sources de vérité (la valeur dans `graph.yaml` et l'existence réelle de
`content/.../course.mdx`) auraient divergé dès la troisième session.

`contentStatus` est **dérivé au chargement** : pas de `course.mdx` → `empty` ;
sinon la valeur de `status` dans le frontmatter. Le champ a été retiré des
240 nœuds de `graph.yaml`. Le type `Node` du §4 le conserve, seule sa provenance
change ; `docs/prompt.md` §4 et §5 sont amendés en conséquence, et
`scripts/validate_graph.py` refuse désormais un `contentStatus` écrit dans le
YAML, dérive le statut et signale un `course.mdx` sans `status`.

Chemin attendu pour un concept : `content/<domain>/<topic>/<concept>/course.mdx`.

## D3 — Heures sur les `topic` et `domain` : dérivées

`estimatedHours` vaut `0` sur les conteneurs et la valeur affichée est la somme
des descendants, comme `unlocks` est dérivé. Éviter une deuxième source de vérité.
Décidé unilatéralement, faible enjeu, mentionné pour la trace.

## D4 — Granularité du niveau 6 : volontairement grossière — **validée le 2026-09-09**

Les six spécialisations ont des concepts de 20 à 32 h, contre 6 à 16 h ailleurs.
Elles seront redécoupées au moment d'en choisir deux ou trois. Le brief demande
d'en retenir 2-3 : le total de 764 h porté par le niveau 6 n'est donc jamais à
parcourir en entier (2-3 spécialisations ≈ 250 à 380 h).

## D5 — `requires` uniquement entre `concept`

Les arêtes du DAG ne partent et n'arrivent que sur des `concept`. Un `topic` est
disponible dès qu'un de ses concepts l'est ; un `domain` dès qu'un de ses topics
l'est. Sinon la règle « `available` si tous les `requires` sont `learned` » aurait
deux sémantiques selon le `kind`. Vérifié par `scripts/validate_graph.py`.

## D6 — Droits de suppression sur le dossier monté

Le dossier `D:\Maths` n'autorisait pas la suppression de fichiers depuis la
session, et git laissait derrière lui des `.lock` qui bloquaient le commit
suivant. Droit accordé le 2026-09-09 ; les fichiers résiduels et le dossier de
contournement `_to_delete/` ont été supprimés.

## D7 — Châssis avant contenu — **dérogation demandée le 2026-09-09**

Le §3 dit « ne construis jamais du châssis pour du contenu qui n'existe pas ».
La V0 a pourtant été livrée sans cours rédigé, à la demande explicite, pour voir
l'application tourner plus tôt. La dérogation est bornée : la prochaine session
rédige `analyse-reelle` et n'ajoute aucune fonctionnalité.

Un seul contenu a été écrit, parce qu'il est exigé par le §10 et qu'il sert de
banc d'essai à KaTeX : `content/notation.mdx`. Il rend 61 formules dont un
`aligned`, un `cases` et un `bmatrix`, sans erreur.

## D8 — Rendu du graphe : SVG sur mesure, pas React Flow

Le §8 laissait le choix entre React Flow + dagre et un rendu sur mesure. La
disposition étant précalculée et versionnée (principe 3 du design), il ne reste
à faire que du dessin et du zoom : ~180 lignes de SVG, contre une dépendance
lourde dont on n'utiliserait ni l'édition, ni les poignées, ni les handles.
`@dagrejs/dagre` reste utilisé, mais seulement dans `scripts/layout.mjs`, côté
outillage — il n'est jamais envoyé au navigateur.

## D9 — Police de corps : CMU Serif et non Latin Modern Roman

Latin Modern Roman n'existe en distribution web qu'en sous-ensembles de
228 glyphes, sans `œ` ni `’`. CMU Serif (Computer Modern Unicode) est le même
dessin en 2 159 glyphes. Même squelette que les fontes KaTeX, donc la contrainte
du §9 est tenue : prose et formules partagent l'encre et la ligne de base.
Quatre fichiers woff2 dans `public/fonts`, 764 Ko, aucun CDN.

Les `@font-face` du paquet npm `computer-modern` déclarent `font-style: roman`,
qui n'est pas une valeur CSS valide et serait ignoré : les déclarations sont
réécrites à la main dans `globals.css`.

## D10 — Ancres de section : prétraitement avant compilation MDX

MDX lit `{...}` comme une expression JavaScript : `## Pièges {#pieges}` casse la
compilation. Plutôt que de renoncer aux ancres explicites — dont dépend la
décision D1 — `src/lib/mdx.tsx` extrait `{#id}` des titres et pose une ancre
juste au-dessus. La syntaxe de rédaction reste celle attendue, et l'ancre ne
dépend pas du libellé du titre, qui peut être reformulé sans casser les liens.

## D11 — Jeton `--encre-faible`

`--graduation` (#C6CBD1) était utilisé à la fois comme filet et comme couleur de
texte secondaire : 1,3:1 sur la plaque, illisible. Le texte secondaire passe sur
`--encre-faible` (#5B6069, 6,3:1) ; `--graduation` ne trace plus que des traits.

## D12 — Vue par domaine avec fantômes amont

Une vue du graphe entier fait 12 941 px de large : illisible à l'ouverture. La
carte est donc découpée par domaine, chaque vue montrant les concepts du domaine
plus, en pointillés, leurs prérequis extérieurs — la direction amont, celle qui
dit ce qui manque. Les dépendants extérieurs ont été essayés puis retirés : ils
faisaient 39 fantômes pour 22 concepts au niveau 0, et la page de nœud les liste
déjà sous « débloque ». La vue globale reste accessible par « tout le graphe ».

Un niveau qui tient dans le cadre à 85 % ou plus s'ouvre en entier ; sinon la
carte s'ouvre à l'échelle 1 sur le nœud courant, qui porte un contour graphite.

## D13 — Docker : oui, et pour une raison précise

Le §8 n'autorise Docker Compose que « si cela simplifie réellement le
lancement ». Ici, oui : `better-sqlite3` est un module natif, et la seule chose
que je n'ai jamais pu vérifier sur ce projet, c'est sa compilation sous Windows.
Le conteneur supprime la question — image glibc (bookworm et non Alpine), où le
binaire précompilé existe, avec `python3 make g++` comme filet.

Trois services :

| service | profil | ce qu'il fait |
|---|---|---|
| `app` | défaut | image de production, `:3000` |
| `dev` | `dev` | serveur de développement, rechargement à chaud, `:3001` |
| `tools` | `tools` | `npm run layout`, `check`, `db:migrate` sans Node ni Python sur la machine |

`dev` et `tools` réutilisent l'étage `builder`, qui garde `node_modules` complet
— dagre, TypeScript, Vitest, et python3 + PyYAML pour `validate_graph.py`.

**Montages.** `./content` en lecture seule : l'application n'y écrit jamais, et
le dire au niveau du montage vaut mieux que le promettre. `./db` en écriture,
seul état mutable — la sauvegarde reste une copie de fichier, comme le veut le
§8. `node_modules` et `.next` sont des volumes nommés dans le service `dev` :
sans cela le montage du projet ramènerait dans le conteneur les binaires natifs
compilés pour l'hôte, c'est-à-dire exactement le problème qu'on cherchait à
éviter.

**La disposition du graphe** est recalculée dans l'étage `builder`, donc l'image
est toujours cohérente avec `graph.yaml`. Au démarrage, le montage en lecture
seule fait gagner le fichier versionné : l'entrypoint vérifie qu'il existe et
échoue avec la commande à lancer sinon. Après une modification de `graph.yaml`,
il faut `npm run layout` puis `docker compose restart app` — le graphe est mis
en cache au démarrage, contrairement aux `course.mdx`, relus à chaque requête.

**Sortie autonome.** `output: "standalone"` réduit le runtime à 29 Mo au lieu
des ~500 Mo de `node_modules`. Vérifié : le binaire natif
`better_sqlite3.node` est bien tracé. `sharp` l'était aussi — 46 Mo pour une
optimisation d'images dont l'application ne se sert jamais — et il est exclu par
`outputFileTracingExcludes`. À rouvrir le jour où une image passera par
`next/image`.

**Ce qui n'est pas vérifié.** Docker Hub est bloqué par la politique de sortie
réseau de ma session : impossible de tirer `node:22-bookworm-slim`, donc l'image
n'a jamais été construite. Ce qui a été vérifié à la place, hors conteneur :
l'arborescence exacte que le runner assemble (standalone + static + public +
content + db/migrations + scripts/migrate.mjs), démarrée avec les mêmes
variables d'environnement — toutes les routes en 200, migrations appliquées,
polices servies ; l'entrypoint dans ses deux cas, nominal et disposition
manquante ; et `docker compose config` sur les trois services. Reste non testé :
`npm ci` et l'installation de better-sqlite3 dans le conteneur.

## D14 — FSRS-4.5, et le piège de l'appariement formule / poids

L'ordonnanceur est FSRS-4.5 : dix-sept poids, stabilité S en jours,
difficulté D dans [1, 10], rétrievabilité R(t) = (1 + FACTOR·t/S)^DECAY avec
DECAY = −0,5 et FACTOR = 19/81 — valeur choisie pour que R(S) = 0,9 exactement,
ce que vérifie le premier test.

**Un bogue silencieux a été trouvé en lisant la base après une session de
révision réelle.** J'avais écrit la difficulté initiale sous sa forme
exponentielle, D₀(G) = w₄ − e^(w₅·(G−1)) + 1, qui est celle de FSRS-5, avec les
poids de FSRS-4.5. Résultat : D₀(3) ≈ −5,5 et D₀(4) ≈ −18, tous deux ramenés à
1 par le bornage. Autrement dit, toute carte réussie recevait la difficulté
minimale, le terme (11 − D) de la mise à jour de stabilité se figeait, et
l'ordonnanceur cessait de distinguer les cartes difficiles des autres — sans
qu'aucune erreur n'apparaisse nulle part. La forme correcte pour ce jeu de
poids est linéaire : D₀(G) = w₄ − w₅·(G−3), qui donne 7,62 / 6,39 / 5,16 / 3,93.

Deux tests ont été ajoutés pour cette classe de bogue : D₀(2) et D₀(3) doivent
tomber **strictement à l'intérieur** de [1, 10], et une carte de difficulté 1
doit gagner au moins 50 % de stabilité de plus qu'une carte de difficulté 10.
Le test qui existait déjà — « D₀ décroît avec la note, et reste dans [1, 10] » —
passait malgré le bogue.

Les 26 tests de l'ordonnanceur portent sur des propriétés (monotonie en la
note, effet d'espacement, un oubli n'augmente jamais la stabilité, bornes
respectées après cinquante révisions) et non sur des valeurs numériques
attendues, qui ne feraient que recopier l'implémentation.

Les poids sont les valeurs publiées par défaut. Ils sont censés être réoptimisés
sur l'historique réel — d'où la table `review_log`, qui conserve l'état *avant*
chaque révision. Sans elle, cette réoptimisation serait impossible.

## D15 — Pyodide : une seule URL, un échec bavard

Les blocs ```` ```python ```` des sections « Vérification par simulation »
deviennent exécutables. Pyodide tourne dans un web worker
(`public/pyodide-worker.js`) pour ne pas figer la page pendant un calcul.

Le chargement vient d'un CDN : au premier lancement il faut du réseau et une
dizaine de mégaoctets, ensuite le cache du navigateur suffit. L'URL de base est
écrite **à un seul endroit**, `PYODIDE_BASE` dans `src/components/BlocPython.tsx`,
surchargeable par `NEXT_PUBLIC_PYODIDE_BASE`. Une version inexistante donnerait
un 404 muet : le message d'erreur cite donc l'URL complète et le fichier à
modifier. Comportement vérifié — le conteneur de développement n'a pas accès au
CDN, et c'est bien ce message qui s'affiche.

Conséquence pour Docker : le conteneur n'a rien à télécharger, c'est le
navigateur qui va chercher Pyodide. Hors ligne, le reste de l'application
fonctionne, seuls les boutons « exécuter » échouent.

## D16 — Recherche plein texte : sans dépendance, par section

L'index est construit à partir des fichiers, en mémoire, au premier appel :
un document par **section** de cours (et non par cours), un par exercice
(énoncé et correction), un par carte, un par nœud. Chercher doit renvoyer au
bon endroit du cours, pas en haut de la page — d'où le découpage sur les titres
de niveau 2 et l'utilisation de leurs ancres.

Normalisation : minuscules, accents retirés. Recherche conjonctive — tous les
termes doivent apparaître. Un terme trouvé dans un titre pèse trois fois plus
que dans le corps, et un nœud voit son score doublé : sans cela une longue
démonstration citant dix fois « Cauchy » passe devant le nœud qui porte ce nom.

Aucune bibliothèque : le corpus complet fera quelques mégaoctets de texte, très
loin de ce qui justifierait un index inversé.

## D17 — Plafond de vingt cartes neuves par file

Un nœud fraîchement rédigé apporte d'un coup une dizaine de cartes. Sans
plafond, elles partent toutes le même jour et l'ordonnanceur les ramène ensuite
groupées — l'effet d'avalanche classique. Le plafond est **sans état** : il
s'applique à la file, pas à la journée, ce qui évite une table de plus. À
revoir quand plusieurs topics seront rédigés.

## D18 — Ce que la V1 a changé aux règles de progression

Les règles du §4 n'ont pas bougé : elles étaient déjà écrites et testées en V0.
Ce qui change, c'est leur alimentation — `lib/progression/evidence.ts` assemble
maintenant les preuves à partir des tentatives réelles et des stabilités FSRS,
là où la V0 ne connaissait que le marquage manuel.

Un point non évident : les stabilités sont calculées sur **toutes** les cartes
déclarées dans `cards.yaml`, pas seulement sur celles déjà révisées, une carte
jamais vue comptant pour zéro. Sans cela, un nœud dont une seule carte sur onze
aurait été révisée passerait `mastered`.

Vérifié de bout en bout : après huit tentatives sur les exercices de difficulté
≤ 3 de `suites-reelles` (sept réussites, dont cinq sans indice),
le nœud passe `learned` et ses deux successeurs directs,
`limites-continuite` et `series-numeriques`, passent `available`, tandis que
`derivation-taylor`, à deux arêtes, reste `locked`.

## D19 — Aucune lecture de base pendant le build

Le premier `docker compose build` de la V1 a échoué sur
`SqliteError: no such table: review_state`, dans `next build`. Cause : le
compteur de révisions vivait dans le layout racine, et Next prérend
`/_not-found` au build — donc le layout s'exécutait à un moment où aucune base
n'existait. Le bogue n'était pas docker-spécifique : une base supprimée aurait
produit la même erreur en local.

Trois corrections, du symptôme vers la racine :

1. **Le compteur sort du prérendu.** Il est isolé dans un composant appelant
   `connection()`, sous un `Suspense` : l'en-tête se prérend, le compteur
   attend la requête. `/_not-found` devient dynamique, ce qui est correct — un
   en-tête qui affiche un état ne peut pas être statique.

2. **La connexion applique les migrations manquantes à l'ouverture**
   (`src/lib/db/client.ts`), en partageant la table `_migrations` avec
   `scripts/migrate.mjs`. Il n'existe donc plus d'état où l'application tourne
   sur une base sans schéma : base supprimée, migration oubliée, premier
   démarrage sans `db:migrate`. L'appel à `migrate.mjs` reste dans l'entrypoint
   Docker : il fait échouer le démarrage bruyamment plutôt que la première
   requête.

3. **La connexion est ouverte à la première requête, pas à l'import du
   module.** C'était le vrai coupable de la trace : le simple chargement du
   module par le bundler créait `db/parcours.db`, et le fichier finissait tracé
   dans `.next/standalone`, donc embarqué dans l'image — de l'état
   d'utilisateur dans un artefact de build. Un proxy retarde l'ouverture sans
   toucher aux appels.

Vérifié en reproduisant exactement la condition du build Docker : base
supprimée, `next build` passe, aucun fichier de base n'est créé, et la sortie
autonome ne contient plus que `db/migrations`. Au premier démarrage, la base
est créée et les deux migrations appliquées.

## D20 — Défilement du cours : document, pas coquille d'application

La page de nœud était en `min-h-[calc(100vh-2.5rem)]` : la colonne de lecture
n'avait donc jamais de hauteur bornée, son `overflow-y-auto` ne s'activait
jamais, et c'était la page entière qui défilait — rails compris, qui
disparaissaient au bout d'un écran.

Deux issues possibles. Borner la hauteur et faire défiler la seule colonne
donne une coquille d'application ; c'est ce que font déjà l'accueil et la file
de révision, à juste titre — une carte et un canevas sont des instruments, pas
des textes. Mais pour un cours de neuf sections, un conteneur de défilement
interne casse silencieusement la barre du navigateur, la recherche dans la
page, le clavier et le comportement sur mobile.

**Le cours est un document : c'est la page qui défile, et les rails collent.**
L'en-tête et le fil d'Ariane restent en place (2,5 rem puis 2,25 rem), les deux
rails aussi, avec une hauteur fixée au reste du viewport pour que leurs filets
verticaux soient continus et un défilement interne propre quand leur contenu
déborde. Les rails portent la navigation par section et le relevé d'état : ils
n'ont aucune raison de partir au bout de trois écrans.

Deux détails qui font échouer la chose si on les oublie : `items-start` sur le
conteneur flex — un enfant étiré sur toute la hauteur n'a aucune marge pour
coller — et un fond opaque sur les règles, sinon le texte défile au travers.

`scroll-margin-top` passe de 64 à 88 px pour dégager les deux règles : cliquer
« 6 pièges » dans le rail posait jusque-là le titre sous le fil d'Ariane.
Vérifié : le titre atterrit à 112 px, les règles occupant les 76 premiers.

## D21 — Des graphiques à l'encre, pas une palette

Le §9 dit que la couleur encode l'état de maîtrise et rien d'autre. Un tableau
de bord dit normalement le contraire : une teinte par série. Les deux ne peuvent
pas cohabiter, il fallait trancher.

**Les graphiques sont tracés à l'encre** — graphite sur plaque, comme un
enregistrement d'instrument — et la rampe de maîtrise n'apparaît qu'à un seul
endroit, les heures acquises, parce que la grandeur mesurée y *est* la maîtrise.
Là où il faudrait distinguer des catégories, on emploie la texture et
l'étiquetage direct : dans les barres de réussite par tag, encre pleine =
réussi seul, hachure à 45° = réussi avec indice, contour seul = échec. Aucune
seconde teinte, et le tableau de bord reste lisible imprimé en noir et blanc.

La rampe a été vérifiée comme échelle séquentielle : luminosité OKLab
strictement décroissante et régulièrement espacée, 0,809 → 0,609 → 0,459 →
0,311. En revanche son premier échelon n'a que **1,61:1** de contraste sur la
plaque — sous le seuil de 3:1. Tout aplat clair porte donc une étiquette
chiffrée, et chaque graphique est doublé d'un tableau. C'est aussi ce qui
remplace l'infobulle au survol : la valeur est déjà à l'écran, ce qui vaut mieux
qu'un survol pour une page destinée à être imprimée.

## D22 — Ce que le tableau de bord refuse de faire

Chaque panneau annonce ce qui lui manque plutôt que d'afficher un graphique
vide : « aucune carte révisée — la courbe est calculée à partir des stabilités,
qui n'existent qu'après une première révision ». Avec un seul nœud rédigé,
c'est l'essentiel de ce que la page a à dire, et le dire est plus utile que de
tracer du bruit.

La **courbe d'oubli est une prévision, pas une mesure** : c'est la formule FSRS
appliquée aux stabilités actuelles, et la page l'écrit noir sur blanc. La courbe
empirique — taux de rappel réel en fonction du délai — demandera plusieurs
centaines de lignes dans `review_log`, que la V1 enregistre déjà pour ça.

Les heures affichent trois grandeurs distinctes côte à côte : estimé, acquis,
réel. L'écart entre estimé et réel est la seule façon de savoir si les
estimations du graphe valent quelque chose ; il ne voudra rien dire avant
plusieurs nœuds terminés, et la page le dit aussi.

## D23 — Un seul widget, celui qui a du contenu

Le §7 cite quatre widgets : loi des grands nombres, chaîne de Markov,
trajectoires browniennes, effet du prior. Trois portent sur des nœuds qui
n'existent pas — ce serait du châssis pour du contenu absent, ce que le §3
interdit.

`Convergence` est construit parce qu'il sert trois nœuds réels ou proches :
`suites-reelles`, où il montre qu'une suite convergente peut l'être très
lentement ; `loi-grands-nombres-intuitive`, dont il est l'illustration directe ;
et `loi-cauchy-lois-lourdes`, parce que basculer la loi sur Cauchy fait
disparaître la convergence sous les yeux — sans espérance, pas de LGN. Il est
inséré dans la section 7 de `suites-reelles`, là où le cours parlait déjà de
ça.

Le générateur pseudo-aléatoire est déterministe et sa graine est un paramètre
affiché : la même page donne toujours la même figure, ce qui est la moindre des
choses pour un support de cours dont on peut discuter les valeurs. Les widgets
suivants viendront avec les nœuds qu'ils illustrent.

## D24 — L'export PDF est une feuille de style, pas un générateur

Le §7 demande un export PDF. Il n'y a pas de chaîne de génération : il y a la
route `/corpus`, qui rend tout le corpus rédigé dans l'ordre topologique du
DAG, et un bloc `@media print`. « Imprimer vers un PDF » depuis le navigateur
produit le fichier.

La raison est simple : un générateur séparé serait un second moteur de rendu à
maintenir — KaTeX, les polices, la mise en page — et le premier écart entre les
deux serait invisible jusqu'à ce qu'on relise le PDF. Là, le PDF *est* la page.

La feuille d'impression retire le chrome (en-tête, rails, boutons, formulaires,
contrôles de widget), passe en noir sur blanc, force un saut de page avant
chaque nœud et interdit de couper un énoncé, une figure, un bloc de code ou une
formule affichée. Vérifié en émulant le média d'impression : 22 pages A4
générées pour le seul nœud rédigé, en-tête et boutons absents.
