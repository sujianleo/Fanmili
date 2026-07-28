"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AvatarImage } from "@/components/avatar";
import { runAutomationAction, runAutomationPipeline, type AutomationActionResponse } from "@/lib/automations";
import { familyFetch } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import { familyMembers } from "@/lib/mockData";
import type { FamilyMember } from "@/lib/types";
import type { BackgroundOrganizationRecord } from "@/lib/server/backgroundOrganizer";
import styles from "./organize.module.css";

type CandidateState = {
  message: string;
  status: "confirming" | "done" | "error";
  token?: string;
};

export default function OrganizePage() {
  const [records, setRecords] = useState<BackgroundOrganizationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [candidateStates, setCandidateStates] = useState<Record<string, CandidateState>>({});
  const [candidateAssignees, setCandidateAssignees] = useState<Record<string, string>>({});
  const [ignored, setIgnored] = useState<string[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>(familyMembers);
  const [currentMemberId, setCurrentMemberId] = useState("me");
  const [selectedAdviceMemberId, setSelectedAdviceMemberId] = useState("");
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  const refresh = useCallback(async () => {
    setError("");
    const response = await familyFetch("/api/background-organize?limit=7");
    const payload = (await response.json()) as { detail?: string; records?: BackgroundOrganizationRecord[] };
    if (!response.ok) throw new Error(payload.detail || "无法读取整理箱。");
    setRecords(payload.records || []);
  }, []);

  useEffect(() => {
    setIgnored(readIgnoredCandidates());
    void refresh()
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取整理箱。"))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void familyFetch("/api/family-members", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ members?: FamilyMember[] }> : null)
      .then((payload) => {
        if (!cancelled && payload?.members?.length) setMembers(payload.members);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void familyFetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ memberId?: string | null }> : null)
      .then((session) => {
        if (!cancelled && session?.memberId) setCurrentMemberId(session.memberId);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const latest = records[0];
  const taskOverview = latest?.organization.taskOverview || {
    completed: [],
    familyPending: [],
    overdue: [],
    personalPending: []
  };
  const visibleTaskCandidates = useMemo(
    () => latest?.organization.taskCandidates.filter((candidate) => !ignored.includes(candidateKey("task", candidate.sourceId))) || [],
    [ignored, latest]
  );
  const visibleMemoryCandidates = useMemo(
    () =>
      latest?.organization.memoryCandidates.filter(
        (candidate) => !ignored.includes(candidateKey("memory", `${candidate.type}:${candidate.sourceIds.join(",")}`))
      ) || [],
    [ignored, latest]
  );
  const advice = latest?.organization.personalizedAdvice || [];
  const adviceMembers = useMemo(
    () => members.filter((member) => advice.some((item) => item.memberId === member.id)),
    [advice, members]
  );
  const activeAdvice = advice.find((item) => item.memberId === selectedAdviceMemberId) || advice[0];
  const visibleTimeline = latest?.organization.timeline.slice(timelineExpanded ? 0 : -4) || [];

  useEffect(() => {
    if (!advice.length) return;
    if (!advice.some((item) => item.memberId === selectedAdviceMemberId)) {
      setSelectedAdviceMemberId(advice[0].memberId);
    }
  }, [advice, selectedAdviceMemberId]);

  async function organizeNow() {
    setRunning(true);
    setError("");
    try {
      const response = await familyFetch("/api/background-organize", {
        body: JSON.stringify({ force: true, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json()) as { detail?: string };
      if (!response.ok) throw new Error(payload.detail || "整理失败。");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "整理失败。");
    } finally {
      setRunning(false);
    }
  }

  async function handleTaskCandidate(candidate: BackgroundOrganizationRecord["organization"]["taskCandidates"][number]) {
    const key = candidateKey("task", candidate.sourceId);
    const current = candidateStates[key];
    const assigneeMemberId = candidateAssignees[key] || candidate.responsibleMemberIds?.[0] || "";
    if (!assigneeMemberId) {
      setCandidateStates((states) => ({
        ...states,
        [key]: { message: "请先选择负责照顾这件事的家人。", status: "error" }
      }));
      return;
    }
    const parameters = {
      assignee_member_ids: [assigneeMemberId],
      display_time: candidate.displayTime,
      due_at: candidate.dueAt,
      source_ids: [candidate.sourceId],
      text: candidate.title,
      title: candidate.title
    };
    setCandidateStates((states) => ({ ...states, [key]: { message: "处理中…", status: "confirming", token: current?.token } }));
    const response = await runAutomationPipeline("pipeline.task.ai_create", parameters, { confirmationToken: current?.token });
    if (!response?.ok) {
      setCandidateStates((states) => ({
        ...states,
        [key]: { message: response?.userReply || response?.error || "处理失败。", status: "error" }
      }));
      return;
    }
    if (response.status === "waiting_confirmation" && response.confirmation?.token) {
      const token = response.confirmation.token;
      setCandidateStates((states) => ({
        ...states,
        [key]: {
          message: response.userReply || "请确认后创建给这位家人。",
          status: "confirming",
          token
        }
      }));
      return;
    }
    const saved = await familyFetch("/api/family-records", {
      body: JSON.stringify({
        assignee_member_ids: [assigneeMemberId],
        assignment_reason: candidate.reason,
        assignment_status: "assigned",
        audience: "core",
        display_time: candidate.displayTime,
        due_at: candidate.dueAt,
        kind: "task",
        reminder_offsets: [15, 0],
        status: "todo",
        summary: `饭米粒根据家庭记录提出。证据：${candidate.sourceId}`,
        tags: ["任务", "家庭关怀"],
        title: candidate.title
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const payload = (await saved.json().catch(() => ({}))) as { detail?: string };
    if (!saved.ok) {
      setCandidateStates((states) => ({
        ...states,
        [key]: { message: payload.detail || "任务保存失败。", status: "error" }
      }));
      return;
    }
    setCandidateStates((states) => ({
      ...states,
      [key]: { message: "已创建给对应家人，并会按时间提醒。", status: "done" }
    }));
  }

  async function handleMemoryCandidate(candidate: BackgroundOrganizationRecord["organization"]["memoryCandidates"][number]) {
    const key = candidateKey("memory", `${candidate.type}:${candidate.sourceIds.join(",")}`);
    const current = candidateStates[key];
    const parameters = {
      evidence_text: candidate.sourceIds.join(","),
      fact: candidate.content,
      memory_type: memorySaveType(candidate.type),
      source_ids: candidate.sourceIds,
      subject: "家庭记忆",
      tags: [candidate.type],
      text: candidate.content
    };
    await runCandidateAction(key, current, () =>
      runAutomationAction("memory.save", parameters, { confirmationToken: current?.token })
    );
  }

  async function runCandidateAction(
    key: string,
    current: CandidateState | undefined,
    action: () => Promise<AutomationActionResponse | null>
  ) {
    setCandidateStates((states) => ({ ...states, [key]: { message: "处理中…", status: "confirming", token: current?.token } }));
    const response = await action();
    if (!response?.ok) {
      setCandidateStates((states) => ({
        ...states,
        [key]: { message: response?.userReply || response?.error || "处理失败。", status: "error" }
      }));
      return;
    }
    if (response.status === "waiting_confirmation" && response.confirmation?.token) {
      setCandidateStates((states) => ({
        ...states,
        [key]: {
          message: response.userReply || "请再次确认后执行。",
          status: "confirming",
          token: response.confirmation?.token
        }
      }));
      return;
    }
    setCandidateStates((states) => ({
      ...states,
      [key]: { message: response.userReply || "已完成。", status: "done" }
    }));
  }

  function ignoreCandidate(key: string) {
    const next = [...new Set([...ignored, key])];
    setIgnored(next);
    localStorage.setItem("family-background-organizer-ignored", JSON.stringify(next.slice(-200)));
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.back} href={withAppBasePath("/")} aria-label="返回首页">
          <svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
        </a>
        <div>
          <p className={styles.eyebrow}>饭米粒</p>
          <h1>整理箱</h1>
        </div>
        <button className={styles.runButton} disabled={running} onClick={() => void organizeNow()}>
          {running ? "整理中…" : "立即整理"}
        </button>
      </header>

      <p className={styles.safety}><span aria-hidden="true" />AI 只整理和建议；任务、提醒与长期记忆仍由你确认。</p>
      {error ? <p className={styles.error}>{error}</p> : null}
      {loading ? <p className={styles.empty}>正在读取整理结果…</p> : null}
      {!loading && !latest ? <p className={styles.empty}>还没有整理结果。可以点击“立即整理”生成第一份。</p> : null}

      {latest ? (
        <>
          <section className={styles.summary}>
            <div className={styles.summaryMeta}>
              <span>今日整理</span>
              <time>{formatDate(latest.createdAt)}</time>
            </div>
            <h2>今天，家里发生了这些事</h2>
            <p className={styles.summaryText}>{formatOrganizationParagraph(latest.organization)}</p>
          </section>

          {activeAdvice ? (
            <section className={styles.adviceSection} aria-labelledby="personalized-advice-title">
              <div className={styles.adviceHeading}>
                <div>
                  <p>FOR EVERYONE</p>
                  <h2 id="personalized-advice-title">今天 AI 对大家的建议</h2>
                </div>
                <span>每个人都不同</span>
              </div>
              <div className={styles.memberRail} role="tablist" aria-label="选择家庭成员">
                {adviceMembers.map((member) => (
                  <button
                    aria-selected={activeAdvice.memberId === member.id}
                    className={activeAdvice.memberId === member.id ? styles.memberTabActive : styles.memberTab}
                    key={member.id}
                    onClick={() => setSelectedAdviceMemberId(member.id)}
                    role="tab"
                    type="button"
                  >
                    <span className={styles.memberAvatar}>
                      <AvatarImage alt="" label={member.displayName} seed={member.avatarSeed} />
                    </span>
                    <span>{adviceMemberLabel(member, currentMemberId)}</span>
                  </button>
                ))}
              </div>
              <article className={styles.adviceCard} role="tabpanel">
                <p className={styles.adviceFor}>给 {adviceMemberLabel(members.find((member) => member.id === activeAdvice.memberId), currentMemberId, activeAdvice.memberName)}</p>
                <h3>{activeAdvice.title}</h3>
                <p className={styles.adviceText}>{activeAdvice.suggestion}</p>
                <p className={styles.adviceReason}>{activeAdvice.reason}</p>
              </article>
              <p className={styles.adviceDisclaimer}>建议来自今天的家庭动态，仅供参考，不会自动执行。</p>
            </section>
          ) : null}

          <Section
            title="家庭状态"
            count={
              taskOverview.familyPending.length +
              taskOverview.personalPending.length +
              taskOverview.completed.length +
              visibleTaskCandidates.length +
              visibleMemoryCandidates.length
            }
          >
            <div className={styles.stateGrid}>
              <StateMetric label="家庭任务" value={taskOverview.familyPending.length} />
              <StateMetric label="我的待办" value={taskOverview.personalPending.length} />
              <StateMetric label="已完成" value={taskOverview.completed.length} />
              <StateMetric label="待确认" value={visibleTaskCandidates.length + visibleMemoryCandidates.length} />
            </div>
          </Section>

          <Section
            title="今日时间线"
            count={latest.organization.timeline.length}
            action={latest.organization.timeline.length > 4 ? (
              <button className={styles.sectionAction} onClick={() => setTimelineExpanded((value) => !value)} type="button">
                {timelineExpanded ? "收起" : "展开全部"}
              </button>
            ) : null}
          >
            <div className={styles.timeline}>
              {visibleTimeline.map((item) => (
                <article className={styles.timelineItem} key={`${item.sourceType}:${item.sourceId}`}>
                  <time>{formatTime(item.createdAt)}</time>
                  <div>
                    {item.actorName ? <p className={styles.actor}>{timelineActorLabel(item.actorName, members, currentMemberId)}</p> : null}
                    <p>{item.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </Section>

          <Section title="待确认候选" count={visibleTaskCandidates.length + visibleMemoryCandidates.length}>
            {!visibleTaskCandidates.length && !visibleMemoryCandidates.length ? (
              <p className={styles.sectionEmpty}>暂时没有新的候选。</p>
            ) : null}
            {visibleTaskCandidates.map((candidate) => {
              const key = candidateKey("task", candidate.sourceId);
              return (
                <CandidateCard
                  key={key}
                  assigneeMemberId={candidateAssignees[key] || candidate.responsibleMemberIds?.[0] || ""}
                  label="关怀任务"
                  meta={candidate.reason}
                  state={candidateStates[key]}
                  text={candidate.title}
                  members={members}
                  currentMemberId={currentMemberId}
                  onAssigneeChange={(memberId) => setCandidateAssignees((current) => ({ ...current, [key]: memberId }))}
                  onConfirm={() => void handleTaskCandidate(candidate)}
                  onIgnore={() => ignoreCandidate(key)}
                />
              );
            })}
            {visibleMemoryCandidates.map((candidate) => {
              const key = candidateKey("memory", `${candidate.type}:${candidate.sourceIds.join(",")}`);
              return (
                <CandidateCard
                  key={key}
                  label="记忆候选"
                  state={candidateStates[key]}
                  text={candidate.content}
                  onConfirm={() => void handleMemoryCandidate(candidate)}
                  onIgnore={() => ignoreCandidate(key)}
                />
              );
            })}
          </Section>

          <Section title="任务健康检查" count={latest.organization.healthSignals.length}>
            {!latest.organization.healthSignals.length ? <p className={styles.sectionEmpty}>没有发现需要处理的问题。</p> : null}
            {latest.organization.healthSignals.map((signal) => (
              <article className={styles.healthItem} key={`${signal.kind}:${signal.sourceIds.join(",")}`}>
                <span>{healthLabel(signal.kind)}</span>
                <p>{signal.text}</p>
              </article>
            ))}
          </Section>
        </>
      ) : null}
    </main>
  );
}

function StateMetric({ label, value }: { label: string; value: number }) {
  return (
    <article className={styles.stateMetric}>
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function formatOrganizationParagraph(organization: BackgroundOrganizationRecord["organization"]) {
  const topics = [...new Map(
    organization.timeline
      .filter((item) => item.text.trim())
      .map((item) => [item.text.replace(/\s+/g, "").replace(/[，。！？!?；;：:]/g, ""), item.text.trim()] as const)
  ).values()].slice(-3);
  const activity = topics.length
    ? `今天家里主要围绕${topics.map((topic) => `“${topic}”`).join("、")}展开。`
    : "今天的家庭记录已经整理完成。";
  const contextParts = [
    organization.conversationHighlights.length ? `${organization.conversationHighlights.length} 段家庭对话` : "",
    organization.contextSnapshot.resources.length ? `${organization.contextSnapshot.resources.length} 份家庭资料` : ""
  ].filter(Boolean);
  const taskParts = [
    organization.taskOverview.familyPending.length ? `${organization.taskOverview.familyPending.length} 项家庭任务待完成` : "",
    organization.taskOverview.personalPending.length ? `${organization.taskOverview.personalPending.length} 项个人待办` : "",
    organization.taskOverview.completed.length ? `${organization.taskOverview.completed.length} 项任务已经完成` : ""
  ].filter(Boolean);
  const reviewCount = organization.candidateCounts.tasks + organization.candidateCounts.memories + organization.healthSignals.length;
  const context = contextParts.length ? `这次共整理了${contextParts.join("和")}。` : "";
  const tasks = taskParts.length ? `目前${taskParts.join("，")}。` : "";
  const review = reviewCount ? `另有 ${reviewCount} 项候选或检查结果等待你确认。` : "目前没有额外事项需要确认。";
  return `${activity}${context}${tasks}${review}`;
}

function Section({ action, children, count, title }: { action?: React.ReactNode; children: React.ReactNode; count: number; title: string }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>
        <h2>{title}</h2>
        <div className={styles.sectionTitleMeta}>
          <span>{count}</span>
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

function CandidateCard(props: {
  assigneeMemberId?: string;
  currentMemberId?: string;
  label: string;
  meta?: string;
  members?: FamilyMember[];
  onAssigneeChange?: (memberId: string) => void;
  onConfirm: () => void;
  onIgnore: () => void;
  state?: CandidateState;
  text: string;
}) {
  const needsFinalConfirmation = Boolean(props.state?.token);
  return (
    <article className={styles.candidate}>
      <span className={styles.candidateLabel}>{props.label}</span>
      <p>{props.text}</p>
      {props.meta ? <p className={styles.candidateMeta}>{props.meta}</p> : null}
      {props.onAssigneeChange ? (
        <label className={styles.assigneeField}>
          <span>由谁负责</span>
          <select value={props.assigneeMemberId || ""} onChange={(event) => props.onAssigneeChange?.(event.target.value)}>
            <option value="">请选择家人</option>
            {(props.members || familyMembers)
              .filter((member) => member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"))
              .map((member) => <option key={member.id} value={member.id}>{adviceMemberLabel(member, props.currentMemberId || "me")}</option>)}
          </select>
        </label>
      ) : null}
      {props.state?.message ? (
        <p className={props.state.status === "error" ? styles.errorText : styles.stateText}>{props.state.message}</p>
      ) : null}
      {props.state?.status !== "done" ? (
        <div className={styles.actions}>
          <button onClick={props.onConfirm}>{needsFinalConfirmation ? "确认执行" : "查看并确认"}</button>
          <button className={styles.secondaryButton} onClick={props.onIgnore}>忽略</button>
        </div>
      ) : null}
    </article>
  );
}

function candidateKey(type: "memory" | "task", id: string) {
  return `${type}:${id}`;
}

function adviceMemberLabel(member: FamilyMember | undefined, currentMemberId: string, fallback = "家人") {
  if (!member) return fallback;
  if (member.id === currentMemberId) return "我";
  return member.relationshipLabel || member.displayName || fallback;
}

function timelineActorLabel(actorName: string, members: FamilyMember[], currentMemberId: string) {
  const member = familyMembers.find((candidate) => candidate.displayName === actorName) ||
    members.find((candidate) => candidate.displayName === actorName);
  return member ? adviceMemberLabel(members.find((candidate) => candidate.id === member.id) || member, currentMemberId, actorName) : actorName;
}

function readIgnoredCandidates() {
  try {
    const value = JSON.parse(localStorage.getItem("family-background-organizer-ignored") || "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function healthLabel(kind: "duplicate" | "missing_due_time" | "overdue") {
  if (kind === "overdue") return "已过期";
  if (kind === "duplicate") return "可能重复";
  return "时间待确认";
}

function memorySaveType(type: "preference" | "habit" | "family_fact" | "repeated_pattern" | "rule") {
  if (type === "repeated_pattern") return "habit";
  if (type === "rule") return "family_fact";
  return type;
}
