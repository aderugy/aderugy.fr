/**
 * Annonce du gain d'XP après une capsule terminée (D26), lue dans `?gagne=`.
 * Une ligne de chrome, sans animation (§9 : aucune animation non déclenchée
 * par une action — celle-ci l'est, mais une ligne suffit).
 */
export function lireGain(params: Record<string, string | string[] | undefined>): number | null {
  const brut = Array.isArray(params.gagne) ? params.gagne[0] : params.gagne;
  const n = Number(brut);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : null;
}

export default function Gain({ xp, texte }: { xp: number; texte: string }) {
  return (
    <span role="status" className="text-foreground">
      {texte} · +{xp} XP
    </span>
  );
}
