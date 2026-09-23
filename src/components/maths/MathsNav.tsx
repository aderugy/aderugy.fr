"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const LINKS = [
  { href: "/maths", label: "Parcours" },
  { href: "/maths/revision", label: "Révision" },
  { href: "/maths/recherche", label: "Recherche" },
  { href: "/maths/tableau-de-bord", label: "Tableau de bord" },
  { href: "/maths/corpus", label: "Corpus" },
  { href: "/maths/notation", label: "Notation" },
];

/**
 * Navigation du parcours. Défile plutôt que de passer à la ligne : un en-tête
 * qui change de hauteur décalerait le graphe et les rails collants.
 * `compteur` est le nombre de cartes dues, rendu côté serveur.
 */
export function MathsNav({ compteur }: { compteur: ReactNode }) {
  const path = usePathname();
  return (
    <nav className="-mx-1 flex min-w-0 items-center gap-3 overflow-x-auto px-1 sm:gap-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {LINKS.map((l) => {
        const active =
          l.href === "/maths"
            ? path === "/maths" || path.startsWith("/maths/n/")
            : path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={[
              "flex shrink-0 items-baseline gap-1.5 text-sm",
              active ? "font-semibold tracking-tight" : "text-muted hover:text-foreground",
            ].join(" ")}
          >
            {l.label}
            {l.href === "/maths/revision" && compteur}
          </Link>
        );
      })}
    </nav>
  );
}
