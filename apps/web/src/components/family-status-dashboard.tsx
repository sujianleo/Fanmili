"use client";

import { useEffect, useMemo, useState } from "react";
import { AvatarImage } from "@/components/avatar";
import { familyFetch } from "@/lib/familyApi";
import type { FamilyMember, FamilyRecord } from "@/lib/types";

type InsightCandidate = {
  confidence: number;
  requiresConfirmation: boolean;
  sourceIds: string[];
  suggestedAction: {
    action: "create_plan";
    label: "创建计划";
    requiresConfirmation: true;
    text: string;
  } | null;
  summary: string;
  title: string;
  type: "family_pattern" | "member_pattern" | "task_pattern" | "relationship_pattern" | "reminder_candidate" | "memory_candidate";
};

type InsightResponse = {
  data?: {
    insights?: InsightCandidate[];
    records?: Array<{ id: string; insights?: InsightCandidate[] }>;
  };
  userReply?: string;
};

type FamilyStatusDashboardProps = {
  currentMemberId: string;
  currentMemberName: string;
  familyName: string;
  members: FamilyMember[];
  onAskAssistant: (text: string) => void;
  onOpenRecord: (record: FamilyRecord) => void;
  records: FamilyRecord[];
};

const assistantMemberRole = "assistant";
const dismissedInsightsStorageKey = "family-app.dismissed-insights.v1";

