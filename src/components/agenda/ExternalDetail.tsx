"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { flattenTree, buildTree } from "@/lib/categories";
import { fmtDuration, fmtTime, minutesOfDay } from "@/lib/time";
import { deleteArchivedEvent } from "@/server/actions/google";
import type { CalendarSource, Category, ExternalEvent } from "@/lib/types";

/**
 * Read-only detail for an event mirrored from a calendar.
 *
 * Almost nothing here is editable. The provider is the source of truth and the
 * next sync would revert any change within minutes — an edit that silently
 * undoes itself is worse than no edit at all.
 *
 * The exception is an archive: an event the calendar deleted once it was over,
 * which the planner kept so the week it belonged to does not lose its hours.
 * The provider has forgotten it, so no sync will bring it back and none will
 * take it away. Removing it is the one decision left to you, and it is final —
 * hence a confirmation rather than a single stray click.
 */
export function ExternalDetail({
  event,
  source,
  categories,
  onClose,
}: {
  event: ExternalEvent;
  source: CalendarSource;
  categories: Category[];
  onClose: () => void;
}) {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);

  const archived = Boolean(event.archived_at);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const category = source.category_id
    ? flattenTree(buildTree(categories)).find((c) => c.id === source.category_id)
    : undefined;

  function onDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteArchivedEvent({
        calendarSourceId: event.calendar_source_id,
        externalEventId: event.external_event_id,
      });

      // On success the action refreshes the route and this row stops existing,
      // so the panel has nothing left to show.
      if (result.ok) {
        onClose();
      } else {
        setConfirming(false);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-medium">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: source.color }}
          />
          {source.display_name}
        </span>
        <button onClick={onClose} className="text-muted hover:text-foreground">
          Close
        </button>
      </div>

      <div className="tabular-nums text-muted">
        {start.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "short",
        })}
        {" · "}
        {event.all_day
          ? "all day"
          : `${fmtTime(minutesOfDay(start))}–${fmtTime(minutesOfDay(end))} (${fmtDuration(minutes)})`}
      </div>

      {event.title && (
        <div>
          <span className="text-muted">In {source.display_name}</span>
          <p className="mt-1 rounded border border-line bg-surface px-2 py-1.5">
            {event.title}
          </p>
        </div>
      )}

      <div>
        <span className="text-muted">Counts as</span>
        <p className="mt-1 flex items-center gap-1.5">
          {category ? (
            <>
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: category.effectiveColor }}
              />
              {category.path}
            </>
          ) : (
            <span className="text-muted">nothing — no category on this calendar</span>
          )}
        </p>
      </div>

      {(event.transparency !== "opaque" || event.attendee_response === "declined") && (
        <p className="text-muted">
          {event.transparency !== "opaque"
            ? "Marked as free in the source calendar."
            : "You declined this invitation."}
        </p>
      )}

      {error && <p className="text-red-500">{error}</p>}

      {archived ? (
        <div className="mt-auto space-y-2">
          <div className="rounded border border-line bg-surface px-2 py-1.5">
            <p className="font-medium">⧗ Archived</p>
            <p className="mt-1 text-muted">
              Your calendar deleted this once it was over. It stays on the grid
              and still counts towards{" "}
              {category ? category.path : "its category"} — the hours happened.
              Nothing but you can remove it.
            </p>
            {event.archived_at && (
              <p className="mt-1 tabular-nums text-muted">
                kept since{" "}
                {new Date(event.archived_at).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
            )}
          </div>

          {confirming ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={onDelete}
                className="rounded bg-red-500/10 px-2 py-1 text-red-500 hover:bg-red-500/20 disabled:opacity-50"
              >
                {pending ? "Deleting…" : "Delete for good"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming(false)}
                className="text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded border border-line px-2 py-1 text-muted hover:border-red-500 hover:text-red-500"
            >
              Delete this archive
            </button>
          )}
        </div>
      ) : (
        <p className="mt-auto text-muted">
          Read-only — this comes from your calendar. Change it there, or adjust the
          calendar in{" "}
          <Link href="/agenda/settings" className="underline hover:text-foreground">
            settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}
