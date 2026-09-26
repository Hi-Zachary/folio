import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, Util, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { documentFileUrl } from "../api";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

function normalize(value: string) { return value.toLowerCase().replace(/\s+/g, ""); }
type PdfTextItem = { str: string; transform: number[]; width: number };

function highlightPage(context: CanvasRenderingContext2D, viewport: any, items: PdfTextItem[], targetText: string, scale: number) {
  const target = normalize(targetText).slice(0, 180);
  if (!target || !items.length) return false;
  let combined = "";
  const ranges: Array<{ item: PdfTextItem; start: number; end: number }> = [];
  for (const item of items) {
    const value = normalize(item.str);
    const start = combined.length;
    combined += value;
    ranges.push({ item, start, end: combined.length });
  }
  let matchStart = combined.indexOf(target);
  let matchEnd = matchStart < 0 ? -1 : matchStart + target.length;
  if (matchStart < 0) {
    const token = target.slice(0, Math.min(28, target.length));
    matchStart = token ? combined.indexOf(token) : -1;
    matchEnd = matchStart < 0 ? -1 : matchStart + token.length;
  }
  if (matchStart < 0) return false;
  context.save();
  context.fillStyle = "rgba(250, 204, 21, .62)";
  for (const range of ranges) {
    if (range.end <= matchStart || range.start >= matchEnd) continue;
    const tx = Util.transform(viewport.transform, range.item.transform);
    const fontHeight = Math.max(8, Math.sqrt(tx[2] ** 2 + tx[3] ** 2));
    const width = Math.max(2, Number(range.item.width || 0) * scale);
    context.fillRect(tx[4] - 1, tx[5] - fontHeight - 1, width + 2, fontHeight * 1.35);
  }
  context.restore();
  return true;
}

export default function PdfSourceViewer({ documentId, pageNo, targetText }: { documentId: string; pageNo: number | null; targetText: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pdf: PDFDocumentProxy | null = null;
    async function renderDocument() {
      try {
        setError(null); setHighlighted(false);
        pdf = await getDocument({ url: documentFileUrl(documentId), withCredentials: true }).promise;
        if (cancelled || !containerRef.current) return;
        const container = containerRef.current;
        container.replaceChildren();
        setProgress({ done: 0, total: pdf.numPages });
        const maxWidth = Math.min(1080, Math.max(640, window.innerWidth - 140));
        for (let number = 1; number <= pdf.numPages; number += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(number);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.65, maxWidth / base.width);
          const viewport = page.getViewport({ scale });
          const wrapper = document.createElement("div");
          wrapper.className = "mx-auto mb-4 w-fit bg-white shadow-sm";
          wrapper.dataset.page = String(number);
          const label = document.createElement("div");
          label.className = "border-b border-line px-3 py-1 text-xs text-faint";
          label.textContent = `第 ${number} 页`;
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) continue;
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          wrapper.append(label, canvas); container.appendChild(wrapper);
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          if (number === (pageNo ?? 1)) {
            const text = await page.getTextContent();
            const items = text.items.filter((item: any) => typeof item.str === "string" && Array.isArray(item.transform) && typeof item.width === "number") as PdfTextItem[];
            setHighlighted(highlightPage(context, viewport, items, targetText, scale));
            wrapper.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          setProgress({ done: number, total: pdf.numPages });
        }
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法渲染 PDF 原文"); }
    }
    void renderDocument();
    return () => { cancelled = true; pdf = null; };
  }, [documentId, pageNo, targetText]);

  if (error) return <p className="text-sm text-danger">{error}。可以点击下方“打开原文件”。</p>;
  return (
    <div className="relative h-full overflow-auto rounded-lg border border-line bg-stone-100 p-3">
      {progress.total > 0 && progress.done < progress.total && <p className="sticky top-0 z-10 mb-2 rounded bg-card/90 px-2 py-1 text-xs text-faint">正在加载页面 {progress.done}/{progress.total}…</p>}
      {progress.done > 0 && !highlighted && <p className="sticky top-0 z-10 mb-2 rounded bg-warn-soft px-2 py-1 text-xs text-warn">目标页没有匹配到可高亮的文字层，可能是扫描 PDF 或文本提取顺序不同。</p>}
      <div ref={containerRef} />
    </div>
  );
}
