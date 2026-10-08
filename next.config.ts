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
  // The service worker must be revalidated on every load, or browsers keep an
  // old one for up to a day after a deploy.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
