#!/usr/bin/env python3
"""Validation de content/maths/graph.yaml : structure, references, acyclicite.

Usage : python3 scripts/validate_graph.py
Sort en code 1 si une erreur est detectee.
"""
from __future__ import annotations
import sys, pathlib, collections
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
GRAPH = ROOT / "content" / "maths" / "graph.yaml"

KINDS = {"domain", "topic", "concept"}
STATUSES = {"empty", "draft", "published"}
CONTENT = ROOT / "content" / "maths"
TAGS = {"analyse", "algebre", "combinatoire", "calculatoire", "mesure",
        "asymptotique", "inference", "bayesien", "processus", "ml",
        "causal", "simulation", "donnees", "preuve"}

errors: list[str] = []
warnings: list[str] = []


def main() -> int:
    doc = yaml.safe_load(GRAPH.read_text(encoding="utf-8"))
    nodes = doc["nodes"]
    by_id: dict[str, dict] = {}

    for n in nodes:
        nid = n["id"]
        if nid in by_id:
            errors.append(f"id duplique : {nid}")
        by_id[nid] = n
        if n["kind"] not in KINDS:
            errors.append(f"{nid} : kind inconnu {n['kind']!r}")
        if "contentStatus" in n:
            errors.append(f"{nid} : contentStatus ne doit pas figurer dans graph.yaml "
                          f"(derive du systeme de fichiers, cf. docs/decisions.md D2)")
        for t in n.get("tags") or []:
            if t not in TAGS:
                errors.append(f"{nid} : tag hors vocabulaire {t!r}")

    for n in nodes:
        nid, kind, parent = n["id"], n["kind"], n["parentId"]
        # hierarchie
        if kind == "domain":
            if parent is not None:
                errors.append(f"{nid} : un domain doit avoir parentId null")
        else:
            if parent not in by_id:
                errors.append(f"{nid} : parentId inconnu {parent!r}")
            else:
                expected = "domain" if kind == "topic" else "topic"
                if by_id[parent]["kind"] != expected:
                    errors.append(
                        f"{nid} ({kind}) : parent {parent} est un "
                        f"{by_id[parent]['kind']}, attendu {expected}")
        # requires
        reqs = n.get("requires") or []
        if kind != "concept" and reqs:
            errors.append(f"{nid} : seules les feuilles `concept` portent des requires")
        if len(set(reqs)) != len(reqs):
            errors.append(f"{nid} : requires contient un doublon")
        for r in reqs:
            if r == nid:
                errors.append(f"{nid} : se requiert lui-meme")
            elif r not in by_id:
                errors.append(f"{nid} : requires -> id inconnu {r!r}")
            elif by_id[r]["kind"] != "concept":
                errors.append(f"{nid} : requires -> {r} qui n'est pas un concept")
        # heures
        h = n["estimatedHours"]
        if kind == "concept" and h <= 0:
            errors.append(f"{nid} : estimatedHours doit etre > 0 sur un concept")
        if kind != "concept" and h != 0:
            errors.append(f"{nid} : estimatedHours doit valoir 0 (derive) sur un {kind}")

    if errors:
        return report()

    # acyclicite (tri topologique de Kahn sur les concepts)
    concepts = [n for n in nodes if n["kind"] == "concept"]
    indeg = {n["id"]: len(n["requires"]) for n in concepts}
    dependents: dict[str, list[str]] = collections.defaultdict(list)
    for n in concepts:
        for r in n["requires"]:
            dependents[r].append(n["id"])
    queue = collections.deque(sorted(i for i, d in indeg.items() if d == 0))
    order: list[str] = []
    while queue:
        cur = queue.popleft()
        order.append(cur)
        for d in dependents[cur]:
            indeg[d] -= 1
            if indeg[d] == 0:
                queue.append(d)
    if len(order) != len(concepts):
        bloques = sorted(i for i, d in indeg.items() if d > 0)
        errors.append(f"cycle detecte, {len(bloques)} concepts non ordonnables : {bloques}")
        return report()

    # profondeur (chemin le plus long dans le DAG)
    depth: dict[str, int] = {}
    for nid in order:
        reqs = by_id[nid]["requires"]
        depth[nid] = 1 + max((depth[r] for r in reqs), default=0)
    plus_profond = max(depth, key=lambda k: depth[k])

    # avertissements : concepts isoles
    for n in concepts:
        if not n["requires"] and not dependents[n["id"]]:
            warnings.append(f"{n['id']} : aucun prerequis et aucun successeur (ilot)")

    # rapport
    print(f"OK — {len(nodes)} noeuds : "
          f"{sum(1 for n in nodes if n['kind']=='domain')} domaines, "
          f"{sum(1 for n in nodes if n['kind']=='topic')} topics, "
          f"{len(concepts)} concepts.")
    print(f"DAG acyclique. Profondeur maximale : {depth[plus_profond]} "
          f"(atteinte par {plus_profond}).")
    aretes = sum(len(n['requires']) for n in concepts)
    print(f"{aretes} aretes de prerequis, "
          f"{aretes/len(concepts):.2f} par concept en moyenne.")

    print("\nHeures estimees par domaine")
    for d in [n for n in nodes if n["kind"] == "domain"]:
        topics = [t["id"] for t in nodes if t["parentId"] == d["id"]]
        h = sum(c["estimatedHours"] for c in concepts if c["parentId"] in topics)
        n_c = sum(1 for c in concepts if c["parentId"] in topics)
        print(f"  {d['id']:<12} {h:>5} h   {n_c:>3} concepts   "
              f"~{h/12/4.33:>4.1f} mois a 12 h/semaine")

    inter = collections.Counter()
    dom_of = {}
    for c in concepts:
        topic = by_id[c["parentId"]]
        dom_of[c["id"]] = topic["parentId"]
    for c in concepts:
        for r in c["requires"]:
            if dom_of[r] != dom_of[c["id"]]:
                inter[(dom_of[r], dom_of[c["id"]])] += 1
    print("\nAretes traversant les niveaux (les plus structurantes)")
    for (a, b), k in sorted(inter.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {a} -> {b} : {k}")
    statuts = collections.Counter(content_status(c, by_id) for c in concepts)
    print("\nContenu (derive du systeme de fichiers)")
    for st in ("published", "draft", "empty"):
        print(f"  {st:<10} {statuts.get(st, 0):>3} concepts")

    return report()


def content_status(node: dict, by_id: dict) -> str:
    """Statut derive du systeme de fichiers (decision D2)."""
    if node["kind"] != "concept":
        return "n/a"
    topic = by_id[node["parentId"]]
    domain = by_id[topic["parentId"]]
    course = CONTENT / domain["id"] / topic["id"] / node["id"] / "course.mdx"
    if not course.exists():
        return "empty"
    head = course.read_text(encoding="utf-8").split("---")
    if len(head) > 1 and "status:" in head[1]:
        for line in head[1].splitlines():
            if line.strip().startswith("status:"):
                value = line.split(":", 1)[1].strip()
                if value not in STATUSES:
                    errors.append(f"{node['id']} : status {value!r} inconnu dans le frontmatter")
                return value
    errors.append(f"{node['id']} : course.mdx sans `status` dans le frontmatter")
    return "empty"


def report() -> int:
    for w in warnings:
        print(f"AVERTISSEMENT {w}")
    for e in errors:
        print(f"ERREUR {e}", file=sys.stderr)
    if errors:
        print(f"\n{len(errors)} erreur(s).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
