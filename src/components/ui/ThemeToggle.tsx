"use client";

import { useSyncExternalStore } from "react";
import { nextTheme, readTheme, setTheme, subscribeTheme, type Theme } from "@/lib/theme";

const LABEL: Record<Theme, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

/**
 * Header button: system → light → dark → system. The server doesn't know the
 * choice, so it renders the system icon and the client corrects it.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const next = nextTheme(theme);
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`${LABEL[theme]} — switch to ${LABEL[next].toLowerCase()}`}
      title={`${LABEL[theme]} (click: ${LABEL[next].toLowerCase()})`}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-line/60 hover:text-foreground ${className}`}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden>
        {theme === "light" ? (
          <>
            <circle cx="10" cy="10" r="3.5" />
            <path
              d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"
              strokeLinecap="round"
            />
          </>
        ) : theme === "dark" ? (
          <path d="M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5Z" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
            <path d="M7 17h6M10 13.5V17" strokeLinecap="round" />
            <path d="M10 5.5v6a3 3 0 0 0 0-6Z" fill="currentColor" stroke="none" />
          </>
        )}
      </svg>
    </button>
  );
}
