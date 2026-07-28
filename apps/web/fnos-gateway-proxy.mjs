import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const socketPath = process.env.FAMILY_FNOS_GATEWAY_SOCKET;
const upstreamPort = Number(process.env.PORT || "3000");
const entryUrl = normalizeEntryUrl(process.env.FAMILY_FNOS_ENTRY_URL);

if (!socketPath) throw new Error("FAMILY_FNOS_GATEWAY_SOCKET is required");

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
try {
  if (fs.statSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const proxy = http.createServer((request, response) => {
  if (entryUrl && request.method === "GET" && (request.headers.accept || "").includes("text/html")) {
    response.writeHead(302, {
      "cache-control": "no-store",
      "location": entryUrl
    });
    response.end();
    return;
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: request.headers.host || `127.0.0.1:${upstreamPort}` }
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Fanmili is starting");
  });
  request.pipe(upstream);
});

proxy.on("upgrade", (request, socket, head) => {
  const upstream = http.request({
    host: "127.0.0.1",
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: request.headers
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) value.forEach((item) => socket.write(`${name}: ${item}\r\n`));
      else if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
    }
    socket.write("\r\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});

proxy.listen(socketPath, () => fs.chmodSync(socketPath, 0o666));

const shutdown = () => proxy.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function normalizeEntryUrl(value) {
  if (!value?.trim()) return "";
  try {
    const target = new URL(value.trim());
    return target.protocol === "https:" ? target.toString() : "";
  } catch {
    return "";
  }
}
