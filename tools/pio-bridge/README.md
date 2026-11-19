# PioBridge

Local Windows bridge between aderugy.fr and PioSOLVER. The site asks it for a Decision of a `.cfr` save
(strategy, range, equity, EV and EV per action) instead of a CSV pasted from PioViewer.
Design and phase 0 results: project doc `poker/pio-bridge.md`.

Go, one `.exe`, nothing to install. The bridge stays thin: it runs the solver and returns its data as is
(chips, 1326-value vectors in solver hand order). Poker logic (labels, bb, combos, totals) belongs to the site.

## Use

1. Run `dist\PioBridge.exe`. The first time, SmartScreen says "Windows protected your PC": *More info* →
   *Run anyway*. An icon appears in the tray (next to the clock, maybe under ^).
2. Icon: **green** ready · **amber** working · **red** error · **grey** PioSOLVER not found.
   Hover it for the loaded save; click it for the menu:
   - status page
   - solves folder
   - restart solver
   - start with Windows
   - quit
3. Status page: `http://127.0.0.1:7878/` shows the state, recent requests, the log and the settings.
   - Config: `%APPDATA%\PioBridge\config.json`.
   - Log: `%APPDATA%\PioBridge\bridge.log`.
   - Defaults: `D:\Programs\PioSOLVER\PioSOLVER3-edge.exe`, `D:\Poker\Solvers`, port 7878, allowed sites
     `https://aderugy.fr`, `https://www.aderugy.fr`, `http://localhost:3000`, solver stopped after 15 min idle.
4. The first time aderugy.fr calls the bridge, Chrome asks to let the site reach apps on this computer: allow.

## API (GET only, JSON)

`file` = path of a `.cfr` relative to the solves folder, forward slashes (e.g.
`BB vs BTN/Second souffle/8h5d3d.cfr`). `id` = solver node id (`r:0`, `r:0:c:c:As`, …).

