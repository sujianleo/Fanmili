import { familyRecords } from "@/lib/mockData";
import { FamilyHubPage, type NavItem } from "@/components/family-hub-page";
import { readFamilyMembersWithOverrides } from "@/lib/server/memberOverrides";
import { isLocalAuthConfigured, readLocalSession } from "@/lib/server/localAuth";
import { isLiteBackend } from "@/lib/server/familyBackend";
import { readLiteFamilyMembers, readLiteInstallation } from "@/lib/server/liteRepository";
import { isPublicTrialMode } from "@/lib/server/trialMode";
import { headers } from "next/headers";
import { connection } from "next/server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await connection();
  const liteBackend = isLiteBackend();
  const [membersWithOverrides, requestHeaders] = await Promise.all([
    liteBackend ? Promise.resolve(readLiteFamilyMembers()) : readFamilyMembersWithOverrides("data"),
    headers()
  ]);
  const localAuthConfigured = isLocalAuthConfigured();
  const trialMode = isPublicTrialMode();
  const demoDataEnabled = process.env.FAMILY_APP_DEMO_DATA === "true";
  const session = readLocalSession(new Request("http://family-app.local/", { headers: requestHeaders }));
  const initialSignedIn = trialMode || (localAuthConfigured ? Boolean(session) : !liteBackend);
  const initialMemberId = session?.memberId || "me";
  const initialRecords = !localAuthConfigured && demoDataEnabled ? familyRecords : [];
  const familyName = liteBackend ? readLiteInstallation()?.familyName || "我们的家" : process.env.FAMILY_APP_FAMILY_NAME || "我们的家";
  const navItems: NavItem[] = [
    { label: "任务", count: initialRecords.filter((item) => item.kind === "task" && !(item.inviteLink || item.chatMembers?.length)).length },
    { label: "群组", count: initialRecords.filter((item) => item.inviteLink || item.chatMembers?.length).length }
  ];
  return (
    <FamilyHubPage
      demoDataEnabled={demoDataEnabled}
      demoRecordIds={familyRecords.map((record) => record.id)}
      familyMembers={membersWithOverrides}
      familyName={familyName}
      familyRecords={initialRecords}
      initialMemberId={initialMemberId}
      initialSignedIn={initialSignedIn}
      navItems={navItems}
      trialMode={trialMode}
    />
  );
}
