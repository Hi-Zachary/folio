import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardPaste, Download, ExternalLink, FileSearch, FileText, FolderPlus, Link2, Loader2, MessageCircleQuestion, NotebookPen, Pencil, Plus, RefreshCw, Search, Sparkles, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import { api, documentFileUrl } from "../api";
import { useDocs } from "../store/DocsContext";
import Modal from "../components/Modal";
import Markdown from "../components/Markdown";
import StatusBadge from "../components/StatusBadge";
import type { Collection, DocChunk, DocumentNote, DocumentSummary, DocumentVersion, KnowledgeDoc, RelatedDocument, Tag } from "../types";

type UploadItem = {
  id: string;
  name: string;
  sizeKB: number;
  progress: number;
  status: "uploading" | "processing" | "done" | "failed";
  documentId?: string;
  error?: string;
  errorType?: "upload" | "parse";
};

type TagModalState =
  | { mode: "manage" }
  | { mode: "doc"; docId: string; initial?: string[] }
  | { mode: "batch"; initial?: string[] };

export default function DocsPage() {
  const {
    docs, tags, collections, loading, error, addDoc, removeDoc, retryDoc,
    createTag, renameTag, deleteTag, setDocTags,
    renameCollection, deleteCollection, addToCollection, refresh,
  } = useDocs();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("全部");
  const [statusFilter, setStatusFilter] = useState("全部");
  const [sortBy, setSortBy] = useState("recent");
  const [collectionModal, setCollectionModal] = useState<"assign" | null>(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectCreateType, setProjectCreateType] = useState<"manual" | "smart">("manual");
  const [projectCreateName, setProjectCreateName] = useState("");
  const [projectCreateQuery, setProjectCreateQuery] = useState("");
  const [projectCreateTag, setProjectCreateTag] = useState("");
  const [projectCreateDocType, setProjectCreateDocType] = useState("全部");
  const [projectCreateStatus, setProjectCreateStatus] = useState("全部");
  const [assignCollectionId, setAssignCollectionId] = useState<string>("");
  const [textModalOpen, setTextModalOpen] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textSaving, setTextSaving] = useState(false);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [urlSaving, setUrlSaving] = useState(false);
  const [remoteDocs, setRemoteDocs] = useState<KnowledgeDoc[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importedIds, setImportedIds] = useState<string[]>([]);
  const [importProjectId, setImportProjectId] = useState("");
  const [importTagIds, setImportTagIds] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tagModal, setTagModal] = useState<TagModalState | null>(null);
  const [assignTagIds, setAssignTagIds] = useState<string[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [viewerDoc, setViewerDoc] = useState<KnowledgeDoc | null>(null);
  const [viewerTab, setViewerTab] = useState<"content" | "summary" | "notes" | "related">("content");
  const [viewerChunks, setViewerChunks] = useState<DocChunk[] | null>(null);
  const [viewerNotes, setViewerNotes] = useState<DocumentNote[] | null>(null);
  const [viewerRelated, setViewerRelated] = useState<RelatedDocument[] | null>(null);
  const [viewerSummary, setViewerSummary] = useState<DocumentSummary | null>(null);
  const [viewerVersions, setViewerVersions] = useState<DocumentVersion[]>([]);
  const [versionModalOpen, setVersionModalOpen] = useState(false);
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionSaving, setVersionSaving] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerQuery, setViewerQuery] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteQuote, setNoteQuote] = useState("");
  const [noteChunkId, setNoteChunkId] = useState<string | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkHandled = useRef(false);
  const failedDocs = docs.filter((doc) => doc.status === "failed");
  const manualCollections = collections.filter((collection) => !collection.isSmart);

  // Open a document and optional tab from a deep link.
  useEffect(() => {
    if (deepLinkHandled.current || loading || !docs.length) return;
    const docId = searchParams.get("doc");
    if (!docId) return;
    const doc = docs.find((item) => item.id === docId);
    if (!doc) return;
    deepLinkHandled.current = true;
    const tab = searchParams.get("tab");
    void loadViewer(doc, searchParams.get("chunk") ?? undefined).then(() => {
      if (tab === "notes" || tab === "related" || tab === "summary") setViewerTab(tab);
    });
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, loading, searchParams]);

  // Reflect parse state for recently imported files while the import dialog is open.
  useEffect(() => {
    setUploadItems((prev) => prev.map((item) => {
      if (!item.documentId || item.status === "done") return item;
      const doc = docs.find((candidate) => candidate.id === item.documentId);
      if (!doc) return item;
      if (doc.status === "parsed") return { ...item, status: "done" };
      if (doc.status === "failed") return { ...item, status: "failed", errorType: "parse", error: doc.errorMessage ?? "解析失败" };
      return item;
    }));
  }, [docs]);

  // Server-side search/filter (name, content, notes, tags, project).
  useEffect(() => {
    if (!search.trim() && !tagFilter && !collectionFilter) {
      setRemoteDocs(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api.documents({ q: search, tagId: tagFilter ?? undefined, collectionId: collectionFilter ?? undefined })
        .then((list) => { if (active) setRemoteDocs(list); })
        .catch(() => { if (active) setRemoteDocs([]); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [search, tagFilter, collectionFilter]);

  const baseDocs = remoteDocs ?? docs;
  const visibleDocs = useMemo(() => {
    let list = baseDocs;
    if (typeFilter !== "全部") list = list.filter((doc) => doc.type === typeFilter);
    if (statusFilter === "parsed") list = list.filter((doc) => doc.status === "parsed");
    else if (statusFilter === "processing") list = list.filter((doc) => doc.status === "pending" || doc.status === "parsing");
    else if (statusFilter === "failed") list = list.filter((doc) => doc.status === "failed");
    if (sortBy === "title") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    else if (sortBy === "size") list = [...list].sort((a, b) => b.sizeKB - a.sizeKB);
    return list;
  }, [baseDocs, typeFilter, statusFilter, sortBy]);
  const allSelected = visibleDocs.length > 0 && visibleDocs.every((doc) => selectedIds.has(doc.id));

  function updateUploadItem(id: string, update: Partial<UploadItem>) {
    setUploadItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...update } : item)));
  }

  function openImportDialog() {
    setUploadItems([]);
    setImportedIds([]);
    setImportProjectId("");
    setImportTagIds([]);
    setNewTagName("");
    setImportError(null);
    setImportModalOpen(true);
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length || uploading) return;
    setImportModalOpen(true);
    setImportError(null);
    const selected = Array.from(files);
    const items = selected.map((file, index) => ({
      id: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      sizeKB: Math.max(1, Math.round(file.size / 1024)),
      progress: 0,
      status: "uploading" as const,
    }));
    setUploadItems((prev) => [...prev, ...items]);
    setUploading(true);

    const results = await Promise.all(selected.map(async (file, index) => {
      const item = items[index];
      try {
        const created = await addDoc(file, (progress) => updateUploadItem(item.id, { progress }));
        updateUploadItem(item.id, { progress: 100, status: "processing", documentId: created.id });
        return created.id;
      } catch (reason) {
        updateUploadItem(item.id, { status: "failed", errorType: "upload", error: reason instanceof Error ? reason.message : "上传失败" });
        return null;
      }
    }));
    const successfulIds = results.filter((id): id is string => Boolean(id));
    setImportedIds((previous) => [...new Set([...previous, ...successfulIds])]);
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function finishImport(organize: boolean) {
    if (uploading) return;
    setImportError(null);
    try {
      if (organize && importedIds.length) {
        const operations: Promise<unknown>[] = [];
        if (importProjectId) operations.push(api.addCollectionDocuments(importProjectId, importedIds));
        if (importTagIds.length) operations.push(api.batchDocuments(importedIds, "tag", { tagIds: importTagIds }));
        await Promise.all(operations);
        if (operations.length) await refresh();
      }
      setImportModalOpen(false);
      setUploadItems([]);
      setImportedIds([]);
      setImportProjectId("");
      setImportTagIds([]);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : "整理资料失败，请重试");
    }
  }

  async function addTagDuringImport() {
    const name = newTagName.trim();
    if (!name) return;
    try {
      await createTag(name);
      const allTags = await api.tags();
      const created = allTags.find((tag) => tag.name === name);
      if (created) setImportTagIds((current) => [...new Set([...current, created.id])]);
      setNewTagName("");
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : "创建标签失败");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("确定删除这份资料吗？删除后将同时移除其分块和检索索引。")) return;
    setBusyId(id);
    try {
      await removeDoc(id);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRetry(id: string) {
    setBusyId(id);
    try {
      await retryDoc(id);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "重试失败");
    } finally {
      setBusyId(null);
    }
  }

  async function renameDocument(doc: KnowledgeDoc) {
    const name = window.prompt("重命名资料", doc.name)?.trim();
    if (!name || name === doc.name) return;
    try {
      const renamed = await api.renameDocument(doc.id, name);
      await refresh();
      if (viewerDoc?.id === doc.id) setViewerDoc(renamed);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "重命名资料失败");
    }
  }

  async function loadViewer(doc: KnowledgeDoc, targetChunkId?: string) {
    setViewerDoc(doc);
    setViewerTab("content");
    setViewerChunks(null);
    setViewerNotes(null);
    setViewerRelated(null);
    setViewerSummary(null);
    setViewerVersions([]);
    setViewerQuery("");
    setSummaryLoading(true);
    setViewerLoading(true);
    resetNoteForm();
    await Promise.all([
      api.documentChunks(doc.id).then(setViewerChunks).catch(() => setViewerChunks([])),
      api.documentNotes(doc.id).then(setViewerNotes).catch(() => setViewerNotes([])),
      api.relatedDocuments(doc.id).then(setViewerRelated).catch(() => setViewerRelated([])),
      api.documentSummary(doc.id).then(setViewerSummary).catch(() => setViewerSummary(null)),
      api.documentVersions(doc.id).then(setViewerVersions).catch(() => setViewerVersions([])),
    ]);
    setSummaryLoading(false);
    setViewerLoading(false);
    if (targetChunkId) {
      window.setTimeout(() => document.getElementById(`chunk-${targetChunkId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    }
  }

  async function uploadNewVersion() {
    if (!viewerDoc || !versionFile) return;
    setVersionSaving(true);
    try {
      const result = await api.uploadDocumentVersion(viewerDoc.id, versionFile);
      setVersionModalOpen(false);
      setVersionFile(null);
      setNotice(`已保存为版本 ${result.version.versionNo}，正在重新解析。`);
      await refresh();
      await loadViewer(result.document);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "上传新版本失败");
    } finally {
      setVersionSaving(false);
    }
  }

  async function restoreVersion(version: DocumentVersion) {
    if (!viewerDoc || !window.confirm(`确定恢复到版本 ${version.versionNo} 吗？当前内容会自动保存为一个新版本。`)) return;
    setVersionSaving(true);
    try {
      const result = await api.restoreDocumentVersion(viewerDoc.id, version.id);
      setNotice(`已恢复版本 ${version.versionNo}，当前内容已保存为版本 ${result.preservedVersionNo}。`);
      await refresh();
      await loadViewer(result.document);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "恢复版本失败");
    } finally {
      setVersionSaving(false);
    }
  }

  async function generateSummary() {
    if (!viewerDoc) return;
    setSummaryLoading(true);
    try {
      setViewerSummary(await api.generateSummary(viewerDoc.id));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "生成摘要失败");
    } finally {
      setSummaryLoading(false);
    }
  }

  async function savePastedText() {
    if (!textTitle.trim() || !textContent.trim()) return;
    setTextSaving(true);
    try {
      await api.createTextDocument({ title: textTitle.trim(), content: textContent });
      setTextModalOpen(false);
      setTextTitle("");
      setTextContent("");
      setNotice("已创建资料，正在后台解析。");
      await refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "创建资料失败");
    } finally {
      setTextSaving(false);
    }
  }

  async function saveUrlDocument() {
    if (!urlValue.trim()) return;
    setUrlSaving(true);
    try {
      await api.createUrlDocument({ url: urlValue.trim(), title: urlTitle.trim() || undefined });
      setUrlModalOpen(false);
      setUrlValue("");
      setUrlTitle("");
      setNotice("网页已导入，正在后台解析。");
      await refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "导入网页失败");
    } finally {
      setUrlSaving(false);
    }
  }

  async function createProject() {
    const name = projectCreateName.trim();
    if (!name) return;
    if (projectCreateType === "smart" && !projectCreateQuery.trim() && !projectCreateTag && projectCreateDocType === "全部" && projectCreateStatus === "全部") {
      setNotice("智能项目至少需要一个筛选条件");
      return;
    }
    try {
      const smartFilter = projectCreateType === "smart" ? {
        q: projectCreateQuery.trim() || undefined,
        tagId: projectCreateTag || undefined,
        type: projectCreateDocType === "全部" ? undefined : projectCreateDocType,
        status: projectCreateStatus === "全部" ? undefined : projectCreateStatus,
      } : undefined;
      await api.createCollection(name, undefined, undefined, { isSmart: projectCreateType === "smart", smartFilter });
      await refresh();
      setProjectCreateOpen(false);
      setProjectCreateName("");
      setProjectCreateQuery("");
      setProjectCreateTag("");
      setProjectCreateDocType("全部");
      setProjectCreateStatus("全部");
      setNotice("项目已创建");
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "创建项目失败"); }
  }

  async function promptRenameCollection(collection: Collection) {
    const name = window.prompt("重命名项目", collection.name)?.trim();
    if (!name || name === collection.name) return;
    try {
      await renameCollection(collection.id, name);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "重命名项目失败");
    }
  }

  async function removeCollection(collection: Collection) {
    if (!window.confirm(`确定删除项目“${collection.name}”吗？项目内的资料不会被删除。`)) return;
    try {
      await deleteCollection(collection.id);
      if (collectionFilter === collection.id) setCollectionFilter(null);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "删除项目失败");
    }
  }

  async function applyCollectionAssignment() {
    if (!assignCollectionId) return;
    try {
      await addToCollection(assignCollectionId, [...selectedIds]);
      setSelectedIds(new Set());
      setCollectionModal(null);
      setAssignCollectionId("");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "加入项目失败");
    }
  }

  async function removeDocFromProject(documentId: string) {
    if (!collectionFilter) return;
    try {
      await api.removeCollectionDocument(collectionFilter, documentId);
      await refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "移出项目失败");
    }
  }

  function askAbout(documentIds: string[]) {
    if (!documentIds.length) return;
    navigate(`/qa?scopeType=documents&docs=${documentIds.join(",")}`);
  }

  function askAboutCollection(collectionId: string) {
    navigate(`/qa?scopeType=collection&collection=${collectionId}`);
  }

  function resetNoteForm() {
    setNoteContent("");
    setNoteQuote("");
    setNoteChunkId(undefined);
  }

  async function saveNote() {
    if (!viewerDoc || !noteContent.trim()) return;
    try {
      const created = await api.createNote(viewerDoc.id, { content: noteContent.trim(), quote: noteQuote.trim() || undefined, chunkId: noteChunkId });
      setViewerNotes((prev) => [created, ...(prev ?? [])]);
      resetNoteForm();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "保存笔记失败");
    }
  }

  async function editNote(note: DocumentNote) {
    const content = window.prompt("编辑笔记", note.content)?.trim();
    if (!content || content === note.content) return;
    try {
      const updated = await api.updateNote(note.id, { content });
      setViewerNotes((prev) => (prev ?? []).map((item) => (item.id === note.id ? updated : item)));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "更新笔记失败");
    }
  }

  async function removeNote(note: DocumentNote) {
    if (!window.confirm("删除这条笔记？")) return;
    try {
      await api.deleteNote(note.id);
      setViewerNotes((prev) => (prev ?? []).filter((item) => item.id !== note.id));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "删除笔记失败");
    }
  }

  function openTagModal(state: TagModalState, initial: string[] = []) {
    setAssignTagIds(initial);
    setNewTagName("");
    setTagModal(state);
  }

  async function applyTags() {
    if (!tagModal || tagModal.mode === "manage") return;
    try {
      if (tagModal.mode === "doc") await setDocTags(tagModal.docId, assignTagIds);
      else await runBatch("tag", { tagIds: assignTagIds });
      setTagModal(null);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "设置标签失败");
    }
  }

  async function addTagInModal() {
    const name = newTagName.trim();
    if (!name) return;
    try {
      await createTag(name);
      setNewTagName("");
      const list = await api.tags();
      const created = list.find((tag) => tag.name === name);
      if (created) setAssignTagIds((prev) => [...prev, created.id]);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "创建标签失败");
    }
  }

  async function runBatch(action: "tag", extra?: { tagIds?: string[] }) {
    if (!selectedIds.size) return;
    try {
      await api.batchDocuments([...selectedIds], action, extra);
      setSelectedIds(new Set());
      await refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "批量操作失败");
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(visibleDocs.map((doc) => doc.id)));
  }

  async function promptRenameTag(tag: Tag) {
    const name = window.prompt("重命名标签", tag.name)?.trim();
    if (!name || name === tag.name) return;
    try {
      await renameTag(tag.id, name);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "重命名标签失败");
    }
  }

  async function removeTag(tag: Tag) {
    if (!window.confirm(`确定删除标签“${tag.name}”吗？`)) return;
    try {
      await deleteTag(tag.id);
      if (tagFilter === tag.id) setTagFilter(null);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "删除标签失败");
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">资料库</h1>
        <label className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名、内容或笔记" className="input pl-9" />
        </label>
      </header>

      {(error || notice) && (
        <div className="mb-5 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">{error ?? notice}</div>
      )}
      {failedDocs.length > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>有 {failedDocs.length} 个文件解析失败，可点击对应行的重试按钮再次处理。</span>
        </div>
      )}

      <div
        className="mb-5 flex flex-wrap items-center gap-2 border-y border-line py-3"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}
      >
        <button disabled={uploading} onClick={openImportDialog} className="btn btn-primary px-3 py-2 text-sm"><Upload className="h-4 w-4" />上传文件</button>
        <button onClick={() => setTextModalOpen(true)} className="btn btn-ghost px-3 py-2 text-sm"><ClipboardPaste className="h-4 w-4" />粘贴文本</button>
        <button onClick={() => setUrlModalOpen(true)} className="btn btn-ghost px-3 py-2 text-sm"><Link2 className="h-4 w-4" />导入网页</button>
        <button onClick={() => openTagModal({ mode: "manage" })} className="btn btn-ghost ml-auto px-3 py-2 text-sm"><TagIcon className="h-4 w-4" />标签</button>
        {uploading && <Loader2 className="h-4 w-4 animate-spin text-brand" />}
        <span className="basis-full text-xs text-faint sm:basis-auto sm:ml-2">也可拖放文件 · PDF、DOCX、Markdown、HTML、CSV、TXT</span>
      </div>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between border-b border-line pb-2">
          <h2 className="text-sm font-semibold text-ink">项目</h2>
          <button onClick={() => setProjectCreateOpen(true)} className="btn btn-ghost px-2 py-1 text-xs"><Plus className="h-3.5 w-3.5" />新建项目</button>
        </div>
        {collections.length ? (
          <div className="divide-y divide-line">
            {collections.map((collection) => {
              const active = collectionFilter === collection.id;
              return (
                <div key={collection.id} className={`flex min-h-12 items-center gap-3 py-2 ${active ? "text-brand-dark" : "text-ink"}`}>
                  <button onClick={() => { setCollectionFilter(active ? null : collection.id); setTagFilter(null); }} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <FolderPlus className={`h-4 w-4 flex-none ${collection.isSmart ? "text-warn" : "text-muted"}`} />
                    <span className="truncate text-sm">{collection.name}</span>
                    {collection.isSmart && <span className="flex-none text-xs text-faint">智能</span>}
                    <span className="flex-none text-xs text-faint">{collection.documentCount ?? 0}</span>
                  </button>
                  <button onClick={() => askAboutCollection(collection.id)} disabled={!collection.documentCount} className="btn btn-ghost px-2 py-1 text-xs">提问</button>
                  <button onClick={() => void promptRenameCollection(collection)} className="btn btn-ghost px-2 py-1" title="重命名项目"><Pencil className="h-3.5 w-3.5" /></button>
                  <button onClick={() => void removeCollection(collection)} className="btn btn-ghost px-2 py-1 hover:text-danger" title="删除项目"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              );
            })}
          </div>
        ) : <p className="py-3 text-sm text-muted">暂无项目</p>}
      </section>

      {tags.length > 0 && (
        <div className="mb-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">标签
            <select value={tagFilter ?? ""} onChange={(event) => setTagFilter(event.target.value || null)} className="input w-auto min-w-36 py-1.5 text-xs">
              <option value="">全部</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          {tagFilter && <button onClick={() => setTagFilter(null)} className="text-xs text-muted underline">清除</button>}
        </div>
      )}

      {collectionFilter && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted">项目：{collections.find((item) => item.id === collectionFilter)?.name}</span>
          <button onClick={() => setCollectionFilter(null)} className="text-xs text-muted underline">显示全部资料</button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="input w-auto py-1.5 text-xs">
          {["全部", "PDF", "Word", "Markdown", "HTML", "CSV", "TXT"].map((type) => (<option key={type} value={type}>{type === "全部" ? "全部类型" : type}</option>))}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="input w-auto py-1.5 text-xs">
          <option value="全部">全部状态</option>
          <option value="parsed">已解析</option>
          <option value="processing">处理中</option>
          <option value="failed">失败</option>
        </select>
        <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="input w-auto py-1.5 text-xs">
          <option value="recent">最近导入</option>
          <option value="title">标题</option>
          <option value="size">文件大小</option>
        </select>
        <span className="ml-auto text-faint">共 {visibleDocs.length} 个文件</span>
      </div>

      {selectedIds.size > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
          <span className="mr-1 text-muted">已选 {selectedIds.size} 项</span>
          <button onClick={() => openTagModal({ mode: "batch" }, [])} className="btn btn-outline px-3 py-1.5 text-xs"><TagIcon className="h-3.5 w-3.5" />添加标签</button>
          <button onClick={() => { setCollectionModal("assign"); setAssignCollectionId(manualCollections[0]?.id ?? ""); }} disabled={!manualCollections.length} className="btn btn-outline px-3 py-1.5 text-xs"><FolderPlus className="h-3.5 w-3.5" />加入项目</button>
          <button onClick={() => askAbout([...selectedIds])} className="btn btn-primary px-3 py-1.5 text-xs"><MessageCircleQuestion className="h-3.5 w-3.5" />基于所选提问</button>
          <button onClick={() => setSelectedIds(new Set())} className="btn btn-ghost ml-auto px-3 py-1.5 text-xs">取消选择</button>
        </div>
      )}

      {!loading && visibleDocs.length === 0 && (
        <div className="card px-4 py-10 text-center text-sm text-faint sm:hidden">{search.trim() || tagFilter || collectionFilter ? "没有匹配的资料" : "暂无资料，请先上传第一份资料或粘贴文本"}</div>
      )}

      {/* Mobile: card list instead of a horizontally scrolling table */}
      {visibleDocs.length > 0 && (
        <div className="space-y-2 sm:hidden">
          {visibleDocs.map((doc) => (
            <div key={doc.id} className="card p-3">
              <div className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={selectedIds.has(doc.id)} onChange={() => toggleSelect(doc.id)} />
                <button onClick={() => void loadViewer(doc)} className="min-w-0 flex-1 text-left">
                  <p className="whitespace-normal text-sm font-medium leading-5 text-ink [overflow-wrap:anywhere]">{doc.number ? <span className="mr-1.5 text-xs font-normal text-faint">{doc.number}.</span> : null}{doc.name}</p>
                </button>
                <StatusBadge status={doc.status} />
              </div>
              {doc.errorMessage && <p className="mt-1 truncate text-xs text-danger" title={doc.errorMessage}>{doc.errorMessage}</p>}
              {doc.warningMessage && <p className="mt-1 truncate text-xs text-warn" title={doc.warningMessage}>{doc.warningMessage}</p>}
              {doc.jobStatus === "failed" && doc.jobError && <p className="mt-1 truncate text-xs text-danger" title={doc.jobError}>索引失败：{doc.jobError}</p>}
              {(doc.tags ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(doc.tags ?? []).map((tag) => (<span key={tag.id} className="pill bg-brand-soft text-brand-dark">{tag.name}</span>))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                <button onClick={() => void loadViewer(doc)} className="btn btn-outline px-2.5 py-1.5 text-xs">详情</button>
                <button onClick={() => void renameDocument(doc)} className="btn btn-outline px-2.5 py-1.5 text-xs">重命名</button>
                <button onClick={() => askAbout([doc.id])} className="btn btn-outline px-2.5 py-1.5 text-xs">提问</button>
                <button onClick={() => openTagModal({ mode: "doc", docId: doc.id, initial: (doc.tags ?? []).map((tag) => tag.id) })} className="btn btn-outline px-2.5 py-1.5 text-xs">标签</button>
                {collectionFilter && !collections.find((item) => item.id === collectionFilter)?.isSmart && <button onClick={() => void removeDocFromProject(doc.id)} className="btn btn-outline px-2.5 py-1.5 text-xs">移出项目</button>}
                <a href={documentFileUrl(doc.id, true)} className="btn btn-outline px-2.5 py-1.5 text-xs">下载</a>
                {doc.status === "failed" && <button onClick={() => void handleRetry(doc.id)} className="btn btn-outline px-2.5 py-1.5 text-xs">重试</button>}
                <button onClick={() => void handleDelete(doc.id)} className="btn btn-outline ml-auto px-2.5 py-1.5 text-xs text-danger">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card hidden overflow-hidden sm:block">
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="border-b border-line text-xs text-faint">
              <tr>
                <th className="w-10 px-3 py-3"><input type="checkbox" checked={allSelected} onChange={toggleSelectAll} /></th>
                <th className="w-[46%] px-3 py-3 font-medium">文件名</th>
                <th className="w-36 px-3 py-3 font-medium">标签</th>
                <th className="w-28 px-3 py-3 font-medium">状态</th>
                <th className="w-56 px-3 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading && <tr><td colSpan={5} className="px-4 py-10 text-center text-faint">正在加载资料…</td></tr>}
              {!loading && visibleDocs.map((doc) => (
                <tr key={doc.id} className="hover:bg-paper/70">
                  <td className="px-3 py-3"><input type="checkbox" checked={selectedIds.has(doc.id)} onChange={() => toggleSelect(doc.id)} /></td>
                  <td className="px-3 py-3 align-top font-medium text-ink">
                    <div className="flex items-start gap-2">
                      <FileText className="h-4 w-4 flex-none text-faint" />
                      {doc.number && <span className="flex-none text-xs font-normal text-faint">{doc.number}.</span>}
                      <span className="min-w-0 whitespace-normal leading-5 [overflow-wrap:anywhere]">{doc.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(doc.tags ?? []).map((tag) => (
                        <button key={tag.id} onClick={() => setTagFilter(tag.id)} className="pill bg-brand-soft text-brand-dark hover:underline">{tag.name}</button>
                      ))}
                      {(doc.tags ?? []).length === 0 && <span className="text-xs text-faint">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <StatusBadge status={doc.status} />
                    {doc.errorMessage && <p className="mt-1 max-w-44 truncate text-xs text-danger" title={doc.errorMessage}>{doc.errorMessage}</p>}
                    {doc.warningMessage && <p className="mt-1 max-w-44 truncate text-xs text-warn" title={doc.warningMessage}>{doc.warningMessage}</p>}
                    {doc.jobStatus === "failed" && doc.jobError && <p className="mt-1 max-w-44 truncate text-xs text-danger" title={doc.jobError}>索引失败：{doc.jobError}</p>}
                  </td>
                  <td className="px-2 py-3 align-top">
                    <div className="flex flex-wrap justify-end gap-0.5">
                      <button onClick={() => void loadViewer(doc)} className="btn btn-ghost px-2 py-1.5 text-xs"><FileSearch className="h-4 w-4" />详情</button>
                      <button onClick={() => void renameDocument(doc)} className="btn btn-ghost px-2 py-1.5" title="重命名资料"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => openTagModal({ mode: "doc", docId: doc.id, initial: (doc.tags ?? []).map((tag) => tag.id) })} className="btn btn-ghost px-2 py-1.5" title="设置标签"><TagIcon className="h-4 w-4" /></button>
                      {collectionFilter && !collections.find((item) => item.id === collectionFilter)?.isSmart && <button onClick={() => void removeDocFromProject(doc.id)} className="btn btn-ghost px-2 py-1.5" title="移出项目"><X className="h-4 w-4" /></button>}
                      <a href={documentFileUrl(doc.id)} target="_blank" rel="noreferrer" className="btn btn-ghost px-2 py-1.5" title="预览文件"><ExternalLink className="h-4 w-4" /></a>
                      <a href={documentFileUrl(doc.id, true)} className="btn btn-ghost px-2 py-1.5" title="下载文件"><Download className="h-4 w-4" /></a>
                      {doc.status === "failed" && (
                        <button disabled={busyId === doc.id} onClick={() => void handleRetry(doc.id)} className="btn btn-ghost px-2 py-1.5" title="重试解析"><RefreshCw className={`h-4 w-4 ${busyId === doc.id ? "animate-spin" : ""}`} /></button>
                      )}
                      <button disabled={busyId === doc.id} onClick={() => void handleDelete(doc.id)} className="btn btn-ghost px-2 py-1.5 hover:bg-danger-soft hover:text-danger" title="删除资料"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && visibleDocs.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-faint">{search.trim() || tagFilter || collectionFilter ? "没有匹配的资料" : "暂无资料，请先上传文件"}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {importModalOpen && (
        <Modal
          title="导入资料"
          onClose={() => { if (!uploading) void finishImport(false); }}
          footer={
            <div className="flex justify-end gap-2">
              {uploading ? (
                <button disabled className="btn btn-primary"><Loader2 className="h-4 w-4 animate-spin" />正在上传</button>
              ) : importedIds.length ? (
                <>
                  <button onClick={() => void finishImport(false)} className="btn btn-ghost">稍后整理</button>
                  <button onClick={() => void finishImport(true)} className="btn btn-primary">完成导入</button>
                </>
              ) : (
                <>
                  <button onClick={() => void finishImport(false)} className="btn btn-ghost">关闭</button>
                  <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary"><Upload className="h-4 w-4" />选择文件</button>
                </>
              )}
            </div>
          }
        >
          <div
            className="space-y-4"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}
          >
            {importError && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{importError}</p>}
            <button disabled={uploading} onClick={() => fileInputRef.current?.click()} className="flex min-h-20 w-full items-center justify-center gap-2 border border-dashed border-line text-sm text-muted hover:border-brand disabled:cursor-wait">
              <Upload className="h-4 w-4" />{uploadItems.length ? "继续添加文件，或拖放到这里" : "选择文件或拖放到这里"}
              <span className="hidden text-xs text-faint sm:inline">PDF、DOCX、Markdown、HTML、CSV、TXT</span>
            </button>

            {uploadItems.length > 0 && (
              <div className="max-h-48 divide-y divide-line overflow-y-auto border-y border-line">
                {uploadItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 py-2.5">
                    {item.status === "failed" ? <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-danger" /> : item.status === "done" ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-brand" /> : item.status === "processing" ? <Loader2 className="mt-0.5 h-4 w-4 flex-none animate-spin text-brand" /> : <Upload className="mt-0.5 h-4 w-4 flex-none text-muted" />}
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-ink [overflow-wrap:anywhere]">{item.name}</p>
                      {item.status === "uploading" && <div className="mt-1.5 h-1 overflow-hidden bg-line"><div className="h-full bg-brand" style={{ width: `${item.progress}%` }} /></div>}
                      <p className={`mt-0.5 text-xs ${item.status === "failed" ? "text-danger" : "text-faint"}`}>
                        {item.status === "uploading" ? `上传中 ${item.progress}%` : item.status === "processing" ? "已上传，正在解析" : item.status === "done" ? "已解析" : item.errorType === "parse" ? "解析失败" : "上传失败"}
                        {item.error && <span title={item.error}> · {item.error}</span>}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 border-t border-line pt-3">
              <label className="block max-w-sm">
                <span className="mb-1.5 block text-sm font-medium text-ink">加入项目</span>
                <select value={importProjectId} onChange={(event) => setImportProjectId(event.target.value)} className="input">
                  <option value="">暂不加入项目</option>
                  {manualCollections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
                </select>
              </label>
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-ink">添加标签</legend>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {tags.map((tag) => (
                      <label key={tag.id} className="flex items-center gap-1.5 text-sm text-muted">
                        <input type="checkbox" checked={importTagIds.includes(tag.id)} onChange={() => setImportTagIds((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])} />
                        {tag.name}
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex max-w-sm gap-2">
                  <input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addTagDuringImport(); } }} placeholder="新建标签" className="input py-1.5 text-xs" />
                  <button onClick={() => void addTagDuringImport()} disabled={!newTagName.trim()} className="btn btn-ghost flex-none px-2 py-1 text-xs"><Plus className="h-3.5 w-3.5" />标签</button>
                </div>
              </fieldset>
              {importedIds.length > 0 && <p className="text-xs text-faint">解析在后台继续进行。</p>}
            </div>

            <input ref={fileInputRef} type="file" multiple disabled={uploading} className="hidden" accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv" onChange={(event) => void handleFiles(event.target.files)} />
          </div>
        </Modal>
      )}

      {tagModal && (
        <Modal
          title={tagModal.mode === "manage" ? "管理标签" : tagModal.mode === "batch" ? "为所选资料添加标签" : "设置标签"}
          onClose={() => setTagModal(null)}
          footer={tagModal.mode === "manage" ? undefined : (
            <div className="flex justify-end gap-2">
              <button onClick={() => setTagModal(null)} className="btn btn-ghost">取消</button>
              <button onClick={() => void applyTags()} className="btn btn-primary">确定</button>
            </div>
          )}
        >
          {tagModal.mode === "manage" ? (
            <>
              <ul className="space-y-2">
                {tags.map((tag) => (
                  <li key={tag.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                    <span className="truncate text-sm text-ink">{tag.name}{typeof tag.count === "number" && <span className="ml-1 text-xs text-faint">· {tag.count} 篇</span>}</span>
                    <div className="flex flex-none gap-1">
                      <button onClick={() => void promptRenameTag(tag)} className="btn btn-ghost px-2 py-1.5" title="重命名"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => void removeTag(tag)} className="btn btn-ghost px-2 py-1.5 hover:bg-danger-soft hover:text-danger" title="删除"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </li>
                ))}
                {!tags.length && <li className="py-2 text-sm text-faint">还没有标签</li>}
              </ul>
              <div className="mt-4 flex items-center gap-2">
                <input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addTagInModal(); }} placeholder="新标签名称" className="input" />
                <button onClick={() => void addTagInModal()} disabled={!newTagName.trim()} className="btn btn-primary flex-none"><Plus className="h-4 w-4" />添加</button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                {tags.map((tag) => {
                  const checked = assignTagIds.includes(tag.id);
                  return (
                    <label key={tag.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-paper">
                      <input type="checkbox" checked={checked} onChange={() => setAssignTagIds((prev) => (checked ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))} />
                      <span className="text-sm text-ink">{tag.name}</span>
                    </label>
                  );
                })}
                {!tags.length && <p className="text-sm text-faint">还没有标签，先在下方创建</p>}
              </div>
              <div className="mt-4 flex items-center gap-2">
                <input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addTagInModal(); }} placeholder="新建标签并选中" className="input" />
                <button onClick={() => void addTagInModal()} disabled={!newTagName.trim()} className="btn btn-outline flex-none"><Plus className="h-4 w-4" />新建</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {viewerDoc && (
        <Modal title={`${viewerDoc.name}`} onClose={() => setViewerDoc(null)}>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex gap-2">
              {([["content", "解析内容"], ["summary", "AI 摘要"], ["notes", `笔记${viewerNotes?.length ? ` · ${viewerNotes.length}` : ""}`], ["related", "相关文档"]] as const).map(([key, label]) => (
                <button key={key} className="tab" data-active={viewerTab === key} onClick={() => setViewerTab(key)}>{label}</button>
              ))}
            </div>
            <button onClick={() => askAbout([viewerDoc.id])} className="btn btn-outline ml-auto px-3 py-1.5 text-xs"><MessageCircleQuestion className="h-3.5 w-3.5" />就此文档提问</button>
            <button onClick={() => setVersionModalOpen(true)} className="btn btn-outline px-3 py-1.5 text-xs"><Upload className="h-3.5 w-3.5" />版本</button>
          </div>

          {viewerLoading ? (
            <p className="text-sm text-faint">正在加载…</p>
          ) : viewerTab === "summary" ? (
            <div className="space-y-4">
              {summaryLoading ? (
                <p className="text-sm text-faint">正在读取摘要状态…</p>
              ) : !viewerSummary || viewerSummary.status === "none" ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  {viewerSummary?.generationStatus === "pending" || viewerSummary?.generationStatus === "running" ? (
                    <p className="flex items-center gap-2 text-sm text-faint"><Loader2 className="h-4 w-4 animate-spin" />摘要正在后台生成，稍后刷新即可查看。</p>
                  ) : (
                    <><p className="text-sm text-faint">这份资料还没有生成摘要。</p><button onClick={() => void generateSummary()} disabled={summaryLoading} className="btn btn-primary py-2.5">{summaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}生成摘要</button></>
                  )}
                </div>
              ) : (
                <>
                  {viewerSummary.status === "stale" && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
                      <span>文档内容已更新，摘要可能过期。</span>
                      <button onClick={() => void generateSummary()} disabled={summaryLoading} className="btn btn-outline flex-none px-3 py-1 text-xs">重新生成</button>
                    </div>
                  )}
                  <div className="rounded-lg bg-paper p-4">
                    <Markdown>{viewerSummary.summary}</Markdown>
                  </div>
                  {viewerSummary.keyPoints.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-sm font-semibold text-ink">核心要点</h4>
                      <div className="flex flex-wrap gap-2">
                        {viewerSummary.keyPoints.map((point, index) => (
                          <span key={`${index}-${point}`} className="pill bg-brand-soft text-brand-dark">{point}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {viewerSummary.outline.length > 0 && (
                    <div>
                      <h4 className="mb-2 text-sm font-semibold text-ink">内容结构</h4>
                      <ol className="space-y-1.5 text-sm text-muted">
                        {viewerSummary.outline.map((item, index) => (
                          <li key={`${index}-${item}`} className="rounded-lg bg-paper px-4 py-2">{item}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button onClick={() => void generateSummary()} disabled={summaryLoading} className="btn btn-ghost px-3 py-1.5 text-xs"><RefreshCw className="h-3.5 w-3.5" />重新生成</button>
                  </div>
                </>
              )}
            </div>
          ) : viewerTab === "content" ? (
            !viewerChunks?.length ? <p className="text-sm text-faint">暂无解析内容。</p> : (
              <div className="space-y-3">
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-card pb-2">
                  <input value={viewerQuery} onChange={(event) => setViewerQuery(event.target.value)} placeholder="在解析内容中搜索…" className="input py-1.5 text-xs" />
                  {viewerQuery && <span className="flex-none text-xs text-faint">匹配 {viewerChunks.filter((chunk) => chunk.content.toLowerCase().includes(viewerQuery.toLowerCase())).length} 个分块</span>}
                </div>
                {viewerChunks.filter((chunk) => !viewerQuery.trim() || chunk.content.toLowerCase().includes(viewerQuery.trim().toLowerCase())).map((chunk) => (
                  <div key={chunk.id} id={`chunk-${chunk.id}`} className="rounded-lg border border-line bg-paper/60 p-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-faint">
                      <span>分块 {chunk.chunkNo}</span>
                      {chunk.pageNo && <span>· 第 {chunk.pageNo} 页</span>}
                      {chunk.sectionTitle && <span className="truncate">· {chunk.sectionTitle}</span>}
                      <button onClick={() => { setNoteChunkId(chunk.id); setNoteQuote(chunk.content.slice(0, 300)); setViewerTab("notes"); }} className="btn btn-ghost ml-auto px-2 py-1 text-xs"><NotebookPen className="h-3.5 w-3.5" />记笔记</button>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{chunk.content}</p>
                  </div>
                ))}
                {viewerQuery.trim() && !viewerChunks.some((chunk) => chunk.content.toLowerCase().includes(viewerQuery.trim().toLowerCase())) && <p className="py-6 text-center text-sm text-faint">没有匹配的解析内容。</p>}
              </div>
            )
          ) : viewerTab === "notes" ? (
            <div>
              <div className="mb-4 rounded-lg border border-line p-3">
                {noteQuote && (
                  <div className="mb-2 flex items-start gap-2 rounded bg-brand-soft px-2 py-1.5 text-xs text-brand-dark">
                    <span className="min-w-0 flex-1 border-l-2 border-brand/40 pl-2">{noteQuote}</span>
                    <button onClick={() => { setNoteQuote(""); setNoteChunkId(undefined); }} className="btn btn-ghost flex-none px-1 py-0.5"><X className="h-3 w-3" /></button>
                  </div>
                )}
                <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} rows={3} placeholder="写下你的笔记、理解或考点…" className="input resize-none" />
                <div className="mt-2 flex justify-end">
                  <button onClick={() => void saveNote()} disabled={!noteContent.trim()} className="btn btn-primary px-3 py-1.5 text-xs">保存笔记</button>
                </div>
              </div>
              <div className="space-y-2">
                {(viewerNotes ?? []).map((note) => (
                  <div key={note.id} className="rounded-lg border border-line p-3">
                    {note.quote && <p className="mb-1.5 border-l-2 border-brand/40 pl-2 text-xs text-faint">{note.quote}</p>}
                    <p className="whitespace-pre-wrap text-sm text-ink">{note.content}</p>
                    <div className="mt-2 flex items-center justify-between text-xs text-faint">
                      <span>{note.updatedAt}</span>
                      <span className="flex gap-1">
                        <button onClick={() => void editNote(note)} className="btn btn-ghost px-1.5 py-1" title="编辑"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => void removeNote(note)} className="btn btn-ghost px-1.5 py-1 hover:bg-danger-soft hover:text-danger" title="删除"><Trash2 className="h-3.5 w-3.5" /></button>
                      </span>
                    </div>
                  </div>
                ))}
                {!(viewerNotes ?? []).length && <p className="text-sm text-faint">还没有笔记。可在“解析内容”里选中分块记笔记。</p>}
              </div>
            </div>
          ) : (
            !viewerRelated?.length ? <p className="text-sm text-faint">暂无相关文档。</p> : (
              <div className="space-y-2">
                {viewerRelated.map((item) => (
                  <button key={item.id} onClick={() => void loadViewer(item)} className="flex w-full items-start gap-2 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-brand">
                    <Link2 className="mt-0.5 h-3.5 w-3.5 flex-none text-brand" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{item.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-faint">{item.snippet}</p>
                    </div>
                    <span className="flex-none text-xs text-faint">{Math.round(item.score * 100)}%</span>
                  </button>
                ))}
              </div>
            )
          )}
        </Modal>
      )}

      {projectCreateOpen && (
        <Modal
          title="新建项目"
          onClose={() => setProjectCreateOpen(false)}
          footer={<div className="flex justify-end gap-2"><button onClick={() => setProjectCreateOpen(false)} className="btn btn-ghost">取消</button><button onClick={() => void createProject()} disabled={!projectCreateName.trim() || (projectCreateType === "smart" && !projectCreateQuery.trim() && !projectCreateTag && projectCreateDocType === "全部" && projectCreateStatus === "全部")} className="btn btn-primary">创建项目</button></div>}
        >
          <div className="space-y-4">
            <label className="block"><span className="mb-1.5 block text-sm font-medium text-ink">项目名称</span><input value={projectCreateName} onChange={(event) => setProjectCreateName(event.target.value)} placeholder="例如：机器学习课程" className="input" autoFocus /></label>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-ink">项目类型</span>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setProjectCreateType("manual")} className={`rounded-lg border px-3 py-2 text-left text-sm ${projectCreateType === "manual" ? "border-brand bg-brand-soft text-brand-dark" : "border-line text-muted"}`}><span className="block font-medium">手动项目</span><span className="mt-0.5 block text-xs opacity-75">自己选择资料加入</span></button>
                <button onClick={() => setProjectCreateType("smart")} className={`rounded-lg border px-3 py-2 text-left text-sm ${projectCreateType === "smart" ? "border-brand bg-brand-soft text-brand-dark" : "border-line text-muted"}`}><span className="block font-medium">智能项目</span><span className="mt-0.5 block text-xs opacity-75">按条件自动匹配资料</span></button>
              </div>
            </div>
            {projectCreateType === "smart" && (
              <div className="space-y-3 rounded-xl bg-paper p-3">
                <label className="block"><span className="mb-1 block text-xs font-medium text-muted">关键词（可选）</span><input value={projectCreateQuery} onChange={(event) => setProjectCreateQuery(event.target.value)} placeholder="文件名或内容包含…" className="input" /></label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block"><span className="mb-1 block text-xs font-medium text-muted">标签</span><select value={projectCreateTag} onChange={(event) => setProjectCreateTag(event.target.value)} className="input"><option value="">全部标签</option>{tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
                  <label className="block"><span className="mb-1 block text-xs font-medium text-muted">类型</span><select value={projectCreateDocType} onChange={(event) => setProjectCreateDocType(event.target.value)} className="input">{["全部", "PDF", "Word", "Markdown", "HTML", "CSV", "TXT"].map((type) => <option key={type}>{type}</option>)}</select></label>
                </div>
                <label className="block"><span className="mb-1 block text-xs font-medium text-muted">解析状态</span><select value={projectCreateStatus} onChange={(event) => setProjectCreateStatus(event.target.value)} className="input"><option value="全部">全部状态</option><option value="parsed">已解析</option><option value="parsing">处理中</option><option value="failed">失败</option></select></label>
                {!projectCreateQuery.trim() && !projectCreateTag && projectCreateDocType === "全部" && projectCreateStatus === "全部" && <p className="text-xs text-warn">至少设置一个条件，智能项目才会有明确范围。</p>}
              </div>
            )}
          </div>
        </Modal>
      )}

      {collectionModal === "assign" && (
        <Modal
          title={`把 ${selectedIds.size} 篇资料加入项目`}
          onClose={() => setCollectionModal(null)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setCollectionModal(null)} className="btn btn-ghost">取消</button>
              <button onClick={() => void applyCollectionAssignment()} disabled={!assignCollectionId} className="btn btn-primary">加入</button>
            </div>
          }
        >
          {!manualCollections.length ? (
            <p className="text-sm text-faint">还没有手动项目。</p>
          ) : (
            <div className="space-y-1.5">
              {manualCollections.map((collection) => (
                <label key={collection.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-paper">
                  <input type="radio" name="assign-collection" checked={assignCollectionId === collection.id} onChange={() => setAssignCollectionId(collection.id)} />
                  <span className="text-sm text-ink">{collection.name}</span>
                </label>
              ))}
            </div>
          )}
        </Modal>
      )}

      {textModalOpen && (
        <Modal
          title="粘贴文本创建资料"
          onClose={() => setTextModalOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setTextModalOpen(false)} className="btn btn-ghost">取消</button>
              <button onClick={() => void savePastedText()} disabled={textSaving || !textTitle.trim() || !textContent.trim()} className="btn btn-primary">
                {textSaving && <Loader2 className="h-4 w-4 animate-spin" />}创建资料
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">标题</span>
              <input value={textTitle} onChange={(event) => setTextTitle(event.target.value)} placeholder="例如：机器学习复习笔记" className="input" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">内容</span>
              <textarea value={textContent} onChange={(event) => setTextContent(event.target.value)} rows={10} placeholder="粘贴要保存为资料的文本…" className="input resize-y font-mono text-xs" />
            </label>
          </div>
        </Modal>
      )}

      {urlModalOpen && (
        <Modal
          title="导入网页"
          onClose={() => setUrlModalOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <button onClick={() => setUrlModalOpen(false)} className="btn btn-ghost">取消</button>
              <button onClick={() => void saveUrlDocument()} disabled={urlSaving || !urlValue.trim()} className="btn btn-primary">
                {urlSaving && <Loader2 className="h-4 w-4 animate-spin" />}导入网页
              </button>
            </div>
          }
        >
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">网页地址</span>
              <input value={urlValue} onChange={(event) => setUrlValue(event.target.value)} placeholder="https://example.com/article" className="input" type="url" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">标题（可选）</span>
              <input value={urlTitle} onChange={(event) => setUrlTitle(event.target.value)} placeholder="留空则使用网页标题" className="input" />
            </label>
            <p className="text-xs leading-5 text-faint">系统会提取网页正文并保留来源地址。仅支持公开的 HTTP/HTTPS 页面，单页最大 2 MB。</p>
          </div>
        </Modal>
      )}

      {versionModalOpen && viewerDoc && (
        <Modal
          title={`版本管理 · ${viewerDoc.name}`}
          onClose={() => { if (!versionSaving) setVersionModalOpen(false); }}
          footer={
            <div className="flex items-center justify-between gap-2">
              <label className="btn btn-outline cursor-pointer px-3 py-1.5 text-xs">
                <Upload className="h-3.5 w-3.5" />选择新版本
                <input type="file" className="hidden" accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv" onChange={(event) => setVersionFile(event.target.files?.[0] ?? null)} />
              </label>
              <button onClick={() => void uploadNewVersion()} disabled={versionSaving || !versionFile} className="btn btn-primary px-3 py-1.5 text-xs">{versionSaving ? "处理中…" : "上传并解析"}</button>
            </div>
          }
        >
          <p className="mb-3 text-xs text-faint">上传新文件会保留当前版本。恢复旧版本时，当前内容也会先保存为新版本。</p>
          {versionFile && <p className="mb-3 rounded-lg bg-brand-soft px-3 py-2 text-xs text-brand-dark">待上传：{versionFile.name}</p>}
          {!viewerVersions.length ? <p className="text-sm text-faint">还没有历史版本。</p> : (
            <div className="space-y-2">
              {viewerVersions.map((version) => (
                <div key={version.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium text-ink">版本 {version.versionNo} · {version.name}</p><p className="mt-0.5 text-xs text-faint">{version.createdAt} · {version.sizeKB} KB</p></div>
                  <button onClick={() => void restoreVersion(version)} disabled={versionSaving} className="btn btn-ghost px-2 py-1 text-xs">恢复</button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