| Endpoint | Returns |
|---|---|
| `/api/health` | version, state (`idle` · `starting` · `ready` · `busy` · `error` · `pio_missing`), loaded save |
| `/api/files?dir=` | folders and `.cfr` files |
| `/api/tree?file=` | board (from the root: the tree info `#Board#` can be wrong → `infoBoardMatches`), root, first decision, effective stack, tree info, starting ranges |
| `/api/hand-order` | the 1326 combos in solver order (`2d2c … AsAh`); every vector follows it |
| `/api/node?file=&id=` | node + children |
| `/api/decision?file=&id=&stats=1&villain=1` | node, children (= actions, in strategy row order), `strategy` (rows × 1326), `range`, `villainRange`, `globalFreq`, and with `stats`: `equity`, `equityWeights`, `equityTotal`, `ev`, `evWeights`, `childEv` (EV of each action), with `villain` also `villainEquity*` and `villainEv` / `villainEvWeights` (the other player's equity and EV), `notes` |
| `/api/runouts?file=&id=` | `id` = a split node (where the turn or river is dealt). Per card: the decision after it (`node`, `children`), `strategy` (each option's average frequency over the actor's range), `equity` and `ev` by player (solver's equity total 0–1, EV in chips averaged with `calc_ev`'s weights), `notes`. Runs `load_all_nodes` once per save first. With `after=` (e.g. `c`, `c:b150`): the same line below every card instead of the card's first decision (a later node of the street on every runout). Cards the save doesn't hold (rivers of a `no_rivers` save, whose split is flagged `UNSOLVED`) come back with `node.solved: false` and the note `not in the save`; with `resolve=1` they are read anyway (PioSOLVER re-solves each river on the fly, about 1 s each) and noted `re-solved on the fly`. |

A node is `{id, type, player, last, board, pot: {oop, ip, start}, children, flags, solved}`.
- `last` is the action token: `c`, `f`, `b495`, or a card.
- `bNNN` and `pot.oop` / `pot.ip` are the chips each player has put in **during the whole hand**, not the bet
  on that street.
- EVs are in chips, on the basis PioViewer shows.
- Combos out of range are `null` in EV and equity.
- Averages over the range: weight by `evWeights` / `equityWeights`. `equityTotal` is the solver's own figure.

Errors: `{error, message}` with a code:
- `not_in_save` (409: river of a `no_rivers` save; `&resolve=1` lets the solver re-solve it)
- `not_a_decision`
- `bad_node_id`
- `forbidden_path` · `not_cfr` · `not_found`
- `pio_missing` · `solver_unavailable` · `solver_error`
- `origin_not_allowed`

## PokerTracker 4 (the HUD on /poker/hud)

The bridge also reads the local PokerTracker 4 database (PostgreSQL) so the site can show the HUD of the players
at the table, and reads/writes their PT4 notes. A role with `SELECT`, plus `INSERT, UPDATE` on `notes` only; every
session opens with `default_transaction_read_only = on`, and only the note save switches its own transaction to
read-write.

1. Create the role once (pgAdmin, or `psql -U postgres -d "PT4 DB"`):
   ```sql
   CREATE ROLE aderugy_ro LOGIN PASSWORD '…';
   GRANT CONNECT ON DATABASE "PT4 DB" TO aderugy_ro;
   GRANT USAGE ON SCHEMA public TO aderugy_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO aderugy_ro;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO aderugy_ro;
   ALTER ROLE aderugy_ro SET default_transaction_read_only = on;
   -- player notes (optional: without it, saving a note answers pt4_no_write)
   GRANT INSERT, UPDATE ON public.notes TO aderugy_ro;
   ```
2. Status page → Settings → *PokerTracker 4 database*:
   `postgres://aderugy_ro:PASSWORD@localhost:5432/PT4%20DB` (space = `%20`, `@` in the password = `%40`).
   The status card then shows `connected · … · last hand #N`.
3. Check the stats against PT4 for a regular: `http://127.0.0.1:7878/pt4/verify?id=<id_player>` (the id is in
   `/pt4/players?q=name`). It compares the unfiltered totals with PT4's own `cash_cache` counters, mismatches first.

How it works (`internal/pt4/`):
- A small built-in PostgreSQL client (`pgwire.go`: protocol 3, SCRAM-SHA-256 / MD5, simple queries): no driver to
  download.
- The first time a player is asked for, all his hands are loaded (one indexed query on
  `cash_hand_player_statistics`, about 0.6 s for 60 000 hands) and kept in memory; afterwards only hands with a
  higher `id_hand` are fetched, when `max(id_hand)` moves (checked at most every 2 s). Up to 200 players stay
  cached.
- A HUD for a filter (stakes, last N hands, last N days) is computed from those hands in a few ms and cached until
  new hands arrive.
- `stats.go` re-derives every stat of the HUD layout by its PT4 name from the `flg_*` / `enum_*` columns and
  `cash_hand_summary.str_aggressors_*` / `str_actors_*`. The four custom stats exported with the HUD use PT4's own
  formulas. Positions come from PT4's `lookup_positions`.

| Endpoint | Returns |
|---|---|
| `/pt4/status` | `configured`, `connected`, `database` (no password), `error`, `maxHand`, `cachedPlayers` |
| `/pt4/players?q=` | up to 25 cash players whose name contains `q` (prefix matches first) with their hand count |
| `/pt4/limits` | stakes that have hands |
| `/pt4/hud?ids=1,2&limits=3,4&last=500&days=30` | per player: `name`, `site`, `hands` (matching), `total`, `stats`: `{name: [[num, den] × 7]}` — index 0 all positions, then BB, SB, EP, MP, CO, BTN |
| `/pt4/verify?id=` | the check against `cash_cache` |
| `/pt4/notes?ids=1,2` | PT4 player notes: `{notes: {"1": {id, color, date, text, rich}}}` (players without one absent) |
| `POST /pt4/notes` `{player, color, text, expected}` | saves a note (JSON only); `expected` = the `date` it was loaded with (`""` for a new one), 409 `note_changed` with PT4's current note if it changed meanwhile |

Notes (`notes.go`): table `notes`, `enum_type = 'P'`, `id_x` = player, one per player. The text is wxWidgets rich text;
the site edits plain text (one line per paragraph) and a save keeps the note's `<paragraphlayout>` (font, margins)
but drops inline formatting — `rich: true` warns about it. A new note takes `max(id_note) + 1` under
`LOCK TABLE notes IN EXCLUSIVE MODE`; every save moves `date_note`, which is the version checked against `expected`.

Errors: `pt4_not_configured`, `pt4_error` (with the database's message).

## Security

- Listens on `127.0.0.1` only (no firewall prompt, not reachable from the LAN).
- `Host` must be `127.0.0.1` / `localhost` (DNS rebinding).
- CORS only for the allowed sites. Answers Chrome's Private Network preflight.
- Only `.cfr` under the solves folder (symlinks resolved).
- Node ids limited to `r`, digits, `c`, `f`, `bN`, cards: nothing else reaches the solver.
- No raw-command endpoint.
- Status page and settings: same origin + per-run token.
- PT4: read-only role and read-only sessions; the search text is quoted (and its `%` / `_` escaped), every other
  parameter is a number. The one write (`POST /pt4/notes`) needs JSON, so a browser sends a preflight the guard
  only answers for allowed sites; it touches only `notes`.
- The solver runs hidden, inside a job object: it dies with the bridge.

## Layout

| Path | What |
|---|---|
| `cmd/piobridge/` | the app (tray on Windows, headless elsewhere for tests) |
| `cmd/probe/` | PioProbe, the phase 0 recorder |
| `internal/upi/` | UPI client: start (hidden, job object), `set_end_string`, one command at a time, `show_node` parsing |
| `internal/bridge/` | config, solver manager (start on demand, reload on change, retry once after a crash, idle stop), HTTP API, status page |
| `internal/pt4/` | PokerTracker 4: PostgreSQL client, hand loading and cache, stat catalogue, check against `cash_cache` |
| `internal/tray/`, `internal/winutil/` | tray icon and menu; single instance, start with Windows, open URL / folder |
| `testdata/pt4_fixture.sql` | four hands with known stats for the PT4 integration test |
| `testdata/` | real solver transcripts (`probe-8h5d3d*.txt`, licence line redacted) + `replay_pio.py` that replays them + `fake_pio.py` |

## Build and test

- `./build.sh` (Git Bash / WSL) or `.\build.ps1` (PowerShell): with Docker `golang:1.24`, it runs `go mod tidy`,
  vet and tests, then builds both `.exe` into `dist/`.
- Tests: they drive the HTTP API against `testdata/replay_pio.py`, which replays the real solver's answers. They
  need `python3` and are skipped without it.
- What they check:
  - EV(node) = Σ strategy × EV(action) on the flop and a turn;
  - pots and bet tokens;
  - river refused;
  - the tree info's wrong `#Board#` flagged;
  - path traversal, id injection, foreign origin, DNS rebinding, CSRF on settings;
  - Private Network preflight;
  - solver crash → restart + retry;
  - idle stop / restart;
  - PioSOLVER missing.
- PT4: unit tests on the stats, and every stat of the site's layout (`src/lib/hud/layout.json`) must be in the
  catalogue. The integration test runs when `PT4_TEST_DSN` points to a PostgreSQL holding an empty PT4 schema
  (`pg_dump -s` of a real database) plus `testdata/pt4_fixture.sql`.
