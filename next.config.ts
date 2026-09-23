import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /maths lit son contenu (graphe, cours MDX, exercices, cartes) sur le
  // disque à l'exécution. Le traçage de fichiers ne voit pas ces lectures
  // dynamiques : sans cette ligne, le déploiement Vercel n'embarque pas
  // content/maths et chaque page du parcours échoue.
  outputFileTracingIncludes: {
    "/maths": ["./content/maths/**/*"],
    "/maths/**": ["./content/maths/**/*"],
  },
};

export default nextConfig;
