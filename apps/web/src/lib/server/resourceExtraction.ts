import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export type ResourceExtractionFileInput = {
  name: string;
  originalUrl?: string;
  size?: number;
  text?: string;
  type?: string;
  url?: string;
};

export type ResourceExtractionMethod =
  | "provided_text"
  | "pdf_text"
  | "pdf_ocr"
  | "image_ocr"
  | "plain_text"
  | "office_text"
  | "spreadsheet_text"
  | "unsupported"
  | "unavailable";

export type ResourceFileExtraction = {
  confidence?: number;
  method: ResourceExtractionMethod;
  name: string;
  pageCount?: number;
  text: string;
};

export type ResourceExtractionResult = {
  files: ResourceFileExtraction[];
  text: string;
  textLength: number;
  usedOcr: boolean;
};

type ResourceExtractionGlobal = typeof globalThis & {
  familyResourceOcrQueue?: Promise<void>;
};

const globalForResourceExtraction = globalThis as ResourceExtractionGlobal;
const maxDocumentExtractionBytes = 20 * 1024 * 1024;
const maxOcrPdfPages = 4;
const minimumUsefulPdfTextLength = 40;
const maximumExtractedCharacters = 60_000;
const ocrRequestTimeoutMs = 90_000;

export async function extractResourceFiles(
  files: ResourceExtractionFileInput[],
  options: { dataDir?: string } = {}
): Promise<ResourceExtractionResult> {
  const dataDir = options.dataDir || "data";
  const extracted = await Promise.all(files.map((file) => extractResourceFile(file, dataDir)));
  const text = extracted
    .map((file) => file.text)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maximumExtractedCharacters);
  return {
    files: extracted,
    text,
    textLength: text.length,
    usedOcr: extracted.some((file) => file.method === "image_ocr" || file.method === "pdf_ocr")
  };
}

async function extractResourceFile(file: ResourceExtractionFileInput, dataDir: string): Promise<ResourceFileExtraction> {
  if (file.text?.trim()) {
    return extraction(file.name, "provided_text", normalizeExtractedText(file.text));
  }
  if (file.size && file.size > maxDocumentExtractionBytes) {
    return extraction(file.name, "unavailable", "");
  }
  if (!isSupportedFile(file)) {
    return extraction(file.name, "unsupported", "");
  }

  const buffer = await readUploadedFileBuffer(file, dataDir);
  if (!buffer || buffer.length > maxDocumentExtractionBytes) {
    return extraction(file.name, "unavailable", "");
  }

  if (isPdfFile(file)) return extractPdf(buffer, file.name, dataDir);
  if (isImageFile(file)) return extractImage(buffer, file.name, dataDir);
  if (isTextLikeFile(file)) return extraction(file.name, "plain_text", normalizeExtractedText(buffer.toString("utf8")));
  if (isWordDocumentFile(file)) return extraction(file.name, "office_text", await extractOfficeText(buffer));
  if (isExcelDocumentFile(file)) return extraction(file.name, "spreadsheet_text", await extractExcelText(buffer));
  return extraction(file.name, "unsupported", "");
}

async function extractPdf(buffer: Buffer, name: string, dataDir: string): Promise<ResourceFileExtraction> {
  try {
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(pathToFileURL(path.resolve(
      process.cwd(),
      "node_modules/pdf-parse/dist/pdf-parse/esm/pdf.worker.mjs"
    )).href);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pdfText = normalizeExtractedText(result.text || "");
      if (pdfText.length >= minimumUsefulPdfTextLength) {
        return { ...extraction(name, "pdf_text", pdfText), pageCount: result.total || undefined };
      }
      const screenshot = await parser.getScreenshot({
        desiredWidth: 1800,
        first: Math.min(Math.max(result.total, 1), maxOcrPdfPages),
        imageBuffer: true,
        imageDataUrl: false
      });
      const ocrResults: Array<{ confidence: number; text: string }> = [];
      for (const page of screenshot.pages) {
        if (!page.data?.length) continue;
        ocrResults.push(await recognizeImageText(Buffer.from(page.data)));
      }
      const ocrText = normalizeExtractedText(ocrResults.map((item) => item.text).filter(Boolean).join("\n\n"));
      const text = richerText(pdfText, ocrText);
      return {
        ...extraction(name, ocrText ? "pdf_ocr" : "pdf_text", text),
        confidence: averageConfidence(ocrResults),
        pageCount: result.total
      };
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    console.warn("Family resource PDF extraction failed", {
      file: name,
      message: error instanceof Error ? error.message : "unknown error"
    });
    return extraction(name, "unavailable", "");
  }
}

async function extractImage(buffer: Buffer, name: string, dataDir: string): Promise<ResourceFileExtraction> {
  try {
    const prepared = await prepareImageForOcr(buffer);
    const result = await recognizeImageText(prepared);
    return {
      ...extraction(name, "image_ocr", normalizeExtractedText(result.text)),
      confidence: result.confidence
    };
  } catch {
    return extraction(name, "unavailable", "");
  }
}

