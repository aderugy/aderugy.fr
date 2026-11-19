"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pt4 } from "@/lib/hud/client";
import { describeFilters, popupTabs, shortCount, showStat } from "@/lib/hud/format";
import layoutJson from "@/lib/hud/layout.json";
import { NO_FILTERS } from "@/lib/hud/types";
import type {
  HudFilters,
  HudLayout,
  PlayerHud,
  Pt4AutoNote,
  Pt4Limit,
  Pt4Note,
  Pt4Player,
  Pt4Status,
} from "@/lib/hud/types";
import { PioBridgeError } from "@/lib/solver/pioBridge";
import { LIMPERS } from "@/lib/hud/extra";
import { HudPanel } from "./HudPanel";
import { NotesBox } from "./NotesBox";

const layout = layoutJson as HudLayout;
const MAIN = layout.groups.find((g) => g.main) ?? layout.groups[0];
const TABS = popupTabs(layout);
const POPUPS = TABS.map((t) => t.group);
/** Shown to the right of the main line. Nothing opens it in PT4, so it isn't a tab. */
const SIDE = layout.groups.find((g) => g.name === "Avancé");

const STORE = { pins: "poker.hud.pins", selected: "poker.hud.selected", filters: "poker.hud.filters", popup: "poker.hud.popup" };
const POLL_MS = 3000;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota: the list just won't survive a reload
  }
}

const filterKey = (f: HudFilters) => JSON.stringify(f);

/**
 * /poker/hud — PokerTracker 4 HUDs of the players at the table.
 *
 * Players are searched in the local PT4 database through PioBridge and pinned
 * to a list (kept in this browser). The HUD of every pinned player is fetched
 * for the current filters and kept here, so clicking a player only re-renders;
 * the bridge is polled for new hands and the pinned HUDs refresh on their own.
 */
