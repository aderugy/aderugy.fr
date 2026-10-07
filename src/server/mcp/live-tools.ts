import "server-only";
import { z } from "zod";
import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import { fmtDateTime } from "@/lib/jobs/format";
import { handText } from "@/lib/live/describe";
import { breaksOf, fmtDuration, summarize } from "@/lib/live/session";
import { describeMove, describeSeatEvent, readableSeatLog } from "@/lib/live/table";
import { LIVE_LIMITS, fmtMoney, fmtStakes, type LiveTag, type PlayerSummary } from "@/lib/live/types";
import {
  addNote,
  getSessionBundle,
  handsWithPlayer,
  listSessions,
  loadNotes,
  loadPlayers,
  loadTags,
  patchNote,
  removeNote,
  resolveTagRefs,
  sessionsWithPlayer,
  setPlayerTags,
} from "@/server/live/data";
import { callerOf } from "./auth";

/**
 * /poker/live as MCP tools, on the same connector as the backlog and /jobs.
 *
 * Every call goes through server/live/data.ts with the caller's own token,
 * so RLS and the OAuth-client rules of migration 0018 apply: Claude reads
 * everything, adds notes on players (and edits or deletes only the notes it
 * wrote), and puts tags on players or takes them off. Sessions, money, the
 * table, hands, players and the tag list stay with Arthur in the app.
 */

export const LIVE_INSTRUCTIONS = `Arthur's live poker sessions (aderugy.fr/poker/live): NLHE cash games in card rooms, full ring (9 or 10 seats).

How the data works:
- A session is one sitting: venue, stakes, buy-in and rebuys, breaks, cash-out. The result is cash-out − buy-ins; time played leaves out breaks.
- The table is a log of seat events: who sat where, sat out, came back, changed seat, left. Some seats hold someone not identified yet.
- Players are a database reused across sessions: a name or nickname, a description (how to recognise them), tags (Arthur's, e.g. fish, reg, nit) and timestamped notes. A note may point at the session or hand it was taken in.
- Hands are entered action by action. Amounts are chips in the session's currency; "raises to 15" is the total on that street. Arthur's net per hand is before rake.

What you may do: read everything; add notes on players (add_player_note), edit or delete the notes you wrote (never Arthur's); tag and untag players with existing tags (tag_player). You cannot create sessions, players or tags, change the table, or edit hands.

Reviewing a session: get_live_session (the table's history and every hand), then for the opponents worth it, get_live_player and add concise, actionable notes ("over-folds to river raises", "limps AA UTG") tied to the hand that shows it.`;

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const sessionId = z.string().uuid().describe("Session id, from list_live_sessions.");
const playerRef = z.string().min(1).max(200).describe("Player id, or their exact name (any case).");

function findPlayer(players: PlayerSummary[], ref: string): PlayerSummary | string {
  const r = ref.trim().toLowerCase();
  const byId = players.find((p) => p.id === ref);
  if (byId) return byId;
  const named = players.filter((p) => p.name.toLowerCase() === r);
  if (named.length === 1) return named[0];
  if (named.length > 1) return `Several players are named "${ref}": ${named.map((p) => `${p.name} (${p.description ?? "no description"}, id ${p.id})`).join("; ")}. Use the id.`;
  const close = players.filter((p) => p.name.toLowerCase().includes(r)).slice(0, 8);
  return `No player "${ref}".${close.length ? ` Close: ${close.map((p) => `${p.name} (id ${p.id})`).join(", ")}.` : ""}`;
}

function tagNames(p: PlayerSummary, tags: LiveTag[]): string {
  const names = p.tag_ids.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "no tags";
}

