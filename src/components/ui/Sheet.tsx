"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A panel over the page: a bottom sheet on a phone, where the thumb is, and a
 * centred dialog from `sm` up. Esc and the backdrop close it.
 *
 * Kept mounted only while open — callers render it conditionally — so its
 * contents start fresh every time and nothing stale lingers between tasks.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A combobox inside closes its own list on Esc and stops the event.
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    // Focus the panel so Tab starts inside it, unless a field asked for focus.
    if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus({ preventScroll: true });
    }
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-background shadow-2xl outline-none sm:rounded-xl ${
          wide ? "sm:max-w-2xl" : "sm:max-w-lg"
        }`}
      >
        {/* The grab handle tells a phone user this is a sheet. */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" aria-hidden />
        <div className="flex shrink-0 items-center gap-3 px-4 pb-2 pt-2 sm:pt-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
