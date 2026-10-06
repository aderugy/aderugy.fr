"use client";

import { DEFAULT_COLOR } from "@/lib/categories";
import { STATUS_LABELS, type ApplicationStatus, type JobTag } from "@/lib/jobs/types";

const STATUS_STYLE: Record<ApplicationStatus, string> = {
  to_apply: "border-line text-muted",
  applied: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  interviewing: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  offer: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  accepted: "border-emerald-600 bg-emerald-600 text-white",
  rejected: "border-red-500/30 bg-red-500/5 text-red-600/80 dark:text-red-400/80",
  withdrawn: "border-line text-muted line-through",
};

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function TagChip({
  tag,
  active = true,
  onClick,
  title,
}: {
  tag: Pick<JobTag, "name" | "color">;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const color = tag.color ?? DEFAULT_COLOR;
  const body = (
    <>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {tag.name}
    </>
  );
  const cls = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${
    active ? "border-line bg-surface text-foreground" : "border-dashed border-line text-muted"
  }`;
  if (!onClick) return <span className={cls}>{body}</span>;
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active} className={`${cls} hover:border-accent`}>
      {body}
    </button>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-1 text-xs text-red-500">{error}</p>;
}
