import { isValidElement, type ReactElement, type ReactNode } from "react";
import { compileMDX } from "next-mdx-remote/rsc";
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

// Les widgets sont utilisables directement dans un .mdx :
// `<Convergence loiInitiale="cauchy" />`.
//
// next-mdx-remote ≥ 6 bloque par défaut toute expression JavaScript
// (`blockJS`) : un attribut `trajectoires={30}` est retiré à la
// compilation. Les props de widget s'écrivent donc en chaînes, ou
// gardent leur valeur par défaut. Le contenu est versionné et n'exécute
// rien : on laisse ce garde-fou en place plutôt que de le désactiver.
const COMPOSANTS = { pre: Pre, Convergence };

const OPTIONS = {
  parseFrontmatter: true,
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkGfm],
    rehypePlugins: [rehypeSlug, [rehypeKatex, { strict: false }]],
  },
} satisfies NonNullable<Parameters<typeof compileMDX>[0]["options"]>;

/**
 * Rendus déjà compilés, par source. Compiler est cher — remark, rehype et
 * KaTeX coûtent ~15 ms par fragment, et une page de nœud en compte une
 * cinquantaine — alors que le contenu est versionné : la même source donne
 * toujours le même arbre. On garde donc l'élément React produit (immuable,
 * sans rien de propre à la requête) pour toute la vie de l'instance.
 *
 * C'est la promesse qui est gardée, pour que deux requêtes simultanées ne
 * compilent pas deux fois. En développement, pas de cache : on veut voir
 * tout de suite la modification d'un .mdx, comme pour `loadGraph`.
 */
const compilees = new Map<string, Promise<ReactElement>>();

export function compiler(source: string): Promise<ReactElement> {
  const prod = process.env.NODE_ENV === "production";
  const deja = prod ? compilees.get(source) : undefined;
  if (deja) return deja;
  const rendu = compileMDX({
    source: extraireAncres(source),
    components: COMPOSANTS,
    options: OPTIONS,
  }).then((r) => r.content);
  if (prod) {
    compilees.set(source, rendu);
    // Un échec ne doit pas rester en cache.
    rendu.catch(() => compilees.delete(source));
  }
  return rendu;
}

export async function Mdx({ source }: { source: string }) {
  return compiler(source);
}
