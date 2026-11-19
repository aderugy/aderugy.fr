"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pt4 } from "@/lib/hud/client";
import { describeFilters, popupTabs, shortCount, showStat } from "@/lib/hud/format";
import layoutJson from "@/lib/hud/layout.json";
import { NO_FILTERS } from "@/lib/hud/types";
import type { HudFilters, HudLayout, PlayerHud, Pt4Limit, Pt4Player, Pt4Status } from "@/lib/hud/types";
import { PioBridgeError } from "@/lib/solver/pioBridge";
import { HudPanel } from "./HudPanel";

const layout = layoutJson as HudLayout;
const MAIN = layout.groups.find((g) => g.main) ?? layout.groups[0];
const TABS = popupTabs(layout);
const POPUPS = TABS.map((t) => t.group);

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
  const [loading, setLoading] = useState(false);
  const maxHand = useRef(0);

  useEffect(() => save(STORE.pins, pins), [pins]);
  useEffect(() => save(STORE.selected, selected), [selected]);
  useEffect(() => save(STORE.filters, filters), [filters]);
  useEffect(() => save(STORE.popup, popup), [popup]);

  const ids = useMemo(() => pins.map((p) => p.id), [pins]);
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

  // Pins or filters changed: refresh every pinned HUD (debounced for typing).
  const idsKey = ids.join(",");
  const idsRef = useRef(ids);
  const filtersRef = useRef(filters);
  useEffect(() => {
    idsRef.current = ids;
    filtersRef.current = filters;
    const t = setTimeout(() => void fetchHuds(ids, filters), 150);
    return () => clearTimeout(t);
    // ids / filters are compared by value (idsKey, key), not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, key, fetchHuds]);

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
  }, [fetchHuds]);

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
        const p = pins[Number(e.key) - 1];
        if (p) setSelected(p.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pins]);

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
          {pins.map((p, i) => (
            <PinnedPlayer
              key={p.id}
              index={i}
              player={p}
              hud={huds[p.id]?.hud}
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
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <BridgeState status={status} error={error} />
        <Filters filters={filters} limits={limits} onChange={setFilters} />

        {currentPin ? (
          <section className="mt-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
            {current?.hud.error ? (
              <p className="mt-3 text-sm text-red-600">{current.hud.error}</p>
            ) : !current ? (
              <p className="mt-3 text-sm text-muted">Loading his hands…</p>
            ) : (
              <div className={current.key !== key ? "opacity-60 transition-opacity" : undefined}>
                <div className="mt-3">
                  <HudPanel group={MAIN} hud={current.hud} compact onPopup={setPopup} />
                </div>
                <div className="mt-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
                  {TABS.map(({ label, group: g }) => (
                    <button
                      key={g.name}
                      type="button"
                      onClick={() => setPopup(g.name)}
                      className={[
                        "shrink-0 rounded-md px-2.5 py-1 text-xs",
                        g.name === popupGroup?.name ? "bg-accent font-medium text-white" : "text-muted hover:text-foreground",
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
  active,
  onSelect,
  onRemove,
}: {
  index: number;
  player: Pt4Player;
  hud: PlayerHud | undefined;
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
