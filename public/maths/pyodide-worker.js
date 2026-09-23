// Exécution du Python des sections « Vérification par simulation », dans un
// web worker : le thread principal reste réactif même quand un calcul dure.
//
// Pyodide est chargé depuis un CDN, donc au premier lancement il faut du
// réseau et une dizaine de mégaoctets. Ensuite le cache HTTP du navigateur
// prend le relais. L'URL de base est passée par le composant appelant
// (voir src/components/maths/BlocPython.tsx) : elle n'est écrite qu'à un seul
// endroit dans le dépôt.

let pyodide = null;

async function demarrer(base) {
  importScripts(base + "pyodide.js");
  const py = await loadPyodide({ indexURL: base });
  await py.loadPackage(["numpy"]);
  return py;
}

self.onmessage = async (event) => {
  const { code, base } = event.data;
  let sortie = "";
  try {
    if (!pyodide) {
      self.postMessage({ etat: "chargement" });
      pyodide = await demarrer(base);
    }
    pyodide.setStdout({ batched: (s) => (sortie += s + "\n") });
    pyodide.setStderr({ batched: (s) => (sortie += s + "\n") });
    const t0 = performance.now();
    await pyodide.runPythonAsync(code);
    self.postMessage({
      etat: "fini",
      ok: true,
      sortie,
      ms: Math.round(performance.now() - t0),
    });
  } catch (erreur) {
    const message = String(erreur && erreur.message ? erreur.message : erreur);
    // Le cas le plus fréquent est un CDN injoignable : le dire, avec l'URL
    // exacte, plutôt que de laisser une erreur d'importScripts nue.
    const contexte = pyodide
      ? ""
      : `\nPyodide n'a pas pu être chargé depuis ${base}pyodide.js — ` +
        `vérifier le réseau, ou la version dans src/components/maths/BlocPython.tsx.`;
    self.postMessage({ etat: "fini", ok: false, sortie: sortie + message + contexte });
  }
};
