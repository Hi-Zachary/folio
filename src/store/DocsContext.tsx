import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Collection, KnowledgeDoc, Tag } from "../types";

interface DocsContextValue {
  docs: KnowledgeDoc[];
  tags: Tag[];
  collections: Collection[];
  loading: boolean;
  error: string | null;
  addDoc: (file: File, onProgress?: (progress: number) => void) => Promise<KnowledgeDoc>;
  removeDoc: (id: string) => Promise<void>;
  retryDoc: (id: string) => Promise<void>;
  createTag: (name: string) => Promise<void>;
  renameTag: (id: string, name: string) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  setDocTags: (id: string, tagIds: string[]) => Promise<void>;
  createCollection: (name: string, documentIds?: string[]) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  addToCollection: (id: string, documentIds: string[]) => Promise<void>;
  removeFromCollection: (id: string, documentId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const DocsContext = createContext<DocsContextValue | null>(null);

export function DocsProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextDocs, nextTags, nextCollections] = await Promise.all([
        api.documents(), api.tags(), api.collections(),
      ]);
      setDocs(nextDocs);
      setTags(nextTags);
      setCollections(nextCollections);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接后端服务");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!docs.some((doc) => doc.status === "pending" || doc.status === "parsing"
      || (doc.jobType === "embedding" && (doc.jobStatus === "pending" || doc.jobStatus === "running")))) return;
    const timer = window.setInterval(() => { void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [docs, refresh]);

  async function addDoc(file: File, onProgress?: (progress: number) => void) {
    setError(null);
    const created = await api.upload(file, onProgress);
    setDocs((prev) => [created, ...prev]);
    return created;
  }

  async function removeDoc(id: string) {
    await api.removeDocument(id);
    setDocs((prev) => prev.filter((doc) => doc.id !== id));
    await refresh();
  }

  async function retryDoc(id: string) {
    const updated = await api.retryDocument(id);
    setDocs((prev) => prev.map((doc) => doc.id === id ? updated : doc));
  }

  async function createTag(name: string) {
    await api.createTag(name);
    await refresh();
  }

  async function renameTag(id: string, name: string) {
    await api.renameTag(id, name);
    await refresh();
  }

  async function deleteTag(id: string) {
    await api.deleteTag(id);
    await refresh();
  }

  async function setDocTags(id: string, tagIds: string[]) {
    await api.setDocumentTags(id, tagIds);
    await refresh();
  }


  async function createCollection(name: string, documentIds?: string[]) {
    await api.createCollection(name, undefined, documentIds);
    await refresh();
  }

  async function renameCollection(id: string, name: string) {
    await api.renameCollection(id, name);
    await refresh();
  }

  async function deleteCollection(id: string) {
    await api.deleteCollection(id);
    await refresh();
  }

  async function addToCollection(id: string, documentIds: string[]) {
    await api.addCollectionDocuments(id, documentIds);
    await refresh();
  }

  async function removeFromCollection(id: string, documentId: string) {
    await api.removeCollectionDocument(id, documentId);
    await refresh();
  }

  return (
    <DocsContext.Provider value={{ docs, tags, collections, loading, error, addDoc, removeDoc, retryDoc, createTag, renameTag, deleteTag, setDocTags, createCollection, renameCollection, deleteCollection, addToCollection, removeFromCollection, refresh }}>
      {children}
    </DocsContext.Provider>
  );
}

export function useDocs() {
  const context = useContext(DocsContext);
  if (!context) throw new Error("useDocs must be used within DocsProvider");
  return context;
}
