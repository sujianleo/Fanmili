const http = require("node:http");
const path = require("node:path");
const { createWorker } = require("tesseract.js");

const host = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3100);
const maxImageBytes = 20 * 1024 * 1024;
const modelPath = process.env.OCR_MODEL_PATH || path.join(process.cwd(), "models");
const cachePath = process.env.OCR_CACHE_PATH || "/tmp/fanmili-ocr-cache";
let workerPromise;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(["chi_sim", "eng"], undefined, {
      cachePath,
      gzip: true,
      langPath: modelPath,
      workerPath: require.resolve("tesseract.js/src/worker-script/node/index.js")
    });
  }
  return workerPromise;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxImageBytes) {
        reject(new Error("IMAGE_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function recognize(image) {
  const worker = await getWorker();
  const result = await worker.recognize(image);
  return {
    confidence: Number.isFinite(result.data.confidence) ? Math.round(result.data.confidence) : 0,
    text: typeof result.data.text === "string" ? result.data.text : ""
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { component: "fanmili-ocr", ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/recognize") {
    json(response, 404, { detail: "Not found." });
    return;
  }

  try {
    const image = await readBody(request);
    if (!image.length) {
      json(response, 400, { detail: "Image body is required." });
      return;
    }
    const task = queue.catch(() => undefined).then(() => recognize(image));
    queue = task.then(() => undefined, () => undefined);
    json(response, 200, await task);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "IMAGE_TOO_LARGE";
    json(response, tooLarge ? 413 : 500, {
      detail: tooLarge ? "Image exceeds 20 MB." : "OCR recognition failed."
    });
  }
});

async function shutdown() {
  server.close();
  const worker = await workerPromise?.catch(() => null);
  await worker?.terminate().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.listen(port, host, () => {
  console.log(`Fanmili OCR listening on http://${host}:${port}`);
});
