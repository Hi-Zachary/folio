import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface OcrPage {
  pageNo: number;
  text: string;
}

async function hasCommand(command: string) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

// Render the requested PDF pages to PNG files and return them in page order.
async function renderPdfPages(filePath: string, directory: string, dpi: number, maxPages: number) {
  const prefix = path.join(directory, "page");
  await execFileAsync("pdftoppm", [
    "-r", String(dpi),
    "-png",
    "-f", "1",
    "-l", String(maxPages),
    filePath,
    prefix,
  ], { maxBuffer: 1024 * 1024 * 32 });

  const files = (await fs.readdir(directory))
    .filter((file) => file.startsWith("page-") && file.endsWith(".png"))
    .sort((a, b) => Number(a.replace(/\D+/g, "")) - Number(b.replace(/\D+/g, "")));
  return files.map((file) => path.join(directory, file));
}

async function ocrWithTesseract(images: string[]): Promise<OcrPage[]> {
  const pages: OcrPage[] = [];
  for (const [index, image] of images.entries()) {
    const { stdout } = await execFileAsync("tesseract", [image, "stdout", "-l", config.ocr.language], {
      maxBuffer: 1024 * 1024 * 32,
    });
    pages.push({ pageNo: index + 1, text: stdout });
  }
  return pages;
}

interface VisionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

async function ocrWithModel(images: string[]): Promise<OcrPage[]> {
  if (!config.ai.baseUrl || !config.ocr.model) {
    throw new Error("未配置 OCR_MODEL，无法使用模型 OCR");
  }
  const pages: OcrPage[] = [];
  for (const [index, image] of images.entries()) {
    const data = await fs.readFile(image);
    const content: VisionContentPart[] = [
      {
        type: "text",
        text: "请只输出图片中的所有文字内容，保持原始语种和阅读顺序，不要翻译、总结或添加任何解释。",
      },
      { type: "image_url", image_url: { url: `data:image/png;base64,${data.toString("base64")}` } },
    ];
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.ai.baseUrl.includes("openrouter.ai") ? { "HTTP-Referer": config.origin, "X-Title": "Personal Knowledge Base OCR" } : {}),
        ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ocr.model,
        temperature: 0,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    };
    if (!response.ok) throw new Error(`OCR 模型请求失败 (${response.status}): ${JSON.stringify(payload.error ?? payload)}`);
    pages.push({ pageNo: index + 1, text: payload.choices?.[0]?.message?.content ?? "" });
  }
  return pages;
}

export async function ocrAvailable() {
  if (!config.ocr.enabled) return false;
  const provider = config.ocr.provider;
  if (provider === "tesseract") return (await hasCommand("pdftoppm")) && (await hasCommand("tesseract"));
  if (provider === "model") return Boolean(config.ai.baseUrl && config.ocr.model);
  const local = (await hasCommand("pdftoppm")) && (await hasCommand("tesseract"));
  return local || Boolean(config.ai.baseUrl && config.ocr.model);
}

export async function ocrPdf(filePath: string): Promise<{ pages: OcrPage[]; provider: "tesseract" | "model" }> {
  if (!config.ocr.enabled) throw new Error("OCR 未启用");

  const localReady = (await hasCommand("pdftoppm")) && (await hasCommand("tesseract"));
  const modelReady = Boolean(config.ai.baseUrl && config.ocr.model);
  const provider = config.ocr.provider === "auto"
    ? localReady ? "tesseract" : modelReady ? "model" : null
    : config.ocr.provider;

  if (provider === "tesseract" && !localReady) throw new Error("未安装 pdftoppm/tesseract，无法使用本地 OCR");
  if (provider === "model" && !modelReady) throw new Error("未配置 OCR_MODEL，无法使用模型 OCR");
  if (!provider) throw new Error("没有可用的 OCR 方案（安装 tesseract 或配置 OCR_MODEL）");

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kb-ocr-"));
  try {
    const images = await renderPdfPages(filePath, directory, config.ocr.dpi, config.ocr.maxPages);
    if (!images.length) throw new Error("PDF 无法渲染为图片");
    const pages = provider === "tesseract" ? await ocrWithTesseract(images) : await ocrWithModel(images);
    return { pages, provider };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
