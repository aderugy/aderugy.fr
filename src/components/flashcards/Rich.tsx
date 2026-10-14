"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { markdownComponents } from "@/components/ui/Markdown";

/**
 * A card field: Markdown (GFM), KaTeX math ($…$, $$…$$) and highlighted code,
 * with the site's Markdown styling. Raw HTML is not rendered. Images are the
 * ones pasted into notes (/flashcards/media/…) or plain URLs.
 */

const components: Components = {
  ...markdownComponents,
  img: ({ node, alt, ...p }) => {
    void node;
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={alt ?? ""} loading="lazy" className="my-2 max-h-[50dvh] max-w-full rounded" {...p} />;
  },
};

export function Rich({ source, className }: { source: string; className?: string }) {
  return (
    <div className={["fc-rich break-words", className ?? "text-base"].join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
