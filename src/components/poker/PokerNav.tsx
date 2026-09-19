"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/poker/spots", label: "Solver notes" },
  { href: "/poker/trainers", label: "Trainers" },
  { href: "/poker", label: "Calculator" },
];

/** The signed-in poker tools' shared nav: Solver notes · Trainers · Calculator. */
export function PokerNav() {
  const path = usePathname();
  return (
    <nav className="flex min-w-0 items-center gap-3 sm:gap-5">
      {LINKS.map((l) => {
        const active = l.href === "/poker" ? path === "/poker" : path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={[
              "shrink-0 text-sm",
              active ? "font-semibold tracking-tight" : "text-muted hover:text-foreground",
            ].join(" ")}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
