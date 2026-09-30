import { useEffect, useRef, useState } from "react";
import { Bot, Check, Copy, Download, FileDown, FileSearch, FolderPlus, Lightbulb, MessageSquarePlus, NotebookPen, Pencil, RefreshCw, Search, Send, ThumbsDown, ThumbsUp, Trash2, User } from "lucide-react";
import { api, documentFileUrl, regenerateChatMessage, streamChatMessage } from "../api";
import Markdown from "../components/Markdown";
import Modal from "../components/Modal";
import PdfSourceViewer from "../components/PdfSourceViewer";
import type { ChatMessage, ChatScope, ChatSession, Collection, KnowledgeDoc, SourceRef } from "../types";

function sessionDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function withCitationLinks(content: string, sourceCount: number) {
  if (!sourceCount) return content;
  return content.replace(/\[(\d{1,2})\](?!\()/g, (match, digits) => {
    const index = Number(digits);
    return index >= 1 && index <= sourceCount ? `[${index}](#source-${index})` : match;
  });
}

function HighlightedSourceText({ content, target }: { content: string; target: string }) {
  const needle = target.trim().replace(/\s+/g, " ").slice(0, 500);
  if (!needle) return <p className="whitespace-pre-wrap rounded-lg bg-paper p-4 text-sm leading-7 text-ink">{content}</p>;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = content.split(new RegExp(`(${escaped})`, "ig"));
  return (
    <p className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-paper p-4 text-sm leading-7 text-ink">
      {parts.map((part, index) => part.toLowerCase() === needle.toLowerCase() ? <mark key={index} className="rounded bg-yellow-200 px-0.5">{part}</mark> : part)}
    </p>
  );
}

export default function QAPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const sessionSearchActive = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string>();
  const [isThinking, setIsThinking] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<{ documentId: string | null; documentName: string; pageNo: number | null; sectionTitle: string | null; content: string; targetText: string; fileExtension: string | null } | null>(null);
  const [stageMessage, setStageMessage] = useState("");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [allDocs, setAllDocs] = useState<KnowledgeDoc[]>([]);
  const [scopeType, setScopeType] = useState<"library" | "collection" | "documents">("library");
  const [scopeCollectionId, setScopeCollectionId] = useState("");
  const [scopeDocumentIds, setScopeDocumentIds] = useState<string[]>([]);
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const pendingSources = useRef<SourceRef[]>([]);
  const initialSessionParam = useRef(new URLSearchParams(window.location.search).get("session"));
  const initialMessageParam = useRef(new URLSearchParams(window.location.search).get("message"));

  function applyStoredScope(session: ChatSession) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("scopeType") || params.get("docs") || params.get("collection")) return;
    const type = session.scopeType ?? "library";
    setScopeType(type);
    setScopeCollectionId(type === "collection" ? session.scopeCollectionId ?? "" : "");
    setScopeDocumentIds(type === "documents" ? session.scopeDocumentIds ?? [] : []);
  }

  // Question scope can be preset from the library (“就此文档提问” / “基于所选提问”).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const type = params.get("scopeType");
    const docs = params.get("docs");
    const collection = params.get("collection");
    if (type === "documents" && docs) {
      setScopeType("documents");
      setScopeDocumentIds(docs.split(",").filter(Boolean));
    } else if (type === "collection" && collection) {
      setScopeType("collection");
      setScopeCollectionId(collection);
    }
    void api.collections().then(setCollections).catch(() => undefined);
    void api.documents().then(setAllDocs).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!sessionSearchActive.current) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.sessions(sessionSearch).then((items) => { if (active) setSessions(items); }).catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "搜索对话失败");
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [sessionSearch]);

  useEffect(() => {
    let active = true;
    void api.sessions().then(async (items) => {
      if (!active) return;
      setSessions(items);
      const target = initialSessionParam.current && items.some((item) => item.id === initialSessionParam.current)
        ? initialSessionParam.current
        : items[0]?.id;
      if (target) {
        setSessionId(target);
        const selected = items.find((item) => item.id === target);
        if (selected) applyStoredScope(selected);
        const history = await api.sessionMessages(target);
        if (active) setMessages(history);
        return;
      }
      setMessages([]);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "无法加载对话历史");
    }).finally(() => {
      if (active) setLoadingHistory(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (loadingHistory || !initialMessageParam.current) return;
    const target = document.getElementById(`message-${initialMessageParam.current}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("ring-2", "ring-brand/40");
    const timer = window.setTimeout(() => target.classList.remove("ring-2", "ring-brand/40"), 2200);
    initialMessageParam.current = null;
    return () => window.clearTimeout(timer);
  }, [loadingHistory, messages]);

  function handleChatScroll() {
    const element = chatScrollRef.current;
    if (!element) return;
    autoFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }

  useEffect(() => {
    const element = chatScrollRef.current;
    if (!element || !autoFollowRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, isThinking]);

  async function selectSession(id: string) {
    if (isThinking || id === sessionId) return;
    setError(null);
    setSuggestions([]);
    setLoadingHistory(true);
    setSessionId(id);
    const selected = sessions.find((item) => item.id === id);
    if (selected) applyStoredScope(selected);
    try {
      setMessages(await api.sessionMessages(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载会话");
    } finally {
      setLoadingHistory(false);
    }
  }

  function newSession() {
    if (isThinking) return;
    setSessionId(undefined);
    setMessages([]);
    setSuggestions([]);
    setError(null);
  }

  async function renameSession(id: string) {
    const current = sessions.find((session) => session.id === id);
    const title = window.prompt("请输入新的会话名称", current?.title ?? "新会话")?.trim();
    if (!title || title === current?.title) return;
    try {
      const updated = await api.renameSession(id, title);
      setSessions((prev) => prev.map((session) => (session.id === id ? updated : session)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名会话失败");
    }
  }

  async function deleteSession(id: string) {
    if (!window.confirm("确定删除这段对话历史吗？")) return;
    try {
      await api.deleteSession(id);
      const next = sessions.filter((item) => item.id !== id);
      setSessions(next);
      if (id === sessionId) {
        setSessionId(next[0]?.id);
        setMessages(next[0] ? await api.sessionMessages(next[0].id) : []);
        setSuggestions([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除会话失败");
    }
  }

  function makeUpserter(assistantId: string, getText: () => string) {
    return () => {
      setMessages((prev) => {
        const exists = prev.some((message) => message.id === assistantId);
        if (!exists) return [...prev, { id: assistantId, role: "assistant", content: getText(), sources: pendingSources.current }];
        return prev.map((message) => (message.id === assistantId ? { ...message, content: getText(), sources: pendingSources.current } : message));
      });
    };
  }

  async function handleSend() {
    const question = input.trim();
    if (!question || isThinking) return;
    setInput("");
    setError(null);
    setSuggestions([]);
    setIsThinking(true);
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: question }]);

    const assistantId = `stream-${Date.now()}`;
    let assembled = "";
    pendingSources.current = [];
    setStageMessage("");
    setNotice(null);
    const upsert = makeUpserter(assistantId, () => assembled);
    try {
      await streamChatMessage(question, sessionId, {
        onSession: (data) => setSessionId(data.sessionId),
        onStage: (message) => setStageMessage(message),
        onReset: () => { assembled = ""; upsert(); },
        onSources: (sources) => { pendingSources.current = sources; },
        onDelta: (text) => { assembled += text; setStageMessage(""); upsert(); },
        onDone: (data) => {
          setStageMessage("");
          // Swap the local streaming id for the real message id so feedback,
          // save-as-note and regenerate work without a page reload.
          setMessages((prev) => prev.map((message) => (message.id === assistantId ? { ...message, id: data.assistantMessageId, noMatch: data.noMatch, answerSource: data.answerSource } : message)));
          void api.suggestions(data.assistantMessageId).then(setSuggestions).catch(() => undefined);
        },
      }, effectiveScope);
      setSessions(await api.sessions(sessionSearch));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "问答请求失败");
      if (assembled) upsert();
    } finally {
      setIsThinking(false);
    }
  }

  async function saveAsNote(message: ChatMessage) {
    const content = window.prompt("保存为笔记（可编辑）", message.content)?.trim();
    if (!content) return;
    try {
      await api.saveMessageAsNote(message.id, content);
      setNotice("已保存为笔记，可在资料库中找到。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存为笔记失败");
    }
  }

  async function handleRegenerate(target: ChatMessage) {
    if (isThinking || !sessionId) return;
    setError(null);
    setSuggestions([]);
    setIsThinking(true);
    setRegeneratingId(target.id);
    const placeholderId = `regen-${Date.now()}`;
    let assembled = "";
    pendingSources.current = target.sources ?? [];
    setMessages((prev) => [...prev.filter((message) => message.id !== target.id), { id: placeholderId, role: "assistant", content: "", sources: pendingSources.current }]);
    const upsert = makeUpserter(placeholderId, () => assembled);
    try {
      await regenerateChatMessage(sessionId, target.id, {
        onReset: () => { assembled = ""; upsert(); },
        onSources: (sources) => { pendingSources.current = sources; },
        onDelta: (text) => { assembled += text; upsert(); },
        onDone: (data) => {
          setMessages((prev) => prev.map((message) => (message.id === placeholderId ? { ...message, id: data.assistantMessageId, noMatch: data.noMatch, answerSource: data.answerSource } : message)));
          void api.suggestions(data.assistantMessageId).then(setSuggestions).catch(() => undefined);
        },
      });
      setSessions(await api.sessions(sessionSearch));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新生成失败");
      setMessages((prev) => [...prev.filter((message) => message.id !== placeholderId), target]);
    } finally {
      setIsThinking(false);
      setRegeneratingId(null);
    }
  }

  async function react(message: ChatMessage, value: number) {
    const next = message.feedback === value ? 0 : value;
    try {
      await api.setMessageFeedback(message.id, next);
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, feedback: next === 0 ? null : next } : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "反馈失败");
    }
  }

  async function copyMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 1500);
    } catch {
      setError("复制失败，请手动选择文本");
    }
  }

  function openCitation(message: ChatMessage, index: number) {
    const source = message.sources?.[index - 1];
    if (source) void openSource(message.id, source);
  }

  async function openSource(messageId: string, source: SourceRef) {
    try {
      const rows = await api.messageSources(messageId);
      const row = rows.find((item) => item.chunkId === source.chunkId);
      if (row) {
        let content = row.content;
        if (row.documentId && row.fileExtension?.toLowerCase() !== ".pdf") {
          const chunks = await api.documentChunks(row.documentId).catch(() => []);
          if (chunks.length) content = chunks.map((chunk) => chunk.content).join("\n\n");
        }
        setSourceDetail({ ...row, content, targetText: row.content });
      } else {
        setSourceDetail({ documentId: source.documentId ?? null, documentName: source.docName, pageNo: source.pageNo ?? null, sectionTitle: source.sectionTitle ?? null, content: source.snippet, targetText: source.snippet, fileExtension: source.fileExtension ?? null });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取引用原文");
    }
  }

  const lastAssistantId = [...messages].reverse().find((message) => message.role === "assistant" && !message.id.startsWith("stream-") && !message.id.startsWith("regen-"))?.id;
  // An incomplete scope (no collection / no documents chosen) falls back to the
  // whole library instead of silently returning no results.
  const effectiveScope: ChatScope = scopeType === "collection" && scopeCollectionId
    ? { type: "collection", collectionId: scopeCollectionId }
    : scopeType === "documents" && scopeDocumentIds.length
      ? { type: "documents", documentIds: scopeDocumentIds }
      : { type: "library" };
  const scopeLabel = effectiveScope.type === "library"
    ? "全库"
    : effectiveScope.type === "collection"
      ? `项目 · ${collections.find((item) => item.id === scopeCollectionId)?.name ?? "未选择"}`
      : `指定资料 · ${scopeDocumentIds.length} 篇`;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-4 sm:px-6 sm:py-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">问答</h1>
        {sessionId && (
          <div className="flex items-center gap-1.5">
            <a href={api.sessionExportUrl(sessionId, "markdown")} download className="btn btn-outline px-3 py-2 text-xs sm:text-sm" title="导出 Markdown">
              <FileDown className="h-4 w-4" /><span className="hidden sm:inline">Markdown</span>
            </a>
            <a href={api.sessionExportUrl(sessionId, "txt")} download className="btn btn-outline px-3 py-2 text-xs sm:text-sm" title="导出 TXT">
              <Download className="h-4 w-4" /><span className="hidden sm:inline">TXT</span>
            </a>
          </div>
        )}
      </header>

      <div className="card mb-3 flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span className="text-muted">问答范围</span>
        <select
          value={scopeType}
          onChange={(event) => setScopeType(event.target.value as "library" | "collection" | "documents")}
          className="input w-auto py-1.5 text-xs"
        >
          <option value="library">全库</option>
          <option value="collection">项目</option>
          <option value="documents">指定资料</option>
        </select>
        {scopeType === "collection" && (
          <select value={scopeCollectionId} onChange={(event) => setScopeCollectionId(event.target.value)} className="input w-auto py-1.5 text-xs">
            <option value="">选择项目…</option>
            {collections.map((collection) => (<option key={collection.id} value={collection.id}>{collection.name}</option>))}
          </select>
        )}
        {scopeType === "documents" && (
          <button onClick={() => setScopePickerOpen(true)} className="btn btn-outline px-3 py-1.5 text-xs">
            <FolderPlus className="h-3.5 w-3.5" />选择资料（已选 {scopeDocumentIds.length}）
          </button>
        )}
        <span className="ml-auto text-xs text-faint">当前范围：{scopeLabel}</span>
      </div>

      {notice && <div className="mb-3 rounded-lg border border-brand/30 bg-brand-soft px-4 py-2 text-sm text-brand-dark">{notice}</div>}

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 md:grid-cols-[240px_1fr] md:grid-rows-1 md:gap-4">
        <aside className="card flex min-h-0 flex-col gap-2 p-2">
          <button onClick={newSession} className="btn btn-outline w-full"><MessageSquarePlus className="h-4 w-4" />新建对话</button>
          <label className="relative block flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input value={sessionSearch} onChange={(event) => { sessionSearchActive.current = true; setSessionSearch(event.target.value); }} placeholder="查找对话内容" className="input py-2 pl-8 text-xs" />
          </label>
          <div className="flex min-h-0 gap-2 overflow-x-auto pb-1 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-0">
            {sessions.map((session) => (
              <div key={session.id} className={`group flex flex-none items-center gap-1 rounded-lg md:w-full md:min-w-0 ${sessionId === session.id ? "bg-brand-soft" : "hover:bg-paper"}`}>
                <button onClick={() => void selectSession(session.id)} className={`min-w-0 flex-1 px-3 py-2.5 text-left text-sm ${sessionId === session.id ? "font-medium text-brand-dark" : "text-muted"}`}>
                  <p className="truncate">{session.title}</p>
                  <p className="mt-0.5 truncate text-xs text-faint">{session.matchSnippet || `${sessionDate(session.updatedAt)} · ${session.messageCount} 条`}</p>
                </button>
                <button onClick={() => void renameSession(session.id)} className="btn btn-ghost px-1.5 py-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100" title="重命名会话"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => void deleteSession(session.id)} className="btn btn-ghost mr-1 px-1.5 py-1.5 hover:bg-danger-soft hover:text-danger opacity-100 md:opacity-0 md:group-hover:opacity-100" title="删除会话"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
            {!sessions.length && <p className="px-3 py-3 text-center text-xs leading-5 text-faint">{sessionSearch ? "没有匹配的对话" : "还没有历史对话"}</p>}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">{error}</div>}
          <div ref={chatScrollRef} onScroll={handleChatScroll} className="card min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
            {loadingHistory ? (
              <div className="flex h-full items-center justify-center text-sm text-faint">正在加载对话历史…</div>
            ) : !messages.length && !isThinking ? (
              <div className="flex h-full items-center justify-center text-sm text-faint">试试提问：这份资料的核心概念是什么？</div>
            ) : (
              messages.map((message) => (
                <div id={`message-${message.id}`} key={message.id} className={`rounded-xl transition-shadow ${message.role === "user" ? "flex justify-end gap-2.5 sm:gap-3" : "flex gap-2.5 sm:gap-3"}`}>
                  {message.role === "assistant" && (
                    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-soft text-brand"><Bot className="h-4 w-4" /></div>
                  )}
                  <div className={`max-w-[85%] sm:max-w-[75%] ${message.role === "user" ? "order-first" : ""}`}>
                    <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${message.role === "user" ? "whitespace-pre-wrap rounded-br-sm bg-brand text-white" : message.noMatch ? "rounded-bl-sm bg-warn-soft text-warn" : "rounded-bl-sm bg-paper text-ink"}`}>
                      {message.role === "user"
                        ? message.content
                        : <Markdown onCitation={(index) => openCitation(message, index)}>{
                            (message.sources?.length ?? 0)
                              ? withCitationLinks(message.content, message.sources!.length)
                              : message.content.replace(/\s*\[\d{1,2}\]/g, "")
                          }</Markdown>}
                    </div>
                    {message.role === "assistant" && message.answerSource === "general" && (
                      <p className="mt-1 text-xs text-warn">以下内容基于通用知识，不是来自你的资料库。</p>
                    )}
                    {message.role === "assistant" && message.answerSource === "fallback" && (
                      <p className="mt-1 text-xs text-warn">本轮没有找到可用的资料依据。</p>
                    )}
                    {message.role === "assistant" && message.answerSource === "document" && !message.sources?.length && (
                      <p className="mt-1 text-xs text-faint">答案使用了知识库信息，但本轮没有可点击的原文片段。</p>
                    )}
                    {message.role === "assistant" && Boolean(message.sources?.length) && !message.id.startsWith("stream-") && !message.id.startsWith("regen-") && (
                      <details className="mt-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-muted">
                        <summary className="cursor-pointer select-none font-medium text-brand-dark">本轮依据 · {message.sources!.length} 个来源</summary>
                        <div className="mt-2 space-y-1.5">
                          {message.sources!.map((source, index) => (
                            <button key={`${source.docId}-${index}`} onClick={() => openCitation(message, index + 1)} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-paper">
                              <span className="font-medium text-ink">[{index + 1}] {source.docName}</span>
                              {source.pageNo && <span className="ml-1 text-faint">· 第 {source.pageNo} 页</span>}
                              <span className="mt-0.5 block line-clamp-2 text-faint">{source.snippet}</span>
                            </button>
                          ))}
                        </div>
                      </details>
                    )}

                    {message.role === "assistant" && !message.id.startsWith("stream-") && !message.id.startsWith("regen-") && (
                      <div className="mt-1.5 flex items-center gap-1 text-faint">
                        <button onClick={() => void copyMessage(message)} className="btn btn-ghost px-1.5 py-1" title="复制回答">
                          {copiedId === message.id ? <Check className="h-3.5 w-3.5 text-brand" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => void react(message, 1)} className={`btn btn-ghost px-1.5 py-1 ${message.feedback === 1 ? "text-brand" : ""}`} title="有帮助"><ThumbsUp className="h-3.5 w-3.5" /></button>
                        <button onClick={() => void react(message, -1)} className={`btn btn-ghost px-1.5 py-1 ${message.feedback === -1 ? "text-danger" : ""}`} title="没帮助"><ThumbsDown className="h-3.5 w-3.5" /></button>
                        <button onClick={() => void saveAsNote(message)} className="btn btn-ghost px-1.5 py-1" title="保存为笔记"><NotebookPen className="h-3.5 w-3.5" /></button>
                        {message.id === lastAssistantId && (
                          <button onClick={() => void handleRegenerate(message)} disabled={isThinking} className="btn btn-ghost px-1.5 py-1" title="重新生成">
                            <RefreshCw className={`h-3.5 w-3.5 ${regeneratingId === message.id ? "animate-spin" : ""}`} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {message.role === "user" && (
                    <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-line text-muted"><User className="h-4 w-4" /></div>
                  )}
                </div>
              ))
            )}
            {isThinking && messages[messages.length - 1]?.role === "user" && (
              <div className="flex items-center gap-2 text-sm text-faint"><FileSearch className="h-4 w-4 animate-pulse" />{stageMessage || "正在检索资料并生成回答…"}</div>
            )}
            {!isThinking && suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Lightbulb className="h-3.5 w-3.5 text-faint" />
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); setSuggestions([]); }}
                    className="tab"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="card mt-3 flex items-center gap-2 p-2 sm:mt-4">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void handleSend(); }}
              placeholder="输入你的问题"
              className="h-10 flex-1 border-0 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-faint"
            />
            <button onClick={() => void handleSend()} disabled={!input.trim() || isThinking} className="btn btn-primary h-10 px-3.5 sm:px-4"><Send className="h-4 w-4" />发送</button>
          </div>
        </section>
      </div>

      {scopePickerOpen && (
        <Modal
          title="选择要提问的资料"
          onClose={() => setScopePickerOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setScopeDocumentIds([])} className="btn btn-ghost">清空</button>
              <button onClick={() => setScopePickerOpen(false)} className="btn btn-primary">确定（已选 {scopeDocumentIds.length} 篇）</button>
            </div>
          }
        >
          {!allDocs.filter((doc) => doc.status === "parsed").length ? (
            <p className="text-sm text-faint">还没有可用的资料，请先在资料库上传并完成解析。</p>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {allDocs.filter((doc) => doc.status === "parsed").map((doc) => {
                const checked = scopeDocumentIds.includes(doc.id);
                return (
                  <label key={doc.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-paper">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setScopeDocumentIds((prev) => (checked ? prev.filter((id) => id !== doc.id) : [...prev, doc.id]))}
                    />
                    <span className="truncate text-sm text-ink">{doc.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {sourceDetail && (
        <Modal variant="reader" title={`引用原文 · ${sourceDetail.documentName}`} onClose={() => setSourceDetail(null)}>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-faint">
            {sourceDetail.pageNo && <span>第 {sourceDetail.pageNo} 页</span>}
            {sourceDetail.sectionTitle && <span>· {sourceDetail.sectionTitle}</span>}
            {sourceDetail.documentId && <a className="ml-auto text-brand hover:underline" href={documentFileUrl(sourceDetail.documentId, false, sourceDetail.fileExtension?.toLowerCase() === ".pdf" ? sourceDetail.pageNo : undefined)} target="_blank" rel="noreferrer">打开原文件</a>}
          </div>
          {sourceDetail.documentId && sourceDetail.fileExtension?.toLowerCase() === ".pdf" ? (
            <PdfSourceViewer documentId={sourceDetail.documentId} pageNo={sourceDetail.pageNo} targetText={sourceDetail.targetText} />
          ) : (
            <HighlightedSourceText content={sourceDetail.content} target={sourceDetail.targetText} />
          )}
        </Modal>
      )}
    </div>
  );
}
