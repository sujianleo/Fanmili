import { withAppBasePath } from "./appBasePath";

export function buildConnectivityTarget(serverUrl: string, serverPort: string) {
  const value = serverUrl.trim();
  const target = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);

  if (serverPort.trim()) target.port = serverPort.trim();
  target.pathname = withAppBasePath("/api/auth/session");
  target.search = "";
  target.hash = "";

  return target;
}

const defaultLanPort = process.env.NEXT_PUBLIC_FAMILY_LAN_PORT?.trim() || "3000";

export function buildLanConnectivityTarget(lanIp: string, port = defaultLanPort) {
  const value = lanIp.trim();
  const host = value.replace(/^https?:\/\//i, "").split("/")[0]?.split(":")[0] || "";
  if (!isCompleteLanAddress(host)) throw new Error("本地地址不完整。");
  const target = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);

  if (!target.port && port.trim()) target.port = port.trim();
  target.pathname = withAppBasePath("/api/auth/session");
  target.search = "";
  target.hash = "";

  return target;
}

export function isCompleteLanAddress(lanIp: string) {
  const segments = lanIp.trim().split(".");
  return segments.length === 4 && segments.every((segment) => /^\d{1,3}$/.test(segment) && Number(segment) <= 255);
}

export function selectFastestNetwork(
  internet: { latencyMs?: number; status: string },
  local: { latencyMs?: number; status: string },
  localEnabled = true
) {
  const internetLatency = internet.status === "success" ? internet.latencyMs : undefined;
  const localLatency = localEnabled && local.status === "success" ? local.latencyMs : undefined;
  if (typeof internetLatency !== "number") return typeof localLatency === "number" ? "local" as const : null;
  if (typeof localLatency !== "number") return "internet" as const;
  return localLatency < internetLatency ? "local" as const : "internet" as const;
}
