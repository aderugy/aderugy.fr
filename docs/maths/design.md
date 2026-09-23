# Plan de design — avant toute ligne de CSS

Réponse au §9 du brief. Rien de ce document n'est encore implémenté.

---

## 1. Le parti pris

L'objet n'est pas un cours en ligne, c'est **un instrument de mesure posé sur une
paillasse** : une plaque neutre, des graduations, une aiguille. Ce qui bouge à
l'écran, c'est l'état de l'apprentissage — le reste est du cadran.

Conséquence directe : l'interface ne contient qu'**une seule variable visuelle
libre**, la couleur, et cette variable est réservée à la maîtrise. Tout le reste
(hiérarchie, groupement, importance) passe par la position, le filet et le blanc.

---

## 2. Couleurs

Quatre couleurs nommées, plus une rampe qui compte pour une variable unique.

| jeton | valeur | rôle |
|---|---|---|
| `--graphite` | `#1B1D21` | **encre unique** : texte, formules KaTeX, arêtes du graphe, icônes. Aucun texte n'a jamais une autre couleur. |
| `--plaque` | `#F1F2F3` | fond de page, du bord au bord. Pas de blanc « carte » posé dessus. |
| `--graduation` | `#C6CBD1` | filets 1 px, règles, axes, ticks, contour des nœuds verrouillés. Le seul outil de groupement. **Jamais une couleur de texte.** |
| `--encre-faible` | `#5B6069` | texte secondaire : libellés de rails, métadonnées, unités. 6,3:1 sur la plaque. |
| `--maitrise-*` | rampe | **la seule couleur porteuse d'information** (voir ci-dessous). |
| `--alerte` | `#B3261E` | erreurs système uniquement (échec de sauvegarde, contenu introuvable). **Jamais** un état d'apprentissage. |

**La rampe de maîtrise** — une seule teinte (bleu instrument, ~205°), quatre
arrêts d'intensité croissante. La maîtrise est une grandeur ordonnée : elle doit
se lire comme une échelle graduée, pas comme un code de couleurs à mémoriser.

```
verrouillé   --graduation  #C6CBD1   contour seul, intérieur vide
disponible   --maitrise-10 #AFC4D2   aplat pâle
en cours     --maitrise-40 #5C89A6
acquis       --maitrise-70 #2A5D7E
maîtrisé     --maitrise-100 #10344A  aplat plein, texte en --plaque
```

**Ce qui n'a pas droit à une couleur.** Une révision en retard, un nœud fragile,
une carte en échec : ce sont des informations de *temps*, pas de maîtrise. Elles
s'encodent hors de la couleur — hachure diagonale sur l'aplat, et tick plein sur
la règle d'échéance. Un nœud maîtrisé dont les révisions échouent redescend la
rampe **et** se hachure : la perte de maîtrise se voit sans introduire une
seconde teinte. Cela rend aussi l'information lisible sans distinguer les
couleurs.

Un mode sombre est une inversion des jetons `--graphite` / `--plaque` et une
rampe rééchelonnée. Les jetons sont posés pour que ce soit un remplacement de
valeurs, pas une refonte. Non fait en V0.

---

## 3. Typographie

Contrainte dominante du §9 : le corps de texte et KaTeX doivent partager une
ligne de base et une encre. KaTeX rend en Computer Modern ; presque toutes les
polices d'écran modernes jurent à côté.

| usage | famille | réglage |
|---|---|---|
| corps, titres, mathématiques | **CMU Serif** (Computer Modern Unicode, woff2 auto-hébergé) | 18 px / 28 px, mesure 68ch (≈ 72 caractères) |
| mathématiques | **KaTeX** (Computer Modern, même squelette) | `font-size: 1em`, `color: inherit` |
| chrome : navigation, rails, métadonnées, étiquettes du graphe, tableaux | **Inter** | 13–14 px, `font-variant-numeric: tabular-nums` |
| code Python | **JetBrains Mono** | 14 px / 24 px |

Règles fermes :

- Une formule en ligne n'a **ni** taille **ni** couleur propre. `.katex` hérite.
- Les formules affichées sont alignées sur la **marge gauche du paragraphe**,
  pas centrées : l'œil qui descend la colonne ne dévie pas. Numérotation en
  marge droite.
- Échelle réduite à cinq corps : 13 / 15 / 18 / 22 / 28. Tout s'aligne sur une
  grille de 4 px.
- Inter ne touche jamais le contenu du cours. Si une police sans empattement
  apparaît dans la colonne de lecture, c'est un bug.

---

## 4. Mise en page

### Page d'accueil — le graphe occupe le cadre

```
┌────────────────────────────────────────────────────────────────────────────┐
│ parcours    révision 12    journal                        1 633 h · 0,0 %  │  règle haute, filet bas
├───────┬────────────────────────────────────────────────────────────────────┤
│ N0 ▮  │                                                                    │
│ N1 ▯  │         ●───●───●                                                  │
│ N2 ▯  │          ╲   ╲                    le DAG, plein cadre,             │
│ N3 ▯  │           ●───●───◐───○           zoom et déplacement,             │
│ N4 ▯  │                ╲       ╲          disposition figée                │
│ N5 ▯  │                 ●───────○                                          │
│ N6 ▯  │                                                                    │
│ TR ▯  │                                                                    │
├───────┴────────────────────────────────────────────────────────────────────┤
│ suites-reelles · disponible · 10 h · débloque 3 nœuds          [ ouvrir ]   │  règle basse : nœud pointé
└────────────────────────────────────────────────────────────────────────────┘
```

