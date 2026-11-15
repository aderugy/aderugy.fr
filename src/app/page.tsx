import Link from "next/link";
import { LegalFooter } from "@/components/legal/LegalPage";
import { NowPanel, TodayHeading } from "@/components/home/NowPanel";

type Tool = {
  href: string;
  name: string;
  description: string;
  /** A second door straight into the part used most. */
  shortcut?: { href: string; label: string };
};

const groups: { title: string; tools: Tool[] }[] = [
  {
    title: "Plan",
    tools: [
      {
        href: "/agenda",
        name: "Agenda",
        description: "The week: a backlog of typed tasks, placed on a timetable.",
        shortcut: { href: "/agenda/backlog", label: "Backlog" },
      },
      {
        href: "/projects",
        name: "Projects",
        description: "Research on a budget: contract, steps with a cut line, one open step, notes with Claude.",
      },
      {
        href: "/jobs",
        name: "Jobs",
        description: "The internship search: applications, companies, interviews, offers kept.",
      },
    ],
  },
  {
    title: "Learn",
    tools: [
      {
        href: "/maths",
        name: "Maths",
        description: "Probability & statistics: a graph of concepts, courses, exercises, spaced repetition.",
        shortcut: { href: "/maths/revision", label: "Révision" },
      },
      {
        href: "/flashcards",
        name: "Flashcards",
        description: "Decks in Markdown and maths, FSRS reviews, Claude-written cards to approve.",
        shortcut: { href: "/flashcards/review", label: "Study" },
      },
    ],
  },
  {
    title: "Poker",
    tools: [
      {
        href: "/poker/live",
        name: "Live",
        description: "Sessions at the table: seats, players and notes, hands, results.",
        shortcut: { href: "/poker/live/players", label: "Players" },
      },
      {
        href: "/poker/spots",
        name: "Solver notes",
        description: "Spots from the solver, studied node by node.",
      },
      {
        href: "/poker/trainers",
        name: "Trainers",
        description: "Drills on the spots, with sessions and stats.",
      },
      {
        href: "/poker",
        name: "Calculator",
        description: "Pot odds, drawing equity and fold equity, rake included.",
      },
    ],
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 pt-[max(3rem,env(safe-area-inset-top))] pb-12 sm:px-6 sm:pt-20">
      <h1 className="text-2xl font-semibold tracking-tight">aderugy.fr</h1>
      <TodayHeading />

      {/* Signed in: the live session to get back to, and today. Nothing otherwise. */}
      <NowPanel />

      <div className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.title} className={g.title === "Poker" ? "sm:col-span-2" : ""}>
            <h2 className="mb-2 px-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{g.title}</h2>
            {/* Hairlines between rows (and columns) are the border colour showing through a 1px gap. */}
            <ul className={`grid gap-px overflow-hidden rounded-xl border border-line bg-line ${g.title === "Poker" ? "sm:grid-cols-2" : ""}`}>
              {g.tools.map((t) => (
                <li key={t.href} className="relative bg-surface">
                  <Link href={t.href} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-background/60">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium group-hover:text-accent">{t.name}</span>
                      <span className="mt-0.5 block text-sm text-muted">{t.description}</span>
                    </span>
                    {!t.shortcut && <span className="mt-0.5 text-muted" aria-hidden>›</span>}
                  </Link>
                  {t.shortcut && (
                    <Link
                      href={t.shortcut.href}
                      className="absolute top-2.5 right-3 rounded-full border border-line bg-background px-2.5 py-0.5 text-xs text-muted hover:border-accent hover:text-foreground"
                    >
                      {t.shortcut.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <LegalFooter className="mt-16" />
    </main>
  );
}
