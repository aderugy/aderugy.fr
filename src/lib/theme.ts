/**
 * The site's colour theme: "light", "dark", or "system" (follow the OS).
 * Kept in localStorage and set as `data-theme` on <html>; globals.css reads
 * it. THEME_SCRIPT applies it before the first paint (root layout).
 */

export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "theme";

/** Inline in <head>: no flash of the wrong theme on a full load. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

const listeners = new Set<() => void>();

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // private mode: the choice lasts for this page only
  }
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  for (const l of listeners) l();
}

export function subscribeTheme(onChange: () => void) {
  listeners.add(onChange);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    const t = readTheme();
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The next theme when the header button is clicked. */
export function nextTheme(t: Theme): Theme {
  return t === "system" ? "light" : t === "light" ? "dark" : "system";
}