export function HudView() {
  // Rendered in the browser only (HudClient, ssr: false): the stored state is
  // read in the initial render.
  const [pins, setPins] = useState<Pt4Player[]>(() => load(STORE.pins, []));
  const [selected, setSelected] = useState<number | null>(() => load(STORE.selected, null));
  const [filters, setFilters] = useState<HudFilters>(() => ({ ...NO_FILTERS, ...load(STORE.filters, NO_FILTERS) }));
  const [popup, setPopup] = useState<string>(() => {
    const p = load<string>(STORE.popup, "");
    return POPUPS.some((g) => g.name === p) ? p : (POPUPS[0]?.name ?? "");
  });
  const [huds, setHuds] = useState<Record<number, { hud: PlayerHud; key: string }>>({});
  const [status, setStatus] = useState<Pt4Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<Pt4Limit[]>([]);
  const [notes, setNotes] = useState<Record<number, Pt4Note>>({});
  const [autos, setAutos] = useState<Record<number, Pt4AutoNote[]>>({});
  const [loading, setLoading] = useState(false);
  const maxHand = useRef(0);

  useEffect(() => save(STORE.pins, pins), [pins]);
  useEffect(() => save(STORE.selected, selected), [selected]);
  useEffect(() => save(STORE.filters, filters), [filters]);
  useEffect(() => save(STORE.popup, popup), [popup]);

  const ids = useMemo(() => pins.map((p) => p.id), [pins]);
  // Shown alphabetically (case and accents ignored); 1–9 follow this order.
  const sortedPins = useMemo(
    () => [...pins].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })),
    [pins],
  );
  const key = filterKey(filters);

  // Fetch the HUDs of `which` (default: every pinned player) for the filters.
  const inflight = useRef<AbortController | null>(null);
  const fetchHuds = useCallback(
    async (which: number[], f: HudFilters, quiet = false) => {
      if (!which.length) return;
      const ctl = new AbortController();
      if (!quiet) {
        inflight.current?.abort();
        inflight.current = ctl;
        setLoading(true);
      }
      try {
        const r = await pt4.huds(which, f, ctl.signal);
        maxHand.current = Math.max(maxHand.current, r.maxHand);
        const k = filterKey(f);
        setHuds((prev) => {
          const next = { ...prev };
          for (const h of r.players) next[h.id] = { hud: h, key: k };
          return next;
        });
        // Names and hand counts may have changed since the pin.
        setPins((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            const h = r.players.find((x) => x.id === p.id);
            if (h && !h.error && (h.name !== p.name || h.total !== p.hands)) {
              changed = true;
              return { ...p, name: h.name, site: h.site, hands: h.total };
            }
            return p;
          });
          return changed ? next : prev;
        });
        setError(null);
      } catch (e) {
        if (ctl.signal.aborted) return;
        setError(e instanceof PioBridgeError ? e.message : String(e));
      } finally {
        if (!quiet && inflight.current === ctl) setLoading(false);
      }
    },
    [],
  );

  // PT4 notes of the pinned players (cheap: one indexed query).
  const fetchNotes = useCallback(async (which: number[]) => {
    if (!which.length) return;
    try {
      const n = await pt4.notes(which);
      setNotes((prev) => {
        const next = { ...prev };
        for (const id of which) {
          const v = n[String(id)];
          if (v) next[id] = v;
          else delete next[id];
        }
        return next;
      });
    } catch {
      // the HUD fetch reports bridge errors
    }
  }, []);

  // PT4's auto-notes change only when hands are imported.
  const fetchAutos = useCallback(async (which: number[]) => {
    if (!which.length) return;
    try {
      const a = await pt4.autoNotes(which);
      setAutos((prev) => {
        const next = { ...prev };
        for (const id of which) next[id] = a[String(id)] ?? [];
        return next;
      });
    } catch {
      // the HUD fetch reports bridge errors
    }
  }, []);

  // Pins or filters changed: refresh every pinned HUD (debounced for typing).
  const idsKey = ids.join(",");
  const idsRef = useRef(ids);
  const filtersRef = useRef(filters);
  useEffect(() => {
    idsRef.current = ids;
    filtersRef.current = filters;
    const t = setTimeout(() => {
      void fetchHuds(ids, filters);
      void fetchNotes(ids);
      void fetchAutos(ids);
    }, 150);
    return () => clearTimeout(t);
    // ids / filters are compared by value (idsKey, key), not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, key, fetchHuds, fetchNotes, fetchAutos]);

  // Poll the bridge: connection state, and new hands → refresh quietly.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await pt4.status();
        if (stop) return;
        setStatus(s);
        // New hands, or the bridge just came back: refresh the table quietly.
        if (s.connected && s.maxHand > maxHand.current) {
          maxHand.current = s.maxHand;
          void fetchHuds(idsRef.current, filtersRef.current, true);
          void fetchAutos(idsRef.current);
        }
      } catch (e) {
        if (!stop) {
          setStatus(null);
          setError(e instanceof PioBridgeError ? e.message : String(e));
        }
      }
      if (!stop) timer = setTimeout(tick, document.hidden ? POLL_MS * 4 : POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [fetchHuds, fetchNotes, fetchAutos]);

  // Stakes, once connected.
  const connected = !!status?.connected;
  useEffect(() => {
    if (!connected) return;
    pt4
      .limits()
      .then(setLimits)
      .catch(() => {});
  }, [connected]);

  const pin = (p: Pt4Player) => {
    setPins((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
    setSelected(p.id);
  };
  const unpin = (id: number) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
    setSelected((s) => (s === id ? null : s));
  };

  // 1–9: select the nth pinned player. "/" focuses the search.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (/^[1-9]$/.test(e.key)) {
        const p = sortedPins[Number(e.key) - 1];
        if (p) setSelected(p.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sortedPins]);

  const current = selected !== null ? huds[selected] : undefined;
  const currentPin = pins.find((p) => p.id === selected);
  const limitNames = useMemo(() => new Map(limits.map((l) => [l.id, l.name])), [limits]);
  const popupGroup = POPUPS.find((g) => g.name === popup) ?? POPUPS[0];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Players */}
      <aside className="flex shrink-0 flex-col border-b border-line lg:w-72 lg:border-b-0 lg:border-r">
        <div className="p-3">
          <PlayerSearch inputRef={searchRef} disabled={!connected} pinned={ids} onPick={pin} />
        </div>
        <ul className="flex gap-1 overflow-x-auto px-3 pb-3 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-y-auto">
          {pins.length === 0 && (
            <li className="text-xs text-muted">Search a player and press Enter to add him to the table.</li>
          )}
          {sortedPins.map((p, i) => (
            <PinnedPlayer
              key={p.id}
              index={i}
              player={p}
              hud={huds[p.id]?.hud}
              note={notes[p.id]}
              active={p.id === selected}
              onSelect={() => setSelected(p.id)}
              onRemove={() => unpin(p.id)}
            />
          ))}
        </ul>
        {pins.length > 1 && (
          <button
            type="button"
            onClick={() => {
              setPins([]);
              setSelected(null);
            }}
            className="hidden px-3 pb-3 text-left text-xs text-muted hover:text-foreground lg:block"
          >
            Clear the table
          </button>
        )}
      </aside>

      {/* HUD */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {/* Filters live in a menu: the HUD keeps the space while playing. */}
        <div className="absolute right-3 top-3 z-40 sm:right-5 sm:top-4">
          <FiltersMenu filters={filters} limits={limits} onChange={setFilters} />
        </div>
        <BridgeState status={status} error={error} />

        {currentPin ? (
          <section>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-12">
              <h1 className="text-lg font-semibold tracking-tight">{currentPin.name}</h1>
              <span className="text-xs text-muted">{currentPin.site}</span>
              {current && (
                <span className="text-xs text-muted">
                  {current.hud.hands.toLocaleString()} hands
                  {current.hud.hands !== current.hud.total && ` of ${current.hud.total.toLocaleString()}`} ·{" "}
                  {describeFilters(filters, limitNames)}
                </span>
              )}
              {(loading || (current && current.key !== key)) && <span className="text-xs text-accent">updating…</span>}
            </div>
            {/* Two columns: the HUD (⅔) and the notes (⅓, kept in view). */}
            <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                {current?.hud.error ? (
                  <p className="text-sm text-red-600">{current.hud.error}</p>
                ) : !current ? (
                  <p className="text-sm text-muted">Loading his hands…</p>
                ) : (
                  <div className={current.key !== key ? "opacity-60 transition-opacity" : undefined}>
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0">
                        <HudPanel group={MAIN} hud={current.hud} compact onPopup={setPopup} />
                      </div>
                      {SIDE && (
                        <div className="min-w-0">
                          <HudPanel group={SIDE} hud={current.hud} compact onPopup={setPopup} />
                        </div>
                      )}
                      <div className="min-w-0">
                        <HudPanel group={LIMPERS} hud={current.hud} dense onPopup={setPopup} />
                      </div>
                    </div>
                    <div className="mt-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
                      {TABS.map(({ label, group: g }) => (
                        <button
                          key={g.name}
                          type="button"
                          onClick={() => setPopup(g.name)}
                          className={[
                            "shrink-0 rounded-md px-2.5 py-1 text-xs",
                            g.name === popupGroup?.name
                              ? "bg-accent font-medium text-white"
                              : "text-muted hover:text-foreground",
                          ].join(" ")}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {popupGroup && (
                      <div className="mt-2">
                        <HudPanel group={popupGroup} hud={current.hud} onPopup={setPopup} />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* One box per pinned player, inactive ones hidden: a note being
                  typed survives switching players. */}
              <aside className="min-w-0 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto">
                {pins.map((p) => (
                  <div key={p.id} hidden={p.id !== selected}>
                    <NotesBox
                      player={p.id}
                      note={notes[p.id]}
                      autos={autos[p.id]}
                      onSaved={(n) => setNotes((prev) => ({ ...prev, [p.id]: n }))}
                    />
                  </div>
                ))}
              </aside>
            </div>
          </section>
        ) : (
          <p className="mt-6 text-sm text-muted">
            {pins.length ? "Pick a player on the left (or press 1–9)." : "No player at the table yet."}
          </p>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function PinnedPlayer({
  index,
  player,
  hud,
  note,
  active,
  onSelect,
  onRemove,
}: {
  index: number;
  player: Pt4Player;
  hud: PlayerHud | undefined;
  note: Pt4Note | undefined;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const quick = (["VPIP", "PFR", "3Bet Preflop"] as const).map(
    (stat) => showStat({ t: "stat", stat, pos: 0 }, hud?.stats).text,
  );
  return (
    <li
      className={[
        "group flex min-w-44 shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 lg:min-w-0",
        active ? "border-accent bg-accent/10" : "border-transparent hover:bg-surface",
      ].join(" ")}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-1.5">
          {index < 9 && <span className="text-[10px] text-muted">{index + 1}</span>}
          <span className="truncate text-sm font-medium">{player.name}</span>
          {note && note.color > 0 && (
            <span title={`PT4 colour ${note.color}`} className="rounded bg-line px-1 font-mono text-[10px] text-muted">
              {note.color}
            </span>
          )}
          {note?.text && (
            <span title={note.text} className="text-[11px] text-muted">
              ✎
            </span>
          )}
        </span>
        <span className="block font-mono text-[11px] tabular-nums text-muted">
          {hud?.error ? "error" : hud ? `${quick.join(" / ")} · ${shortCount(hud.total)}` : "…"}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${player.name}`}
        className="shrink-0 rounded px-1 text-muted hover:text-foreground lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"
      >
        ×
      </button>
    </li>
  );
}

function PlayerSearch({
  inputRef,
  disabled,
  pinned,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled: boolean;
  pinned: number[];
  onPick: (p: Pt4Player) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Pt4Player[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (!query) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setBusy(true);
      pt4
        .search(query, ctl.signal)
        .then((r) => {
          setResults(r);
          setActive(0);
        })
        .catch(() => {})
        .finally(() => !ctl.signal.aborted && setBusy(false));
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const pick = (p: Pt4Player | undefined) => {
    if (!p) return;
    onPick(p);
    setQ("");
    setResults([]);
  };
  const shown = q.trim() ? results : [];

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={q}
        disabled={disabled}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter") pick(shown[active]);
          else if (e.key === "Escape") setQ("");
          else return;
          e.preventDefault();
        }}
        placeholder={disabled ? "PT4 not connected" : "Add a player…  ( / )"}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
        autoComplete="off"
        spellCheck={false}
      />
      {busy && <span className="absolute right-3 top-2.5 text-xs text-muted">…</span>}
      {q.trim() && !busy && shown.length === 0 && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-line bg-surface p-3 text-xs text-muted shadow-lg">
          No cash player matches.
        </div>
      )}
      {shown.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
          {shown.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={[
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                  i === active ? "bg-accent/10" : "",
                ].join(" ")}
              >
                <span className="truncate">{p.name}</span>
                <span className="text-[11px] text-muted">{p.site}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted">
                  {pinned.includes(p.id) ? "✓ " : ""}
                  {shortCount(p.hands)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A gear at the top right opening the filters; a dot when some are active. */
function FiltersMenu({
  filters,
  limits,
  onChange,
}: {
  filters: HudFilters;
  limits: Pt4Limit[];
  onChange: (f: HudFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = filters.limits.length > 0 || filters.lastHands > 0 || filters.days > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="HUD filters"
        title="Filters: stakes, last hands, last days"
        className={[
          "relative flex h-8 w-8 items-center justify-center rounded-md border text-muted hover:text-foreground",
          open ? "border-accent text-foreground" : "border-line bg-surface",
        ].join(" ")}
      >
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden>
          <path d="M3 5h9M15 5h2M3 10h3M9 10h8M3 15h7M13 15h4" strokeLinecap="round" />
          <circle cx="13.5" cy="5" r="1.6" />
          <circle cx="7.5" cy="10" r="1.6" />
          <circle cx="11.5" cy="15" r="1.6" />
        </svg>
        {active && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[36rem] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 shadow-xl">
          <Filters filters={filters} limits={limits} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function Filters({
  filters,
  limits,
  onChange,
}: {
  filters: HudFilters;
  limits: Pt4Limit[];
  onChange: (f: HudFilters) => void;
}) {
  const toggle = (id: number) =>
    onChange({
      ...filters,
      limits: filters.limits.includes(id) ? filters.limits.filter((x) => x !== id) : [...filters.limits, id],
    });
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onChange({ ...filters, limits: [] })}
          className={[
            "rounded-md px-2 py-1",
            filters.limits.length === 0 ? "bg-accent font-medium text-white" : "text-muted hover:text-foreground",
          ].join(" ")}
        >
          All stakes
        </button>
        {limits.map((l) => (
          <button
            key={l.id}
            type="button"
            title={`${l.hands.toLocaleString()} hands`}
            onClick={() => toggle(l.id)}
            className={[
              "rounded-md px-2 py-1",
              filters.limits.includes(l.id) ? "bg-accent font-medium text-white" : "text-muted hover:text-foreground",
            ].join(" ")}
          >
            {l.name}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-muted">
        Last
        <input
          type="number"
          min={0}
          step={100}
          inputMode="numeric"
          value={filters.lastHands || ""}
          placeholder="all"
          onChange={(e) => onChange({ ...filters, lastHands: num(e.target.value) })}
          className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-foreground tabular-nums outline-none focus:border-accent"
        />
        hands
      </label>
      <label className="flex items-center gap-1.5 text-muted">
        Last
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={filters.days || ""}
          placeholder="all"
          onChange={(e) => onChange({ ...filters, days: num(e.target.value) })}
          className="w-16 rounded-md border border-line bg-surface px-2 py-1 text-foreground tabular-nums outline-none focus:border-accent"
        />
        days
      </label>
      {(filters.limits.length > 0 || filters.lastHands > 0 || filters.days > 0) && (
        <button type="button" onClick={() => onChange(NO_FILTERS)} className="text-muted hover:text-foreground">
          Reset
        </button>
      )}
    </div>
  );
}

function BridgeState({ status, error }: { status: Pt4Status | null; error: string | null }) {
  if (status?.connected) return null;
  let msg: string;
  if (!status) msg = error ?? "Connecting to PioBridge…";
  else if (!status.configured)
    msg = "PioBridge has no PokerTracker 4 database set. Open its status page (http://127.0.0.1:7878) → Settings.";
  else msg = `PioBridge can't reach the PT4 database: ${status.error ?? "unknown error"}`;
  return <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">{msg}</p>;
}
