import Link from "next/link";

const tools = [
  {
    href: "/agenda",
    name: "Agenda",
    description: "Plan the week: typed tasks, reusable blocks, a timetable.",
  },
  {
    href: "/poker",
    name: "Poker odds",
    description: "Pot odds, drawing equity and fold equity, rake included.",
  },
  {
    href: "/maths",
    name: "Maths",
    description: "Probability & statistics path: a DAG of concepts, courses, exercises, spaced repetition.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">aderugy.fr</h1>
      <p className="mt-2 text-muted">Personal site and utility tools.</p>

      <ul className="mt-10 space-y-3">
        {tools.map((tool) => (
          <li key={tool.href}>
            <Link
              href={tool.href}
              className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent"
            >
              <span className="font-medium">{tool.name}</span>
              <span className="mt-1 block text-sm text-muted">
                {tool.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
