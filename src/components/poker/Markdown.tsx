"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a node's Markdown notes (GitHub-flavoured: tables, task lists,
 * strikethrough). Raw HTML is not rendered, so notes can't inject markup.
 * Styling is mapped per element since the app has no typography plugin.
 */
/** react-markdown passes its AST node as a prop; keep it off the DOM. */
function omitNode<T extends object>(props: T): Omit<T, "node"> {
  const { node, ...rest } = props as T & { node?: unknown };
  void node;
  return rest;
}

const components: Components = {
  h1: (p) => <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0" {...omitNode(p)} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0" {...omitNode(p)} />,
  h3: (p) => <h3 className="mb-1 mt-2 text-sm font-medium first:mt-0" {...omitNode(p)} />,
  p: (p) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0" {...omitNode(p)} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...omitNode(p)} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...omitNode(p)} />,
  li: (p) => <li className="leading-relaxed" {...omitNode(p)} />,
  a: (p) => (
    <a className="text-accent underline" target="_blank" rel="noreferrer noopener" {...omitNode(p)} />
  ),
  blockquote: (p) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-muted" {...omitNode(p)} />
  ),
  code: (p) => (
    <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]" {...omitNode(p)} />
  ),
  pre: (p) => (
    <pre
      className="my-2 overflow-x-auto rounded border border-line bg-background p-2 text-xs [&_code]:bg-transparent [&_code]:p-0"
      {...omitNode(p)}
    />
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...omitNode(p)} />
    </div>
  ),
  th: (p) => <th className="border border-line px-2 py-1 text-left font-medium" {...omitNode(p)} />,
  td: (p) => <td className="border border-line px-2 py-1" {...omitNode(p)} />,
};

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={["text-sm break-words", className ?? ""].join(" ")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
