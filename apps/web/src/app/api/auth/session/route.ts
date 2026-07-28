import { NextResponse } from "next/server";
import { isLocalAuthConfigured, readLocalSession } from "@/lib/server/localAuth";
import { isPublicTrialMode, publicTrialContext } from "@/lib/server/trialMode";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (isPublicTrialMode()) {
    const context = publicTrialContext();
    return NextResponse.json(
      { authenticated: true, memberId: context.memberId, role: "member", trial: true },
      { headers: { "cache-control": "no-store" } }
    );
  }
  const session = isLocalAuthConfigured() ? readLocalSession(request) : null;
  return NextResponse.json(
    { authenticated: Boolean(session), memberId: session?.memberId || null, role: session?.role || null },
    { headers: { "cache-control": "no-store" }, status: session ? 200 : 401 }
  );
}
