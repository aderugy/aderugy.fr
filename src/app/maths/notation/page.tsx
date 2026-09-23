import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { CONTENT_DIR } from "@/lib/maths/graph/load";
import { Mdx } from "@/lib/maths/mdx";

export default function NotationPage() {
  const file = path.join(CONTENT_DIR, "notation.mdx");
  const { content, data } = matter(fs.readFileSync(file, "utf8"));

  return (
    <main className="px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
      <div className="prose-cours">
        <h1 className="text-2xl font-semibold tracking-tight">
          {String(data.title ?? "Notation")}
        </h1>
        <p className="chrome text-muted mt-1">
          content/maths/notation.mdx · mis à jour le{" "}
          {data.updated instanceof Date
            ? data.updated.toISOString().slice(0, 10)
            : String(data.updated ?? "—")}
        </p>
        <div className="mt-8">
          <Mdx source={content} />
        </div>
      </div>
    </main>
  );
}
