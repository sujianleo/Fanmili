"use client";

import Uppy from "@uppy/core";
import Tus from "@uppy/tus";
import { withAppBasePath } from "./appBasePath";
import { familyFetch } from "./familyApi";
import { RESOURCE_UPLOAD_MAX_BYTES } from "./resourceUploadPolicy";

export const TUS_UPLOAD_ENDPOINT = withAppBasePath("/api/tus");
export const TUS_UPLOAD_CONCURRENCY = 2;

export type UploadedFileReference = {
  cacheUrl?: string;
  name: string;
  originalUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  size?: number;
  storage?: string;
  type?: string;
  url?: string;
};

export async function uploadFilesWithTus(
  files: File[],
  options: {
    messageId: string;
    onFileProgress?: (fileIndex: number, progress: number) => void;
    onProgress?: (progress: number) => void;
  }
) {
  if (process.env.NEXT_PUBLIC_FAMILY_APP_BACKEND === "sqlite") {
    return uploadFilesToLiteStorage(files, options);
  }
  const uppy = new Uppy<{ messageId: string; uploadIndex: number }, Record<string, never>>({
    autoProceed: false,
    allowMultipleUploadBatches: false,
    restrictions: {
      allowedFileTypes: [".pdf", ".docx", ".xlsx", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif"],
      maxFileSize: RESOURCE_UPLOAD_MAX_BYTES,
      maxNumberOfFiles: files.length
    }
  }).use(Tus, {
    endpoint: TUS_UPLOAD_ENDPOINT,
    limit: TUS_UPLOAD_CONCURRENCY,
    retryDelays: [0, 1000, 3000, 5000],
    allowedMetaFields: ["name", "type", "messageId", "uploadIndex"]
  });

  try {
    const fileIds = files.map((file, index) =>
      uppy.addFile({
        data: file,
        meta: {
          messageId: options.messageId,
          uploadIndex: index
        },
        name: file.name,
        type: file.type
      })
    );

    uppy.on("progress", (progress) => {
      options.onProgress?.(progress);
    });
    uppy.on("upload-progress", (file, progress) => {
      const fileIndex = typeof file?.meta.uploadIndex === "number" ? file.meta.uploadIndex : -1;
      if (fileIndex < 0) return;
      const percentage = progress.percentage ?? (progress.bytesTotal ? (progress.bytesUploaded / progress.bytesTotal) * 100 : 0);
      options.onFileProgress?.(fileIndex, Math.max(0, Math.min(100, percentage)));
    });

    const result = await uppy.upload();
    const uploadedFiles = new Array<UploadedFileReference>(files.length);

    for (const fileId of fileIds) {
      const uploaded = result?.successful?.find((file) => file.id === fileId);
      if (!uploaded) {
        continue;
      }

      const index = typeof uploaded.meta.uploadIndex === "number" ? uploaded.meta.uploadIndex : fileIds.indexOf(fileId);
      const uploadUrl = uploaded.uploadURL || uploaded.response?.uploadURL;
      const readableUrl = readableTusUrl(uploadUrl);
      uploadedFiles[index] = {
        name: uploaded.name,
        originalUrl: readableUrl || uploadUrl,
        previewUrl: uploaded.type.startsWith("image/") ? readableUrl || uploadUrl : undefined,
        size: uploaded.size || undefined,
        storage: "tus",
        type: uploaded.type,
        url: readableUrl || uploadUrl
      };
    }

    return await addServerPreviews(uploadedFiles);
  } finally {
    uppy.destroy();
  }
}

async function uploadFilesToLiteStorage(
  files: File[],
  options: {
    messageId: string;
    onFileProgress?: (fileIndex: number, progress: number) => void;
    onProgress?: (progress: number) => void;
  }
) {
  const formData = new FormData();
  formData.set("recordId", "family-lite");
  formData.set("messageId", options.messageId);
  files.forEach((file) => formData.append("files", file, file.name));
  const response = await familyFetch("/api/guest-uploads", {
    body: formData,
    credentials: "include",
    method: "POST"
  });
  const payload = await response.json().catch(() => ({})) as { detail?: string; files?: UploadedFileReference[] };
  if (!response.ok || !Array.isArray(payload.files) || payload.files.length !== files.length) {
    throw new Error(payload.detail || "Lite 文件上传失败。");
  }
  files.forEach((_file, index) => options.onFileProgress?.(index, 100));
  options.onProgress?.(100);
  return payload.files;
}

async function addServerPreviews(files: UploadedFileReference[]) {
  const previewTusIds = files
    .map((file) => tusIdFromReadableUrl(file?.originalUrl || file?.url))
    .filter((id): id is string => Boolean(id));
  if (!previewTusIds.length) {
    return files;
  }

  try {
    const response = await familyFetch("/api/guest-uploads", {
      body: JSON.stringify({ tusIds: previewTusIds }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const payload = (await response.json()) as { files?: UploadedFileReference[] };
    if (!response.ok || !Array.isArray(payload.files)) {
      return files;
    }

    const previewByTusId = new Map(
      payload.files.map((file) => [tusIdFromReadableUrl(file.originalUrl || file.url), file] as const).filter(([id]) => Boolean(id))
    );
    return files.map((file) => {
      if (!file) return file;
      const preview = previewByTusId.get(tusIdFromReadableUrl(file.originalUrl || file.url));
      return preview ? { ...file, ...preview } : file;
    });
  } catch {
    return files;
  }
}

function readableTusUrl(uploadUrl: string | undefined) {
  if (!uploadUrl) {
    return undefined;
  }

  try {
    const url = new URL(uploadUrl, window.location.origin);
    const match = url.pathname.match(/\/api\/tus\/([^/?#]+)/);
    if (!match) {
      return uploadUrl;
    }
    return `/api/guest-uploads?tus=${encodeURIComponent(match[1])}`;
  } catch {
    const match = uploadUrl.match(/\/api\/tus\/([^/?#]+)/);
    return match ? `/api/guest-uploads?tus=${encodeURIComponent(match[1])}` : uploadUrl;
  }
}

function tusIdFromReadableUrl(url: string | undefined) {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.searchParams.get("tus") || parsed.pathname.match(/\/api\/tus\/([^/?#]+)/)?.[1];
  } catch {
    return url.match(/[?&]tus=([^&#]+)/)?.[1] || url.match(/\/api\/tus\/([^/?#]+)/)?.[1];
  }
}
