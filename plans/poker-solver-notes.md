# Poker Solver Notes — Tree Editor

## Context

`/poker` today is a **static, no-auth** pot-odds/equity calculator (pure functions in
`src/lib/poker.ts`, ISR page, nothing stored). We're adding a separate, **authenticated,
persisted** tool: the user builds and edits *spots* (solver trees, e.g. "BTN vs BB SRP")
made of nodes on a 2D pan/zoom canvas. Node types: **text** (title+desc), **flop** (3 cards),
**turn**/**river** (1 card), **strategy** (per-hand action distribution over an owned action
set), and **action** (Check / Bet+sizing, linked to a parent strategy's action).

The tool must not touch the existing calculator: it lives under a new authed segment
`/poker/spots/*`, mirroring the `/agenda` feature's stack (Supabase + normalized RLS tables,
server component fetch → client orchestrator, server actions returning `ActionResult`,
Tailwind v4 tokens, no UI/state libraries).

Design decisions confirmed with the user:
- **Canvas**: node-graph, 2D pan/zoom, auto-computed tree layout (tree too big for one screen); **lazy-loaded** — only render/fetch loaded subtrees.
- **Hands**: 13×13 grid (169) as the editing surface, but weights stored at **combo** level so a cell drills into per-combo detail.
- **Strategy↔action**: **linked** — a strategy node owns its action set; action child-nodes reference one of those actions.
- **Storage**: **normalized** rows (`poker_spots` + `poker_nodes`), heavy strategy grids in a separate 1:1 table for lazy loading.

## Data model — new migration `supabase/migrations/0009_poker_spots.sql`

Follow existing conventions exactly (see `0001_agenda_init.sql`): prose header, re-runnable
statements (`create table if not exists`, guarded policies), `id uuid pk default gen_random_uuid()`,
`user_id uuid not null references auth.users(id) on delete cascade`, `created_at`, `updated_at` +
the existing `touch_updated_at()` trigger, per-user indexes, `enable row level security`, and the
standard `"own rows" for all to authenticated using/with check (auth.uid() = user_id)` policy on
every table.

- **`public.poker_spots`**: `name text not null check(length(trim(name)) between 1 and 120)`,
  `description text`, plus standard columns. Index `(user_id)`.
- **`public.poker_nodes`**:
  - `spot_id uuid not null references poker_spots(id) on delete cascade`
  - `parent_id uuid references poker_nodes(id) on delete cascade` (null = root)
  - `type text not null check (type in ('text','flop','turn','river','strategy','action'))`
  - `position int not null default 0` (order among siblings)
  - `data jsonb not null default '{}'` — light, type-specific payload (see shapes below)
  - Indexes `(spot_id)`, `(spot_id, parent_id)` for lazy child fetches, `(user_id)`.
- **`public.poker_strategies`** (1:1 with a strategy node, kept separate so the canvas never
  pulls big blobs): `node_id uuid primary key references poker_nodes(id) on delete cascade`,
  `user_id`, `weights jsonb not null default '{}'`, `updated_at` + trigger. Loaded only when a
  strategy node is opened.

`data` jsonb shapes (camelCase inside jsonb, mirroring agenda's client view-models):
- text: `{ title, body }`
- flop: `{ cards: ["Ah","Ks","2d"] }`  · turn/river: `{ card: "7c" }`
- strategy: `{ label?, position?: "OOP"|"IP", actions: [{ id, kind: "check"|"bet"|"raise"|"call"|"fold", sizePct?|sizeBb?, label, color }] }`
- action: `{ strategyActionId, kind, size, label, color }` — copied/ref'd from the parent strategy's action set
- `poker_strategies.weights`: `{ hands: { "AKs": [w0,w1,...] }, combos: { "AhKs": [w0,...] } }` — vectors align to the strategy node's `actions` order; `combos` overrides `hands`; both default to a single 100%-first-action weight when unset.

## Domain library — new `src/lib/solver/` (avoids clashing with existing `src/lib/poker.ts`)

Pure, DOM-free helpers (mirror `src/lib/poker.ts` / `src/lib/categories.ts` style):
- `cards.ts`: `RANKS` (A..2), `SUITS` (s/h/d/c) with 4-color-deck colors, card parse/format,
  `GRID_HANDS` (169 hands in 13×13 order: pair diagonal, suited upper-right, offsuit lower-left),
  `handCombos(hand): Combo[]` (pair→6, suited→4, offsuit→12), `comboToHand(combo)`.
- `strategy.ts`: normalize/aggregate helpers — combo weights ↔ hand-level display vector,
  apply-paint, dead-card (blocker) detection from ancestor board cards (optional blur of impossible combos).
- `layout.ts`: pure layered tree layout — given loaded nodes, compute `{ x, y }` per node + edge
  paths (top-down or left-right). No persisted coordinates in v1.
- `types.ts`: `PokerSpot`, `PokerNode` (snake_case DB shape + `NodeType` union), `StrategyAction`,
  `StrategyWeights`, canvas view-models. Reuse `ActionResult` from `@/server/auth`.
- Reuse `PALETTE` / `DEFAULT_COLOR` from `src/lib/categories.ts` for action colors.

## Routes — `src/app/poker/spots/`

- `layout.tsx` (server): auth guard like `agenda/layout.tsx` — `getUser()`; if no user render the
  reused `<LoginForm />` (from `src/components/agenda/LoginForm.tsx`) instead of a blank page;
  otherwise a header (link back to `/poker` calculator, spot nav, sign-out via `SignOutButton`)
  and a `100dvh` flex shell (the canvas needs full height, `min-h-0 flex-1`).
- `page.tsx` (server): fetch `poker_spots` for the user; render `<SpotList>` (create / rename /
  delete, links to each spot). Simplest model = `agenda/backlog/page.tsx`.
- `[spotId]/page.tsx` (server): fetch the spot + an initial shallow slice of `poker_nodes`
  (root + ~1–2 levels, `.eq("user_id").eq("spot_id").order("position")`), guard ownership,
  pass to `<SpotCanvas>`. Uses Next 16 typed `PageProps<"/poker/spots/[spotId]">`; `await params`.

The existing `/poker/page.tsx` gets one added `<Link href="/poker/spots">` entry point; otherwise untouched.

## Routing / auth wiring

- `src/proxy.ts`: extend matcher to `["/", "/agenda/:path*", "/poker/spots/:path*"]` so the session
  cookie refreshes on the new segment. Auth UX itself is handled by the layout (renders `LoginForm`
  when no user), so no `LOGIN_PATH`/`next`-param change is required. RLS remains the real boundary.

## Server actions — new `src/server/actions/solver.ts` (`"use server"`)

Canonical shape (`requireUser()`, stamp `user_id`, `.eq("id").eq("user_id", user.id)` on updates,
`throw` DB errors, `try/catch → fail(e)`, typed `input` objects camelCase→jsonb):
- Spots: `createSpot`, `renameSpot`, `deleteSpot` — call `refresh()` (list page re-renders).
- Nodes: `createNode(input) → { ok, id }` (PlacedResult variant, append-after-last-sibling position
  like categories/block_items), `updateNode` (patch-object: `data`, `position`, `parentId`),
  `deleteNode` (children cascade via FK). These **skip `refresh()`** — the canvas holds nodes in
  client `useState` and applies the returned id, matching the `moveScheduled` hot-path precedent.
- Strategy: `saveStrategy(nodeId, weights)` — upsert `poker_strategies`, skip `refresh()`.

Lazy **reads** (children of a node, and a strategy's `weights`) are done client-side via the
browser client `src/lib/supabase/client.ts` (RLS-scoped), as `CalendarLiveness` already does —
so panning/expanding fetches subtrees on demand without a server round-trip through actions.

## Client UI — new `src/components/poker/` files (all `"use client"`, Tailwind tokens)

- `SpotList.tsx`: CRUD list of spots (inline rename, confirm-delete), mirrors `BlockLibrary.tsx`.
- `SpotCanvas.tsx` (orchestrator, like `WeekPlanner.tsx`): holds loaded nodes in `useState` seeded
  from server props (adjust-during-render on prop-identity change), pan (pointer-drag background)
  + zoom (wheel) via a `transform: translate()/scale()` wrapper, lazy-loads a node's children on
  expand via the browser client, owns selection + the open editor panel. Uses `useTransition` +
  the `commit(fn)` helper for writes. Renders nodes as absolutely-positioned boxes at `layout.ts`
  coords with an SVG edge layer behind them.
- `NodeCard.tsx`: per-type node box (text preview / flop+board cards / turn-river card / strategy
  mini-grid thumbnail / action chip), an "＋ add child" affordance offering sensible child types by
  parent (permissive grammar: flop→strategy, strategy→action, action→turn/text/strategy, …).
- `StrategyEditor.tsx`: portal panel (like `BlockPopup.tsx` — Escape/outside-click/Ctrl-Enter). A
  13×13 grid where each cell renders a stacked weight bar in the action colors; an action-set editor
  (add/rename/kind+size/color from `PALETTE`); paint-drag to assign weights; click a cell → per-combo
  popover editing the ≤6/4/12 combos individually. Optional: blur combos blocked by ancestor board cards.
- `CardPicker.tsx`: pick 3 (flop) / 1 (turn/river) cards from a rank×suit grid, disabling cards
  already used by ancestor board nodes.
- Reuse `Segmented` / `NumberField` from `src/components/poker/ui.tsx` and `eventHitsElement` from
  `src/lib/dom.ts` for popovers.

## Reused existing utilities (do not re-create)

`requireUser`/`fail`/`ActionResult` (`src/server/auth.ts`), both Supabase clients
(`src/lib/supabase/{server,client}.ts`), `touch_updated_at()` trigger + RLS `"own rows"` pattern
(`0001_agenda_init.sql`), `LoginForm`/`SignOutButton` (`src/components/agenda/`), `PALETTE`
(`src/lib/categories.ts`), `Segmented`/`NumberField` (`src/components/poker/ui.tsx`),
`eventHitsElement` (`src/lib/dom.ts`), Tailwind tokens `bg-surface/bg-background/text-foreground/
text-muted/border-line/text-accent` (`src/app/globals.css`).

## Build order

1. Migration `0009_poker_spots.sql` — just add the file; CI/CD applies migrations automatically (do not apply it manually).
2. `src/lib/solver/*` domain lib (cards, hands, layout, strategy, types) — unit-testable pure fns.
3. `src/server/actions/solver.ts`.
4. Spot list route + `SpotList`.
5. Spot canvas route + `SpotCanvas` + `NodeCard` + `CardPicker` (tree building, pan/zoom, lazy load).
6. `StrategyEditor` (grid + action set + per-combo).
7. Add `/poker/spots` entry link on `/poker`; extend `src/proxy.ts` matcher.

## Verification

- `npm run lint` and `npm run build` clean (typed routes must resolve `/poker/spots/[spotId]`).
- Migration is applied by CI/CD, not manually; verify against a database that has run it.
- `npm run dev`, sign in, then end-to-end: create a spot → build flop → strategy → action → turn;
  edit a strategy grid + drill into a cell's per-combo weights; reload and confirm persistence;
  pan/zoom and expand a deep node to confirm lazy loading fires; delete a node and confirm children
  cascade; confirm a second account cannot see the spot (RLS); confirm the public `/poker`
  calculator still renders unauthenticated and unchanged.

## Deferred (not in v1)

Manual node drag-positioning (persisted x/y), `?next=` post-login redirect back to the spot,
range presets/import, cross-account sharing.
