import { isLocalAuthConfigured, localAuthContext, readLocalSession } from "./localAuth";
import { readRemovedMemberIds } from "./memberOverrides";
import { isPublicTrialMode, publicTrialContext } from "./trialMode";

export type FamilyRequestContext = {
  familyId: string;
  memberId: string;
  userId: string;
};

export class FamilyRequestContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 503
  ) {
    super(message);
  }
}

export async function requireFamilyRequestContext(request: Request): Promise<FamilyRequestContext> {
  if (isPublicTrialMode()) {
    return publicTrialContext();
  }
  if (isLocalAuthConfigured()) {
    const session = readLocalSession(request);
    if (session) {
      const removedMemberIds = await readRemovedMemberIds("data");
      if (removedMemberIds.includes(session.memberId)) {
        throw new FamilyRequestContextError("该账号已不在家庭中。", 403);
      }
      return localAuthContext(session);
    }
    throw new FamilyRequestContextError("请先登录家庭账号。", 401);
  }
  if (!isFamilyAuthRequired()) {
    return {
      familyId: "local-family",
      memberId: "me",
      userId: "local-development"
    };
  }
  throw new FamilyRequestContextError("请先配置并登录家庭账号。", 401);
}

export function isFamilyAuthRequired() {
  if (process.env.FAMILY_APP_AUTH_REQUIRED === "true") {
    return true;
  }
  if (process.env.FAMILY_APP_AUTH_REQUIRED === "false") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}