async function prepareImageForOcr(buffer: Buffer) {
  const image = sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: "#ffffff" });
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const targetWidth = Math.min(2200, Math.max(1600, width));
  return image
    .grayscale()
    .normalize()
    .sharpen({ sigma: 0.8 })
    .resize({ width: targetWidth, withoutEnlargement: width >= 1600 })
    .png({ compressionLevel: 7 })
    .toBuffer();
}

async function recognizeImageText(image: Buffer) {
  const previous = globalForResourceExtraction.familyResourceOcrQueue || Promise.resolve();
  let resolveQueue: () => void = () => undefined;
  const queued = new Promise<void>((resolve) => { resolveQueue = resolve; });
  globalForResourceExtraction.familyResourceOcrQueue = previous.catch(() => undefined).then(() => queued);
  await previous.catch(() => undefined);
  try {
    const endpoint = resolveOcrEndpoint();
    if (!endpoint) throw new Error("OCR optional component is disabled.");
    const response = await fetch(endpoint, {
      body: new Uint8Array(image).buffer,
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      signal: AbortSignal.timeout(ocrRequestTimeoutMs)
    });
    if (!response.ok) throw new Error(`OCR component returned HTTP ${response.status}.`);
    const result = await response.json() as { confidence?: unknown; text?: unknown };
    return {
      confidence: clampConfidence(result.confidence),
      text: typeof result.text === "string" ? result.text : ""
    };
  } finally {
    resolveQueue();
  }
}

function resolveOcrEndpoint() {
  const configured = process.env.FAMILY_OCR_ENDPOINT?.trim();
  if (!configured) return "";
  try {
    const endpoint = new URL(configured);
    if (!endpoint.pathname || endpoint.pathname === "/") endpoint.pathname = "/recognize";
    return endpoint;
  } catch {
    return "";
  }
}

async function readUploadedFileBuffer(file: ResourceExtractionFileInput, dataDir: string) {
  const fileUrl = file.originalUrl || file.url || "";
  if (!fileUrl) return null;
  try {
    const url = new URL(fileUrl, "http://family.local");
    if (url.pathname !== "/api/guest-uploads") return null;
    const tusId = sanitizeSegment(url.searchParams.get("tus") || "");
    if (tusId) return await readFile(path.join(dataDir, "tus-uploads", tusId));
    const relativeFile = sanitizeRelativePath(url.searchParams.get("file") || "");
    if (relativeFile) return await readFile(path.join(dataDir, "guest-uploads", relativeFile));
  } catch {
    return null;
  }
  return null;
}

async function extractOfficeText(buffer: Buffer) {
  try {
    const { parseOffice } = await import("officeparser");
    const document = await parseOffice(buffer);
    return normalizeExtractedText(document.toText());
  } catch {
    return "";
  }
}

async function extractExcelText(buffer: Buffer) {
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    return normalizeExtractedText(workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return sheet ? `${sheetName}\n${XLSX.utils.sheet_to_csv(sheet)}` : "";
    }).filter(Boolean).join("\n\n"));
  } catch {
    return "";
  }
}

function extraction(name: string, method: ResourceExtractionMethod, text: string): ResourceFileExtraction {
  return { method, name, text: text.slice(0, maximumExtractedCharacters) };
}

function richerText(first: string, second: string) {
  if (!first) return second;
  if (!second) return first;
  return second.length > first.length * 1.15 ? second : first;
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, maximumExtractedCharacters);
}

function averageConfidence(items: Array<{ confidence: number }>) {
  if (!items.length) return undefined;
  return Math.round(items.reduce((total, item) => total + item.confidence, 0) / items.length);
}

function clampConfidence(value: unknown) {
  const confidence = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function isSupportedFile(file: ResourceExtractionFileInput) {
  return isPdfFile(file) || isImageFile(file) || isTextLikeFile(file) || isWordDocumentFile(file) || isExcelDocumentFile(file);
}

function isPdfFile(file: ResourceExtractionFileInput) {
  return /pdf/i.test(file.type || "") || /\.pdf$/i.test(file.name);
}

function isImageFile(file: ResourceExtractionFileInput) {
  return /^image\//i.test(file.type || "") || /\.(?:avif|heic|heif|jpe?g|png|webp)$/i.test(file.name);
}

function isTextLikeFile(file: ResourceExtractionFileInput) {
  return /^text\//i.test(file.type || "") || /\.(?:txt|md|csv|json)$/i.test(file.name);
}

function isWordDocumentFile(file: ResourceExtractionFileInput) {
  return /\.docx$/i.test(file.name);
}

function isExcelDocumentFile(file: ResourceExtractionFileInput) {
  return /\.xlsx$/i.test(file.name);
}

function sanitizeRelativePath(value: string) {
  const normalized = path.normalize(value).replace(/^(\.\.[/\\])+/, "");
  return normalized.split(path.sep).map(sanitizeFileName).filter(Boolean).join(path.sep);
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "file";
}
