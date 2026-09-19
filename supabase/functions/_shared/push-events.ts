/**
 * Pure mapping from a planned block to the Google event that shows it.
 *
 * No Deno or network APIs here, for the same reason as `events.ts`: this is
 * the part worth testing, and it runs the same under Deno and Node.
 */

export type PushTask = {
  /** The task's category leaf — what this slice of the block counts as. */
  categoryName: string | null;
  description: string | null;
  minutes: number;
  position: number;
};

export type PushBlock = {
  id: string;
  starts_at: string;
  ends_at: string;
  description: string | null;
  status: "planned" | "done" | "skipped" | string;
  /** The template's name, when the block was placed from one. */
  templateName: string | null;
  tasks: PushTask[];
};

export type GoogleEventBody = {
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string };
  end: { dateTime: string };
  status: "confirmed";
  transparency: "opaque" | "transparent";
  extendedProperties: { private: { agendaBlockId: string } };
  source?: { title: string; url: string };
};

/**
 * Google event ids are base32hex (`a-v`, `0-9`), 5 to 1024 characters. A uuid
 * without its dashes is lowercase hex, which is a subset — so the block id
 * itself is the event id, and a retried insert is recognised (409) instead of
 * creating a duplicate.
 */
export function eventIdFor(blockId: string): string {
  const id = blockId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-v]{5,1024}$/.test(id)) {
    throw new Error(`Block id ${blockId} does not map to a valid event id`);
  }
  return id;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/**
 * The same label the grid draws, falling back to what the tasks inside say:
 * a block has no title of its own, and "Block" on a phone lock screen tells
 * you nothing.
 */
export function titleFor(block: PushBlock): string {
  const ordered = [...block.tasks].sort((a, b) => a.position - b.position);
  const categories = [
    ...new Set(ordered.map((t) => t.categoryName?.trim()).filter(Boolean)),
  ] as string[];

  const base =
    block.templateName?.trim() ||
    block.description?.trim() ||
    categories.join(" · ") ||
    "Planned block";

  if (block.status === "done") return `✓ ${base}`;
  if (block.status === "skipped") return `✕ ${base}`;
  return base;
}

export function bodyFor(block: PushBlock, appUrl?: string | null): string {
  const lines = [...block.tasks]
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const what = [t.categoryName, t.description?.trim()].filter(Boolean).join(" — ");
      return `• ${what || "Untitled"} (${formatMinutes(t.minutes)})`;
    });

  // Shown only when it adds something the title does not already say.
  const note =
    block.description?.trim() && block.templateName?.trim()
      ? [block.description.trim(), ""]
      : [];

  const footer = [
    "",
    "Planned in Agenda. Edit it there — changes made here are overwritten.",
  ];
  if (appUrl) footer.push(`${appUrl.replace(/\/$/, "")}/agenda`);

  return [...note, ...lines, ...footer].join("\n").trim();
}

export function eventFor(block: PushBlock, appUrl?: string | null): GoogleEventBody {
  const starts = new Date(block.starts_at);
  const ends = new Date(block.ends_at);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
    throw new Error(`Block ${block.id} has an invalid time range`);
  }

  const event: GoogleEventBody = {
    id: eventIdFor(block.id),
    summary: titleFor(block),
    description: bodyFor(block, appUrl),
    start: { dateTime: starts.toISOString() },
    end: { dateTime: ends.toISOString() },
    // Explicit, so an update revives an event deleted by hand in Google rather
    // than writing into a cancelled one.
    status: "confirmed",
    // A skipped block is not time you are spending; don't let it make you look
    // busy to anyone checking your free/busy.
    transparency: block.status === "skipped" ? "transparent" : "opaque",
    extendedProperties: { private: { agendaBlockId: block.id } },
  };

  if (appUrl) {
    event.source = { title: "Agenda", url: `${appUrl.replace(/\/$/, "")}/agenda` };
  }
  return event;
}