Le rail gauche filtre par domaine, il ne raconte rien. Les deux règles
horizontales sont fines et fixes ; toute la surface restante est le graphe.
Aucun chiffre de progression en gros, aucune bannière.

### Page de nœud — une colonne, deux rails

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ← parcours / niveau 0 / analyse réelle                      disponible ▯   │
├────────────┬─────────────────────────────────────────────┬─────────────────┤
│ 1 position │  Suites réelles, bornes et convergence      │ prérequis       │
│ 2 problème │                                             │   —             │
│ 3 construc.│  Colonne de 68ch. Les formules affichées    │ débloque        │
│ 4 intuition│  s'alignent sur cette marge gauche ; leur   │   limites-cont. │
│ 5 preuves  │  numéro va en marge droite.        (1.4)    │   séries-num.   │
│ 6 pièges   │                                             │                 │
│ 7 simul.   │  ── exercices ──────────────────────────    │ cartes       0  │
│ 8 liens    │  1  ▮▯▯▯▯  calcul       résolu seul  12 min │ tentatives   0  │
│ 9 réfs     │  2  ▮▮▯▯▯  preuve       —         [ ouvrir ]│                 │
│            │  3  ▮▮▮▯▯  simulation   —         [ ouvrir ]│ [ journal ]     │
│ ▮ 0 h 00   │                                             │                 │
└────────────┴─────────────────────────────────────────────┴─────────────────┘
```

Le rail gauche est la rubrique du §6, toujours dans le même ordre, sur toutes les
pages : il devient un repère mémorisable. Le rail droit est le seul endroit où
des chiffres d'état sont affichés. Les exercices sont des bandes séparées par des
filets, pas des cartes.

---

## 5. Trois principes propres à ce projet

1. **L'état est la seule couleur.** Une page sans donnée d'état est en graphite
   sur plaque. Les liens, boutons et onglets ne sont jamais colorés : leur
   affordance vient du soulignement, de la position et de l'anneau de focus. Si
   une couleur apparaît quelque part, elle signifie un niveau de maîtrise ou une
   erreur système — il n'y a pas de troisième cas.

2. **Des filets, pas des cartes.** Le groupement se fait par filet de 1 px et par
   blanc sur une grille de 4 px. Zéro ombre, zéro rayon de bordure supérieur à
   2 px, zéro conteneur imbriqué décoratif. Un écran doit pouvoir s'imprimer en
   noir et blanc sans rien perdre.

3. **Le graphe est une carte, pas une illustration.** La disposition est calculée
   une fois avec une graine fixe et **mise en cache dans le dépôt** : un nœud est
   au même endroit d'une session à l'autre, y compris après ajout de nœuds
   voisins. Sur plusieurs années, la mémoire spatiale devient un outil de
   navigation réel — un layout recalculé à chaque chargement la détruirait.

---

## 6. Relecture critique de ce plan

Le brief demande de relire ce plan et de corriger ce qui ressemble à un réflexe.
Quatre choses ont été retirées d'une première version :

1. **Le feu tricolore.** Premier jet : vert « acquis », ambre « en cours », rouge
   « en retard ». C'est la palette par défaut de n'importe quel LMS, et surtout
   elle viole le brief — trois teintes encodant trois variables différentes,
   alors que la couleur doit encoder la maîtrise et rien d'autre. Remplacé par
   une rampe monochrome ordonnée, et le retard déplacé sur un canal non
   coloré (hachure).

2. **Le grand pourcentage d'avancement en haut de l'accueil**, avec les heures de
   la semaine. C'est de la gamification déguisée (§13) et cela vole la place du
   graphe, qui doit être le héros. Il reste une ligne de chiffres de 13 px dans
   la règle haute, sans emphase.

3. **Les cartes d'exercice arrondies avec ombre.** Figurait explicitement dans la
   liste des défauts par défaut du brief, et j'y allais quand même. Remplacées
   par des bandes séparées par des filets.

4. **Inter comme police de corps.** Choix par défaut confortable, mais
   incompatible avec la contrainte la plus forte du §9 : Inter ne partage ni ligne
   de base ni couleur d'encre avec Computer Modern, et chaque formule en ligne
   aurait eu l'air collée depuis un autre document. Le corps passe en Latin
   Modern Roman, Inter est rétrogradé au chrome.

Ce qui reste discutable et sera tranché à l'usage : CMU Serif est fine à l'écran ;
si elle fatigue au bout de deux heures, le repli est STIX Two Text, qui garde la
compatibilité de squelette avec les mathématiques.

**Correction faite à l'implémentation.** Latin Modern Roman était le choix du
plan ; aucune distribution web n'en existe avec une couverture française
complète (les paquets disponibles sont des sous-ensembles de 228 glyphes, sans
œ ni ’ — or « nœud » est le mot le plus fréquent de l'interface). CMU Serif est
la version Unicode du même dessin, 2 159 glyphes, et partage donc le squelette
des fontes KaTeX. L'intention du plan est tenue, la police change. Voir la
décision D9.

Deuxième correction : `--graduation` servait à la fois de filet et de couleur
de texte secondaire, soit un contraste de 1,3:1 — illisible, et contraire à la
contrainte d'accessibilité. D'où le jeton `--encre-faible`. Voir D11.
