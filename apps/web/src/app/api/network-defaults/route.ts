import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { FamilyRequestContextError, requireFamilyRequestContext } from "@/lib/server/familyRequestContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type NetworkDefaults = {
  lanAddress?: string;
  servicePort?: string;
};

export async function GET(request: Request) {
  try {
    await requireFamilyRequestContext(request);
    const defaults = await readNetworkDefaults();
    return NextResponse.json({
      lanAddress: normalizePrivateIpv4(defaults.lanAddress),
      publicDomain: publicHost(request),
      servicePort: normalizePort(defaults.servicePort)
    });
  } catch (error) {
    if (error instanceof FamilyRequestContextError) {
      return NextResponse.json({ detail: error.message }, { status: error.status });
    }
    return NextResponse.json({ lanAddress: "", publicDomain: publicHost(request), servicePort: "" });
  }
}

async function readNetworkDefaults(): Promise<NetworkDefaults> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", ".fnos-network-defaults.json"), "utf8");
    return JSON.parse(raw) as NetworkDefaults;
  } catch {
    return {};
  }
}

function publicHost(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL || process.env.FAMILY_PUBLIC_URL;
  const candidate = configured
    || request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host")
    || new URL(request.url).host;
  try {
    const parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    return isLocalHostname(parsed.hostname) ? "" : parsed.host;
  } catch {
    return "";
  }
}

function isLocalHostname(hostname: string) {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) return true;
  const segments = hostname.split(".").map(Number);
  if (segments.length !== 4 || segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) return false;
  return segments[0] === 10
    || segments[0] === 127
    || (segments[0] === 172 && segments[1] >= 16 && segments[1] <= 31)
    || (segments[0] === 192 && segments[1] === 168);
}

function normalizePort(value = "") {
  const normalized = String(value).trim();
  if (!/^\d{1,5}$/.test(normalized)) return "";
  const port = Number(normalized);
  return port >= 1 && port <= 65535 ? String(port) : "";
}

function normalizePrivateIpv4(value = "") {
  const address = String(value).trim();
  const segments = address.split(".").map(Number);
  if (segments.length !== 4 || segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) return "";
  return segments[0] === 10
    || (segments[0] === 172 && segments[1] >= 16 && segments[1] <= 31)
    || (segments[0] === 192 && segments[1] === 168)
    ? address
    : "";
}
