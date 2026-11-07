"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { fmtWhenFr } from "@/lib/projects/format";
import { KIND_LABELS, isUnreadFor, type Message } from "@/lib/projects/types";
import type { ProjectState } from "@/server/projects/data";
import { markClaudeRead, removeMessage, sendMessage } from "@/server/actions/projects";
import { Section, btnPrimary, useAction } from "./bits";

/**
 * One thread per project, newest last. Claude's unread messages show bold the
 * first time the page shows them, and are marked read then. Arthur's show
 * when Claude marked them read (it does once it has acted on them).
 */
export function Messages({ state }: { state: ProjectState }) {
  const { project, messages, steps } = state;
  // Captured once: what was unread when the page opened stays bold.
  const [unreadAtOpen] = useState(() => new Set(messages.filter((m) => isUnreadFor(m, "arthur")).map((m) => m.id)));
  const [body, setBody] = useState("");
  const [showLog, setShowLog] = useState(false);
  const { pending, error, run } = useAction();
  const marked = useRef(false);

  useEffect(() => {
    if (marked.current || unreadAtOpen.size === 0) return;
    marked.current = true;
    void markClaudeRead(project.id);
  }, [project.id, unreadAtOpen]);

  const shown = messages.filter((m) => showLog || m.kind !== "next_action");
  const stepCode = (id: string | null) => (id ? steps.find((s) => s.id === id)?.code : null);
  const hidden = messages.length - shown.length;

  return (
    <Section
      id="messages"
      title="Messages"
      aside={
        hidden > 0 || showLog ? (
          <button type="button" onClick={() => setShowLog(!showLog)} className="text-xs text-muted hover:text-foreground">
            {showLog ? "masquer l'historique" : `+ ${hidden} prochaine${hidden > 1 ? "s" : ""} action${hidden > 1 ? "s" : ""}`}
          </button>
        ) : null
      }
    >
      <ul className="space-y-3">
        {shown.map((m) => (
          <MessageRow
            key={m.id}
            m={m}
            bold={unreadAtOpen.has(m.id)}
            step={stepCode(m.step_id) ?? null}
            onDelete={() => run(() => removeMessage(m.id))}
          />
        ))}
        {shown.length === 0 && <li className="text-sm text-muted">Pas encore de messages.</li>}
      </ul>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim()) return;
          run(() => sendMessage(project.id, body, state.open?.id ?? null), () => setBody(""));
        }}
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          rows={2}
          maxLength={4000}
          placeholder="Écrire à Claude… (lu au début de la prochaine session)"
          className="min-w-0 flex-1 resize-y rounded border border-line bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button disabled={pending || !body.trim()} className={btnPrimary}>
          Envoyer
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </Section>
  );
}

function MessageRow({ m, bold, step, onDelete }: { m: Message; bold: boolean; step: string | null; onDelete: () => void }) {
  const mine = m.author === "arthur";
  if (m.kind === "next_action") {
    return (
      <li className="text-xs text-muted">
        {fmtWhenFr(m.created_at)} · {mine ? "Arthur" : "Claude"} · prochaine action : {m.body}
      </li>
    );
  }
  return (
    <li className={`rounded-lg px-3 py-2 ${mine ? "ml-6 bg-background" : "mr-6 border border-line bg-surface"}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        <span className={`font-medium ${mine ? "" : "text-accent"}`}>{mine ? "Arthur" : "Claude"}</span>
        <span>{fmtWhenFr(m.created_at)}</span>
        {m.kind !== "note" && <span className="rounded bg-line px-1">{KIND_LABELS[m.kind]}</span>}
        {step && <span className="font-mono">{step}</span>}
        {!mine && m.surface !== "app" && <span>{m.surface === "claude_code" ? "Claude Code" : "claude.ai"}</span>}
        {mine && (
          <span className="ml-auto">
            {m.read_at ? `lu par Claude ${fmtWhenFr(m.read_at)}` : "pas encore lu"}
            {!m.read_at && (
              <button type="button" onClick={onDelete} className="ml-2 underline hover:text-red-500">
                retirer
              </button>
            )}
          </span>
        )}
      </div>
      <div className={`mt-1 ${bold ? "font-semibold" : ""}`}>
        <Markdown source={m.body} />
      </div>
    </li>
  );
}
