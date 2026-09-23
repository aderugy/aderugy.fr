import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_PATH } from "@/lib/supabase/session";
import { SignOutButton } from "@/components/agenda/SignOutButton";
import { MathsNav } from "@/components/maths/MathsNav";
import { loadGraph } from "@/lib/maths/graph/load";
import { compteursRevision } from "@/lib/maths/revision/queue";
import { chargerDonnees } from "@/server/maths/data";
import "katex/dist/katex.min.css";
import "./maths.css";

export const metadata = {
  title: "Maths — aderugy.fr",
  description: "Parcours de probabilités et statistiques, du niveau 0 à la recherche.",
};

/**
 * Cartes dues, dans l'en-tête. Lit la base, donc isolé derrière un Suspense :
 * le reste de l'en-tête s'affiche sans attendre.
 */
async function CompteurRevision() {
  const { total, nouvelles } = compteursRevision(
    loadGraph(),
    await chargerDonnees(),
    new Date(),
  );
  if (total === 0) return null;
  return (
    <span
      className="rounded-full bg-accent/10 px-1.5 text-[11px] leading-4 font-medium text-accent tabular-nums"
      title={nouvelles > 0 ? `dont ${nouvelles} neuves` : undefined}
    >
      {total}
    </span>
  );
}

export default async function MathsLayout({ children }: LayoutProps<"/maths">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Le proxy protège déjà ce segment ; ce garde évite une page vide si le
  // proxy était mal configuré.
  if (!user) redirect(LOGIN_PATH);

  return (
    // La hauteur d'en-tête est fixe (h-12) : les rails collants et la carte du
    // graphe se calent dessus (top-12, 100dvh - 3rem).
    <div className="maths flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-background px-3 sm:gap-6 sm:px-5">
        <Link href="/" className="hidden shrink-0 text-xs text-muted hover:text-foreground sm:inline">
          ←
        </Link>
        <MathsNav
          compteur={
            <Suspense fallback={null}>
              <CompteurRevision />
            </Suspense>
          }
        />
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
          <span className="hidden lg:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
