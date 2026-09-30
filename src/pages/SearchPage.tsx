import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileText, MessageSquareText, Search, StickyNote } from "lucide-react";
import { api } from "../api";
import type { UnifiedSearchResponse, UnifiedSearchResult, UnifiedSearchType } from "../types";

const emptyResults: UnifiedSearchResponse = { documents: [], chunks: [], notes: [], messages: [] };

const filters: Array<{ id: UnifiedSearchType; label: string }> = [
  { id: "all", label: "全部" },
  { id: "documents", label: "资料" },
  { id: "chunks", label: "正文片段" },
  { id: "notes", label: "笔记" },
  { id: "messages", label: "问答" },
];
const allowedTypes = filters.map((item) => item.id);

const sections: Array<{ key: keyof UnifiedSearchResponse; label: string; icon: typeof FileText }> = [
  { key: "documents", label: "资料", icon: FileText },
  { key: "chunks", label: "正文片段", icon: FileText },
  { key: "notes", label: "笔记", icon: StickyNote },
  { key: "messages", label: "问答", icon: MessageSquareText },
];

function updatedLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [type, setType] = useState<UnifiedSearchType>(() => {
    const initial = searchParams.get("type") as UnifiedSearchType | null;
    return initial && allowedTypes.includes(initial) ? initial : "all";
  });
  const [results, setResults] = useState<UnifiedSearchResponse>(emptyResults);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!normalizedQuery) {
      setResults(emptyResults);
      setError(null);
      setLoading(false);
      setSearchParams({}, { replace: true });
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      setSearchParams({ q: normalizedQuery, type }, { replace: true });
      void api.search(normalizedQuery, type).then((next) => {
        if (active) setResults(next);
      }).catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "搜索失败");
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [normalizedQuery, type, setSearchParams]);

  const total = useMemo(() => Object.values(results).reduce((sum, items) => sum + items.length, 0), [results]);

  function openResult(result: UnifiedSearchResult) {
    if (result.type === "message" && result.sessionId) {
      navigate(`/qa?session=${encodeURIComponent(result.sessionId)}&message=${encodeURIComponent(result.messageId ?? result.id)}`);
      return;
    }
    if (!result.documentId) return;
    const params = new URLSearchParams({ doc: result.documentId });
    if (result.type === "chunk" && result.chunkId) params.set("chunk", result.chunkId);
    if (result.type === "note") params.set("tab", "notes");
    navigate(`/?${params.toString()}`);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">统一搜索</h1>
        <p className="mt-1 text-sm text-muted">搜索资料、正文片段、笔记和历史问答。</p>
      </header>

      <label className="relative block">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入文件名、内容、笔记或问答关键词"
          className="input w-full py-3 pl-10 pr-4"
        />
      </label>

      <div className="my-4 flex flex-wrap gap-2">
        {filters.map((item) => (
          <button key={item.id} onClick={() => setType(item.id)} className="tab" data-active={type === item.id}>
            {item.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</div>}
      {loading && <p className="py-8 text-center text-sm text-faint">正在搜索…</p>}
      {!loading && !normalizedQuery && <p className="card px-4 py-10 text-center text-sm text-faint">输入关键词开始搜索。</p>}
      {!loading && normalizedQuery && !error && total === 0 && <p className="card px-4 py-10 text-center text-sm text-faint">没有找到匹配内容。</p>}

      {!loading && total > 0 && (
        <div className="space-y-6">
          <p className="text-xs text-faint">显示 {total} 条匹配结果</p>
          {sections.filter((section) => results[section.key].length > 0).map((section) => {
            const Icon = section.icon;
            return (
              <section key={section.key}>
                <h2 className="mb-2 flex items-center gap-2 border-b border-line pb-2 text-sm font-semibold text-ink">
                  <Icon className="h-4 w-4 text-muted" />{section.label}<span className="text-xs font-normal text-faint">{results[section.key].length}</span>
                </h2>
                <div className="divide-y divide-line rounded-xl border border-line bg-card">
                  {results[section.key].map((result) => (
                    <button key={`${result.type}-${result.id}`} onClick={() => openResult(result)} className="block w-full px-4 py-3 text-left transition hover:bg-paper/70">
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{result.title}</span>
                          <span className="mt-0.5 block text-xs text-faint">{result.subtitle}{updatedLabel(result.updatedAt) ? ` · ${updatedLabel(result.updatedAt)}` : ""}</span>
                        </span>
                        <span className="mt-0.5 flex-none text-faint"><Search className="h-3.5 w-3.5" /></span>
                      </span>
                      {result.snippet && <span className="mt-2 block whitespace-pre-wrap text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{result.snippet}</span>}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
