import type { FamilyMember, FamilyRecord } from "@/lib/types";
import { FamilyAccessGate } from "./family-access-gate";
import { RecordList } from "./record-list";
import { NotificationCenter } from "./notification-center";
import { OnboardingGate } from "./onboarding-gate";
import { PwaInstallPrompt } from "./pwa-install-prompt";

export type NavItem = {
  label: string;
  count: number;
};

type FamilyHubPageProps = {
  demoDataEnabled: boolean;
  demoRecordIds: string[];
  familyMembers: FamilyMember[];
  familyName: string;
  familyRecords: FamilyRecord[];
  initialMemberId: string;
  initialSignedIn: boolean;
  navItems: NavItem[];
  trialMode: boolean;
};

export function FamilyHubPage({
  demoDataEnabled,
  demoRecordIds,
  familyMembers,
  familyName,
  familyRecords,
  initialMemberId,
  initialSignedIn,
  navItems,
  trialMode
}: FamilyHubPageProps) {
  return (
    <FamilyAccessGate bypassAuth={trialMode} initialSignedIn={initialSignedIn}>
      <OnboardingGate trialMode={trialMode}>
        <NotificationCenter members={familyMembers} />
        <PwaInstallPrompt />
        <main className="app-shell">
          <section className="workspace">
            <div className="columns">
              <RecordList
                demoDataEnabled={demoDataEnabled}
                demoRecordIds={demoRecordIds}
                initialMemberId={initialMemberId}
                familyName={familyName}
                members={familyMembers}
                navItems={navItems}
              records={familyRecords}
              trialMode={trialMode}
            />
            </div>
          </section>
        </main>
      </OnboardingGate>
    </FamilyAccessGate>
  );
}