export function FamilyStatusDashboard({
  currentMemberId,
  currentMemberName,
  familyName,
  members,
  onAskAssistant,
  onOpenRecord,
  records
}: FamilyStatusDashboardProps) {
  const [insight, setInsight] = useState<InsightCandidate | null>(null);
  const [insightRecordId, setInsightRecordId] = useState("");
  const [dismissedInsightKeys, setDismissedInsightKeys] = useState<string[]>([]);
  const now = useMemo(() => new Date(), [records]);
  const humanMembers = useMemo(() => members.filter((member) => !member.householdRoles?.includes(assistantMemberRole)), [members]);
  const membersById = useMemo(() => new Map(humanMembers.map((member) => [member.id, member])), [humanMembers]);
  const attentionRecords = useMemo(() => selectAttentionRecords(records, currentMemberId), [currentMemberId, records]);
  const recentRecords = useMemo(() => selectRecentRecords(records), [records]);
  const memory = useMemo(() => findFamilyMemory(records, now), [now, records]);
  const relationshipReminder = useMemo(() => findRelationshipReminder(humanMembers, now), [humanMembers, now]);
  const confirmedHabit = useMemo(() => findConfirmedHabit(records), [records]);
  const personalCards = useMemo(() => selectPersonalDailyCards(records, humanMembers, now), [humanMembers, now, records]);
  const weeklyWarmth = useMemo(() => describeWeeklyWarmth(records, now, membersById), [membersById, now, records]);
  const todayHighlights = useMemo(() => buildTodayHighlights(records, now, membersById), [membersById, now, records]);
  const insightKey = insight ? `${insightRecordId}:${insight.title}:${insight.summary}` : "";

  useEffect(() => {
    let active = true;
    void familyFetch("/api/family-insights?limit=7", { cache: "no-store", credentials: "include" })
      .then(async (response) => response.ok ? response.json() as Promise<InsightResponse> : null)
      .then((payload) => {
        if (!active || !payload) return;
        const latestRecord = payload.data?.records?.find((record) => record.insights?.length);
        const candidate = [...(latestRecord?.insights || []), ...(payload.data?.insights || [])].find(isSafeInsight) || null;
        setInsight(candidate);
        setInsightRecordId(latestRecord?.id || "latest");
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [records.length]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(dismissedInsightsStorageKey) || "[]") as unknown;
      if (Array.isArray(stored)) {
        setDismissedInsightKeys(stored.filter((value): value is string => typeof value === "string").slice(-50));
      }
    } catch {
      setDismissedInsightKeys([]);
    }
  }, []);

  const insightDismissed = Boolean(insightKey && dismissedInsightKeys.includes(insightKey));
  const visibleInsight = insight && !insightDismissed ? insight : null;
  const statusLine = attentionRecords.length === 0
    ? "家里挺顺利 😊"
    : attentionRecords.length <= 2
      ? "有几件事，慢慢处理就好"
      : "今天有几件事值得留意";

  return (
    <div className="family-status-dashboard">
      <header className="family-status-hero">
        <p>{familyName || "我们的家"}</p>
        <h1>{greetingFor(now)}，{currentMemberName}</h1>
        <strong>{statusLine}</strong>
        {todayHighlights.length ? (
          <ul aria-label="今天家里的情况">
            {todayHighlights.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : <span>今天还没有需要特别处理的事。</span>}
      </header>

      {!insightDismissed ? <section className="family-status-section family-discovery-card" aria-labelledby="family-discovery-title">
        <div className="family-status-section-heading">
          <div>
            <small>✨ 饭米粒发现</small>
            <h2 id="family-discovery-title">{visibleInsight?.title || "安静陪着，不主动打扰"}</h2>
          </div>
          {visibleInsight ? (
            <button
              aria-label="清除这条发现"
              className="family-status-dismiss"
              onClick={() => {
                const next = [...new Set([...dismissedInsightKeys, insightKey])].slice(-50);
                setDismissedInsightKeys(next);
                try {
                  window.localStorage.setItem(dismissedInsightsStorageKey, JSON.stringify(next));
                } catch {
                  // The card still clears for this session when storage is unavailable.
                }
              }}
              type="button"
            >×</button>
          ) : null}
        </div>
        <p>{visibleInsight?.summary || "目前没有足够可靠的新线索。等真正值得提醒时，我再告诉你。"}</p>
        {visibleInsight?.suggestedAction || visibleInsight?.type === "memory_candidate" || visibleInsight?.requiresConfirmation ? (
          <button
            className="family-status-action"
            onClick={() => onAskAssistant(
              visibleInsight.suggestedAction?.text || (
                visibleInsight.type === "memory_candidate"
                  ? `请帮我确认这是不是值得长期记住的家庭习惯：${visibleInsight.summary}`
                  : `请帮我核对这条饭米粒发现，只依据已有记录，不要自行执行：${visibleInsight.title}。${visibleInsight.summary}`
              )
            )}
            type="button"
          >
            {visibleInsight.type === "memory_candidate" ? "确认是否值得记住" : visibleInsight.suggestedAction ? "和饭米粒商量一下" : "确认一下"}
          </button>
        ) : null}
        {visibleInsight?.requiresConfirmation ? <em>只是一条建议，确认后才会执行。</em> : null}
      </section> : null}

      {personalCards.length ? (
        <section className="family-status-section family-personal-cards" aria-labelledby="family-personal-cards-title">
          <div className="family-status-section-heading">
            <div>
              <small>💌 今天的家人卡片</small>
              <h2 id="family-personal-cards-title">饭米粒写给每个人的话</h2>
            </div>
          </div>
          <div className="family-personal-card-list">
            {personalCards.map(({ member, record }) => (
              <button key={record.id} onClick={() => onOpenRecord(record)} type="button">
                <span className="family-personal-card-avatar">
                  <AvatarImage alt="" decoding="sync" height={48} label={member.displayName} loading="eager" seed={member.avatarSeed} width={48} />
                </span>
                <span>
                  <small>{member.relationshipLabel || member.displayName}</small>
                  <strong>{record.title}</strong>
                  <p>{record.summary}</p>
                </span>
              </button>
            ))}
          </div>
          <em>只写当天真实发生、并且能找到来源的事情。</em>
        </section>
      ) : null}

      {relationshipReminder ? (
        <section className="family-status-section family-care-card" aria-labelledby="family-care-title">
          <small>🌿 温和提醒</small>
          <h2 id="family-care-title">{relationshipReminder.title}</h2>
          <p>{relationshipReminder.text}</p>
          <button className="family-status-action" onClick={() => onAskAssistant(relationshipReminder.prompt)} type="button">一起想想</button>
        </section>
      ) : null}

      {confirmedHabit ? (
        <section className="family-status-section family-habit-card" aria-labelledby="family-habit-title">
          <small>🫶 饭米粒记得</small>
          <h2 id="family-habit-title">一个已确认的家庭习惯</h2>
          <p>{confirmedHabit.summary}</p>
          <em>只来自家人确认过的记录，不从闲聊里猜。</em>
        </section>
      ) : null}

      <section className="family-status-section" aria-labelledby="family-attention-title">
        <div className="family-status-section-heading">
          <div>
            <small>📌 需要关注</small>
            <h2 id="family-attention-title">{attentionRecords.length ? `${attentionRecords.length} 件` : "暂时没有"}</h2>
          </div>
        </div>
        {attentionRecords.length ? (
          <div className="family-status-list">
            {attentionRecords.slice(0, 3).map((record) => (
              <button key={record.id} onClick={() => onOpenRecord(record)} type="button">
                <MemberDot member={resolveRecordMember(record, membersById)} />
                <span><strong>{record.title}</strong><small>{attentionDescription(record, membersById)}</small></span>
                <i aria-hidden="true">›</i>
              </button>
            ))}
          </div>
        ) : <p className="family-status-quiet">没有催促，也没有红点。需要时再打开看看。</p>}
      </section>

      {weeklyWarmth ? (
        <section className="family-status-section family-warmth-card" aria-labelledby="family-warmth-title">
          <small>❤️ 最近的家庭互动</small>
          <h2 id="family-warmth-title">这一周</h2>
          <p>{weeklyWarmth}</p>
        </section>
      ) : null}

      {memory ? (
        <section className="family-status-section family-memory-card" aria-labelledby="family-memory-title">
          <small>🕰 家庭回忆</small>
          <h2 id="family-memory-title">{memory.yearsAgo === 1 ? "去年今天" : `${memory.yearsAgo} 年前的今天`}</h2>
          <button onClick={() => onOpenRecord(memory.record)} type="button">
            {recordPreviewUrl(memory.record) ? <img alt="" src={recordPreviewUrl(memory.record)} /> : null}
            <strong>{memory.record.title}</strong>
            <span>{memory.record.summary || "那一天，家里留下了一段记录。"}</span>
          </button>
        </section>
      ) : null}

      <section className="family-status-section" aria-labelledby="family-recent-title">
        <div className="family-status-section-heading">
          <div>
            <small>💬 最近发生</small>
            <h2 id="family-recent-title">家里的新变化</h2>
          </div>
        </div>
        {recentRecords.length ? (
          <div className="family-status-list family-recent-list">
            {recentRecords.slice(0, 4).map((record) => (
              <button key={record.id} onClick={() => onOpenRecord(record)} type="button">
                <span><strong>{recentTitle(record)}</strong><small>{recentDescription(record)}</small></span>
                <i aria-hidden="true">›</i>
              </button>
            ))}
          </div>
        ) : <p className="family-status-quiet">最近还没有新的家庭记录。</p>}
      </section>
    </div>
  );
}

function greetingFor(now: Date) {
  const hour = now.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function selectAttentionRecords(records: FamilyRecord[], currentMemberId: string) {
  return records
    .filter((record) => record.kind === "task" && !isGroupRecord(record) && record.status !== "done")
    .filter((record) => !record.assigneeMemberIds?.length || record.assigneeMemberIds.includes(currentMemberId) || record.createdByMemberId === currentMemberId)
    .sort((left, right) => recordTime(left) - recordTime(right));
}

function selectRecentRecords(records: FamilyRecord[]) {
  return records
    .filter((record) => !isGroupRecord(record))
    .slice()
    .sort((left, right) => recordTime(right) - recordTime(left));
}

function selectPersonalDailyCards(records: FamilyRecord[], members: FamilyMember[], now: Date) {
  const today = dayKey(now);
  const cards = records
    .filter((record) => record.tags.includes("AI总结") && record.tags.includes("日总结") && dayKey(recordDate(record)) === today)
    .map((record) => {
      const member = members.find((candidate) => record.tags.includes(candidate.displayName) || record.title.includes(candidate.displayName));
      return member ? { member, record } : null;
    })
    .filter((value): value is { member: FamilyMember; record: FamilyRecord } => Boolean(value))
    .sort((left, right) => recordTime(right.record) - recordTime(left.record));
  const seen = new Set<string>();
  return cards.filter(({ member }) => {
    if (seen.has(member.id)) return false;
    seen.add(member.id);
    return true;
  });
}

function buildTodayHighlights(records: FamilyRecord[], now: Date, membersById: Map<string, FamilyMember>) {
  const today = dayKey(now);
  const completed = records.filter((record) => record.kind === "task" && record.status === "done" && dayKey(recordDate(record)) === today);
  const newResources = records.filter((record) => record.kind !== "task" && dayKey(recordDate(record)) === today);
  const highlights: string[] = [];
  completed.slice(0, 2).forEach((record) => {
    const member = resolveRecordMember(record, membersById);
    highlights.push(`${member?.displayName || record.ownerName || "家人"}完成了「${record.title}」`);
  });
  if (newResources.length) highlights.push(`家里新增了 ${newResources.length} 条照片或资料`);
  return highlights;
}

function describeWeeklyWarmth(records: FamilyRecord[], now: Date, membersById: Map<string, FamilyMember>) {
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const recent = records.filter((record) => recordDate(record).getTime() >= weekStart.getTime());
  const completed = recent.filter((record) => record.kind === "task" && record.status === "done").length;
  const shared = recent.filter((record) => record.kind !== "task").length;
  const discussions = recent.filter(isGroupRecord).reduce((count, record) => count + (record.chatMessages?.length || 0), 0);
  const participatingMembers = new Set(recent.flatMap((record) => [record.createdByMemberId, ...(record.assigneeMemberIds || [])]).filter((id): id is string => Boolean(id && membersById.has(id))));
  if (completed + shared + discussions < 2) return "";
  const parts = [
    completed ? `完成了 ${completed} 件家庭事项` : "",
    shared ? `留下了 ${shared} 份生活记录` : "",
    discussions ? `有 ${discussions} 次群聊互动` : ""
  ].filter(Boolean);
  return `${parts.join("，")}。${participatingMembers.size > 1 ? "大家在用各自的方式参与，配合得挺自然。" : "家里的节奏正在慢慢被记录下来。"}`;
}

function findFamilyMemory(records: FamilyRecord[], now: Date) {
  const candidates = records
    .map((record) => ({ record, date: recordDate(record) }))
    .filter(({ date }) => date.getFullYear() < now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate())
    .sort((left, right) => right.date.getTime() - left.date.getTime());
  const first = candidates[0];
  return first ? { record: first.record, yearsAgo: now.getFullYear() - first.date.getFullYear() } : null;
}

function findRelationshipReminder(members: FamilyMember[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const upcoming = members.flatMap((member) => {
    const value = member.profile?.birthDate;
    if (!value) return [];
    const parts = value.split("-").map(Number);
    if (parts.length < 3 || !parts[1] || !parts[2]) return [];
    let birthday = new Date(today.getFullYear(), parts[1] - 1, parts[2]);
    if (birthday.getTime() < today.getTime()) birthday = new Date(today.getFullYear() + 1, parts[1] - 1, parts[2]);
    const days = Math.round((birthday.getTime() - today.getTime()) / 86_400_000);
    return days <= 7 ? [{ days, member }] : [];
  }).sort((left, right) => left.days - right.days)[0];
  if (!upcoming) return null;
  const name = upcoming.member.relationshipLabel || upcoming.member.displayName;
  const when = upcoming.days === 0 ? "今天" : upcoming.days === 1 ? "明天" : `${upcoming.days} 天后`;
  return {
    prompt: `${when}是${name}生日。请结合家里已确认的习惯和过去记录，给我几个低压力的准备建议；不要替我创建任务。`,
    text: "不用现在决定。需要的话，我可以结合家里已确认的习惯，陪你慢慢想一想。",
    title: `${when}是${name}生日`
  };
}

function findConfirmedHabit(records: FamilyRecord[]) {
  return records.find((record) => record.tags.includes("长期记忆") && (record.tags.includes("习惯") || record.tags.includes("偏好"))) || null;
}

function isSafeInsight(insight: InsightCandidate) {
  const text = `${insight.title} ${insight.summary} ${insight.suggestedAction?.text || ""}`;
  return (insight.type !== "task_pattern" || insight.sourceIds.length >= 2) &&
    !/(?:可能希望|似乎希望|内心|关系不好|感情不好|身体不好|疑似|患病|生病|抑郁|焦虑)/i.test(text);
}

function recordDate(record: FamilyRecord) {
  const value = record.occurredAt || record.dueAt || "";
  const date = value ? new Date(value) : new Date(0);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function recordTime(record: FamilyRecord) {
  const time = recordDate(record).getTime();
  return time || 0;
}

function dayKey(date: Date) {
  if (!date.getTime()) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function resolveRecordMember(record: FamilyRecord, membersById: Map<string, FamilyMember>) {
  const memberId = record.assigneeMemberIds?.[0] || record.createdByMemberId || record.sourceMemberId;
  return memberId ? membersById.get(memberId) : undefined;
}

function MemberDot({ member }: { member?: FamilyMember }) {
  return <i aria-hidden="true" className="family-member-dot" style={{ backgroundColor: member?.color || "var(--accent)" }} />;
}

function attentionDescription(record: FamilyRecord, membersById: Map<string, FamilyMember>) {
  const member = resolveRecordMember(record, membersById);
  if (record.joinRequestId) return "等待家庭管理员确认";
  if (member) return `${member.displayName} · ${record.displayTime || "待处理"}`;
  return record.displayTime || record.summary || "待处理";
}

function recentTitle(record: FamilyRecord) {
  if (record.tags.includes("AI总结")) return `饭米粒整理了「${record.title}」`;
  if (record.status === "done" && record.kind === "task") return `完成了「${record.title}」`;
  if (record.kind === "media") return `上传了「${record.title}」`;
  if (record.kind === "note" || record.kind === "link") return `保存了「${record.title}」`;
  return `新增了「${record.title}」`;
}

function recentDescription(record: FamilyRecord) {
  return [record.ownerName, record.updatedAt].filter(Boolean).join(" · ") || record.summary;
}

function recordPreviewUrl(record: FamilyRecord) {
  return record.previewUrl || record.sourceFiles?.[0]?.thumbnailUrl || record.sourceFiles?.[0]?.previewUrl || record.sourceFiles?.[0]?.url || "";
}

function isGroupRecord(record: FamilyRecord) {
  return Boolean(record.inviteLink || record.chatMembers?.length || record.tags.includes("群组") || record.tags.includes("群聊"));
}
