import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export default function Markdown({ children, onCitation }: { children: string; onCitation?: (index: number) => void }) {
  const components = useMemo<Components>(() => ({
    h1: ({ children: node }) => <h1 className="mb-2 mt-4 text-base font-semibold text-ink first:mt-0">{node}</h1>,
    h2: ({ children: node }) => <h2 className="mb-2 mt-4 text-[0.95rem] font-semibold text-ink first:mt-0">{node}</h2>,
    h3: ({ children: node }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold text-ink first:mt-0">{node}</h3>,
    h4: ({ children: node }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold text-ink first:mt-0">{node}</h4>,
    p: ({ children: node }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{node}</p>,
    ul: ({ children: node }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{node}</ul>,
    ol: ({ children: node }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{node}</ol>,
    li: ({ children: node }) => <li className="leading-relaxed marker:text-faint">{node}</li>,
    strong: ({ children: node }) => <strong className="font-semibold text-ink">{node}</strong>,
    em: ({ children: node }) => <em className="italic">{node}</em>,
    del: ({ children: node }) => <del className="text-faint">{node}</del>,
    a: ({ href, children: node }) => {
      const citation = href?.match(/^#source-(\d+)$/);
      if (citation && onCitation) {
        const index = Number(citation[1]);
        return (
          <button
            type="button"
            onClick={(event) => { event.preventDefault(); onCitation(index); }}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-brand-soft px-1 align-super text-[0.7rem] font-medium text-brand-dark hover:bg-brand/20"
            title={`跳转到来源 ${index}`}
          >
            {node}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:text-brand-dark">
          {node}
        </a>
      );
    },
    blockquote: ({ children: node }) => (
      <blockquote className="my-2 border-l-2 border-brand/40 pl-3 text-muted [&>p]:my-1">{node}</blockquote>
    ),
    hr: () => <hr className="my-3 border-line" />,
    pre: ({ children: node }) => (
      <pre className="my-2 overflow-x-auto rounded-lg bg-ink px-3 py-2.5 text-xs leading-relaxed text-paper">{node}</pre>
    ),
    code: ({ className, children: node, ...props }) => {
      const isBlock = (typeof className === "string" && className.includes("language-")) || String(node).includes("\n");
      if (isBlock) return <code className="font-mono" {...props}>{node}</code>;
      return <code className="rounded bg-black/[0.07] px-1 py-0.5 font-mono text-[0.85em] text-ink" {...props}>{node}</code>;
    },
    table: ({ children: node }) => (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">{node}</table>
      </div>
    ),
    thead: ({ children: node }) => <thead className="border-b border-line text-left text-faint">{node}</thead>,
    th: ({ children: node }) => <th className="px-2 py-1.5 font-medium">{node}</th>,
    td: ({ children: node }) => <td className="border-t border-line px-2 py-1.5 align-top">{node}</td>,
    img: ({ src, alt }) => <img src={src} alt={alt ?? ""} className="my-2 max-w-full rounded-lg border border-line" />,
  }), [onCitation]);

  return (
    <div className="text-sm leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
