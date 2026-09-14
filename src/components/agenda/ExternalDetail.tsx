"use client";

import Link from "next/link";
import { flattenTree, buildTree } from "@/lib/categories";
import { fmtDuration, fmtTime, minutesOfDay } from "@/lib/time";
import type { CalendarSource, Category, ExternalEvent } from "@/lib/types";

/**
 * Read-only detail for an event mirrored from a calendar.
 *
 * Nothing here is editable. The provider is the source of truth and the next
 * sync would revert any change within minutes — an edit that silently undoes
 * itself is worse than no edit at all.
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

  const category = source.category_id
    ? flattenTree(buildTree(categories)).find((c) => c.id === source.category_id)
    : undefined;

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

      <p className="mt-auto text-muted">
        Read-only — this comes from your calendar. Change it there, or adjust the
        calendar in{" "}
        <Link href="/agenda/settings" className="underline hover:text-foreground">
          settings
        </Link>
        .
      </p>
    </div>
  );
}
