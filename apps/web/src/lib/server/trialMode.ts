export function isPublicTrialMode() {
  return process.env.FAMILY_APP_TRIAL_MODE === "true";
}

export function publicTrialContext() {
  return {
    familyId: process.env.FAMILY_APP_LOCAL_AUTH_FAMILY_ID || "local-family",
    memberId: process.env.FAMILY_APP_LOCAL_AUTH_MEMBER_ID || "me",
    userId: "public-trial"
  };
}
