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
| `/api/runouts?file=&id=` | `id` = a split node (where the turn or river is dealt). Per card: the decision after it (`node`, `children`), `strategy` (each option's average frequency over the actor's range), `equity` and `ev` by player (solver's equity total 0–1, EV in chips averaged with `calc_ev`'s weights), `notes`. Runs `load_all_nodes` once per save first. With `after=` (e.g. `c`, `c:b150`): the same line below every card instead of the card's first decision (a later node of the street on every runout). |

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

## Security

- Listens on `127.0.0.1` only (no firewall prompt, not reachable from the LAN).
- `Host` must be `127.0.0.1` / `localhost` (DNS rebinding).
- CORS only for the allowed sites. Answers Chrome's Private Network preflight.
- Only `.cfr` under the solves folder (symlinks resolved).
- Node ids limited to `r`, digits, `c`, `f`, `bN`, cards: nothing else reaches the solver.
- No raw-command endpoint.
- Status page and settings: same origin + per-run token.
- The solver runs hidden, inside a job object: it dies with the bridge.

## Layout

| Path | What |
|---|---|
| `cmd/piobridge/` | the app (tray on Windows, headless elsewhere for tests) |
| `cmd/probe/` | PioProbe, the phase 0 recorder |
| `internal/upi/` | UPI client: start (hidden, job object), `set_end_string`, one command at a time, `show_node` parsing |
| `internal/bridge/` | config, solver manager (start on demand, reload on change, retry once after a crash, idle stop), HTTP API, status page |
| `internal/tray/`, `internal/winutil/` | tray icon and menu; single instance, start with Windows, open URL / folder |
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
