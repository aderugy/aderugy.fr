import { isValidElement, type ReactNode } from "react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import BlocPython from "@/components/maths/BlocPython";
import Convergence from "@/components/maths/widgets/Convergence";

/**
 * MDX interprète `{...}` comme une expression JavaScript : un titre écrit
 * `## Pièges {#pieges}` casse la compilation. On extrait donc l'ancre avant
 * de compiler et on la pose juste au-dessus du titre.
 *
 * L'ancre explicite est ce qui permet à une carte de révision de pointer vers
 * la section dont elle provient (décision D1). Elle ne dépend pas du libellé
 * du titre, qui peut être reformulé sans casser les liens.
 */
export function extraireAncres(source: string): string {
  return source.replace(
    /^(#{1,6} .+?)[ \t]*\{#([A-Za-z0-9_-]+)\}[ \t]*$/gm,
    '<a id="$2" className="ancre" />\n\n$1',
  );
}

/** Texte brut d'un bloc de code, s'il s'agit bien d'un bloc de code. */
function extraireCode(children: ReactNode): {
  code: string;
  langage: string;
} | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
    return null;
  const { className, children: contenu } = children.props;
  if (typeof contenu !== "string") return null;
  const m = /language-([\w-]+)/.exec(className ?? "");
  return { code: contenu.replace(/\n$/, ""), langage: m?.[1] ?? "" };
}

/**
 * Les blocs ```python deviennent exécutables (§7, V1). Les autres restent des
 * blocs de code ordinaires — on ne rend interactif que ce qui a vocation à
 * l'être, c'est-à-dire les sections « Vérification par simulation ».
 */
function Pre(props: React.ComponentPropsWithoutRef<"pre">) {
  const bloc = extraireCode(props.children);
  if (bloc && bloc.langage === "python") return <BlocPython code={bloc.code} />;
  return <pre {...props} />;
}

export function Mdx({ source }: { source: string }) {
  return (
    <MDXRemote
      source={extraireAncres(source)}
      // Les widgets sont utilisables directement dans un .mdx :
      // `<Convergence loiInitiale="cauchy" />`.
      components={{ pre: Pre, Convergence }}
      options={{
        parseFrontmatter: true,
        mdxOptions: {
          remarkPlugins: [remarkMath, remarkGfm],
          rehypePlugins: [rehypeSlug, [rehypeKatex, { strict: false }]],
        },
      }}
    />
  );
}