export function registerLiveTools(server: McpServer) {
  server.registerTool(
    "list_live_sessions",
    {
      title: "List live poker sessions",
      description: "Arthur's live sessions, newest first: date, venue, stakes, time played, result, hands entered. The running one, if any, is marked.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe("How many, newest first. Default 30."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const rows = await listSessions(db, userId, limit ?? 30);
      if (!rows.length) return ok("No live session recorded yet.");
      const lines = rows.map((s) => {
        const sum = summarize(s, s.events);
        const result = s.ended_at
          ? `${sum.net! >= 0 ? "+" : ""}${fmtMoney(sum.net!, s.currency)}${sum.bbPerHour !== null ? ` (${Math.round(sum.bbPerHour * 10) / 10} bb/h)` : ""}`
          : "RUNNING";
        return `- ${fmtDateTime(s.started_at)} · ${s.venue} · ${fmtStakes(s)} ${s.game} · ${fmtDuration(sum.playedMs)} · in ${fmtMoney(sum.invested, s.currency)} · ${result} · ${s.hand_count} hands (id ${s.id})`;
      });
      return ok(`${rows.length} session${rows.length > 1 ? "s" : ""}:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "get_live_session",
    {
      title: "Read one live session in full",
      description:
        "One session: money and time, Arthur's session notes, the table's history (who sat where and when), the players met with their tags, and every hand written out with positions, board, shown cards and result.",
      inputSchema: z.object({ id: sessionId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const data = await getSessionBundle(db, userId, id);
      if (!data) return failure(`No session with id ${id}.`);
      const { session: s, events, seatEvents, hands, players, tags } = data;
      const sum = summarize(s, events);
      const byId = new Map(players.map((p) => [p.id, p]));
      const nameOf = (pid: string | null) => (pid ? (byId.get(pid)?.name ?? null) : null);

      const met = [...new Set(seatEvents.map((e) => e.player_id).filter((x): x is string => Boolean(x)))]
        .map((pid) => byId.get(pid))
        .filter((p): p is PlayerSummary => Boolean(p));
      const log = readableSeatLog(seatEvents).map(
        ({ event: e, movedTo }) =>
          `- ${fmtDateTime(e.at)}: ${e.kind === "hero_move" ? `Arthur takes seat ${e.seat}` : movedTo ? describeMove(e, movedTo, nameOf(e.player_id)) : describeSeatEvent(e, nameOf(e.player_id))}`,
      );
      const money = events
        .filter((e) => e.kind === "buy_in" || e.kind === "rebuy")
        .map((e) => `${e.kind === "buy_in" ? "buy-in" : "rebuy"} ${fmtMoney(e.amount ?? 0, s.currency)} at ${fmtDateTime(e.at)}`);
      const breaks = breaksOf(events).map((b) => `${fmtDateTime(b.start)}–${b.end ? fmtDateTime(b.end) : "…"}`);

      const out = [
        `# ${s.venue} — ${fmtStakes(s)} ${s.game}, ${s.seats}-max (session ${s.id})`,
        `${fmtDateTime(s.started_at)} → ${s.ended_at ? fmtDateTime(s.ended_at) : "still running"} · played ${fmtDuration(sum.playedMs)}`,
        `Money: ${money.join(", ")}${s.ended_at ? ` · cash-out ${fmtMoney(s.cash_out ?? 0, s.currency)} · result ${sum.net! >= 0 ? "+" : ""}${fmtMoney(sum.net!, s.currency)}${sum.hourly !== null ? ` (${fmtMoney(Math.round(sum.hourly), s.currency)}/h)` : ""}` : ""}`,
        breaks.length ? `Breaks: ${breaks.join(", ")}` : "",
        "",
        "## Session notes",
        s.notes ?? "_(none)_",
        "",
        "## Players met",
        met.length ? met.map((p) => `- ${p.name} — ${tagNames(p, tags)}${p.description ? ` — ${p.description}` : ""} (player ${p.id})`).join("\n") : "_(nobody identified)_",
        "",
        "## The table's history",
        log.join("\n"),
        "",
        `## Hands (${hands.length})`,
        hands.length ? hands.map((h) => handText(h, nameOf, s.currency)).join("\n\n") : "_(none entered)_",
      ];
      return ok(out.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n"));
    },
  );

  server.registerTool(
    "list_live_players",
    {
      title: "List live poker players",
      description:
        "Arthur's player database, most recently seen first: name, tags, description, where last seen, number of notes. Filter by text (name or description) or tags.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Text to find in names and descriptions."),
        tags: z.array(z.string()).optional().describe("Keep players carrying every one of these tags (names or ids)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tags: tagRefs }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [players, tags] = await Promise.all([loadPlayers(db, userId), loadTags(db, userId)]);
      let wanted: string[] = [];
      if (tagRefs?.length) {
        const r = resolveTagRefs(tags, tagRefs);
        if (!r.ok) return failure(r.error);
        wanted = r.ids;
      }
      const q = query?.trim().toLowerCase();
      const rows = players
        .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q))
        .filter((p) => wanted.every((t) => p.tag_ids.includes(t)))
        .sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""));
      if (!rows.length) return ok(players.length ? "No player matches." : "No players yet.");
      return ok(
        rows
          .map(
            (p) =>
              `- ${p.name} — ${tagNames(p, tags)}${p.description ? ` — ${p.description}` : ""} · ${p.last_seen_at ? `last seen ${fmtDateTime(p.last_seen_at)}${p.last_seen_venue ? ` at ${p.last_seen_venue}` : ""}` : "never seated"} · ${p.note_count} note${p.note_count === 1 ? "" : "s"} (player ${p.id})`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "get_live_player",
    {
      title: "Read one player in full",
      description: "One player: description, tags, every note (who wrote it, when, in which session or hand), the sessions shared and the hands they were dealt into, written out.",
      inputSchema: z.object({ player: playerRef }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ player: ref }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [players, tags] = await Promise.all([loadPlayers(db, userId), loadTags(db, userId)]);
      const p = findPlayer(players, ref);
      if (typeof p === "string") return failure(p);
      const [notes, sessions, hands] = await Promise.all([
        loadNotes(db, userId, { playerId: p.id }),
        sessionsWithPlayer(db, userId, p.id),
        handsWithPlayer(db, userId, p.id, 50),
      ]);
      const byId = new Map(players.map((x) => [x.id, x]));
      const nameOf = (pid: string | null) => (pid ? (byId.get(pid)?.name ?? null) : null);
      const venueOf = new Map(sessions.map((s) => [s.id, `${s.venue}, ${fmtDateTime(s.started_at)}`]));
      const out = [
        `# ${p.name} (player ${p.id})`,
        `Tags: ${tagNames(p, tags)}`,
        `Description: ${p.description ?? "_(none)_"}`,
        "",
        "## Notes",
        notes.length
          ? notes
              .map(
                (n) =>
                  `- ${fmtDateTime(n.created_at)} · ${n.source === "claude" ? "by Claude" : "by Arthur"}${n.session_id ? ` · ${venueOf.get(n.session_id) ?? `session ${n.session_id}`}` : ""}${n.hand_id ? ` · hand ${n.hand_id}` : ""} (note ${n.id}):\n  ${n.body.replace(/\n/g, "\n  ")}`,
              )
              .join("\n")
          : "_(none)_",
        "",
        `## Sessions together (${sessions.length})`,
        sessions.map((s) => `- ${fmtDateTime(s.started_at)} · ${s.venue} · seat ${s.seat} (session ${s.id})`).join("\n") || "_(none)_",
        "",
        `## Hands with them (${hands.length}, newest first)`,
        hands.length ? hands.map((h) => `${h.venue ? `_${h.venue}, ${fmtDateTime(h.played_at)}_\n` : ""}${handText(h, nameOf, h.currency)}`).join("\n\n") : "_(none)_",
      ];
      return ok(out.join("\n"));
    },
  );

  server.registerTool(
    "list_live_tags",
    {
      title: "List player tags",
      description: "Arthur's player tags, in his order. Tags cannot be created from here.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const tags = await loadTags(db, userId);
      return ok(tags.length ? tags.map((t) => `- ${t.name} (tag ${t.id})`).join("\n") : "No tags yet — Arthur makes them in the app.");
    },
  );

  server.registerTool(
    "add_player_note",
    {
      title: "Add a note on a player",
      description:
        "Add a timestamped note on a player, marked as written by Claude. Keep it short and actionable. Give the session and the hand it comes from when it does, so Arthur can check it.",
      inputSchema: z.object({
        player: playerRef,
        body: z.string().min(1).max(LIVE_LIMITS.maxNote).describe("The note, plain text."),
        session_id: z.string().uuid().optional().describe("The session the note comes from."),
        hand_id: z.string().uuid().optional().describe("The hand the note comes from."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ player: ref, body, session_id, hand_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const p = findPlayer(await loadPlayers(db, userId), ref);
      if (typeof p === "string") return failure(p);
      const r = await addNote(db, userId, { player_id: p.id, body, session_id, hand_id });
      if (!r.ok) return failure(r.error);
      return ok(`Note added on ${p.name} (note ${r.value.id}).`);
    },
  );

  server.registerTool(
    "edit_player_note",
    {
      title: "Edit a note you wrote",
      description: "Replace the text of a note Claude wrote. Arthur's own notes cannot be changed from here.",
      inputSchema: z.object({
        note_id: z.string().uuid().describe("Note id, from get_live_player."),
        body: z.string().min(1).max(LIVE_LIMITS.maxNote),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id, body }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await patchNote(db, userId, note_id, body);
      if (!r.ok) return failure(r.error);
      return ok("Note updated.");
    },
  );

  server.registerTool(
    "delete_player_note",
    {
      title: "Delete a note you wrote",
      description: "Delete a note Claude wrote. Arthur's own notes cannot be deleted from here.",
      inputSchema: z.object({ note_id: z.string().uuid().describe("Note id, from get_live_player.") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const r = await removeNote(db, userId, note_id);
      if (!r.ok) return failure(r.error);
      return ok("Note deleted.");
    },
  );

  server.registerTool(
    "tag_player",
    {
      title: "Tag or untag a player",
      description: "Put existing tags on a player and/or take some off. Tag names or ids, from list_live_tags.",
      inputSchema: z.object({
        player: playerRef,
        add: z.array(z.string()).optional().describe("Tags to put on."),
        remove: z.array(z.string()).optional().describe("Tags to take off."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ player: ref, add, remove }, ctx) => {
      const { db, userId } = callerOf(ctx.http?.authInfo);
      const [players, tags] = await Promise.all([loadPlayers(db, userId), loadTags(db, userId)]);
      const p = findPlayer(players, ref);
      if (typeof p === "string") return failure(p);
      const a = resolveTagRefs(tags, add ?? []);
      if (!a.ok) return failure(`Nothing was changed. ${a.error}`);
      const d = resolveTagRefs(tags, remove ?? []);
      if (!d.ok) return failure(`Nothing was changed. ${d.error}`);
      const next = [...new Set([...p.tag_ids, ...a.ids])].filter((t) => !d.ids.includes(t));
      const r = await setPlayerTags(db, userId, p.id, next);
      if (!r.ok) return failure(r.error);
      const names = next.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean);
      return ok(`${p.name} now: ${names.length ? names.join(", ") : "no tags"}.`);
    },
  );
}
