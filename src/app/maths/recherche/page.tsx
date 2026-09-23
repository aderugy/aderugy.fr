import Link from "next/link";
import { chercher, normaliser } from "@/lib/maths/search";

const LIBELLE: Record<string, string> = {
  noeud: "nœud",
  cours: "cours",
  exercice: "exercice",
  carte: "carte",
};

export default async function RecherchePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const requete = (q ?? "").trim();
  const resultats = requete ? chercher(requete) : [];
  const termes = normaliser(requete).split(" ").filter(Boolean);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
      <form className="flex gap-2 text-sm" action="/maths/recherche">
        <input
          name="q"
          defaultValue={requete}
          autoFocus
          placeholder="chercher dans les cours, les exercices et les cartes"
          className="grow rounded border border-line bg-surface px-3 py-1.5 focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          className="rounded bg-accent px-3 py-1.5 text-white"
        >
          chercher
        </button>
      </form>

      {requete && (
        <p className="chrome text-muted mt-3">
          {resultats.length} résultat{resultats.length > 1 ? "s" : ""} pour
          « {requete} »
        </p>
      )}

      <ul className="mt-4">
        {resultats.map((r, i) => (
          <li key={i} className="border-line border-b py-3">
            <div className="chrome flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted">{LIBELLE[r.type]}</span>
              <Link
                href={`/maths/n/${r.nodeId}${r.ancre ? `#${r.ancre}` : ""}`}
                className="font-medium hover:text-accent"
              >
                {r.titre}
              </Link>
              {r.type !== "noeud" && (
                <span className="text-muted">· {r.nodeTitle}</span>
              )}
            </div>
            <p className="chrome-15 mt-1">
              <Surligne texte={r.extrait} termes={termes} />
            </p>
          </li>
        ))}
      </ul>

      {requete && resultats.length === 0 && (
        <p className="chrome text-muted mt-4">
          Aucun résultat. La recherche est conjonctive : tous les mots doivent
          apparaître.
        </p>
      )}
    </main>
  );
}

/** Souligne les termes trouvés. Pas de couleur : elle est réservée à l'état. */
function Surligne({ texte, termes }: { texte: string; termes: string[] }) {
  if (termes.length === 0) return <>{texte}</>;
  const motif = new RegExp(
    `(${termes.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return (
    <>
      {texte.split(motif).map((part, i) =>
        termes.some((t) => t === part.toLowerCase()) ? (
          <mark
            key={i}
            className="bg-transparent text-foreground underline decoration-accent decoration-2 underline-offset-2"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
