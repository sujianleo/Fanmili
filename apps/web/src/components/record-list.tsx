"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type TouchEvent, type UIEvent } from "react";
import QRCode from "qrcode";
import { familyFetch } from "@/lib/familyApi";
import type { AssignmentSuggestion, FamilyAssetType, FamilyMember, FamilyRecord, RoomMessage, TaskResponse } from "@/lib/types";
import { resolveFamilyMemberMention, suggestAssignment } from "@/lib/assignment";
import {
  advanceAssistantDialogueState,
  resolveAssistantClarification,
  routeAssistantInput,
  selectAssistantRoutingFocus,
  type AssistantClarification,
  type AssistantDialogueState,
  type FamilyQuestionPlan,
  type AssistantRoute,
  type AssistantRouteActionButton
} from "@/lib/assistantRouter";
import { runAutomationAction as executeAutomationAction, runAutomationPipeline as executeAutomationPipeline, type AutomationActionResponse, type AutomationDisplayTarget, type AutomationDisplayType } from "@/lib/automations";
import type { AutomationActionId, AutomationUnitDefinition } from "@/lib/automationRegistry";
import { buildMentionOnlyGroupMemberIds, buildMentionOnlyGroupTitle, compileComposerIntent, haveSameGroupMemberIds } from "@/lib/composerIntent";
import { clearComposerMentionTrigger, hasComposerMentionTrigger, insertComposerMention, isComposerMentionTriggerAtStart, mentionLabelsForPlainDisplay, removeComposerMention, withSelectedMentionLabels } from "@/lib/composerMention";
import { formatChatTimestamp, shouldShowChatTimestamp } from "@/lib/chatMessageTime";
import { isPollWakeKeyword, parseDecisionCandidate, type FamilyDecision } from "@/lib/familyDecisions";
import { isEligibleJudgementMember, type GroupJudgement } from "@/lib/groupJudgement";
import { createGuestChatLink, getGuestChatSlug } from "@/lib/guestChat";
import { familyRelationshipOptions, relationshipKindForLabel } from "@/lib/familyRelationships";
import type { FanmiliSticker } from "@/lib/fanmiliStickers";
import { enqueueMetaEvent, fetchMetaEvents, metaEventsToRoomMessages } from "@/lib/meta";
import { buildDueLocalTaskReminders, isTaskOverdue, localTaskReminderEventType, nextLocalTaskReminderDelay, readFiredLocalTaskReminderIds, requestSystemNotificationPermission, writeFiredLocalTaskReminderIds } from "@/lib/localTaskReminders";
import { deleteFamilyRecord, enqueueFamilyRecord, requestAssignmentSuggestion, requestResourceInsight, updateFamilyRecord } from "@/lib/records";
import { RESOURCE_UPLOAD_ACCEPT, RESOURCE_UPLOAD_MAX_LABEL, isAnalyzableDocumentFile, validateResourceUploadFile } from "@/lib/resourceUploadPolicy";
import { parseResourceParsePresentation } from "@/lib/resourceParsePresentation";
import { isPwaInstallCommand, PWA_INSTALL_REQUEST_EVENT } from "@/lib/pwaInstallRequest";
import { extractTaskTimeMentions, isAmbiguousOrganizationRequest, isOpenVolunteerQuestion as isOpenVolunteerTaskQuestion, isTimedTaskStatement, normalizeTaskTitle, parseTaskReminder, shouldSuggestTaskFromText } from "@/lib/taskIntent";
import { formatTaskListDateTime } from "@/lib/taskDisplayTime";
import { useChatPresence } from "@/lib/useChatPresence";
import { AvatarImage, MemberAvatar, familyAvatarSeeds, resolveMemberAvatarSeed } from "./avatar";
import { ComposerAutosizeTextarea } from "./composer-autosize-textarea";
import { FamilyStatusDashboard } from "./family-status-dashboard";
import { ComposerVoiceIndicator } from "./composer-voice-indicator";
import { FanmiliStickerMessage, FanmiliStickerSuggestions } from "./fanmili-stickers";
import { ActivityPlanCard, isActivityPlanBody } from "./activity-plan-card";
import { TimeHighlightedText } from "./time-highlight";
import { SettingsDrawer } from "./settings-drawer";
import { TaskSwipeItem } from "./task-swipe-item";
import { SharedGroupChatHeader, SharedGroupMemberStrip, SharedGroupMessage } from "./shared-group-chat";
import { ResourceDocumentPreview, type ResourceDocumentKind } from "./resource-document-preview";
import { ResourceDocumentThumbnailFallback } from "./resource-document-thumbnail-fallback";
import { SharedComposerInputRow } from "./shared-composer-input-row";

import { CreateJudgementSheet } from "./create-judgement-sheet";
import { GroupJudgementBar } from "./group-judgement-bar";
import { GroupJudgementSheet } from "./group-judgement-sheet";
import { StanceConfirmationCard } from "./stance-confirmation-card";

type NavItem = {
  label: string;
  count: number;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function triggerHaptic(kind: "start" | "stop" | "success") {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(kind === "success" ? [10, 35, 14] : kind === "start" ? 14 : 8);
}

function shouldPreferReusableVoiceCapture() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function formatVoiceCaptureError(error: unknown) {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "请在 Safari 的网站设置中将麦克风设为“允许”";
  }
  return error instanceof Error ? error.message : "无法访问麦克风";
}

type VoiceInsertionPoint = {
  after: string;
  before: string;
  keepKeyboardOpen: boolean;
};

function captureVoiceInsertionPoint(input: HTMLTextAreaElement | null, value: string): VoiceInsertionPoint {
  const keepKeyboardOpen = document.activeElement === input;
  const selectionStart = keepKeyboardOpen ? input?.selectionStart ?? value.length : value.length;
  const selectionEnd = keepKeyboardOpen ? input?.selectionEnd ?? selectionStart : selectionStart;
  return {
    after: value.slice(selectionEnd),
    before: value.slice(0, selectionStart),
    keepKeyboardOpen
  };
}

function insertVoiceTranscript(point: VoiceInsertionPoint, transcript: string) {
  const insertedText = transcript.trim();
  return {
    caret: point.before.length + insertedText.length,
    value: `${point.before}${insertedText}${point.after}`
  };
}

type FallbackVoiceCapture = {
  stop: () => void;
};

const preferredVoiceDeviceStorageKey = "family-app.preferred-voice-device";
const fallbackVoiceStreamIdleMs = 10 * 60 * 1000;
let reusableFallbackVoiceStream: MediaStream | null = null;
let reusableFallbackVoiceStreamPromise: Promise<MediaStream> | null = null;
let fallbackVoiceStreamIdleTimer: ReturnType<typeof setTimeout> | null = null;

async function getReusableFallbackVoiceStream() {
  const liveTrack = reusableFallbackVoiceStream?.getAudioTracks().find((track) => track.readyState === "live");
  if (reusableFallbackVoiceStream && liveTrack) {
    if (fallbackVoiceStreamIdleTimer) clearTimeout(fallbackVoiceStreamIdleTimer);
    reusableFallbackVoiceStream.getAudioTracks().forEach((track) => { track.enabled = true; });
    return reusableFallbackVoiceStream;
  }
  if (reusableFallbackVoiceStreamPromise) return reusableFallbackVoiceStreamPromise;

  const preferredDeviceId = (() => {
    try {
      return window.localStorage.getItem(preferredVoiceDeviceStorageKey) || "";
    } catch {
      return "";
    }
  })();
  reusableFallbackVoiceStreamPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      ...(preferredDeviceId ? { deviceId: { ideal: preferredDeviceId } } : {})
    }
  }).then((stream) => {
    reusableFallbackVoiceStream = stream;
    const track = stream.getAudioTracks()[0];
    const deviceId = track?.getSettings().deviceId;
    if (deviceId) {
      try {
        window.localStorage.setItem(preferredVoiceDeviceStorageKey, deviceId);
      } catch {
        // Storage is optional; the live stream can still be reused this session.
      }
    }
    track?.addEventListener("ended", () => {
      if (reusableFallbackVoiceStream === stream) reusableFallbackVoiceStream = null;
    }, { once: true });
    return stream;
  }).finally(() => {
    reusableFallbackVoiceStreamPromise = null;
  });
  return reusableFallbackVoiceStreamPromise;
}

function pauseReusableFallbackVoiceStream(stream: MediaStream) {
  stream.getAudioTracks().forEach((track) => { track.enabled = false; });
  if (fallbackVoiceStreamIdleTimer) clearTimeout(fallbackVoiceStreamIdleTimer);
  fallbackVoiceStreamIdleTimer = setTimeout(() => {
    if (reusableFallbackVoiceStream !== stream) return;
    stream.getTracks().forEach((track) => track.stop());
    reusableFallbackVoiceStream = null;
    fallbackVoiceStreamIdleTimer = null;
  }, fallbackVoiceStreamIdleMs);
}

async function startFallbackVoiceCapture({
  onError,
  onTranscript
}: {
  onError: (message: string) => void;
  onTranscript: (transcript: string) => void;
}): Promise<FallbackVoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("当前设备无法访问麦克风");
  }
  const stream = await getReusableFallbackVoiceStream();
  const preferredMimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
    .find((mimeType) => MediaRecorder.isTypeSupported?.(mimeType));
  const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  const startedAt = performance.now();
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    pauseReusableFallbackVoiceStream(stream);
    const mimeType = recorder.mimeType || preferredMimeType || "audio/webm";
    const extension = mimeType.includes("mp4") ? "m4a" : "webm";
    const file = new File(chunks, `dictation-${Date.now()}.${extension}`, { type: mimeType });
    const form = new FormData();
    form.append("file", file);
    form.append("duration_ms", String(durationMs));
    form.append("transcribe_only", "1");
    void familyFetch("/api/voice-notes", { method: "POST", body: form })
      .then(async (response) => {
        const payload = await response.json() as { detail?: string; transcript?: string };
        if (!response.ok) throw new Error(payload.detail || "语音转写失败");
        const transcript = payload.transcript?.trim();
        if (transcript) onTranscript(transcript); else onError("没有听清，请再试一次");
      })
      .catch((error) => onError(error instanceof Error ? error.message : "语音转写失败"));
  };
  recorder.start(250);
  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    }
  };
}

type TopTab = "任务" | "群组";
type RecordListProps = {
  demoDataEnabled: boolean;
  demoRecordIds: string[];
  familyName: string;
  initialMemberId: string;
  members: FamilyMember[];
  navItems: NavItem[];
  records: FamilyRecord[];
  trialMode: boolean;
};

type AutomationFeedback = {
  clarification?: AssistantClarification;
  confirmation?: NonNullable<AutomationActionResponse["confirmation"]>;
  display?: AssistantDisplayPayload;
  displayTarget?: AutomationDisplayTarget;
  displayType?: AutomationDisplayType;
  links?: AssistantResultLink[];
  state: "running" | "done" | "error";
  text: string;
};

type ComposerChatMessage = {
  clarification?: AssistantClarification;
  confirmation?: NonNullable<AutomationActionResponse["confirmation"]>;
  display?: AssistantDisplayPayload;
  displayTarget?: AutomationDisplayTarget;
  displayType?: AutomationDisplayType;
  id: string;
  links?: AssistantResultLink[];
  role: "assistant" | "user";
  state?: "running" | "done" | "error";
  text: string;
};

type SyncedKnowledgeInquiry = {
  evidence: Array<{
    actorName: string;
    id: string;
    source: "member_reply" | "user_input";
    text: string;
  }>;
  id: string;
  question: string;
  requesterMemberId: string;
  requesterName: string;
  retryCount: number;
  status: "awaiting_choice" | "awaiting_member_reply" | "awaiting_user_input" | "resolved" | "dismissed";
  targetMemberId: string;
  targetMemberName: string;
  updatedAt: string;
};

type FamilyInviteDraft = {
  displayName: string;
  relationshipLabel: string;
};

type LifeLogIntent = "daily_log" | "task" | "reminder" | "knowledge" | "question" | "search" | "summary_request" | "ambiguous";

type LifeLogPromptResult = {
  user_reply: string;
  structured_data: {
    intent: LifeLogIntent[];
    date: string | null;
    time: string | null;
    people: string[];
    location: string | null;
    events: string[];
    mood: string | null;
    food: string[];
    health: string[];
    work: string[];
    family: string[];
    money: string[];
    tags: string[];
    summary: string;
    task_candidate: boolean;
    reminder_candidate: boolean;
    knowledge_candidate: boolean;
    need_user_confirmation: boolean;
    confidence: number;
  };
  raw_meta_policy: {
    preserve_raw_input: true;
    preserve_uploaded_files: true;
    preserve_conversation_context: true;
    do_not_overwrite_raw_record: true;
    allow_reparse: true;
    source_record_ids_required_for_summary: true;
  };
  action_buttons: string[];
};

type ComposerSessionState = {
  id: string;
  messages: ComposerChatMessage[];
  updatedAt: number;
};

type MemberAvatarProfile = {
  displayName: string;
  nickname: string;
  title: string;
};

type AvatarCropSource = {
  height: number;
  name: string;
  src: string;
  width: number;
};

type SwipeToast =
  | {
      id: string;
      message: string;
      record?: FamilyRecord;
      recordIndex?: number;
      type: "deleted";
    }
  | {
      id: string;
      message: string;
      type: "completed";
    };

type ExpandedSwipeTask = {
  id: string;
  side: "complete" | "delete";
};

function keepLocalSelfAssignment(
  localSuggestion: AssignmentSuggestion,
  mentionedMemberIds: string[],
  senderMemberId: string
) {
  return mentionedMemberIds.length === 0
    && localSuggestion.suggestedAssignees.length === 1
    && localSuggestion.suggestedAssignees[0]?.id === senderMemberId
    && localSuggestion.reason === "没有明确对象，先保留为发起人的任务";
}

type AssistantResultLink = {
  id: string;
  kind: "task" | "resource" | "group" | "web";
  label: string;
  url?: string;
};

type AssistantDisplayPayload = Record<string, never>;

type WebSearchResultItem = {
  link?: string;
  snippet?: string;
  title?: string;
};

let currentMemberId = "me";
const defaultCurrentMemberName = "小明";
const coreSpaceId = "core";
const composerSessionTimeoutMs = 5 * 60 * 1000;
const lifeLogPromptVersion = "life-log-ai-prompt-v1";
const tusUploadConcurrency = 2;
const maxRenderedChatMessages = 60;
const familyAssistantPrefillEvent = "family-assistant-prefill";
const defaultCollapsedGroups: Record<string, boolean> = { 任务: true, 群组: true, 资料: true };
const taskSortModes = ["default", "due", "status", "member"] as const;
type TaskSortMode = typeof taskSortModes[number];
const taskSortLabels: Record<TaskSortMode, string> = {
  default: "",
  due: "临期优先",
  status: "待办优先",
  member: "成员归类"
};
const chatDismissBlockedTargets = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  ".chat-message",
  ".chat-poll-card",
  ".group-judgement-bar",
  ".judgement-lifecycle-message",
  ".chat-fullscreen-members i",
  ".composer",
  ".modal-sheet",
  ".judgement-sheet-backdrop"
].join(",");
const avatarProfileDismissBlockedTargets = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "label",
  "[contenteditable='true']",
  ".avatar-grid",
  ".notification-settings-card"
].join(",");
const recordListStorageKeys = {
  activeTab: "family-app.record-list.active-tab",
  avatarProfile: "family-app.record-list.avatar-profile",
  avatarSeed: "family-app.record-list.avatar-seed",
  collapsedGroups: "family-app.record-list.collapsed-groups",
  localRecords: "family-app.record-list.records",
  selectedResourceId: "family-app.record-list.selected-resource-id",
  selectedTaskId: "family-app.record-list.selected-task-id",
  tabOrder: "family-app.record-list.tab-order"
};

function runWhenBrowserIdle(callback: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  if ("requestIdleCallback" in window && "cancelIdleCallback" in window) {
    const idleId = window.requestIdleCallback(callback, { timeout: 1600 });
    return () => window.cancelIdleCallback(idleId);
  }

  const timeoutId = globalThis.setTimeout(callback, 400);
  return () => globalThis.clearTimeout(timeoutId);
}

function ignoreRecordAction(_recordId: string) {
  return undefined;
}

function isChatDismissStartTarget(target: EventTarget | null) {
  return target instanceof Element
    && !target.closest(chatDismissBlockedTargets)
    && Boolean(target.closest(".chat-fullscreen"));
}

function hasSameChatSender(left: RoomMessage | undefined, right: RoomMessage | undefined) {
  if (!left || !right || left.mine !== right.mine) {
    return false;
  }
  if (left.senderMemberId === "guest" && right.senderMemberId === "guest") {
    return left.senderName === right.senderName
      && (left.senderAvatarSeed || left.senderName) === (right.senderAvatarSeed || right.senderName);
  }
  if (left.senderMemberId || right.senderMemberId) {
    return Boolean(left.senderMemberId && left.senderMemberId === right.senderMemberId);
  }
  return left.senderName === right.senderName;
}

function groupChatMessages(messages: RoomMessage[]) {
  return messages.reduce<RoomMessage[][]>((groups, message) => {
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && hasSameChatSender(currentGroup[0], message) && !shouldShowChatTimestamp(currentGroup[currentGroup.length - 1], message)) {
      currentGroup.push(message);
    } else {
      groups.push([message]);
    }
    return groups;
  }, []);
}

function mergeDuplicateGroupChatRecords(records: FamilyRecord[]) {
  const merged: FamilyRecord[] = [];
  const recordIndexByMembers = new Map<string, number>();
  const recordIndexByVisibleMembers = new Map<string, number>();

  for (const record of records) {
    if (record.audience === "guest" || !record.chatMembers?.length) {
      merged.push(record);
      continue;
    }

    const memberKey = [...new Set(record.chatMembers.map((memberId) => memberId === currentMemberId || memberId === "me" ? "__self__" : memberId))].sort().join("|");
    const visibleMemberKey = moveSelfToEndInGroupTitle(record.title).trim().replace(/\s+/g, " ");
    const existingIndex = recordIndexByMembers.get(memberKey) ?? recordIndexByVisibleMembers.get(visibleMemberKey);
    if (existingIndex === undefined) {
      recordIndexByMembers.set(memberKey, merged.length);
      if (visibleMemberKey) recordIndexByVisibleMembers.set(visibleMemberKey, merged.length);
      merged.push(record);
      continue;
    }

    const existing = merged[existingIndex];
    const messagesById = new Map(
      [...(record.chatMessages || []), ...(existing.chatMessages || [])]
        .map((message) => [message.id, message] as const)
    );
    merged[existingIndex] = {
      ...existing,
      chatMessages: [...messagesById.values()]
    };
  }

  return merged;
}

function splitChatMessageGroups(messageGroups: RoomMessage[][], continuationIds: Set<string>) {
  return messageGroups.flatMap((messageGroup) => {
    const sourceGroupId = messageGroup[0]?.id || "message-group";
    return messageGroup.reduce<Array<{ messages: RoomMessage[]; sourceGroupId: string }>>((segments, message) => {
      const currentSegment = segments[segments.length - 1];
      if (!currentSegment || continuationIds.has(message.id)) {
        segments.push({ messages: [message], sourceGroupId });
      } else {
        currentSegment.messages.push(message);
      }
      return segments;
    }, []);
  });
}

const chatDismissActivationDistance = 12;
const chatDismissHorizontalIntentRatio = 1.6;
const chatDismissTravelRatio = 0.92;
const chatDismissCloseProgress = 0.38;
const chatDismissCloseVelocity = 0.85;

export function RecordList({ demoDataEnabled, demoRecordIds, familyName, initialMemberId, members, records, trialMode }: RecordListProps) {
  const activeTab: TopTab = "任务";
  const [sessionMemberId, setSessionMemberId] = useState(initialMemberId || currentMemberId);
  const [perspectiveMembers, setPerspectiveMembers] = useState(members);
  const demoRecordIdSet = useMemo(() => new Set(demoRecordIds), [demoRecordIds]);
  currentMemberId = sessionMemberId;
  const initialSessionMember = members.find((member) => member.id === sessionMemberId);

  const [localRecords, setLocalRecords] = useState(records);
  const [avatarSeed, setAvatarSeed] = useState(initialSessionMember?.avatarSeed || "current-member");
  const [avatarProfile, setAvatarProfile] = useState<MemberAvatarProfile>({
    displayName: initialSessionMember?.displayName || defaultCurrentMemberName,
    nickname: "",
    title: initialSessionMember?.role || "家庭成员"
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(defaultCollapsedGroups);
  const [taskSortMode, setTaskSortMode] = useState<TaskSortMode>("default");
  const [clientStorageHydrated, setClientStorageHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionRole, setSessionRole] = useState<"admin" | "member" | null>(null);
  const [accountSettingsToken, setAccountSettingsToken] = useState(0);
  const [aiConnectedToken, setAiConnectedToken] = useState(0);
  const [composerResumeToken, setComposerResumeToken] = useState(0);
  const currentMemberName = avatarProfile.displayName || defaultCurrentMemberName;
  const displayMembers = useMemo(
    () => perspectiveMembers.map((member) => (member.id === currentMemberId ? { ...member, avatarSeed, displayName: currentMemberName } : member)),
    [avatarSeed, currentMemberName, perspectiveMembers]
  );
  const membersById = useMemo(() => new Map(displayMembers.map((member) => [member.id, member])), [displayMembers]);

  useEffect(() => {
    let cancelled = false;
    void familyFetch("/api/family-members", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{
        members?: FamilyMember[];
        session?: { memberId?: string | null; role?: "admin" | "member" | null };
      }> : null)
      .then((payload) => {
        if (cancelled || !payload) return;
        if (payload.members?.length) setPerspectiveMembers(payload.members);
        setSessionRole(payload.session?.role || null);
        const memberId = payload.session?.memberId?.trim();
        if (!memberId || memberId === sessionMemberId) return;
        const member = payload.members?.find((candidate) => candidate.id === memberId)
          || members.find((candidate) => candidate.id === memberId);
        currentMemberId = memberId;
        setSessionMemberId(memberId);
        if (member) {
          setAvatarSeed(member.avatarSeed);
          setAvatarProfile({ displayName: member.displayName, nickname: "", title: member.role || "家庭成员" });
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionMemberId]);

  useEffect(() => {
    const member = perspectiveMembers.find((candidate) => candidate.id === sessionMemberId);
    if (!member) return;
    setAvatarSeed(member.avatarSeed);
    setAvatarProfile((current) => current.displayName === member.displayName && current.title === (member.role || "家庭成员") ? current : { displayName: member.displayName, nickname: "", title: member.role || "家庭成员" });
  }, [perspectiveMembers, sessionMemberId]);

  const taskRecords = useMemo(() => localRecords
    .filter((record) => record.kind === "task" && !isGroupChatRecord(record))
    .map((record) => {
      const title = normalizeTaskTitle(record.title);
      return title === record.title ? record : { ...record, title };
    }), [localRecords]);
  const sortedTaskRecords = useMemo(() => sortTaskRecords(taskRecords, taskSortMode), [taskRecords, taskSortMode]);
  const groupRecords = useMemo(
    () => mergeDuplicateGroupChatRecords(localRecords.filter((record) => isGroupChatRecord(record))),
    [localRecords]
  );
  const resourceRecords = useMemo(() => localRecords.filter((record) => isResourceRecord(record)), [localRecords]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [inviteTaskId, setInviteTaskId] = useState<string | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [expandedSwipeTask, setExpandedSwipeTask] = useState<ExpandedSwipeTask | null>(null);
  const [swipeToast, setSwipeToast] = useState<SwipeToast | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(() => new Set());
  const deepLinkHandledRef = useRef(false);
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRecordDeletionIdsRef = useRef(new Set<string>());
  const pendingRecordStatusRef = useRef(new Map<string, FamilyRecord["status"]>());
  const softDeleteRequestsRef = useRef(new Map<string, Promise<boolean>>());
  const selectedTask = useMemo(
    () => groupRecords.find((record) => record.id === selectedTaskId)
      || taskRecords.find((record) => record.id === selectedTaskId)
      || null,
    [groupRecords, selectedTaskId, taskRecords]
  );
  const selectedTaskHasOverlay = Boolean(selectedTask);
  const inviteTask = useMemo(() => localRecords.find((record) => record.id === inviteTaskId) || null, [inviteTaskId, localRecords]);
  const selectedResource = useMemo(
    () => localRecords.find((record) => record.id === selectedResourceId && ["note", "link", "media"].includes(record.kind)) || null,
    [localRecords, selectedResourceId]
  );

  function resumeComposerAfterOverlay() {
    setComposerResumeToken((value) => value + 1);
  }

  function closeSelectedTask() {
    blurActiveTextEntry();
    setSelectedTaskId(null);
    window.requestAnimationFrame(() => blurActiveTextEntry());
  }

  function closeSelectedChat() {
    blurActiveTextEntry();
    setSelectedTaskId(null);
    window.requestAnimationFrame(() => blurActiveTextEntry());
  }

  function closeInviteTask() {
    setInviteTaskId(null);
    resumeComposerAfterOverlay();
  }

  function closeSelectedResource() {
    blurActiveTextEntry();
    setSelectedResourceId(null);
    window.requestAnimationFrame(() => blurActiveTextEntry());
    window.setTimeout(blurActiveTextEntry, 120);
  }

  function closeSettings() {
    blurActiveTextEntry();
    setSettingsOpen(false);
    window.requestAnimationFrame(() => blurActiveTextEntry());
    window.setTimeout(blurActiveTextEntry, 120);
  }

  function openSettings() {
    setSettingsOpen(true);
    window.requestAnimationFrame(() => blurActiveTextEntry());
  }

  async function handleSignOutAccount() {
    const response = await familyFetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) return;
    await clearLocalResourceCache();
    window.location.replace("/");
  }

  useEffect(() => {
    const memberRecordsKey = memberScopedStorageKey(recordListStorageKeys.localRecords, sessionMemberId);
    const memberAvatarSeedKey = memberScopedStorageKey(recordListStorageKeys.avatarSeed, sessionMemberId);
    const memberAvatarProfileKey = memberScopedStorageKey(recordListStorageKeys.avatarProfile, sessionMemberId);
    const sessionMember = perspectiveMembers.find((member) => member.id === sessionMemberId);
    const scopedAvatarSeed = loadStoredString(memberAvatarSeedKey) || "";
    const legacyAvatarSeed = sessionMemberId === "me" ? loadStoredString(recordListStorageKeys.avatarSeed) || "" : "";
    const shouldMigrateLegacyAvatar = Boolean(
      legacyAvatarSeed &&
      legacyAvatarSeed !== sessionMember?.avatarSeed &&
      (!scopedAvatarSeed || scopedAvatarSeed === sessionMember?.avatarSeed)
    );
    const storedAvatarIsInitialDefault = scopedAvatarSeed === "current-member"
      && Boolean(sessionMember?.avatarSeed && sessionMember.avatarSeed !== "current-member");
    const hydratedAvatarSeed = shouldMigrateLegacyAvatar
      ? legacyAvatarSeed
      : storedAvatarIsInitialDefault
        ? sessionMember?.avatarSeed || "current-member"
        : scopedAvatarSeed || sessionMember?.avatarSeed || "current-member";
    const scopedAvatarProfile = loadStoredJson<Partial<MemberAvatarProfile>>(memberAvatarProfileKey);
    const legacyAvatarProfile = sessionMemberId === "me" ? loadStoredJson<Partial<MemberAvatarProfile>>(recordListStorageKeys.avatarProfile) : null;
    const hydratedAvatarProfile = loadMemberAvatarProfile(
      shouldMigrateLegacyAvatar && legacyAvatarProfile ? recordListStorageKeys.avatarProfile : memberAvatarProfileKey,
      sessionMember
    );
    const storedRecords = loadStoredJson<FamilyRecord[]>(memberRecordsKey);
    const storedRecordsForMode = demoDataEnabled
      ? storedRecords
      : storedRecords?.filter((record) => !demoRecordIdSet.has(record.id)) || null;
    const hydratedRecords = mergeRecordDisplayDefaults(storedRecordsForMode, records);
    const deepLinkedRecordId = new URLSearchParams(window.location.search).get("record");
    const deepLinkedRecord = hydratedRecords.find((record) => record.id === deepLinkedRecordId);
    setLocalRecords(hydratedRecords);
    setAvatarSeed(hydratedAvatarSeed);
    setAvatarProfile(hydratedAvatarProfile);
    if (shouldMigrateLegacyAvatar) {
      storeString(memberAvatarSeedKey, hydratedAvatarSeed);
      if (!scopedAvatarProfile && legacyAvatarProfile) storeJson(memberAvatarProfileKey, hydratedAvatarProfile);
      void syncMemberProfile(hydratedAvatarProfile, hydratedAvatarSeed)
        .then(() => setPerspectiveMembers((current) => current.map((member) => member.id === sessionMemberId ? {
          ...member,
          avatarSeed: hydratedAvatarSeed,
          displayName: hydratedAvatarProfile.displayName
        } : member)))
        .catch(() => undefined);
    }
    setCollapsedGroups(loadCollapsedGroups());
    setSelectedTaskId(deepLinkedRecord?.kind === "task" ? deepLinkedRecord.id : null);
    setSelectedResourceId(deepLinkedRecord && ["note", "link", "media"].includes(deepLinkedRecord.kind) ? deepLinkedRecord.id : null);
    setClientStorageHydrated(true);
  }, [demoDataEnabled, demoRecordIdSet, members, records, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated || deepLinkHandledRef.current) return;
    const deepLinkedRecordId = new URLSearchParams(window.location.search).get("record");
    if (!deepLinkedRecordId) {
      deepLinkHandledRef.current = true;
      return;
    }
    const deepLinkedRecord = localRecords.find((record) => record.id === deepLinkedRecordId);
    if (!deepLinkedRecord) return;
    if (deepLinkedRecord.kind === "task") setSelectedTaskId(deepLinkedRecord.id);
    else if (["note", "link", "media"].includes(deepLinkedRecord.kind)) setSelectedResourceId(deepLinkedRecord.id);
    deepLinkHandledRef.current = true;
  }, [clientStorageHydrated, localRecords]);

  useEffect(() => {
    if (!clientStorageHydrated) return;
    const openDeepLinkedRecord = () => {
      const recordId = new URLSearchParams(window.location.search).get("record");
      if (!recordId) return;
      const record = localRecords.find((item) => item.id === recordId);
      if (!record) return;
      setSelectedTaskId(record.kind === "task" ? record.id : null);
      setSelectedResourceId(["note", "link", "media"].includes(record.kind) ? record.id : null);
    };
    window.addEventListener("family-record-deep-link", openDeepLinkedRecord);
    window.addEventListener("popstate", openDeepLinkedRecord);
    return () => {
      window.removeEventListener("family-record-deep-link", openDeepLinkedRecord);
      window.removeEventListener("popstate", openDeepLinkedRecord);
    };
  }, [clientStorageHydrated, localRecords]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    let active = true;
    let polling = false;
    const syncFamilyRecords = async () => {
      if (!active || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const response = await familyFetch("/api/family-records", { cache: "no-store" });
        const payload = response.ok ? await response.json() : null;
        if (!active) return;
        const serverRecords = readFamilyRecordsResponse(payload).filter(
          (record) =>
            (demoDataEnabled || !demoRecordIdSet.has(record.id)) &&
            !pendingRecordDeletionIdsRef.current.has(record.id)
        ).map((record) => {
          const pendingStatus = pendingRecordStatusRef.current.get(record.id);
          return pendingStatus ? {
            ...record,
            assignmentStatus: pendingStatus === "done" ? "done" as const : "assigned" as const,
            status: pendingStatus
          } : record;
        });
        if (serverRecords.length) {
          setLocalRecords((currentRecords) => mergeServerRecords(serverRecords, currentRecords));
        }
      } catch {
        // A later poll retries without disturbing the local interaction state.
      } finally {
        polling = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void syncFamilyRecords();
    };
    void syncFamilyRecords();
    const timer = window.setInterval(() => void syncFamilyRecords(), 3_000);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clientStorageHydrated, demoDataEnabled, demoRecordIdSet, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    storeString(recordListStorageKeys.activeTab, activeTab);
  }, [activeTab, clientStorageHydrated]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    storeString(memberScopedStorageKey(recordListStorageKeys.avatarSeed, sessionMemberId), avatarSeed);
  }, [avatarSeed, clientStorageHydrated, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    storeJson(memberScopedStorageKey(recordListStorageKeys.avatarProfile, sessionMemberId), avatarProfile);
  }, [avatarProfile, clientStorageHydrated, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    return storeJsonWhenBrowserIdle(memberScopedStorageKey(recordListStorageKeys.localRecords, sessionMemberId), localRecords);
  }, [clientStorageHydrated, localRecords, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated) return;
    const reminderStorage = memberScopedStorage(window.localStorage, sessionMemberId);
    const systemFiredIds = new Set(readFiredLocalTaskReminderIds(reminderStorage));
    const inAppFiredIds = new Set<string>();
    let timer = 0;
    const checkReminders = () => {
      const systemNotificationsAllowed = "Notification" in window && Notification.permission === "granted";
      const suppressedIds = systemNotificationsAllowed
        ? systemFiredIds
        : new Set([...systemFiredIds, ...inAppFiredIds]);
      const dueReminders = buildDueLocalTaskReminders(localRecords, suppressedIds);
      for (const reminder of dueReminders) {
        window.dispatchEvent(new CustomEvent(localTaskReminderEventType, { detail: reminder }));
        if (systemNotificationsAllowed) systemFiredIds.add(reminder.id);
        else inAppFiredIds.add(reminder.id);
      }
      if (dueReminders.length && systemNotificationsAllowed) {
        writeFiredLocalTaskReminderIds(reminderStorage, systemFiredIds);
      }
      const nextSuppressedIds = systemNotificationsAllowed
        ? systemFiredIds
        : new Set([...systemFiredIds, ...inAppFiredIds]);
      timer = window.setTimeout(checkReminders, nextLocalTaskReminderDelay(localRecords, nextSuppressedIds));
    };
    timer = window.setTimeout(checkReminders, nextLocalTaskReminderDelay(localRecords, systemFiredIds));
    return () => window.clearTimeout(timer);
  }, [clientStorageHydrated, localRecords, sessionMemberId]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    return storeJsonWhenBrowserIdle(recordListStorageKeys.collapsedGroups, collapsedGroups);
  }, [clientStorageHydrated, collapsedGroups]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    storeString(recordListStorageKeys.selectedTaskId, selectedTaskId);
  }, [clientStorageHydrated, selectedTaskId]);

  useEffect(() => {
    if (!clientStorageHydrated) {
      return;
    }

    storeString(recordListStorageKeys.selectedResourceId, selectedResourceId);
  }, [clientStorageHydrated, selectedResourceId]);

  useEffect(
    () => () => {
      clearPendingDeleteToast(deleteToastTimerRef);
    },
    []
  );

  useEffect(() => {
    let active = true;

    const cancelIdleFetch = runWhenBrowserIdle(() => {
      Promise.all([fetchMetaEvents({ type: "group_chat_message" }), fetchMetaEvents({ type: "group_attachment_selected" })]).then((eventGroups) => {
        const events = eventGroups.flat();
        if (!active || events.length === 0) {
          return;
        }

        const messagesByRecordId = new Map<string, RoomMessage[]>();
        for (const event of events) {
          if (!event.record_id) {
            continue;
          }

          const messages = messagesByRecordId.get(event.record_id) || [];
          messages.push(...metaEventsToRoomMessages([event], currentMemberId));
          messagesByRecordId.set(event.record_id, messages);
        }

        setLocalRecords((currentRecords) =>
          currentRecords.map((record) => {
            const persistedMessages = messagesByRecordId.get(record.id);
            if (!persistedMessages?.length) {
              return record;
            }

            const knownMessageIds = new Set((record.chatMessages || []).map((message) => message.id));
            const nextMessages = [
              ...(record.chatMessages || []),
              ...persistedMessages.filter((message) => !knownMessageIds.has(message.id))
            ];

            return {
              ...record,
              chatMessages: nextMessages,
              updatedAt: "刚刚"
            };
          })
        );
      });
    });

    return () => {
      active = false;
      cancelIdleFetch();
    };
  }, []);

  function handleQuickCapture(text: string, suggestion: AssignmentSuggestion) {
    const isPersonalTodo = suggestion.personalTodo ?? isPersonalSuggestion(suggestion);
    const newRecord = createQuickRecord(text, suggestion, { ownerName: currentMemberName, personalTodo: isPersonalTodo });
    if (newRecord.dueAt) requestSystemNotificationPermission();
    setLocalRecords((currentRecords) => [newRecord, ...currentRecords]);
    void enqueueFamilyRecord(newRecord).catch(() => undefined);
    void enqueueMetaEvent({
      type: "task_created",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: newRecord.id,
      spaceId: newRecord.spaceId || coreSpaceId,
      text: newRecord.title,
      metadata: {
        sourceText: text,
        kind: newRecord.kind,
        status: newRecord.status,
        assignmentStatus: newRecord.assignmentStatus,
        assigneeMemberIds: newRecord.assigneeMemberIds || [],
        taskActionType: newRecord.taskActionType
      }
    });
    void enqueueMetaEvent({
      type: "composer_input",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: newRecord.id,
      spaceId: newRecord.spaceId || coreSpaceId,
      text,
      metadata: {
        activeTab,
        suggestionReason: suggestion.reason,
        suggestedRoles: suggestion.suggestedRoles
      }
    });
  }

  function handleAutomationRecords(displayTarget: AutomationDisplayTarget, payload: unknown) {
    if (!shouldApplyAutomationRecords(displayTarget)) {
      return;
    }

    const nextRecords = readAutomationRecordPayload(payload).filter((record) => recordMatchesDisplayTarget(record, displayTarget));
    if (!nextRecords.length) {
      return;
    }

    setLocalRecords((currentRecords) => {
      const nextById = new Map(nextRecords.map((record) => [record.id, record]));
      const knownIds = new Set(currentRecords.map((record) => record.id));
      const refreshedRecords = currentRecords.map((record) => nextById.get(record.id) || record);
      const freshRecords = nextRecords.filter((record) => !knownIds.has(record.id));
      return freshRecords.length ? [...freshRecords, ...refreshedRecords] : refreshedRecords;
    });

    for (const record of nextRecords) {
      void enqueueFamilyRecord(record).catch(() => undefined);
    }
  }

  function handleCreateGroupChatTask(sourceText = "", options: CreateGroupChatOptions = {}): CreateGroupChatResult {
    const intent = compileComposerIntent(sourceText);
    const title = options.title || (intent.action === "create_group_chat" ? intent.fields.title : "临时群聊邀请");
    const chatMembers = buildMentionOnlyGroupMemberIds(currentMemberId, options.memberIds || []);
    const isFamilyGroup = !options.guestInvite;
    const matchingGroup = options.reuseMatchingMembers !== false && options.memberIds?.length
      ? groupRecords.find((record) =>
          record.audience !== "guest" &&
          Boolean(record.chatMembers?.length) &&
          haveSameGroupMemberIds(record.chatMembers || [], chatMembers)
        )
      : null;
    if (matchingGroup) {
      setSelectedTaskId(matchingGroup.id);
      return { recordId: matchingGroup.id, reused: true, title: matchingGroup.title };
    }
    const inviteLink = isFamilyGroup ? undefined : createGuestChatLink();
    const newRecord: FamilyRecord = {
      id: crypto.randomUUID(),
      kind: "task",
      title,
      summary: sourceText.trim() || (isFamilyGroup ? `家庭群聊：${title}` : "长按复制链接，发给别人后进入独立聊天空间"),
      ownerName: currentMemberName,
      createdByMemberId: currentMemberId,
      assigneeMemberIds: [],
      spaceId: coreSpaceId,
      audience: isFamilyGroup ? "core" : "guest",
      assignmentStatus: "assigned",
      assignmentReason: isFamilyGroup ? "通过首页成员提及创建家庭群聊" : "创建了一个非家人群聊入口",
      inviteLink,
      chatMembers,
      chatMessages: options.initialMessages || [],
      status: "todo",
      updatedAt: "刚刚",
      tags: ["群组"]
    };
    setLocalRecords((currentRecords) => [newRecord, ...currentRecords]);
    if (inviteLink) {
      setInviteTaskId(newRecord.id);
      void registerGuestChatInvite(newRecord);
    }
    if (options.openAfterCreate) {
      setSelectedTaskId(newRecord.id);
    }
    void enqueueFamilyRecord(newRecord).catch(() => undefined);
    void enqueueMetaEvent({
      type: "composer_input",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: newRecord.id,
      spaceId: newRecord.spaceId || coreSpaceId,
      text: newRecord.title,
      metadata: {
        action: options.initialMessages?.length ? "create_contextual_group" : "create_group_chat",
        sourceText,
        intent,
        inviteLink
      }
    });
    return { recordId: newRecord.id, reused: false, title: newRecord.title };
  }

  async function createTaskFromDecision(decision: FamilyDecision, selectedTitle?: string) {
    const title = selectedTitle || decision.summaryJson?.recommendation;
    if (!title || title === "未形成唯一多数") return;
    const task: FamilyRecord = {
      id: crypto.randomUUID(),
      kind: "task",
      title,
      summary: `来自家庭决定：${decision.question}`,
      ownerName: currentMemberName,
      createdByMemberId: currentMemberId,
      assigneeMemberIds: decision.participants.map((item) => item.memberId),
      spaceId: coreSpaceId,
      audience: "core",
      assignmentStatus: "assigned",
      assignmentReason: "家庭决定采纳方案",
      taskActionType: "approval",
      status: "todo",
      updatedAt: "刚刚",
      tags: ["任务", "家庭决定"]
    };
    setLocalRecords((current) => [task, ...current]);
    const saved = await enqueueFamilyRecord(task);
    if (!saved?.id) {
      setLocalRecords((current) => current.filter((item) => item.id !== task.id));
      throw new Error("任务保存失败，家庭决定仍未采纳。");
    }
    const adopted = await familyFetch(`/api/family-decisions/${encodeURIComponent(decision.id)}/adopt`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: saved.id })
    });
    if (!adopted.ok) throw new Error("任务已保存，但家庭决定关联失败。");
    setSelectedTaskId(task.id);
  }

  function handleChatMessagesChange(recordId: string, messages: RoomMessage[]) {
    setLocalRecords((currentRecords) =>
      currentRecords.map((record) => {
        if (record.id !== recordId) {
          return record;
        }

        const nextRecord = {
          ...record,
          chatMessages: messages,
          updatedAt: "刚刚"
        };
        void enqueueFamilyRecord(nextRecord).catch(() => undefined);
        return nextRecord;
      })
    );
  }

  function handleChatMembersChange(recordId: string, memberIds: string[]) {
    setLocalRecords((currentRecords) =>
      currentRecords.map((record) => {
        if (record.id !== recordId) {
          return record;
        }

        const nextRecord = {
          ...record,
          chatMembers: memberIds,
          updatedAt: "刚刚"
        };
        void enqueueFamilyRecord(nextRecord).catch(() => undefined);
        return nextRecord;
      })
    );
  }

  function handleChatTitleChange(recordId: string, title: string) {
    setLocalRecords((currentRecords) =>
      currentRecords.map((record) => (record.id === recordId ? { ...record, title, updatedAt: "刚刚" } : record))
    );
  }

  function handleSaveChatMessagesAsResources(chatRecord: FamilyRecord, messagesToSave: RoomMessage[]) {
    const savedAt = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const resources = buildResourcesFromChatMessages(chatRecord, messagesToSave, displayMembers, membersById, savedAt);
    if (resources.length === 0) {
      return;
    }

    setLocalRecords((currentRecords) => [...resources, ...currentRecords]);
    for (const resource of resources) {
      void enqueueFamilyRecord(resource).catch(() => undefined);
    }
    for (const resource of resources) {
      void enqueueMetaEvent({
        type: "resource_saved",
        actorMemberId: currentMemberId,
        actorName: currentMemberName,
        recordId: resource.id,
        spaceId: coreSpaceId,
        text: resource.title,
        metadata: {
          action: "save_group_message_as_resource",
          chatRecordId: chatRecord.id,
          chatTitle: chatRecord.title,
          sourceMessageIds: messagesToSave.map((message) => message.id),
          resource
        }
      });
    }
  }

  async function handleUploadResources(files: File[]) {
    const validationResults = files.map((file) => ({ file, validation: validateResourceUploadFile(file) }));
    const acceptedFiles = validationResults.filter((item) => item.validation.ok).map((item) => item.file);
    const rejectedMessages = validationResults.flatMap((item) => item.validation.ok ? [] : [item.validation.message]);
    if (acceptedFiles.length === 0) {
      const answer = rejectedMessages.join("\n") || `没有可上传的文件。单个文件最大 ${RESOURCE_UPLOAD_MAX_LABEL}。`;
      return { answer, state: "error", voiceStatus: "附件未上传" } satisfies ResourceUploadOutcome;
    }

    const uploadedAt = new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const contentHashes = await Promise.all(acceptedFiles.map(hashResourceFile));
    const uploadBatchId = `resource-upload-${Date.now()}`;
    const pendingResources = acceptedFiles.map((file, index) => {
      const assetType = assetTypeFromFile(file);
      const localPreviewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      return {
        id: createResourceId(),
        kind: assetType === "photo" || assetType === "video" || assetType === "audio" ? "media" : "note",
        title: stripFileExtension(file.name),
        summary: `我上传 · ${uploadedAt}`,
        ownerName: currentMemberName,
        ownerMemberId: currentMemberId,
        createdByMemberId: currentMemberId,
        spaceId: coreSpaceId,
        audience: "core",
        assignmentStatus: "accepted",
        assignmentReason: "从任务页附件加入资料",
        assetType,
        fileName: file.name,
        previewUrl: localPreviewUrl,
        sourceFiles: [
          {
            cacheUrl: localPreviewUrl,
            contentHash: contentHashes[index],
            name: file.name,
            previewUrl: localPreviewUrl,
            size: file.size,
            storage: "local-upload",
            type: file.type,
          }
        ],
        sourceAvatarSeed: avatarSeed,
        sourceMemberId: currentMemberId,
        status: "saved",
        updatedAt: uploadedAt,
        uploadProgress: 0,
        uploadState: "uploading",
        tags: ["资料", formatAssetType({ assetType } as FamilyRecord)]
      } satisfies FamilyRecord;
    });

    setLocalRecords((currentRecords) => [...pendingResources, ...currentRecords]);
    setCollapsedGroups((current) => ({ ...current, 资料: false }));
    try {
      const { uploadFilesWithTus } = await import("@/lib/uploadQueue");
      const uploadedFiles = await uploadFilesWithTus(acceptedFiles, {
        messageId: uploadBatchId,
        onFileProgress: (fileIndex, progress) => {
          const pendingId = pendingResources[fileIndex]?.id;
          if (!pendingId) return;
          setLocalRecords((currentRecords) => currentRecords.map((record) =>
            record.id === pendingId ? { ...record, uploadProgress: progress } : record
          ));
        }
      });
      const completedResources = pendingResources.map((pendingResource, index) => {
        const uploadedFile = uploadedFiles[index];
        if (!uploadedFile) return { ...pendingResource, uploadState: "error" as const };
        const persistentPreviewUrl = readPersistentPreviewUrl(uploadedFile);
        const originalUrl = readOriginalFileUrl(uploadedFile);
        return {
          ...pendingResource,
          previewUrl: persistentPreviewUrl,
          sourceFiles: [{
            contentHash: contentHashes[index],
            name: acceptedFiles[index].name,
            originalUrl,
            previewUrl: persistentPreviewUrl,
            thumbnailUrl: uploadedFile.thumbnailUrl,
            size: acceptedFiles[index].size,
            storage: uploadedFile.storage || "tus",
            type: acceptedFiles[index].type,
            url: uploadedFile.url
          }],
          uploadProgress: undefined,
          uploadState: undefined
        } satisfies FamilyRecord;
      });
      const completedById = new Map(completedResources.map((resource) => [resource.id, resource]));
      setLocalRecords((currentRecords) => currentRecords.map((record) => completedById.get(record.id) || record));
      const assistantParts = [...rejectedMessages];
      let activeResource: Pick<FamilyRecord, "id" | "title"> | undefined;
      for (const resource of completedResources.filter((record) => record.uploadState !== "error")) {
        const saveResult = await enqueueFamilyRecord(resource).catch(() => null);
        if (!saveResult) {
          assistantParts.push(`《${resource.title}》上传完成，但保存记录失败，请重试。`);
          continue;
        }
        const savedResource = saveResult.record || { ...resource, id: saveResult.id };
        activeResource = { id: savedResource.id, title: savedResource.title };
        if (saveResult.deduplicated) {
          setLocalRecords((currentRecords) => currentRecords.filter((record) => record.id !== resource.id));
          assistantParts.push(`《${savedResource.title}》已经在资料库里，本次没有重复保存。`);
        }
        await enqueueMetaEvent({
          type: "resource_uploaded",
          actorMemberId: currentMemberId,
          actorName: currentMemberName,
          recordId: savedResource.id,
          spaceId: coreSpaceId,
          text: savedResource.title,
          metadata: {
            action: "upload_resource_from_task_page",
            concurrency: tusUploadConcurrency,
            inputText: resource.title,
            protocol: "tus",
            contentHash: savedResource.sourceFiles?.[0]?.contentHash,
            deduplicated: Boolean(saveResult.deduplicated),
            resource: savedResource
          }
        });
        const sourceFile = savedResource.sourceFiles?.[0];
        if (sourceFile && isAnalyzableDocumentFile(sourceFile)) {
          const insight = await requestResourceInsight(savedResource);
          if (insight) {
            assistantParts.push([insight.analysisText, insight.question].filter(Boolean).join("\n"));
          } else {
            assistantParts.push(`《${savedResource.title}》已保存并记录到本次 AI 对话，但解析服务暂时没有返回结果。`);
          }
        } else {
          assistantParts.push(`已保存图片《${savedResource.title}》，并记录到本次 AI 对话。`);
        }
      }
      const failedCount = completedResources.filter((record) => record.uploadState === "error").length;
      if (failedCount > 0) assistantParts.push(`${failedCount} 个附件上传失败，请重试。`);
      const answer = assistantParts.join("\n\n");
      window.setTimeout(() => pendingResources.forEach((resource) => {
        const localUrl = resource.previewUrl;
        if (localUrl?.startsWith("blob:")) URL.revokeObjectURL(localUrl);
      }), 1_000);
      return {
        activeResource,
        answer,
        state: "done",
        voiceStatus: `已加入资料 ${completedResources.length - failedCount}`
      } satisfies ResourceUploadOutcome;
    } catch (error) {
      const pendingIds = new Set(pendingResources.map((resource) => resource.id));
      setLocalRecords((currentRecords) => currentRecords.map((record) =>
        pendingIds.has(record.id) ? { ...record, uploadState: "error" } : record
      ));
      const answer = error instanceof Error ? `附件上传失败：${error.message}` : "附件上传失败，请重试。";
      return { answer, state: "error", voiceStatus: "附件上传失败" } satisfies ResourceUploadOutcome;
    }
  }

  async function handleCreateTaskFromChatMessage(message: RoomMessage) {
    const sourceMember = resolveMessageMember(message, displayMembers, membersById);
    const localSuggestion = suggestAssignment(message.body, displayMembers, sourceMember.id, []);
    const suggestion = (await requestAssignmentSuggestion(message.body, [], "群聊", 4200)) || localSuggestion;
    const taskRecord = {
      ...createQuickRecord(message.body, suggestion),
      id: `chat-task-${Date.now()}`,
      ownerName: message.senderName,
      createdByMemberId: message.senderMemberId || sourceMember.id,
      summary: `来自 ${message.senderName} 的群聊文字 · ${suggestion.reason}`,
      assignmentReason: suggestion.reason,
      sourceAvatarSeed: message.senderAvatarSeed || sourceMember.avatarSeed,
      sourceMemberId: message.senderMemberId || sourceMember.id,
      sourceMessageId: message.id
    } satisfies FamilyRecord;

    setLocalRecords((currentRecords) => [taskRecord, ...currentRecords]);
    setSelectedTaskId(taskRecord.id);
    void enqueueFamilyRecord(taskRecord).catch(() => undefined);
    void enqueueMetaEvent({
      type: "task_created",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: taskRecord.id,
      spaceId: taskRecord.spaceId || coreSpaceId,
      text: taskRecord.title,
      metadata: {
        action: "create_task_from_group_message",
        sourceMessage: message,
        suggestion,
        taskRecord
      }
    });
  }

  function setGroupCollapsed(title: string, collapsed: boolean) {
    setCollapsedGroups((current) => (current[title] === collapsed ? current : { ...current, [title]: collapsed }));
  }

  function syncNativeGroupToggle(title: string, open: boolean) {
    setGroupCollapsed(title, !open);
  }

  function logDeletedRecord(deletedRecord: FamilyRecord) {
    void enqueueMetaEvent({
      type: "record_deleted",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: deletedRecord.id,
      spaceId: deletedRecord.spaceId || coreSpaceId,
      text: deletedRecord.title,
      metadata: {
        kind: deletedRecord.kind,
        status: deletedRecord.status,
        tags: deletedRecord.tags
      }
    });
  }

  function removeRecordFromLocalState(recordId: string) {
    setLocalRecords((currentRecords) => currentRecords.filter((record) => record.id !== recordId));
    setSelectedTaskId((currentId) => (currentId === recordId ? null : currentId));
    setInviteTaskId((currentId) => (currentId === recordId ? null : currentId));
    setSelectedResourceId((currentId) => (currentId === recordId ? null : currentId));
    setExpandedSwipeTask((current) => (current?.id === recordId ? null : current));
    setSelectedRecordIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.delete(recordId);
      return nextIds;
    });
  }

  function restoreRecordToLocalState(record: FamilyRecord, recordIndex = 0) {
    setLocalRecords((currentRecords) => {
      if (currentRecords.some((item) => item.id === record.id)) return currentRecords;
      const nextRecords = [...currentRecords];
      nextRecords.splice(Math.min(recordIndex, nextRecords.length), 0, record);
      return nextRecords;
    });
  }

  function persistRecordDeletion(record: FamilyRecord, recordIndex = 0) {
    pendingRecordDeletionIdsRef.current.add(record.id);
    const request = deleteFamilyRecord(record.id).catch(() => false);
    void request.then((deleted) => {
      pendingRecordDeletionIdsRef.current.delete(record.id);
      if (!deleted) restoreRecordToLocalState(record, recordIndex);
    });
    return request;
  }

  function handleDeleteRecord(recordId: string) {
    const recordIndex = localRecords.findIndex((record) => record.id === recordId);
    const deletedRecord = localRecords.find((record) => record.id === recordId);
    removeRecordFromLocalState(recordId);
    if (deletedRecord) {
      logDeletedRecord(deletedRecord);
      void persistRecordDeletion(deletedRecord, Math.max(0, recordIndex));
    }
  }

  function handleSoftDeleteTask(recordId: string) {
    const recordIndex = localRecords.findIndex((record) => record.id === recordId);
    const deletedRecord = localRecords[recordIndex];
    if (!deletedRecord) {
      return;
    }

    if (swipeToast?.type === "deleted" && swipeToast.record) {
      logDeletedRecord(swipeToast.record);
      softDeleteRequestsRef.current.delete(swipeToast.record.id);
    }
    clearPendingDeleteToast(deleteToastTimerRef);
    removeRecordFromLocalState(recordId);
    const deleteRequest = persistRecordDeletion(deletedRecord, recordIndex);
    softDeleteRequestsRef.current.set(recordId, deleteRequest);
    setSwipeToast({
      id: `deleted-${recordId}-${Date.now()}`,
      message: "已删除，可撤销",
      record: deletedRecord,
      recordIndex,
      type: "deleted"
    });
    deleteToastTimerRef.current = setTimeout(() => {
      logDeletedRecord(deletedRecord);
      softDeleteRequestsRef.current.delete(recordId);
      setSwipeToast((current) => (current?.type === "deleted" && current.record?.id === recordId ? null : current));
      deleteToastTimerRef.current = null;
    }, 5200);
  }

  function handleUndoSoftDelete() {
    if (swipeToast?.type !== "deleted" || !swipeToast.record) {
      return;
    }

    const { record, recordIndex = 0 } = swipeToast;
    const deleteRequest = softDeleteRequestsRef.current.get(record.id);
    softDeleteRequestsRef.current.delete(record.id);
    clearPendingDeleteToast(deleteToastTimerRef);
    restoreRecordToLocalState(record, recordIndex);
    if (deleteRequest) {
      void deleteRequest.then((deleted) => {
        if (deleted) void enqueueFamilyRecord(record);
      });
    }
    setSwipeToast(null);
  }

  function handleCompleteTask(recordId: string) {
    const completedRecord = localRecords.find((record) => record.id === recordId);
    if (!completedRecord || pendingRecordStatusRef.current.has(recordId)) return;
    const restoringTask = completedRecord?.status === "done";
    const completedTask = completedRecord
      ? {
          ...completedRecord,
          assignmentStatus: restoringTask ? "assigned" as const : "done" as const,
          status: restoringTask ? "todo" as const : "done" as const,
          taskResponses: (completedRecord.taskResponses || []).map((response) =>
            restoringTask && response.status === "accepted" && response.text === "已完成"
              ? { ...response, status: "pending" as const, text: "", updatedAt: "刚刚" }
              : response.status === "pending"
              ? { ...response, status: "accepted" as const, text: response.text || "已完成", updatedAt: "刚刚" }
              : response
          ),
          updatedAt: "刚刚"
        }
      : null;
    if (!completedTask) return;
    pendingRecordStatusRef.current.set(recordId, completedTask.status);
    setLocalRecords((currentRecords) =>
      currentRecords.map((record) => {
        if (record.id !== recordId) {
          return record;
        }

        return {
          ...record,
          assignmentStatus: restoringTask ? "assigned" : "done",
          status: restoringTask ? "todo" : "done",
          taskResponses: (record.taskResponses || []).map((response) =>
            restoringTask && response.status === "accepted" && response.text === "已完成"
              ? { ...response, status: "pending", text: "", updatedAt: "刚刚" }
              : response.status === "pending" ? { ...response, status: "accepted", text: response.text || "已完成", updatedAt: "刚刚" } : response
          ),
          updatedAt: "刚刚"
        };
      })
    );
    setExpandedSwipeTask((current) => (current?.id === recordId ? null : current));
    const completedToastId = `completed-${recordId}-${Date.now()}`;
    setSwipeToast({
      id: completedToastId,
      message: restoringTask ? "已复原为待办" : "已完成",
      type: "completed"
    });
    window.setTimeout(() => {
      setSwipeToast((current) => (current?.id === completedToastId ? null : current));
    }, 2400);
    if (completedRecord) {
      void (async () => {
        let saved = false;
        try {
          saved = await updateFamilyRecord(completedTask);
        } catch {
          saved = false;
        } finally {
          pendingRecordStatusRef.current.delete(recordId);
        }
        if (!saved) {
          setLocalRecords((currentRecords) => currentRecords.map((record) => record.id === recordId ? completedRecord : record));
        }
      })();
      void enqueueMetaEvent({
        type: restoringTask ? "task_reopened" : "task_completed",
        actorMemberId: currentMemberId,
        actorName: currentMemberName,
        recordId,
        spaceId: completedRecord.spaceId || coreSpaceId,
        text: restoringTask ? "右滑复原" : "右滑完成",
        metadata: {
          action: restoringTask ? "swipe_restore" : "swipe_complete",
          status: restoringTask ? "todo" : "done",
          recordTitle: completedRecord.title
        }
      });
    }
  }

  function handleStartResourceSelection(recordId: string) {
    const record = localRecords.find((item) => item.id === recordId);
    if (!record || !["image", "document"].includes(resourceColumnKind(record))) return;
    blurActiveTextEntry();
    setSelectedRecordIds(new Set([recordId]));
    setMultiSelectMode(true);
  }

  function handleDownloadSelectedResources() {
    const selectedResources = localRecords.filter((record) => selectedRecordIds.has(record.id));
    selectedResources.forEach((record, index) => {
      window.setTimeout(() => void downloadResourceRecord(record), index * 160);
    });
    setSelectedRecordIds(new Set());
    setMultiSelectMode(false);
  }

  function handleDeleteSelectedResources() {
    const selectedResources = localRecords.filter((record) => selectedRecordIds.has(record.id));
    if (!selectedResources.length) return;
    const selectedIds = new Set(selectedResources.map((record) => record.id));
    setLocalRecords((currentRecords) => currentRecords.filter((record) => !selectedIds.has(record.id)));
    selectedResources.forEach((record) => {
      logDeletedRecord(record);
      void persistRecordDeletion(record, Math.max(0, localRecords.findIndex((item) => item.id === record.id)));
    });
    setSelectedResourceId((currentId) => currentId && selectedIds.has(currentId) ? null : currentId);
    setSelectedRecordIds(new Set());
    setMultiSelectMode(false);
  }

  function handleToggleSelectedRecord(recordId: string) {
    setSelectedRecordIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(recordId)) {
        nextIds.delete(recordId);
      } else {
        nextIds.add(recordId);
      }
      return nextIds;
    });
  }

  function handleCancelMultiSelect() {
    setMultiSelectMode(false);
    setSelectedRecordIds(new Set());
  }

  function handleTaskResponse(recordId: string, response: TaskResponse) {
    setLocalRecords((currentRecords) =>
      currentRecords.map((record) => {
        if (record.id !== recordId) {
          return record;
        }

        const responses = record.taskResponses || [];
        const nextResponses = responses.some((item) => item.memberId === response.memberId)
          ? responses.map((item) => (item.memberId === response.memberId ? response : item))
          : [...responses, response];
        const allDone = nextResponses.length > 0 && nextResponses.every((item) => item.status !== "pending");

        const nextRecord = {
          ...record,
          assignmentStatus: allDone ? "done" : record.assignmentStatus,
          status: allDone ? "done" : record.status,
          taskResponses: nextResponses
        };
        void updateFamilyRecord(nextRecord).catch(() => false);
        return nextRecord;
      })
    );
    const record = localRecords.find((item) => item.id === recordId);
    void enqueueMetaEvent({
      type: "task_response",
      actorMemberId: response.memberId,
      actorName: response.memberName,
      recordId,
      spaceId: record?.spaceId || coreSpaceId,
      text: response.text || response.choices?.join("、") || response.status,
      metadata: {
        recordTitle: record?.title,
        response
      }
    });
  }

  function openRelatedRecord(link: AssistantResultLink) {
    if (link.kind === "web" && link.url) {
      window.open(link.url, "_blank", "noopener,noreferrer");
      return;
    }

    const record = localRecords.find((item) => item.id === link.id);
    if (!record) {
      return;
    }

    if (link.kind === "resource" || ["note", "link", "media"].includes(record.kind)) {
      setSelectedResourceId(record.id);
      return;
    }

    if (link.kind === "group" || record.inviteLink) {
      setSelectedTaskId(record.id);
      return;
    }

    setSelectedTaskId(record.id);
  }

  const cycleTaskSort = useCallback(() => {
    setExpandedSwipeTask(null);
    setTaskSortMode((current) => taskSortModes[(taskSortModes.indexOf(current) + 1) % taskSortModes.length]);
  }, []);

  return (
    <section
      className="record-list"
      aria-label="家庭记录"
      onClick={(event) => {
        if (event.target instanceof Element && !event.target.closest(".task-swipe-shell")) {
          setExpandedSwipeTask(null);
        }
      }}
    >
      <FamilyStatusDashboard
        currentMemberId={sessionMemberId}
        currentMemberName={currentMemberName}
        familyName={familyName}
        members={displayMembers}
        onAskAssistant={(text) => window.dispatchEvent(new CustomEvent(familyAssistantPrefillEvent, { detail: { text } }))}
        onOpenRecord={(record) => {
          if (record.kind === "task" || isGroupChatRecord(record)) setSelectedTaskId(record.id);
          else setSelectedResourceId(record.id);
        }}
        records={localRecords}
      />
      <details className="family-library">
        <summary>查看任务、群聊与资料</summary>
        <div className="family-library-content">
      <RecordGroup
        collapsed={Boolean(collapsedGroups["任务"])}
        collapsible
        expandedSwipeTask={expandedSwipeTask}
        membersById={membersById}
        onCompleteTask={handleCompleteTask}
        onCycleTaskSort={cycleTaskSort}
        onDeleteRecord={handleSoftDeleteTask}
        onExpandSwipeTask={(recordId, side) => setExpandedSwipeTask(recordId && side ? { id: recordId, side } : null)}
        onLongPressTask={ignoreRecordAction}
        onOpenTask={setSelectedTaskId}
        onToggleSelectedRecord={handleToggleSelectedRecord}
        onToggleCollapse={syncNativeGroupToggle}
        records={sortedTaskRecords}
        selectedRecordIds={selectedRecordIds}
        selectionMode={false}
        sortLabel={taskSortLabels[taskSortMode]}
        title="任务"
        variant="inbox"
      />
      <details
        className={collapsedGroups["群组"] ? "record-group collapsed" : "record-group"}
        data-feature="groups"
        open={!collapsedGroups["群组"]}
        onToggle={(event) => syncNativeGroupToggle("群组", event.currentTarget.open)}
      >
        <summary aria-expanded={!collapsedGroups["群组"]} className="record-group-toggle">
          <span>{formatSectionTitle("群组", groupRecords.length, Boolean(collapsedGroups["群组"]))}</span>
        </summary>
        <div className="record-group-body">
          <GroupChatList
            membersById={membersById}
            onDeleteRecord={handleSoftDeleteTask}
            onLongPressChat={ignoreRecordAction}
            onOpenChat={setSelectedTaskId}
            records={groupRecords}
            selectionMode={false}
          />
        </div>
      </details>
      <RecordGroup
        collapsed={Boolean(collapsedGroups["资料"])}
        collapsible
        membersById={membersById}
        onDeleteRecord={handleDeleteRecord}
        onLongPressTask={handleStartResourceSelection}
        onOpenTask={setSelectedResourceId}
        onToggleSelectedRecord={handleToggleSelectedRecord}
        onToggleCollapse={syncNativeGroupToggle}
        records={resourceRecords}
        selectedRecordIds={selectedRecordIds}
        selectionMode={multiSelectMode}
        title="资料"
        variant="source"
      />
        </div>
      </details>

      <CaptureComposer
        accountSettingsToken={accountSettingsToken}
        activeTab={activeTab}
        aiConnectedToken={aiConnectedToken}
        avatarProfile={avatarProfile}
        avatarSeed={avatarSeed}
        resumeFocusToken={composerResumeToken}
        members={displayMembers}
        onAvatarSettingsSave={(profile, seed) => {
          setAvatarProfile(profile);
          setAvatarSeed(seed);
          void syncMemberProfile(profile, seed);
        }}
        onCreateGroupChatTask={handleCreateGroupChatTask}
        onAutomationRecords={handleAutomationRecords}
        onOpenRelatedRecord={openRelatedRecord}
        onQuickCapture={handleQuickCapture}
        onUploadResources={handleUploadResources}
        records={localRecords}
        suspended={Boolean(selectedTaskHasOverlay || selectedResource || inviteTask || multiSelectMode || settingsOpen)}
      />
      <SettingsDrawer
        authRequired={!trialMode}
        currentMemberId={sessionMemberId}
        isFamilyAdmin={sessionRole === "admin"}
        members={displayMembers}
        open={settingsOpen}
        onAiConnected={() => {
          closeSettings();
          setAiConnectedToken((value) => value + 1);
        }}
        onClose={closeSettings}
        onOpen={openSettings}
        onOpenAccount={() => setAccountSettingsToken((value) => value + 1)}
        onMemberRemoved={(memberId) => setPerspectiveMembers((current) => current.filter((member) => member.id !== memberId))}
        onMemberUpdated={(memberId, profile) => setPerspectiveMembers((current) => current.map((member) => member.id === memberId ? { ...member, profile: { ...(member.profile || {}), ...profile } } : member))}
        onSignOut={() => void handleSignOutAccount()}
      />
      {selectedTask && selectedTaskHasOverlay ? (
        selectedTask.inviteLink || selectedTask.chatMembers?.length ? (
          <ChatFullscreen
            key={selectedTask.id}
            link={selectedTask.inviteLink}
            membersById={membersById}
            suppressInputFocus={settingsOpen}
            onClose={closeSelectedChat}
            onMessagesChange={(messages) => handleChatMessagesChange(selectedTask.id, messages)}
            onMembersChange={(memberIds) => handleChatMembersChange(selectedTask.id, memberIds)}
            onCreateTaskFromMessage={(message) => void handleCreateTaskFromChatMessage(message)}
            onCreateTaskFromDecision={createTaskFromDecision}
            onSaveMessagesAsResources={(messages) => handleSaveChatMessagesAsResources(selectedTask, messages)}
            onTitleChange={(title) => handleChatTitleChange(selectedTask.id, title)}
            record={selectedTask}
          />
        ) : (
          <TaskActionSheet
            membersById={membersById}
            onClose={closeSelectedTask}
            onComplete={() => {
              handleCompleteTask(selectedTask.id);
              closeSelectedTask();
            }}
            onDelete={() => {
              handleSoftDeleteTask(selectedTask.id);
              closeSelectedTask();
            }}
            onRespond={(response) => handleTaskResponse(selectedTask.id, response)}
            record={selectedTask}
          />
        )
      ) : null}
      {inviteTask?.inviteLink ? <InviteLinkSheet record={inviteTask} onClose={closeInviteTask} /> : null}
      {multiSelectMode ? (
        <ResourceSelectionBar
          count={selectedRecordIds.size}
          onCancel={handleCancelMultiSelect}
          onDelete={handleDeleteSelectedResources}
          onDownload={handleDownloadSelectedResources}
        />
      ) : null}
      {selectedResource ? <ResourcePreviewSheet onClose={closeSelectedResource} record={selectedResource} /> : null}
      {swipeToast ? (
        <div className={`swipe-toast ${swipeToast.type}`} role="status">
          <span>{swipeToast.message}</span>
          {swipeToast.type === "deleted" ? (
            <button type="button" onClick={handleUndoSoftDelete}>
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type RecordGroupProps = {
  collapsed?: boolean;
  collapsible?: boolean;
  expandedSwipeTask?: ExpandedSwipeTask | null;
  membersById: Map<string, FamilyMember>;
  onCompleteTask?: (recordId: string) => void;
  onCycleTaskSort?: () => void;
  onDeleteRecord: (recordId: string) => void;
  onExpandSwipeTask?: (recordId: string | null, side?: "complete" | "delete") => void;
  onLongPressTask: (recordId: string) => void;
  onOpenTask: (recordId: string) => void;
  onToggleSelectedRecord: (recordId: string) => void;
  onToggleCollapse?: (title: string, open: boolean) => void;
  records: FamilyRecord[];
  selectedRecordIds: Set<string>;
  selectionMode: boolean;
  sortLabel?: string;
  title: string;
  variant: "inbox" | "summary" | "source";
  displayCount?: number;
};

const RecordGroup = memo(function RecordGroup({
  collapsed = false,
  collapsible = false,
  expandedSwipeTask = null,
  membersById,
  onCompleteTask,
  onCycleTaskSort,
  onDeleteRecord,
  onExpandSwipeTask,
  onLongPressTask,
  onOpenTask,
  onToggleSelectedRecord,
  onToggleCollapse,
  records,
  selectedRecordIds,
  selectionMode,
  sortLabel,
  title,
  variant,
  displayCount
}: RecordGroupProps) {
  const feature = featureForSection(title);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousRowPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const sortTouchRef = useRef<{ x: number; y: number } | null>(null);
  const suppressSummaryClickRef = useRef(false);
  const [completedTasksExpanded, setCompletedTasksExpanded] = useState(false);

  useLayoutEffect(() => {
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-record-sort-id]") || []);
    const nextPositions = new Map(rows.map((row) => [row.dataset.recordSortId || "", row.getBoundingClientRect()]));
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      rows.forEach((row, index) => {
        const id = row.dataset.recordSortId || "";
        const previous = previousRowPositionsRef.current.get(id);
        const next = nextPositions.get(id);
        const delta = previous && next ? previous.top - next.top : 0;
        if (Math.abs(delta) < 1) return;
        row.animate(
          [{ transform: `translate3d(0, ${delta}px, 0)`, opacity: 0.78 }, { transform: "translate3d(0, 0, 0)", opacity: 1 }],
          { duration: 380 + Math.min(index * 18, 110), easing: "cubic-bezier(.2,.9,.25,1)", fill: "both" }
        );
      });
    }
    previousRowPositionsRef.current = nextPositions;
  }, [records]);

  function handleSortTouchStart(event: TouchEvent<HTMLElement>) {
    if (!onCycleTaskSort || event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".record-group-toggle")) return;
    sortTouchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  function handleSortTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = sortTouchRef.current;
    sortTouchRef.current = null;
    if (!start || !onCycleTaskSort || event.changedTouches.length !== 1) return;
    const deltaX = event.changedTouches[0].clientX - start.x;
    const deltaY = event.changedTouches[0].clientY - start.y;
    if (deltaY < 64 || Math.abs(deltaX) > Math.min(72, deltaY * 0.65)) return;
    suppressSummaryClickRef.current = true;
    event.preventDefault();
    onCycleTaskSort();
  }

  const completedTaskRecords = variant === "inbox" ? records.filter(isCompletedTaskRecord) : [];
  const visibleRecords = variant === "inbox" ? records.filter((record) => !isCompletedTaskRecord(record)) : records;
  const renderRecord = (record: FamilyRecord) => (
    <div className="record-action-wrap" data-record-sort-id={record.id} key={record.id}>
      <RecordRow
        membersById={membersById}
        onCompleteTask={onCompleteTask || (() => undefined)}
        onDeleteRecord={onDeleteRecord}
        onExpandSwipeTask={onExpandSwipeTask || (() => undefined)}
        onLongPressTask={onLongPressTask}
        onOpenTask={onOpenTask}
        onToggleSelectedRecord={onToggleSelectedRecord}
        record={record}
        swipeExpandedSide={expandedSwipeTask?.id === record.id ? expandedSwipeTask.side : null}
        selected={selectedRecordIds.has(record.id)}
        selectionMode={selectionMode}
        variant={variant}
      />
    </div>
  );

  const groupContent = variant === "source" ? (
    records.length ? (
      <div className="record-group-body resource-columns-body" ref={bodyRef}>
        <ResourceColumns
          onLongPressResource={onLongPressTask}
          onOpenResource={onOpenTask}
          onToggleSelectedRecord={onToggleSelectedRecord}
          records={records}
          selectedRecordIds={selectedRecordIds}
          selectionMode={selectionMode}
        />
      </div>
    ) : null
  ) : (
    <div className="record-group-body" ref={bodyRef}>
      {visibleRecords.map(renderRecord)}
      {completedTaskRecords.length ? (
        <div className="completed-task-group">
          <button
            aria-expanded={completedTasksExpanded}
            className="completed-task-toggle"
            onClick={() => setCompletedTasksExpanded((expanded) => !expanded)}
            type="button"
          >
            <span className="completed-task-label">
              <span>已完成</span>
              <em>{completedTaskRecords.length}</em>
            </span>
            <span aria-hidden="true" className="completed-task-expand-symbol">
              {completedTasksExpanded ? (
                <svg viewBox="0 0 12 12"><path d="M2.5 6h7" /></svg>
              ) : (
                <svg viewBox="0 0 12 12"><path d="M2.5 6h7M6 2.5v7" /></svg>
              )}
            </span>
          </button>
          {completedTasksExpanded ? <div className="completed-task-list">{completedTaskRecords.map(renderRecord)}</div> : null}
        </div>
      ) : null}
    </div>
  );

  if (collapsible) {
    return (
      <details
        className={collapsed ? "record-group collapsed" : "record-group"}
        data-feature={feature}
        open={!collapsed}
        onToggle={(event) => onToggleCollapse?.(title, event.currentTarget.open)}
        onTouchEnd={handleSortTouchEnd}
        onTouchStart={handleSortTouchStart}
      >
        <summary aria-expanded={!collapsed} className="record-group-toggle" onClick={(event) => { if (suppressSummaryClickRef.current) { suppressSummaryClickRef.current = false; event.preventDefault(); } }}>
          <span>{formatSectionTitle(title, displayCount ?? records.length, collapsed, sortLabel)}</span>
        </summary>
        {groupContent}
      </details>
    );
  }

  return (
    <div className="record-group" data-feature={feature}>
      <h2>{title}</h2>
      {groupContent}
    </div>
  );
}, areRecordGroupPropsEqual);

function featureForSection(title: string) {
  if (title === "任务") return "tasks";
  if (title === "资料") return "resources";
  return "records";
}

function isCompletedTaskRecord(record: FamilyRecord) {
  return record.status === "done" || Boolean(getTaskProgress(record)?.complete);
}

type ResourceColumnKind = "image" | "document" | "audio";

function ResourceColumns({
  onLongPressResource,
  onOpenResource,
  onToggleSelectedRecord,
  records,
  selectedRecordIds,
  selectionMode
}: {
  onLongPressResource: (recordId: string) => void;
  onOpenResource: (recordId: string) => void;
  onToggleSelectedRecord: (recordId: string) => void;
  records: FamilyRecord[];
  selectedRecordIds: Set<string>;
  selectionMode: boolean;
}) {
  const [expandedRows, setExpandedRows] = useState<Set<ResourceColumnKind>>(() => new Set());
  const columns: Array<{ kind: ResourceColumnKind; label: string }> = [
    { kind: "image", label: "图片和视频" },
    { kind: "document", label: "文档" }
  ];

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const urls = [...new Set(records.flatMap((record) => {
      const kind = resourceColumnKind(record);
      if (kind === "image") {
        return [getResourceThumbnailUrl(record), getResourceCompressedPreviewUrl(record)];
      }
      if (kind === "document") {
        return [getResourceDocumentThumbnailUrl(record), getResourceDownloadUrl(record)];
      }
      return [];
    }).filter((url): url is string => Boolean(url) && !isBlobUrl(url)))];
    if (!urls.length) return;

    let cancelled = false;
    const warmCache = () => {
      void navigator.serviceWorker.ready.then((registration) => {
        if (cancelled) return;
        (navigator.serviceWorker.controller || registration.active)?.postMessage({ type: "family-cache-resources", urls });
      });
    };
    const idleWindow = window as typeof window & {
      cancelIdleCallback?: (handle: number) => void;
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    const idleHandle = idleWindow.requestIdleCallback?.(warmCache, { timeout: 2_500 });
    const timer = idleHandle === undefined ? window.setTimeout(warmCache, 800) : null;
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [records]);

  return (
    <div className="resource-columns" aria-label="资料分类">
      {columns.map((column) => {
        const columnRecords = records.filter((record) => resourceColumnKind(record) === column.kind);
        const expanded = expandedRows.has(column.kind);
        return (
          <section className={`resource-column resource-column-${column.kind}${expanded ? " expanded" : ""}`} aria-label={`${column.label}资料`} key={column.kind}>
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "收起" : "展开"}${column.label}`}
              className="resource-row-expand"
              onClick={() => setExpandedRows((current) => {
                const next = new Set(current);
                if (next.has(column.kind)) next.delete(column.kind);
                else next.add(column.kind);
                return next;
              })}
              type="button"
            >
              {expanded ? (
                <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 6h7" /></svg>
              ) : (
                <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 6h7M6 2.5v7" /></svg>
              )}
            </button>
            <div className="resource-column-scroll" data-resource-column={column.kind}>
              {columnRecords.length ? columnRecords.map((record) => (
                <ResourceColumnCard
                  kind={column.kind}
                  key={record.id}
                  onLongPress={() => onLongPressResource(record.id)}
                  onOpen={() => {
                    if (selectionMode) {
                      onToggleSelectedRecord(record.id);
                      return;
                    }
                    onOpenResource(record.id);
                  }}
                  onToggleSelected={() => onToggleSelectedRecord(record.id)}
                  record={record}
                  selected={selectedRecordIds.has(record.id)}
                  selectionMode={selectionMode}
                />
              )) : (
                <span className="resource-column-empty">暂无</span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ResourceColumnCard({
  kind,
  onLongPress,
  onOpen,
  onToggleSelected,
  record,
  selected,
  selectionMode
}: {
  kind: ResourceColumnKind;
  onLongPress: () => void;
  onOpen: () => void;
  onToggleSelected: () => void;
  record: FamilyRecord;
  selected: boolean;
  selectionMode: boolean;
}) {
  const previewUrl = kind === "image" ? getResourceThumbnailUrl(record) || fallbackPhoto(record.id) : getResourceDocumentThumbnailUrl(record);
  const [previewFailed, setPreviewFailed] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const uploadProgress = Math.max(0, Math.min(100, record.uploadProgress || 0));

  useEffect(() => setPreviewFailed(false), [previewUrl]);

  function cancelLongPress() {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  function startLongPress() {
    if (selectionMode) return;
    cancelLongPress();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      navigator.vibrate?.(12);
      onLongPress();
    }, 520);
  }

  const cardClasses = [
    "resource-column-card",
    `resource-column-card-${kind}`,
    selectionMode ? "selection-mode" : "",
    selected ? "selected" : "",
    record.uploadState === "uploading" ? "uploading" : "",
    record.uploadState === "error" ? "upload-error" : ""
  ].filter(Boolean).join(" ");

  return (
    <article className={cardClasses} data-record-sort-id={record.id}>
      {selectionMode ? (
        <input
          aria-label={`选择 ${record.title}`}
          checked={selected}
          className="resource-column-select"
          onChange={onToggleSelected}
          onClick={(event) => event.stopPropagation()}
          type="checkbox"
        />
      ) : null}
      <button
        aria-label={`打开 ${record.title}`}
        onClick={() => {
          if (longPressTriggeredRef.current) {
            longPressTriggeredRef.current = false;
            return;
          }
          onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onPointerCancel={cancelLongPress}
        onPointerDown={startLongPress}
        onPointerLeave={cancelLongPress}
        onPointerUp={cancelLongPress}
        type="button"
      >
        {kind === "image" ? (
          <span className="resource-column-thumbnail-frame">
            <img alt="" className="resource-column-thumbnail user-upload-image" draggable={false} loading="lazy" src={previewUrl} />
            {record.uploadState === "uploading" ? (
              <span
                aria-label={`上传进度 ${Math.round(uploadProgress)}%`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(uploadProgress)}
                className="resource-upload-progress-veil"
                role="progressbar"
                style={{ "--resource-upload-progress": `${uploadProgress}%` } as CSSProperties}
              />
            ) : null}
            {record.uploadState === "error" ? <span className="resource-upload-error">上传失败</span> : null}
          </span>
        ) : null}
        {kind === "document" ? (
          <span className={`resource-column-document-frame${previewUrl && !previewFailed ? " has-preview" : ""}`} aria-hidden="true">
            {previewUrl && !previewFailed ? <img alt="" className="resource-column-document-thumbnail" draggable={false} loading="lazy" onError={() => setPreviewFailed(true)} src={previewUrl} /> : null}
            {!previewUrl || previewFailed ? (
              <span className="resource-column-document-fallback">
                <small>{formatDocumentTypeBadge(record)}</small>
                <strong>{stripFileExtension(record.title)}</strong>
                <i>{record.summary || "家庭资料"}</i>
                <span aria-hidden="true"><b /><b /><b /></span>
              </span>
            ) : null}
          </span>
        ) : null}
        {kind === "document" ? (
          <span className="resource-column-meta"><small>{formatResourceDate(record)}</small><strong>{record.title}</strong></span>
        ) : kind === "image" ? null : <strong>{record.title}</strong>}
      </button>
    </article>
  );
}

function resourceColumnKind(record: FamilyRecord): ResourceColumnKind {
  if (record.assetType === "photo" || record.assetType === "video") return "image";
  if (isVoiceResource(record)) return "audio";
  return "document";
}

function areRecordGroupPropsEqual(previous: RecordGroupProps, next: RecordGroupProps) {
  return (
    previous.collapsed === next.collapsed &&
    previous.collapsible === next.collapsible &&
    previous.displayCount === next.displayCount &&
    previous.expandedSwipeTask?.id === next.expandedSwipeTask?.id &&
    previous.expandedSwipeTask?.side === next.expandedSwipeTask?.side &&
    previous.membersById === next.membersById &&
    previous.records === next.records &&
    previous.selectedRecordIds === next.selectedRecordIds &&
    previous.selectionMode === next.selectionMode &&
    previous.sortLabel === next.sortLabel &&
    previous.title === next.title &&
    previous.variant === next.variant
  );
}

function formatSectionTitle(title: string, count: number, collapsed: boolean, sortLabel?: string) {
  return (
    <>
      <strong className="section-title-text">{title}</strong>
      <span className="section-title-meta">
        {sortLabel ? <small className="task-sort-mode" key={sortLabel}>{sortLabel}</small> : null}
        <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1" viewBox="0 0 24 24">
          {collapsed ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
        </svg>
      </span>
    </>
  );
}

function sortTaskRecords(records: FamilyRecord[], mode: TaskSortMode) {
  if (mode === "default") return groupIncomingTasksBySender(records);
  const sorted = [...records];
  if (mode === "due") {
    return sorted.sort((left, right) => taskDueTimestamp(left) - taskDueTimestamp(right) || right.updatedAt.localeCompare(left.updatedAt));
  }
  if (mode === "status") {
    const rank: Record<FamilyRecord["status"], number> = { todo: 0, doing: 1, saved: 2, done: 3 };
    return sorted.sort((left, right) => rank[left.status] - rank[right.status] || taskDueTimestamp(left) - taskDueTimestamp(right));
  }
  return sorted.sort((left, right) => left.ownerName.localeCompare(right.ownerName, "zh-Hans-CN") || taskDueTimestamp(left) - taskDueTimestamp(right));
}

function groupIncomingTasksBySender(records: FamilyRecord[]) {
  const originalIndex = new Map(records.map((record, index) => [record.id, index]));
  const incoming = records.filter((record) =>
    record.createdByMemberId !== currentMemberId
    && Boolean(record.assigneeMemberIds?.includes(currentMemberId))
  );
  const senderOrder = new Map<string, number>();
  for (const record of incoming) {
    const sender = record.createdByMemberId || record.ownerName;
    if (!senderOrder.has(sender)) senderOrder.set(sender, senderOrder.size);
  }

  return [...records].sort((left, right) => {
    const leftIncoming = incoming.includes(left);
    const rightIncoming = incoming.includes(right);
    if (leftIncoming !== rightIncoming) return leftIncoming ? -1 : 1;
    if (!leftIncoming) return (originalIndex.get(left.id) || 0) - (originalIndex.get(right.id) || 0);
    const leftSender = left.createdByMemberId || left.ownerName;
    const rightSender = right.createdByMemberId || right.ownerName;
    return (senderOrder.get(leftSender) || 0) - (senderOrder.get(rightSender) || 0)
      || taskDueTimestamp(left) - taskDueTimestamp(right)
      || (originalIndex.get(left.id) || 0) - (originalIndex.get(right.id) || 0);
  });
}

function taskDueTimestamp(record: FamilyRecord) {
  const value = record.dueAt ? new Date(record.dueAt).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

type RecordRowProps = {
  membersById: Map<string, FamilyMember>;
  onCompleteTask: (recordId: string) => void;
  onDeleteRecord: (recordId: string) => void;
  onExpandSwipeTask: (recordId: string | null, side?: "complete" | "delete") => void;
  onLongPressTask: (recordId: string) => void;
  onOpenTask: (recordId: string) => void;
  onToggleSelectedRecord: (recordId: string) => void;
  record: FamilyRecord;
  selected: boolean;
  selectionMode: boolean;
  swipeExpandedSide: "complete" | "delete" | null;
  variant: "inbox" | "summary" | "source";
};

const RecordRow = memo(function RecordRow({
  membersById,
  onCompleteTask,
  onDeleteRecord,
  onExpandSwipeTask,
  onLongPressTask,
  onOpenTask,
  onToggleSelectedRecord,
  record,
  selected,
  selectionMode,
  swipeExpandedSide,
  variant
}: RecordRowProps) {
  if (variant === "inbox") {
    return (
      <InboxRecordRow
        membersById={membersById}
        onCompleteTask={onCompleteTask}
        onDeleteRecord={onDeleteRecord}
        onExpandSwipeTask={onExpandSwipeTask}
        onLongPressTask={onLongPressTask}
        onOpenTask={onOpenTask}
        onToggleSelectedRecord={onToggleSelectedRecord}
        record={record}
        selected={selected}
        selectionMode={selectionMode}
        swipeExpandedSide={swipeExpandedSide}
      />
    );
  }

  const detailText = formatRecordHint(
    variant === "summary" ? record.summary : `来自 ${record.ownerName} · ${record.updatedAt}`
  );
  const showResourceIcon = variant === "source";

  return (
    <SwipeRecordRow
      className={selected ? "record-row inbox-row resource-swipe-row selected" : "record-row inbox-row resource-swipe-row"}
      completeLabel={variant === "source" ? "下载" : "打开"}
      onClick={() => {
        if (selectionMode) {
          onToggleSelectedRecord(record.id);
          return;
        }
        onOpenTask(record.id);
      }}
      onComplete={() => {
        if (variant === "source") {
          void downloadResourceRecord(record);
          return;
        }
        onOpenTask(record.id);
      }}
      onDelete={() => onDeleteRecord(record.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (selectionMode) {
            onToggleSelectedRecord(record.id);
          } else {
            onOpenTask(record.id);
          }
        }
      }}
      onLongPress={() => onLongPressTask(record.id)}
      selectionMode={selectionMode}
    >
      {selectionMode ? (
        <input
          aria-label={`选择 ${record.title}`}
          checked={selected}
          onChange={() => onToggleSelectedRecord(record.id)}
          onClick={(event) => event.stopPropagation()}
          type="checkbox"
        />
      ) : null}
      {showResourceIcon ? (
        <div className={`resource-type-icon ${resourceIconClass(record)}`} aria-hidden="true">
          <ResourceTypeIcon record={record} />
        </div>
      ) : null}
      <div className="record-copy inbox-copy">
        <h3>{record.title}</h3>
        <span className="record-hint">{detailText}</span>
      </div>
      <span className={`status ${record.status}`}>{formatResourceDate(record)}</span>
    </SwipeRecordRow>
  );
}, areRecordRowPropsEqual);

function areRecordRowPropsEqual(previous: RecordRowProps, next: RecordRowProps) {
  return (
    previous.membersById === next.membersById &&
    previous.record === next.record &&
    previous.selected === next.selected &&
    previous.selectionMode === next.selectionMode &&
    previous.swipeExpandedSide === next.swipeExpandedSide &&
    previous.variant === next.variant
  );
}

function SwipeRecordRow({
  children,
  className,
  commitDeleteOnSwipe = false,
  completeLabel = "打开",
  onClick,
  onComplete,
  onDelete,
  onKeyDown,
  onLongPress,
  selectionMode,
  style
}: {
  children: ReactNode;
  className: string;
  commitDeleteOnSwipe?: boolean;
  completeLabel?: string;
  onClick: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onLongPress: () => void;
  selectionMode: boolean;
  style?: CSSProperties;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);

  return (
    <TaskSwipeItem
      className={className}
      commitDeleteOnSwipe={commitDeleteOnSwipe}
      completeLabel={completeLabel}
      expandedSide={null}
      itemId="resource-swipe"
      onClick={() => {
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        onClick();
      }}
      onComplete={onComplete}
      onContextMenu={() => {
        if (!selectionMode) {
          onLongPress();
        }
      }}
      onDelete={onDelete}
      onExpandChange={() => undefined}
      onPointerCancelCapture={() => {
        clearLongPressTimer(longPressTimerRef);
      }}
      onPointerDownCapture={(event) => {
        if (selectionMode) {
          return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        clearLongPressTimer(longPressTimerRef);
        longPressTriggeredRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
          longPressTriggeredRef.current = true;
          onLongPress();
        }, 520);
      }}
      onPointerUpCapture={() => {
        clearLongPressTimer(longPressTimerRef);
      }}
      onKeyDown={onKeyDown}
      onSwipeStart={() => {
        clearLongPressTimer(longPressTimerRef);
        longPressTriggeredRef.current = false;
      }}
      selectionMode={selectionMode}
      style={style}
    >
      {children}
    </TaskSwipeItem>
  );
}

function ResourceTypeIcon({ record }: { record: FamilyRecord }) {
  const icon = resolveResourceIcon(record);
  if (icon === "image") return <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.5-4 3.2 2.7 2.6-2.2L19 17" /></svg>;
  if (icon === "audio") return <svg viewBox="0 0 24 24"><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4" /></svg>;
  if (icon === "link") return <svg viewBox="0 0 24 24"><path d="m9.5 14.5 5-5" /><path d="M7.2 17.8 5.7 19.3a3.5 3.5 0 0 1-5-5l3.1-3.1a3.5 3.5 0 0 1 5 0" transform="translate(3)" /><path d="m16.8 6.2 1.5-1.5a3.5 3.5 0 1 1 5 5l-3.1 3.1a3.5 3.5 0 0 1-5 0" transform="translate(-3)" /></svg>;
  if (icon === "text") return <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M4 7h6l2-2h8v14H4z" /><path d="M4 9h16" /></svg>;
}

function resolveResourceIcon(record: FamilyRecord) {
  if (record.assetType === "photo" || record.assetType === "video") {
    return "image";
  }
  if (record.assetType === "audio") {
    return "audio";
  }
  if (record.assetType === "link" || record.kind === "link") {
    return "link";
  }
  if (record.assetType === "archive") {
    return "file";
  }
  if (record.assetType === "text" || (!record.assetType && record.kind === "note")) {
    return "text";
  }
  return "file";
}

function resourceIconClass(record: FamilyRecord) {
  return `resource-type-${resolveResourceIcon(record)}`;
}

function InboxRecordRow({
  membersById,
  onLongPressTask,
  onCompleteTask,
  onDeleteRecord,
  onExpandSwipeTask,
  onOpenTask,
  onToggleSelectedRecord,
  selected,
  selectionMode,
  swipeExpandedSide,
  record
}: {
  membersById: Map<string, FamilyMember>;
  onLongPressTask: (recordId: string) => void;
  onCompleteTask: (recordId: string) => void;
  onDeleteRecord: (recordId: string) => void;
  onExpandSwipeTask: (recordId: string | null, side?: "complete" | "delete") => void;
  onOpenTask: (recordId: string) => void;
  onToggleSelectedRecord: (recordId: string) => void;
  selected: boolean;
  selectionMode: boolean;
  swipeExpandedSide: "complete" | "delete" | null;
  record: FamilyRecord;
}) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const sender = (record.createdByMemberId && membersById.get(record.createdByMemberId)) || findMemberByName(membersById, record.ownerName);
  const senderColor = stableMemberColor(sender);
  const delegatedAssignees = getDelegatedTaskAssignees(record, membersById);
  const isDelegatedByMe = delegatedAssignees.length > 0;
  const progress = getTaskProgress(record);
  const timeMeta = formatTaskTimeMeta(record);
  const overdue = useTaskOverdue(record);
  const listStatus = record.status === "done" || progress?.complete ? "done" : overdue ? "overdue" : "todo";
  const listStatusLabel =
    listStatus === "done" ? "完成" : listStatus === "overdue" ? "过期" : isDelegatedByMe ? "派出" : "待办";

  return (
    <TaskSwipeItem
      allowComplete={!isDelegatedByMe}
      commitOnSwipe
      completeLabel={record.status === "done" ? "复原" : "完成"}
      completeVariant={record.status === "done" ? "restore" : "complete"}
      className={[
        "record-row",
        "inbox-row",
        isDelegatedByMe ? "delegated-task-row" : "",
        selected ? "selected" : "",
        record.status === "done" ? "done" : "",
        overdue ? "overdue" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      expandedSide={isDelegatedByMe && swipeExpandedSide === "complete" ? null : swipeExpandedSide}
      itemId={record.id}
      onClick={() => {
        if (swipeExpandedSide) {
          onExpandSwipeTask(null);
          return;
        }
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        if (selectionMode) {
          onToggleSelectedRecord(record.id);
          return;
        }
        onOpenTask(record.id);
      }}
      onComplete={() => {
        if (!isDelegatedByMe) {
          onCompleteTask(record.id);
        }
      }}
      onContextMenu={() => {
        if (!selectionMode) {
          onLongPressTask(record.id);
        }
      }}
      onDelete={() => onDeleteRecord(record.id)}
      onExpandChange={onExpandSwipeTask}
      onPointerCancelCapture={() => {
        clearLongPressTimer(longPressTimerRef);
      }}
      onPointerDownCapture={(event) => {
        if (selectionMode) {
          return;
        }
        if (event.pointerType === "mouse" && event.button !== 0) {
          return;
        }
        clearLongPressTimer(longPressTimerRef);
        longPressTriggeredRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
          longPressTriggeredRef.current = true;
          onLongPressTask(record.id);
        }, 520);
      }}
      onPointerUpCapture={() => {
        clearLongPressTimer(longPressTimerRef);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenTask(record.id);
        }
      }}
      onSwipeStart={() => {
        clearLongPressTimer(longPressTimerRef);
        longPressTriggeredRef.current = false;
      }}
      selectionMode={selectionMode}
      style={{ "--member-color": senderColor } as CSSProperties}
    >
      {selectionMode ? (
        <input
          aria-label={`选择 ${record.title}`}
          checked={selected}
          onChange={() => onToggleSelectedRecord(record.id)}
          onClick={(event) => event.stopPropagation()}
          type="checkbox"
        />
      ) : null}
      {isDelegatedByMe ? (
        <AssignedTaskAvatars members={delegatedAssignees} />
      ) : (
        <div className="sender-avatar" aria-hidden="true">
          {sender ? <MemberAvatar member={sender} /> : <AvatarImage alt="" className="member-avatar-image" decoding="sync" label={record.ownerName} loading="eager" seed={record.sourceMemberId || record.ownerName} />}
        </div>
      )}
      <div className="record-copy inbox-copy task-copy">
        <h3>{record.displayTime ? stripTaskTimeFromTitle(record.title, record.displayTime) : record.title}</h3>
      {timeMeta ? <TaskTimeMeta text={timeMeta} /> : null}
      </div>
      <span className={`status task-status ${listStatus}`}>
        {listStatusLabel}
      </span>
    </TaskSwipeItem>
  );
}

function useTaskOverdue(record: Pick<FamilyRecord, "dueAt" | "status">) {
  const [overdue, setOverdue] = useState(() => isTaskOverdue(record));

  useEffect(() => {
    let timer = 0;
    const update = () => {
      const nextOverdue = isTaskOverdue(record);
      setOverdue(nextOverdue);
      if (nextOverdue || record.status === "done" || !record.dueAt) return;
      const dueAt = new Date(record.dueAt).getTime();
      timer = window.setTimeout(update, Math.max(25, Math.min(60_000, dueAt - Date.now() + 25)));
    };
    update();
    return () => window.clearTimeout(timer);
  }, [record.dueAt, record.status]);

  return overdue;
}

function TaskTimeMeta({ text }: { text: string }) {
  const parts = text.trim().split(/\s+/);
  const time = parts.at(-1) || "";
  const weekday = parts.length >= 3 ? parts.at(-2) || "" : "";
  const date = parts.slice(0, weekday ? -2 : -1).join(" ");
  if (!date || !/^周[一二三四五六日]$/.test(weekday) || !/^\d{2}:\d{2}$/.test(time)) {
    return <TimeHighlightedText className="task-time-meta" text={text} />;
  }
  return (
    <span className="task-time-meta task-time-meta-columns">
      <mark className="time-highlight date" data-time-part="date">{date}</mark>
      <mark className="time-highlight weekday" data-time-part="weekday">{weekday}</mark>
      <mark className="time-highlight time" data-time-part="time">{time}</mark>
    </span>
  );
}

function AssignedTaskAvatars({ members }: { members: FamilyMember[] }) {
  const visibleMembers = members.slice(0, 4);

  return (
    <span className={visibleMembers.length > 1 ? "assigned-task-avatars group-chat-avatars" : "assigned-task-avatar sender-avatar"} aria-label={`派出给${members.map((member) => member.displayName).join("、")}`}>
      {visibleMembers.length > 1 ? (
        visibleMembers.map((member) => (
          <i key={member.id}>
            <MemberAvatar member={member} />
          </i>
        ))
      ) : visibleMembers[0] ? (
        <MemberAvatar member={visibleMembers[0]} />
      ) : null}
    </span>
  );
}

const GroupChatList = memo(function GroupChatList({
  membersById,
  onDeleteRecord,
  onLongPressChat,
  onOpenChat,
  records,
  selectionMode
}: {
  membersById: Map<string, FamilyMember>;
  onDeleteRecord: (recordId: string) => void;
  onLongPressChat: (recordId: string) => void;
  onOpenChat: (recordId: string) => void;
  records: FamilyRecord[];
  selectionMode: boolean;
}) {
  if (records.length === 0) {
    return null;
  }

  return (
    <div className="group-chat-list" aria-label="生成的群组">
      {records.map((record) => {
        const members = (record.chatMembers || [])
          .map((memberId) => membersById.get(memberId) || createGuestMember(memberId))
          .filter(Boolean)
          .sort((left, right) => Number(left.id === currentMemberId) - Number(right.id === currentMemberId))
          .slice(0, 4);

        return (
          <div className="record-action-wrap" key={record.id}>
            <SwipeRecordRow
              className="record-row inbox-row group-chat-row"
              commitDeleteOnSwipe
              onClick={() => {
                onOpenChat(record.id);
              }}
              onComplete={() => onOpenChat(record.id)}
              onDelete={() => onDeleteRecord(record.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenChat(record.id);
                }
              }}
              onLongPress={() => onLongPressChat(record.id)}
              selectionMode={selectionMode}
            >
              <span className="group-chat-avatars" aria-hidden="true">
                {members.map((member) => (
                  <i key={member.id}>
                    <MemberAvatar member={member} />
                  </i>
                ))}
              </span>
              <div className="record-copy inbox-copy">
                <h3 className="group-chat-title">
                  <span>{moveSelfToEndInGroupTitle(record.title)}</span>
                  {record.inviteLink ? <GuestInviteCodeBadge link={record.inviteLink} /> : null}
                </h3>
              </div>
            </SwipeRecordRow>
          </div>
        );
      })}
    </div>
  );
}, areGroupChatListPropsEqual);

type GroupChatListProps = {
  membersById: Map<string, FamilyMember>;
  onDeleteRecord: (recordId: string) => void;
  onLongPressChat: (recordId: string) => void;
  onOpenChat: (recordId: string) => void;
  records: FamilyRecord[];
  selectionMode: boolean;
};

function GuestInviteCodeBadge({ link }: { link: string }) {
  const { code } = useGuestInviteCode(link);
  if (!code) return null;
  return <span className="group-invite-code" aria-label={`当前群聊口令 ${code}`}>{code}</span>;
}

function useGuestInviteCode(link?: string) {
  const [state, setState] = useState({ code: "", validUntil: "" });

  useEffect(() => {
    if (!link) {
      setState({ code: "", validUntil: "" });
      return;
    }
    let active = true;
    let timer = 0;
    const slug = getGuestChatSlug(link);
    const refresh = async () => {
      const response = await familyFetch(`/api/guest-chat/code?slug=${encodeURIComponent(slug)}`, { cache: "no-store" }).catch(() => null);
      if (!active) return;
      if (!response?.ok) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refresh(), 1_500);
        return;
      }
      const payload = await response.json() as { code?: string; validUntil?: string };
      if (!payload.code || !/^\d{4}$/.test(payload.code)) return;
      const validUntil = payload.validUntil || "";
      setState({ code: payload.code, validUntil });
      const refreshDelay = Math.max(1_000, new Date(validUntil).getTime() - Date.now() + 250);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), refreshDelay);
    };
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [link]);

  return state;
}

async function registerGuestChatInvite(record: FamilyRecord) {
  if (!record.inviteLink) return false;
  const response = await familyFetch("/api/guest-chat/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: record.id,
      inviteLink: record.inviteLink,
      title: record.title,
      spaceId: record.spaceId,
      chatMembers: record.chatMembers || [],
      chatMessages: record.chatMessages || []
    })
  }).catch(() => null);
  return Boolean(response?.ok);
}

function areGroupChatListPropsEqual(previous: GroupChatListProps, next: GroupChatListProps) {
  return previous.membersById === next.membersById && previous.records === next.records && previous.selectionMode === next.selectionMode;
}

function formatDecisionRemaining(closesAt: string) {
  const minutes = Math.max(0, Math.ceil((new Date(closesAt).getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  if (minutes < 24 * 60) return `剩余 ${Math.ceil(minutes / 60)} 小时`;
  return `剩余 ${Math.ceil(minutes / 1440)} 天`;
}

function formatRecordHint(text: string) {
  const missingMatch = text.match(/^(.+?)，需要确认(.+)$/);
  if (missingMatch) {
    return `缺 ${missingMatch[2]} · ${missingMatch[1]}`;
  }

  const assignMatch = text.match(/^(.+?)，分配(.+)$/);
  if (assignMatch) {
    return `待分配 ${assignMatch[2]} · ${assignMatch[1]}`;
  }

  return text;
}

function blurActiveTextEntry() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement !== document.body) {
    activeElement.blur();
  }
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Clipboard permission can be unavailable in embedded previews.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  textarea.style.top = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

type CaptureComposerProps = {
  accountSettingsToken: number;
  activeTab: string;
  aiConnectedToken: number;
  avatarProfile: MemberAvatarProfile;
  avatarSeed: string;
  members: FamilyMember[];
  onAvatarSettingsSave: (profile: MemberAvatarProfile, seed: string) => void;
  onAutomationRecords: (displayTarget: AutomationDisplayTarget, payload: unknown) => void;
  onCreateGroupChatTask: (sourceText?: string, options?: CreateGroupChatOptions) => CreateGroupChatResult;
  onOpenRelatedRecord: (link: AssistantResultLink) => void;
  onQuickCapture: (text: string, suggestion: AssignmentSuggestion) => void;
  onUploadResources: (files: File[]) => Promise<ResourceUploadOutcome>;
  records: FamilyRecord[];
  resumeFocusToken: number;
  suspended: boolean;
};

type ResourceUploadOutcome = {
  activeResource?: Pick<FamilyRecord, "id" | "title">;
  answer: string;
  state: "done" | "error";
  voiceStatus: string;
};

type CreateGroupChatOptions = {
  guestInvite?: boolean;
  initialMessages?: RoomMessage[];
  memberIds?: string[];
  openAfterCreate?: boolean;
  reuseMatchingMembers?: boolean;
  title?: string;
};

type CreateGroupChatResult = {
  recordId: string;
  reused: boolean;
  title: string;
};

type SlashCommand = {
  action: "account" | "api_usage" | "deep_summary" | "group";
  label: string;
};

const composerSlashCommands: SlashCommand[] = [
  {
    action: "account",
    label: "资料"
  },
  {
    action: "api_usage",
    label: "查询消费"
  },
  {
    action: "group",
    label: "创建群聊"
  },
  {
    action: "deep_summary",
    label: "深度总结"
  }
];

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

function CaptureComposer({ accountSettingsToken, activeTab, aiConnectedToken, avatarProfile, avatarSeed, members, onAvatarSettingsSave, onAutomationRecords, onCreateGroupChatTask, onOpenRelatedRecord, onQuickCapture, onUploadResources, records, resumeFocusToken, suspended }: CaptureComposerProps) {
  const currentMemberName = avatarProfile.displayName || defaultCurrentMemberName;
  const liteBackend = process.env.NEXT_PUBLIC_FAMILY_APP_BACKEND === "sqlite";

  function runAutomationAction(
    actionId: AutomationActionId,
    parameters: Record<string, unknown> = {},
    options: { confirmationToken?: string } = {}
  ) {
    return executeAutomationAction(actionId, parameters, {
      ...options,
      actorMemberId: currentMemberId,
      actorName: currentMemberName
    });
  }

  function runAutomationPipeline(
    pipelineId: string,
    parameters: Record<string, unknown> = {},
    options: { confirmationToken?: string } = {}
  ) {
    return executeAutomationPipeline(pipelineId, parameters, {
      ...options,
      actorMemberId: currentMemberId,
      actorName: currentMemberName
    });
  }
  const [inputValue, setInputValue] = useState("");
  const [showAvatarSheet, setShowAvatarSheet] = useState(false);
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState<AssignmentSuggestion | null>(null);
  const [pendingTaskText, setPendingTaskText] = useState("");
  const [pendingKnowledgeInquiry, setPendingKnowledgeInquiry] = useState<{
    id: string;
    memberName: string;
    status: "awaiting_choice" | "awaiting_user_input";
  } | null>(null);
  const [automationFeedback, setAutomationFeedback] = useState<AutomationFeedback | null>(null);
  const [composerSession, setComposerSession] = useState<ComposerSessionState>(() => createEmptyComposerSessionState());
  const [composerSessionHydrated, setComposerSessionHydrated] = useState(false);
  const [composerSheetOpen, setComposerSheetOpen] = useState(false);
  const [familyInviteDraft, setFamilyInviteDraft] = useState<FamilyInviteDraft | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceTranscriptPreview, setVoiceTranscriptPreview] = useState("");
  const [isComposingText, setIsComposingText] = useState(false);
  const [, startInputTransition] = useTransition();
  const debouncedInputValue = useDebouncedValue(inputValue, 160);
  const inputValueRef = useRef("");
  const baseInputRef = useRef<HTMLTextAreaElement | null>(null);
  const baseFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputTouchHandledAtRef = useRef<number | null>(null);
  const composerSubmitSeqRef = useRef(0);
  const composerDraftVersionRef = useRef(0);
  const conversationSessionIdRef = useRef(composerSession.id);
  const activeResourceRef = useRef<Pick<FamilyRecord, "id" | "title"> | null>(null);
  const assistantDialogueStateRef = useRef<AssistantDialogueState | undefined>(undefined);
  const composerConversationDismissedRef = useRef(false);
  const voiceStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePressActiveRef = useRef(false);
  const voiceSendSuppressClickRef = useRef(false);
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceInsertionRef = useRef<VoiceInsertionPoint | null>(null);
  const voiceFallbackCaptureRef = useRef<FallbackVoiceCapture | null>(null);
  const voiceFallbackActiveRef = useRef(false);
  const voiceFallbackStopRequestedRef = useRef(false);
  const knowledgeSyncCursorRef = useRef("");

  useEffect(() => {
    setComposerSession(loadComposerSessionState());
    setComposerSessionHydrated(true);
  }, []);

  useEffect(() => {
    if (activeResourceRef.current) return;
    const latestUploadMessage = [...composerSession.messages].reverse().find((message) =>
      message.role === "user" && message.text.startsWith("上传附件：")
    );
    if (!latestUploadMessage) return;
    const uploadedName = latestUploadMessage.text.slice("上传附件：".length).split("、")[0]?.trim();
    const resource = records.find((record) =>
      Boolean(record.sourceFiles?.length) && (!uploadedName || record.fileName === uploadedName || record.title === stripFileExtension(uploadedName))
    );
    if (resource) activeResourceRef.current = { id: resource.id, title: resource.title };
  }, [composerSession.messages, records]);

  useEffect(() => {
    if (!composerSessionHydrated) {
      return;
    }

    conversationSessionIdRef.current = composerSession.id;
    storeComposerSessionState(composerSession);
    storeString("family-app.conversation-session-id", composerSession.id);
  }, [composerSession, composerSessionHydrated]);

  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);

  useEffect(() => {
    const prefillAssistant = (event: Event) => {
      const text = event instanceof CustomEvent && typeof event.detail?.text === "string" ? event.detail.text.trim() : "";
      if (!text) return;
      handleInputChange(text);
      setComposerSheetOpen(false);
      window.requestAnimationFrame(() => focusComposerInput("base"));
    };
    window.addEventListener(familyAssistantPrefillEvent, prefillAssistant);
    return () => window.removeEventListener(familyAssistantPrefillEvent, prefillAssistant);
  }, []);

  useEffect(() => {
    const cursorKey = `family-app.knowledge-inquiry-cursor.${currentMemberId}`;
    knowledgeSyncCursorRef.current = window.localStorage.getItem(cursorKey) || "";
    let stopped = false;
    let polling = false;
    const sync = async () => {
      if (stopped || polling || document.visibilityState === "hidden") return;
      polling = true;
      try {
        const query = knowledgeSyncCursorRef.current ? `?after=${encodeURIComponent(knowledgeSyncCursorRef.current)}` : "";
        const response = await familyFetch(`/api/knowledge-inquiries${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { inquiries?: SyncedKnowledgeInquiry[]; nextCursor?: string };
        const inquiries = (payload.inquiries || []).slice().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
        for (const inquiry of inquiries) applySyncedKnowledgeInquiry(inquiry);
        const nextCursor = payload.nextCursor || inquiries.at(-1)?.updatedAt || knowledgeSyncCursorRef.current;
        if (nextCursor) {
          knowledgeSyncCursorRef.current = nextCursor;
          window.localStorage.setItem(cursorKey, nextCursor);
        }
      } catch {
        // A later poll retries. Inquiry state remains durable on the server.
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void sync(), 3_000);
    void sync();
    const onVisibility = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [currentMemberId]);

  function applySyncedKnowledgeInquiry(inquiry: SyncedKnowledgeInquiry) {
    const recentEnough = Date.now() - new Date(inquiry.updatedAt).getTime() <= 24 * 60 * 60_000;
    if (!recentEnough) return;
    if (inquiry.targetMemberId === currentMemberId && inquiry.status === "awaiting_member_reply") {
      setAutomationFeedback({
        displayTarget: "inline_assistant",
        displayType: "chat_reply",
        state: "done",
        text: `${inquiry.requesterName}想向你确认：${inquiry.question}${inquiry.retryCount ? `\n这是第 ${inquiry.retryCount} 次温和提醒；你方便时再回复。` : "\n请在对应群聊里直接回复。"}`
      });
      return;
    }
    if (inquiry.requesterMemberId !== currentMemberId) return;
    if (inquiry.status === "resolved") {
      const evidence = inquiry.evidence.at(-1);
      setPendingKnowledgeInquiry((current) => current?.id === inquiry.id ? null : current);
      setAutomationFeedback({
        displayTarget: "inline_assistant",
        displayType: "chat_reply",
        state: "done",
        text: evidence?.source === "member_reply"
          ? `已收到${inquiry.targetMemberName}本人的回复：${evidence.text}\n依据：${evidence.id}`
          : `已采用你本轮补充的信息：${evidence?.text || "已补充"}\n依据：${evidence?.id || inquiry.id}`
      });
      return;
    }
    if (inquiry.status === "dismissed") {
      setPendingKnowledgeInquiry((current) => current?.id === inquiry.id ? null : current);
      return;
    }
    if (inquiry.status === "awaiting_user_input") {
      setPendingKnowledgeInquiry({ id: inquiry.id, memberName: inquiry.targetMemberName, status: "awaiting_user_input" });
      return;
    }
    if (inquiry.status !== "awaiting_choice") return;
    const familyQuestionPlan: FamilyQuestionPlan = {
      dateLabel: null,
      knowledgeInquiryId: inquiry.id,
      memberIds: [inquiry.targetMemberId],
      message: `${inquiry.targetMemberName}，想直接向你确认：${inquiry.question}`,
      question: inquiry.question,
      title: `问问${inquiry.targetMemberName}`
    };
    setPendingKnowledgeInquiry({ id: inquiry.id, memberName: inquiry.targetMemberName, status: "awaiting_choice" });
    setAutomationFeedback({
      clarification: {
        familyQuestionPlan,
        id: `member-knowledge-sync-${inquiry.id}`,
        knowledgeInquiryId: inquiry.id,
        memberName: inquiry.targetMemberName,
        options: [
          { label: `问${inquiry.targetMemberName}`, value: "ask_member" },
          { label: "我来补充", value: "provide_input" },
          { label: "先不处理", value: "dismiss" }
        ],
        originalText: inquiry.question,
        prompt: `还没有找到关于${inquiry.targetMemberName}的可靠依据，你想怎么继续？`,
        round: 1
      },
      displayTarget: "inline_assistant",
      displayType: "confirmation_card",
      state: "done",
      text: `还没有找到关于${inquiry.targetMemberName}的可靠依据，你想怎么继续？`
    });
  }

  useEffect(() => () => {
    voiceRecognitionRef.current?.stop();
    voiceFallbackCaptureRef.current?.stop();
  }, []);

  useEffect(() => {
    if (accountSettingsToken === 0) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setShowAvatarSheet(true);
  }, [accountSettingsToken]);

  useEffect(() => {
    if (aiConnectedToken === 0) return;
    const now = Date.now();
    composerConversationDismissedRef.current = false;
    setAutomationFeedback(null);
    setComposerSheetOpen(true);
    setComposerSession((session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: `assistant-ai-connected-${now}`,
          role: "assistant",
          state: "done",
          text: "我好像有点聪明了"
        } satisfies ComposerChatMessage
      ].slice(-12),
      updatedAt: now
    }));
  }, [aiConnectedToken]);

  useEffect(() => {
    if (!suspended) {
      return;
    }

    setComposerSheetOpen(false);
  }, [suspended]);

  useEffect(() => {
    if (suspended || resumeFocusToken === 0 || typeof window === "undefined") {
      return;
    }
    if (!window.matchMedia("(pointer: coarse)").matches && window.innerWidth > 768) {
      return;
    }
    baseInputRef.current?.focus({ preventScroll: true });
  }, [resumeFocusToken, suspended]);

  useEffect(() => {
    if (!automationFeedback) {
      return;
    }

    appendAssistantMessage(automationFeedback);
  }, [automationFeedback]);

  function ensureActiveComposerSession() {
    const now = Date.now();
    if (now - composerSession.updatedAt <= composerSessionTimeoutMs) {
      return composerSession.id;
    }

    const nextSession: ComposerSessionState = {
      id: createComposerSessionId(),
      messages: [],
      updatedAt: now
    };
    conversationSessionIdRef.current = nextSession.id;
    setComposerSession(nextSession);
    setAutomationFeedback(null);
    // 新会话从收起状态开始；只有收到本次会话的结果后才显示对话面板。
    setComposerSheetOpen(false);
    return nextSession.id;
  }

  function beginAssistantTurn(text: string) {
    const now = Date.now();
    const suffix = Math.random().toString(36).slice(2, 6);
    const userMessage: ComposerChatMessage = {
      id: `user-${now}-${suffix}`,
      role: "user",
      text
    };
    const assistantMessage: ComposerChatMessage = {
      id: `assistant-${now}-${suffix}`,
      role: "assistant",
      state: "running",
      text: "正在整理..."
    };
    composerConversationDismissedRef.current = false;
    setComposerSheetOpen(true);
    setAutomationFeedback(null);
    setComposerSession((session) => ({
      ...session,
      messages: [...session.messages, userMessage, assistantMessage].slice(-12),
      updatedAt: now
    }));
  }

  function beginLocalComposerTurn(text: string) {
    const now = Date.now();
    composerConversationDismissedRef.current = false;
    setComposerSheetOpen(true);
    setAutomationFeedback(null);
    setComposerSession((session) => ({
      ...session,
      messages: [
        ...session.messages,
        {
          id: `user-${now}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          text
        } satisfies ComposerChatMessage
      ].slice(-12),
      updatedAt: now
    }));
  }

  function appendAssistantMessage(feedback: AutomationFeedback) {
    if (feedback.displayTarget === "none") {
      return;
    }

    if (!composerConversationDismissedRef.current) {
      setComposerSheetOpen(true);
    }
    setComposerSession((session) => {
      const lastMessage = session.messages.at(-1);
      const nextMessage: ComposerChatMessage = {
        clarification: feedback.clarification,
        display: feedback.display,
        confirmation: feedback.confirmation,
        displayTarget: feedback.displayTarget,
        displayType: feedback.displayType,
        id: lastMessage?.role === "assistant" && lastMessage.state === "running" ? lastMessage.id : `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        links: feedback.links,
        role: "assistant",
        state: feedback.state,
        text: feedback.text
      };

      const nextMessages =
        lastMessage?.role === "assistant" && lastMessage.state === "running"
          ? [...session.messages.slice(0, -1), nextMessage]
          : [...session.messages, nextMessage];

      return {
        ...session,
        messages: nextMessages.slice(-12),
        updatedAt: Date.now()
      };
    });
  }

  function collapseComposerPanel() {
    composerConversationDismissedRef.current = true;
    setComposerSheetOpen(false);
    setAutomationFeedback(null);
  }

  async function requestAssistantRoute(text: string): Promise<AssistantRoute> {
    const routeContext = buildAssistantRouteContext();
    try {
      const response = await familyFetch("/api/assistant-route", {
        body: JSON.stringify({
          actor_member_id: routeContext.actorMemberId,
          actor_name: routeContext.actorName,
          dialogue_state: routeContext.dialogueState,
          recent_conversation: routeContext.recentConversation,
          recent_user_texts: routeContext.recentUserTexts,
          text
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error("assistant route request failed");
      }
      const payload = (await response.json()) as { route?: AssistantRoute };
      const route = payload.route || routeAssistantInput(text, members, routeContext);
      assistantDialogueStateRef.current = advanceAssistantDialogueState(assistantDialogueStateRef.current, route);
      return route;
    } catch {
      const route = routeAssistantInput(text, members, routeContext);
      assistantDialogueStateRef.current = advanceAssistantDialogueState(assistantDialogueStateRef.current, route);
      return route;
    }
  }

  function buildAssistantRouteContext() {
    const contextMessages = composerSession.id === conversationSessionIdRef.current ? composerSession.messages : [];
    return {
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      dialogueState: assistantDialogueStateRef.current,
      recentConversation: contextMessages
        .filter((message) => (message.role === "assistant" || message.role === "user") && message.state !== "running")
        .map((message) => ({ role: message.role, text: message.text }))
        .slice(-12),
      recentUserTexts: contextMessages
        .filter((message) => message.role === "user")
        .map((message) => message.text)
        .slice(-8)
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    keepKeyboardDockFocused();
    const text = inputValue.trim();
    const submittedMentionIds = [...selectedMentionIds];
    const submittedMentionMembers = members.filter((member) => submittedMentionIds.includes(member.id));
    const submittedAssigneeMentionIds = submittedMentionMembers
      .filter((member) => member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"))
      .map((member) => member.id);
    const assistantInputText = withSelectedMentionLabels(text, submittedMentionMembers.map((member) => member.displayName));

    if (!text && selectedMentionIds.length > 0) {
      const selectedMembers = members.filter((member) => submittedMentionIds.includes(member.id) && member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"));
      if (selectedMembers.length === 0 && submittedMentionMembers.some((member) => member.householdRoles?.includes("assistant"))) {
        setSelectedMentionIds([]);
        setMentionPickerOpen(false);
        setSlashMenuOpen(false);
        setTemporaryVoiceStatus("选中小饭大人后，继续输入你想说的内容");
        return;
      }
      const memberIds = selectedMembers.map((member) => member.id);
      const title = buildMentionOnlyGroupTitle(selectedMembers.map((member) => member.displayName));
      const groupResult = onCreateGroupChatTask("", { memberIds, title });
      setSelectedMentionIds([]);
      setMentionPickerOpen(false);
      setSlashMenuOpen(false);
      setTemporaryVoiceStatus(groupResult.reused ? `已进入群组：${groupResult.title}` : `已创建群组：${groupResult.title}`);
      return;
    }

    if (!text) {
      setTemporaryVoiceStatus("先输入一点内容");
      return;
    }

    ensureActiveComposerSession();
    if (isPwaInstallCommand(text)) {
      beginLocalComposerTurn(text);
      setInputValue("");
      setSelectedMentionIds([]);
      setMentionPickerOpen(false);
      setSlashMenuOpen(false);
      window.setTimeout(() => {
        baseInputRef.current?.blur();
        window.dispatchEvent(new Event(PWA_INSTALL_REQUEST_EVENT));
      }, 220);
      return;
    }
    // 先记录原始输入并创建整理中的结果卡，再开始任何路由或网络请求。
    beginAssistantTurn(assistantInputText);
    const resourceOwner = resolveResourceOwnerFromText(text, members, currentMemberId);
    if (activeResourceRef.current && resourceOwner) {
      setInputValue("");
      setSelectedMentionIds([]);
      setMentionPickerOpen(false);
      setSlashMenuOpen(false);
      await runGenericAssistantAction("resource.assign_owner", text, {
        owner_member_id: resourceOwner.id,
        owner_name: resourceOwner.displayName,
        record_id: activeResourceRef.current.id,
        resource_title: activeResourceRef.current.title
      });
      return;
    }
    if (pendingKnowledgeInquiry?.status === "awaiting_user_input") {
      setInputValue("");
      await runGenericAssistantAction("member.knowledge.provide_input", text, {
        inquiry_id: pendingKnowledgeInquiry.id,
        text
      });
      setPendingKnowledgeInquiry(null);
      return;
    }
    const submitSeq = composerSubmitSeqRef.current + 1;
    composerSubmitSeqRef.current = submitSeq;
    composerDraftVersionRef.current += 1;
    const submittedDraftVersion = composerDraftVersionRef.current;
    const initialFocusText = selectAssistantRoutingFocus(assistantInputText);
    const localPreflightRoute = routeAssistantInput(assistantInputText, members, buildAssistantRouteContext());
    const directContextualGroup = localPreflightRoute.kind === "action" && localPreflightRoute.id === "group.organize.contextual";
    const directFamilyQuestion = localPreflightRoute.kind === "action" && localPreflightRoute.id === "group.ask.family";
    const directLocalGroupAction = directContextualGroup || directFamilyQuestion;
    const directTimedTask =
      isTimedTaskStatement(initialFocusText) &&
      !directLocalGroupAction &&
      localPreflightRoute.kind === "fallback" &&
      localPreflightRoute.suggestedAction === "task.create.input";
    const shouldOfferTaskSuggestion =
      shouldSuggestTaskFromText(initialFocusText, { contextTab: activeTab, mentionedMemberIds: submittedAssigneeMentionIds, senderMemberId: currentMemberId }) ||
      shouldOfferComposerTaskCard(initialFocusText);
    const directMentionedTask = submittedAssigneeMentionIds.length > 0 && shouldOfferTaskSuggestion;
    setInputValue("");
    setSelectedMentionIds([]);
    setMentionPickerOpen(false);
    setSlashMenuOpen(false);
    if (pendingSuggestion && pendingTaskText) {
      if (isPendingSuggestionConfirmation(text)) {
        confirmPendingSuggestion(text);
        return;
      }

      const updatedSuggestion = updatePendingSuggestionFromFollowUp(text, pendingSuggestion, members);
      if (updatedSuggestion) {
        setPendingSuggestion(updatedSuggestion);
        setInputValue("");
        setSelectedMentionIds([]);
        const answer = formatTaskCandidateReply(updatedSuggestion.taskTitle || pendingTaskText, updatedSuggestion);
        void appendUiConversationTurn(text, answer);
        setAutomationFeedback(createAutomationFeedback("done", answer, undefined, { displayTarget: "inline_assistant", displayType: "task_candidate", links: false }));
        return;
      }
    }

    const naturalGroupMemberIds = resolveGroupMemberIdsFromText(text, members, currentMemberId);
    if (naturalGroupMemberIds.length && /(?:一起|一块|共同).{0,4}(?:聊聊|聊天|说说)|(?:拉上?|叫上?).{0,18}(?:群聊|群组|群)|(?:群聊|群组).{0,8}(?:妈妈|老妈|姐姐|老姐|家人)/.test(text.replace(/\s+/g, ""))) {
      const groupMembers = members.filter((member) => naturalGroupMemberIds.includes(member.id));
      const title = buildMentionOnlyGroupTitle(groupMembers.map((member) => member.displayName));
      const groupResult = onCreateGroupChatTask(text, { memberIds: naturalGroupMemberIds, title });
      const answer = `${groupResult.reused ? "已进入" : "已创建"}群聊：${groupResult.title}`;
      void appendUiConversationTurn(text, answer);
      setAutomationFeedback(createAutomationFeedback("done", answer, undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
      setPendingSuggestion(null);
      setPendingTaskText("");
      return;
    }

    const composerIntent = compileComposerIntent(text);
    if (composerIntent.action === "create_family_invite") {
      setFamilyInviteDraft({
        displayName: composerIntent.fields.displayName,
        relationshipLabel: composerIntent.fields.relationshipLabel
      });
      const answer = composerIntent.fields.relationshipLabel
        ? `好，先确认这位${composerIntent.fields.relationshipLabel}的信息。`
        : "好，先选择你要邀请的家人关系。";
      void appendUiConversationTurn(text, answer);
      setAutomationFeedback(createAutomationFeedback("done", answer, undefined, {
        displayTarget: "inline_assistant",
        displayType: "confirmation_card",
        links: false
      }));
      return;
    }
    if (composerIntent.action === "create_group_chat") {
      const contextualRoute = directContextualGroup ? localPreflightRoute : await requestAssistantRoute(text);
      if (contextualRoute.kind === "action" && contextualRoute.id === "group.organize.contextual" && contextualRoute.parameters.groupPlan) {
        createContextualGroup(contextualRoute.parameters.groupPlan);
        return;
      }
      const explicitMemberIds = [...new Set([...submittedAssigneeMentionIds, ...naturalGroupMemberIds])];
      onCreateGroupChatTask(text, explicitMemberIds.length ? { memberIds: explicitMemberIds } : undefined);
      const answer = `群聊已创建：${composerIntent.fields.title}`;
      void appendUiConversationTurn(text, answer);
      setAutomationFeedback(createAutomationFeedback("done", answer, undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
      setPendingSuggestion(null);
      setPendingTaskText("");
      void enqueueMetaEvent({
        type: "composer_input",
        actorMemberId: currentMemberId,
        actorName: currentMemberName,
        spaceId: coreSpaceId,
        text,
        metadata: {
          action: "create_group_chat",
          intent: composerIntent
        }
      });
      return;
    }

    const assistantRoute: AssistantRoute = directLocalGroupAction
      ? localPreflightRoute
      : directTimedTask || directMentionedTask
      ? {
          kind: "fallback",
          focusText: initialFocusText,
          reason: "assignment_or_search",
          suggestedAction: "task.create.input"
        }
      : await requestAssistantRoute(assistantInputText);
    if (directTimedTask || directMentionedTask) {
      assistantDialogueStateRef.current = advanceAssistantDialogueState(assistantDialogueStateRef.current, assistantRoute);
    }
    const routedFocusText = assistantRoute.kind === "fallback" ? assistantRoute.focusText || initialFocusText : assistantRoute.parameters.text || initialFocusText;
    const shouldOfferRoutedTaskSuggestion =
      shouldOfferTaskSuggestion ||
      (assistantRoute.kind === "fallback" && assistantRoute.suggestedAction === "task.create.input");
    if (assistantRoute.kind === "fallback" && assistantRoute.clarification) {
      setAutomationFeedback({
        clarification: assistantRoute.clarification,
        displayTarget: "inline_assistant",
        displayType: "confirmation_card",
        state: "done",
        text: assistantRoute.clarification.prompt
      });
      return;
    }
    if (assistantRoute.kind === "pipeline" && assistantRoute.id === "pipeline.meta.profile_learning") {
      await runProfileLearningPipeline(text);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "profile.describe") {
      await showProfileDescription(text, assistantRoute.parameters.member || "");
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "member.knowledge.resolve") {
      await runMemberKnowledgeResolveAction(
        text,
        assistantRoute.parameters.member || "",
        assistantRoute.parameters.memberId || ""
      );
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "app.answer") {
      await runAppAnswerAction(text, assistantRoute.parameters.queryType, assistantRoute.parameters.recordDate);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "group.organize.contextual" && assistantRoute.parameters.groupPlan) {
      createContextualGroup(assistantRoute.parameters.groupPlan);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "group.ask.family" && assistantRoute.parameters.familyQuestionPlan) {
      createFamilyQuestionGroup(assistantRoute.parameters.familyQuestionPlan);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "web.search.duckduckgo") {
      await runWebSearchAction(text);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "app.chat") {
      await runCasualChatAction(text);
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "member.rename") {
      await runMemberRenameAction(text, assistantRoute.parameters.member || "", assistantRoute.parameters.newName || "");
      return;
    }

    if (assistantRoute.kind === "action" && assistantRoute.id === "safety.dangerous_operation") {
      await runDangerousOperationAction(text);
      return;
    }

    if (assistantRoute.kind === "fallback" && assistantRoute.suggestedAction === "memory.save") {
      await runGenericAssistantAction("memory.save", text);
      return;
    }

    if (assistantRoute.kind === "action") {
      await runGenericAssistantAction(assistantRoute.id, text, assistantRoute.parameters);
      return;
    }

    if (assistantRoute.kind === "automation") {
      await runMatchedAutomationUnit(assistantRoute.unit, text);
      return;
    }

    if (!shouldOfferRoutedTaskSuggestion) {
      await runCasualChatAction(text);
      return;
    }

    setIsSuggesting(true);
    setAutomationFeedback({ state: "running", text: "正在整理任务..." });
    const localSuggestion = suggestOpenVolunteerQuestion(routedFocusText, members) || suggestAssignment(routedFocusText, members, currentMemberId, submittedAssigneeMentionIds);
    const requestedSuggestion: AssignmentSuggestion = directTimedTask
      ? localSuggestion
      : (await requestAssignmentSuggestion(routedFocusText, submittedAssigneeMentionIds, activeTab, 4200)) || localSuggestion;
    const rawSuggestion = keepLocalSelfAssignment(localSuggestion, submittedAssigneeMentionIds, currentMemberId)
      ? { ...requestedSuggestion, suggestedAssignees: localSuggestion.suggestedAssignees, reason: localSuggestion.reason }
      : requestedSuggestion;
    const reminder = parseTaskReminder(routedFocusText);
    const suggestion = {
      ...rawSuggestion,
      displayTime: rawSuggestion.displayTime || reminder.displayTime,
      dueAt: rawSuggestion.dueAt || reminder.dueAt,
      recurrence: rawSuggestion.recurrence || reminder.recurrence,
      sourceText: rawSuggestion.sourceText || assistantInputText,
      taskTitle: normalizeTaskTitle(rawSuggestion.taskTitle || reminder.title || routedFocusText, rawSuggestion.displayTime || reminder.displayTime),
      requiresClarification: rawSuggestion.requiresClarification || reminder.requiresClarification,
      clarificationMessage: rawSuggestion.clarificationMessage || reminder.clarificationMessage
    };

    if (composerSubmitSeqRef.current !== submitSeq || composerDraftVersionRef.current !== submittedDraftVersion) {
      setIsSuggesting(false);
      setTemporaryVoiceStatus(null);
      return;
    }

    if (suggestion.requiresClarification) {
      const clarification = suggestion.clarificationMessage || "你希望我提醒你做什么？请补充具体事项。";
      void appendUiConversationTurn(text, clarification);
      setAutomationFeedback(createAutomationFeedback("done", clarification, undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
      setIsSuggesting(false);
      setTemporaryVoiceStatus(null);
      return;
    }
    setPendingSuggestion(suggestion);
    const nextTaskText = suggestion.taskTitle || text;
    setPendingTaskText(nextTaskText);
    const suggestionAnswer = formatTaskCandidateReply(nextTaskText, suggestion);
    void appendUiConversationTurn(text, suggestionAnswer);
    setAutomationFeedback(createAutomationFeedback("done", suggestionAnswer, undefined, { displayTarget: "inline_assistant", displayType: "task_candidate", links: false }));
    setIsSuggesting(false);
    setTemporaryVoiceStatus(null);
  }

  function createContextualGroup(groupPlan: NonNullable<Extract<AssistantRoute, { kind: "action" }>["parameters"]["groupPlan"]>) {
    const assistantMember = members.find((member) => member.householdRoles?.includes("assistant")) || members.find((member) => member.id === "fanmili");
    const sentAt = new Date().toISOString();
    const initialMessage: RoomMessage = {
      id: `assistant-group-${Date.now()}`,
      body: groupPlan.message,
      senderAvatarSeed: assistantMember?.avatarSeed || "fanmili",
      senderMemberId: assistantMember?.id || "fanmili",
      senderName: assistantMember?.displayName || "饭米粒",
      sentAt,
      presentation: "activity_plan",
      type: "text"
    };
    const groupResult = onCreateGroupChatTask(groupPlan.message, {
      initialMessages: [initialMessage],
      memberIds: groupPlan.memberIds,
      openAfterCreate: true,
      reuseMatchingMembers: false,
      title: groupPlan.title
    });
    setAutomationFeedback(null);
    setPendingSuggestion(null);
    setPendingTaskText("");
    setTemporaryVoiceStatus(`已创建群组：${groupResult.title}`);
  }

  function createFamilyQuestionGroup(plan: FamilyQuestionPlan) {
    const assistantMember = members.find((member) => member.householdRoles?.includes("assistant")) || members.find((member) => member.id === "fanmili");
    const initialMessage: RoomMessage = {
      id: `assistant-question-${Date.now()}`,
      body: plan.message,
      senderAvatarSeed: assistantMember?.avatarSeed || "fanmili",
      senderMemberId: assistantMember?.id || "fanmili",
      senderName: assistantMember?.displayName || "饭米粒",
      sentAt: new Date().toISOString(),
      knowledgeInquiryId: plan.knowledgeInquiryId,
      type: "text"
    };
    const groupResult = onCreateGroupChatTask(plan.message, {
      initialMessages: [initialMessage],
      memberIds: plan.memberIds,
      openAfterCreate: true,
      reuseMatchingMembers: false,
      title: plan.title
    });
    setAutomationFeedback(null);
    setPendingSuggestion(null);
    setPendingTaskText("");
    setTemporaryVoiceStatus(`已创建群组：${groupResult.title}`);
  }

  function handleConfirmSuggestion() {
    confirmPendingSuggestion(inputValue.trim());
  }

  function confirmPendingSuggestion(confirmText: string) {
    const text = pendingTaskText || inputValue.trim();

    if (!text || !pendingSuggestion) {
      return;
    }

    if (pendingSuggestion.dueAt && new Date(pendingSuggestion.dueAt).getTime() <= Date.now()) {
      const answer = "这个提醒时间已经过去了，请重新指定一个未来时间。";
      void appendUiConversationTurn(confirmText || text, answer);
      setAutomationFeedback(createAutomationFeedback("done", answer, undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
      setPendingSuggestion(null);
      setPendingTaskText("");
      setTemporaryVoiceStatus(null);
      return;
    }

    onQuickCapture(text, pendingSuggestion);
    void appendUiConversationTurn(confirmText || text, "任务已创建");
    setAutomationFeedback(null);
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setPendingTaskText("");
    setTemporaryVoiceStatus(null);
  }

  function handleCancelSuggestion() {
    if (inputValue.trim() && pendingSuggestion) {
      void appendUiConversationTurn(inputValue.trim(), "已取消任务建议。");
      setAutomationFeedback(createAutomationFeedback("done", "已取消，继续输入也可以。", undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
    }
    setPendingSuggestion(null);
    setPendingTaskText("");
    setTemporaryVoiceStatus(null);
  }

  function handleInputChange(value: string) {
    composerDraftVersionRef.current += 1;
    setInputValue(value);
    setMentionPickerOpen(hasComposerMentionTrigger(value));
    setSlashMenuOpen(hasComposerSlashTrigger(value) && !/[@＠]/.test(value));
    const shouldClearFeedback = automationFeedback !== null && automationFeedback.state !== "running";
    if (!shouldClearFeedback) {
      return;
    }
    startInputTransition(() => {
      if (shouldClearFeedback) {
        setAutomationFeedback(null);
      }
    });
  }

  function focusComposerInput(_variant: "base" | "dock") {
    if (typeof window === "undefined") {
      return;
    }
    window.requestAnimationFrame(() => {
      baseInputRef.current?.focus({ preventScroll: true });
    });
  }

  function closeAvatarSheetAndRestoreFocus() {
    setShowAvatarSheet(false);
    window.requestAnimationFrame(() => baseInputRef.current?.focus({ preventScroll: true }));
  }

  function handleToggleMention(memberId: string, variant: "base" | "dock") {
    const member = mentionableMembers.find((candidate) => candidate.id === memberId);
    if (!member) return;
    const removing = selectedMentionIds.includes(memberId);
    const cursor = baseInputRef.current?.selectionStart ?? inputValue.length;
    const sentenceStartSelection = isComposerMentionTriggerAtStart(inputValue, cursor) || (inputValue.trim().length === 0 && selectedMentionIds.length > 0);
    const edit = removing
      ? removeComposerMention(inputValue, member.displayName)
      : sentenceStartSelection
        ? clearComposerMentionTrigger(inputValue, cursor)
        : insertComposerMention(inputValue, member.displayName, cursor);
    composerDraftVersionRef.current += 1;
    setSelectedMentionIds((ids) => toggleMemberId(ids, memberId));
    setInputValue(edit.value);
    setMentionPickerOpen(sentenceStartSelection);
    setSlashMenuOpen(false);
    focusComposerInput(variant);
    window.requestAnimationFrame(() => baseInputRef.current?.setSelectionRange(edit.caret, edit.caret));
  }

  function handleSelectAllMentions(variant: "base" | "dock") {
    const selectingAll = selectedMentionIds.length !== mentionableMembers.length;
    const cursor = baseInputRef.current?.selectionStart ?? inputValue.length;
    const sentenceStartSelection = isComposerMentionTriggerAtStart(inputValue, cursor) || (inputValue.trim().length === 0 && selectedMentionIds.length > 0);
    const edit = selectingAll
      ? sentenceStartSelection
        ? clearComposerMentionTrigger(inputValue, cursor)
        : mentionableMembers
          .filter((member) => !selectedMentionIds.includes(member.id))
          .reduce((current, member) => insertComposerMention(current.value, member.displayName, current.caret), { caret: cursor, value: inputValue })
      : mentionableMembers.reduce((current, member) => removeComposerMention(current.value, member.displayName), { caret: cursor, value: inputValue });
    composerDraftVersionRef.current += 1;
    setSelectedMentionIds((ids) => resolveAllMentionIds(mentionableMembers, ids));
    setInputValue(edit.value);
    setMentionPickerOpen(sentenceStartSelection && selectingAll);
    setSlashMenuOpen(false);
    focusComposerInput(variant);
    window.requestAnimationFrame(() => baseInputRef.current?.setSelectionRange(edit.caret, edit.caret));
  }

  function reopenMentionPicker(variant: "base" | "dock") {
    setMentionPickerOpen(true);
    setSlashMenuOpen(false);
    focusComposerInput(variant);
  }

  async function handleSlashCommand(command: SlashCommand, variant: "base" | "dock") {
    const sourceText = command.label;
    composerDraftVersionRef.current += 1;
    ensureActiveComposerSession();
    setMentionPickerOpen(false);
    setSlashMenuOpen(false);
    setPendingSuggestion(null);
    setPendingTaskText("");
    setInputValue((value) => stripLatestSlashTrigger(value));

    if (command.action === "account") {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setShowAvatarSheet(true);
      return;
    }

    beginAssistantTurn(sourceText);

    if (command.action === "api_usage") {
      await runAppAnswerAction(sourceText, "api.usage");
      return;
    }

    if (command.action === "deep_summary") {
      await runDeepSummaryCommand(sourceText);
      return;
    }

    const composerIntent = compileComposerIntent(sourceText);
    onCreateGroupChatTask(sourceText, { guestInvite: true });
    const answer = `群聊已创建：${composerIntent.action === "create_group_chat" ? composerIntent.fields.title : "临时群聊邀请"}`;
    void appendUiConversationTurn(sourceText, answer);
    setAutomationFeedback(createAutomationFeedback("done", answer, undefined, { displayTarget: "inline_assistant", displayType: "chat_reply", links: false }));
    focusComposerInput(variant);
    void enqueueMetaEvent({
      type: "composer_input",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      spaceId: coreSpaceId,
      text: sourceText,
      metadata: {
        action: "create_group_chat",
        intent: composerIntent
      }
    });
  }

  async function showProfileDescription(sourceText: string, memberQuery: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在查询..." });
    setTemporaryVoiceStatus("正在读取人物画像", { sticky: true });
    const result = await runAutomationAction("profile.describe", {
      member: memberQuery,
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const profileResult = readAutomationResultPayload(result) as { memberName?: string; source?: string; text?: string; status?: string } | undefined;
    const text = profileResult?.text || "没有找到这个成员的人物画像。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, text, { state: result ? "done" : "error" });
  }

  async function runMemberKnowledgeResolveAction(sourceText: string, memberName: string, memberId: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在查找可靠依据..." });
    setTemporaryVoiceStatus("正在查找可靠依据", { sticky: true });
    const result = await runAutomationAction("member.knowledge.resolve", {
      member: memberName,
      member_id: memberId,
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result) as {
      familyQuestionPlan?: FamilyQuestionPlan;
      inquiryId?: string;
      options?: AssistantRouteActionButton[];
      resolutionKind?: "ask_member" | "evidence_answer";
      text?: string;
    } | undefined;
    const answer = result?.userReply || payload?.text || "现有记录里没有找到足够依据。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    if (payload?.resolutionKind === "ask_member" && payload.familyQuestionPlan) {
      void appendUiConversationTurn(sourceText, answer);
      if (payload.inquiryId) {
        setPendingKnowledgeInquiry({ id: payload.inquiryId, memberName, status: "awaiting_choice" });
      }
      setAutomationFeedback({
        clarification: {
          familyQuestionPlan: payload.familyQuestionPlan,
          id: `member-knowledge-${Date.now()}`,
          knowledgeInquiryId: payload.inquiryId,
          memberName,
          options: payload.options || [
            { label: `问${memberName}`, value: "ask_member" },
            { label: "我来补充", value: "provide_input" },
            { label: "先不处理", value: "dismiss" }
          ],
          originalText: sourceText,
          prompt: answer,
          round: 1
        },
        displayTarget: "inline_assistant",
        displayType: "confirmation_card",
        state: "done",
        text: answer
      });
      return;
    }
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runProfileLearningPipeline(sourceText: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在整理大家的人物画像..." });
    setTemporaryVoiceStatus("正在整理人物画像", { sticky: true });
    const result = await runAutomationPipeline("pipeline.meta.profile_learning", {
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    setAutomationFeedback({
      state: result ? "done" : "error",
      text: result ? "已根据历史信息更新大家的人物画像。" : "人物画像整理失败。"
    });
  }

  function handleAssistantActionResult(
    result: AutomationActionResponse | null,
    fallbackText: string,
    options: { display?: AssistantDisplayPayload; state?: AutomationFeedback["state"] } = {}
  ) {
    const payload = result?.data;
    const target = result?.display?.target ?? "inline_assistant";
    const displayType = result?.display?.type ?? (result?.ok === false ? "error_card" : "chat_reply");
    const text = result?.userReply || fallbackText;
    const state = options.state || (result?.ok === false ? "error" : "done");

    switch (target) {
      case "task_list":
      case "resource_list":
      case "group_chat":
        onAutomationRecords(target, payload);
        if (text) {
          setAutomationFeedback(createAutomationFeedback(state, text, payload, { confirmation: result?.confirmation, display: options.display, displayTarget: target, displayType }));
        }
        return;
      case "toast":
        setTemporaryVoiceStatus(text || fallbackText);
        setAutomationFeedback(null);
        return;
      case "modal":
      case "inline_assistant":
      default:
        setAutomationFeedback(createAutomationFeedback(state, text, payload, { confirmation: result?.confirmation, display: options.display, displayTarget: "inline_assistant", displayType }));
        return;
    }
  }

  async function confirmPendingAutomation(confirmation: NonNullable<AutomationActionResponse["confirmation"]>) {
    setAutomationFeedback({ state: "running", text: "正在确认执行…" });
    const result = confirmation.pipelineId
      ? await runAutomationPipeline(confirmation.pipelineId, confirmation.parameters, { confirmationToken: confirmation.token })
      : confirmation.actionId
        ? await runAutomationAction(confirmation.actionId as AutomationActionId, confirmation.parameters, { confirmationToken: confirmation.token })
        : null;
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "操作未完成。";
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runAppAnswerAction(sourceText: string, queryType?: string, recordDate?: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在查询..." });
    setTemporaryVoiceStatus("正在查询", { sticky: true });
    const result = await runAutomationAction("app.answer", {
      query_type: queryType,
      record_date: recordDate,
      session_id: conversationSessionIdRef.current,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "没有查到结果。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runMemberRenameAction(sourceText: string, member: string, newName: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在改名..." });
    setTemporaryVoiceStatus("正在改名", { sticky: true });
    const result = await runAutomationAction("member.rename", {
      member,
      new_name: newName,
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "改名失败。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runCasualChatAction(sourceText: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在回复..." });
    setTemporaryVoiceStatus("正在回复", { sticky: true });
    const contextMessages = composerSession.id === conversationSessionIdRef.current ? composerSession.messages : [];
    const result = await runAutomationAction("app.chat", {
      recent_user_texts: contextMessages
        .filter((message) => message.role === "user")
        .map((message) => message.text)
        .slice(-8),
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || result?.error || (payload as { text?: string } | undefined)?.text || "回复暂时不可用，请稍后重试。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runWebSearchAction(sourceText: string) {
    const query = normalizeWebSearchQuery(sourceText);
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在联网搜索..." });
    setTemporaryVoiceStatus("正在联网搜索", { sticky: true });
    const result = await runAutomationAction("web.search.duckduckgo", {
      max_results: 5,
      query,
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = formatWebSearchFeedback(query, payload);
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runDangerousOperationAction(sourceText: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在隔离危险操作..." });
    setTemporaryVoiceStatus("正在隔离危险操作", { sticky: true });
    const result = await runAutomationAction("safety.dangerous_operation", {
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "这是危险操作，已隔离，没有执行。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runGenericAssistantAction(actionId: AutomationActionId, sourceText: string, parameters: Record<string, unknown> = {}) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在处理..." });
    setTemporaryVoiceStatus("正在处理", { sticky: true });
    const result = await runAutomationAction(actionId, {
      ...parameters,
      session_id: conversationSessionIdRef.current,
      text: typeof parameters.text === "string" && parameters.text.trim() ? parameters.text : sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "处理完成。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  async function runMatchedAutomationUnit(unit: AutomationUnitDefinition, sourceText: string) {
    setPendingSuggestion(null);
    setPendingTaskText("");
    setAutomationFeedback({ state: "running", text: `正在处理...` });
    setTemporaryVoiceStatus(`正在处理`, { sticky: true });
    const parameters = {
      session_id: conversationSessionIdRef.current,
      text: sourceText,
      title: normalizeTaskTitle(sourceText)
    };
    const result =
      unit.unit === "pipeline"
        ? await runAutomationPipeline(unit.id, parameters)
        : await runAutomationAction(unit.id, parameters);
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    const feedbackText = result ? formatAutomationFeedbackText(unit) : "处理失败。";
    handleAssistantActionResult(result, feedbackText, { state: result ? "done" : "error" });
  }

  async function runDeepSummaryCommand(sourceText: string) {
    setPendingSuggestion(null);
    setAutomationFeedback({ state: "running", text: "正在生成深度总结..." });
    setTemporaryVoiceStatus("正在生成深度总结", { sticky: true });
    const result = await runAutomationAction("summary.personal.daily", {
      session_id: conversationSessionIdRef.current,
      text: sourceText
    });
    const payload = readAutomationResultPayload(result);
    const answer = result?.userReply || (payload as { text?: string } | undefined)?.text || "深度总结生成失败。";
    setInputValue("");
    setSelectedMentionIds([]);
    setPendingSuggestion(null);
    setTemporaryVoiceStatus(null);
    handleAssistantActionResult(result, answer, { state: result ? "done" : "error" });
  }

  const humanMentionableMembers = members.filter((member) => member.id !== currentMemberId && member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"));
  const mentionableMembers = humanMentionableMembers.length > 0 || !liteBackend
    ? humanMentionableMembers
    : members.filter((member) => member.householdRoles?.includes("assistant"));
  const selectedMentionMembers = mentionableMembers.filter((member) => selectedMentionIds.includes(member.id));
  const showMentionPicker = mentionPickerOpen && !pendingSuggestion && mentionableMembers.length > 0;
  const showSlashMenu = slashMenuOpen && !showMentionPicker && !pendingSuggestion;
  const composerSearchIndex = useMemo(() => buildComposerSearchIndex(records), [records]);
  const searchSuggestions = useMemo(
    () => (isComposingText ? [] : buildComposerSearchSuggestions(debouncedInputValue, composerSearchIndex)),
    [composerSearchIndex, debouncedInputValue, isComposingText]
  );
  const showSearchSuggestions = searchSuggestions.length > 0 && !showMentionPicker && !showSlashMenu && !pendingSuggestion && !isComposingText;
  const showComposerPanel = composerSheetOpen && composerSession.messages.length > 0;

  function shouldPreventComposerPageScroll() {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 768;
  }

  function focusComposerInputWithoutPageScroll(event: PointerEvent<HTMLTextAreaElement>) {
    if (!shouldPreventComposerPageScroll()) return;
    event.preventDefault();
    if (event.pointerType === "touch") composerInputTouchHandledAtRef.current = window.performance.now();
    baseInputRef.current?.focus({ preventScroll: true });
  }

  function focusComposerInputFromTouch(event: TouchEvent<HTMLTextAreaElement>) {
    const pointerHandledAt = composerInputTouchHandledAtRef.current;
    if (!shouldPreventComposerPageScroll() || (pointerHandledAt !== null && window.performance.now() - pointerHandledAt < 700)) return;
    event.preventDefault();
    baseInputRef.current?.focus({ preventScroll: true });
  }

  function beginVoiceInput() {
    setVoiceTranscriptPreview("");
    voiceInsertionRef.current = captureVoiceInsertionPoint(baseInputRef.current, inputValueRef.current);
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition || shouldPreferReusableVoiceCapture()) {
      void beginFallbackVoiceInput();
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join("")
        .trim();
      applyVoiceTranscript(transcript);
    };
    recognition.onerror = () => {
      voiceRecognitionRef.current = null;
      if (voicePressActiveRef.current) void beginFallbackVoiceInput();
    };
    recognition.onend = () => {
      voiceRecognitionRef.current = null;
      if (voicePressActiveRef.current && !voiceFallbackActiveRef.current) {
        void beginFallbackVoiceInput();
      } else if (!voiceFallbackActiveRef.current) {
        setVoiceRecording(false);
      }
    };
    voiceRecognitionRef.current = recognition;
    try {
      recognition.start();
      triggerHaptic("start");
      setVoiceRecording(true);
      setTemporaryVoiceStatus(null);
    } catch {
      void beginFallbackVoiceInput();
    }
  }

  async function beginFallbackVoiceInput() {
    if (voiceFallbackActiveRef.current) return;
    voiceFallbackActiveRef.current = true;
    voiceFallbackStopRequestedRef.current = false;
    triggerHaptic("start");
    setVoiceRecording(true);
    setTemporaryVoiceStatus(null);
    try {
      const capture = await startFallbackVoiceCapture({
        onTranscript: (transcript) => {
          applyVoiceTranscript(transcript);
          triggerHaptic("success");
          voiceFallbackActiveRef.current = false;
          voiceFallbackCaptureRef.current = null;
          setVoiceRecording(false);
        },
        onError: (message) => {
          voiceFallbackActiveRef.current = false;
          voiceFallbackCaptureRef.current = null;
          setVoiceRecording(false);
          setTemporaryVoiceStatus(message);
        }
      });
      voiceFallbackCaptureRef.current = capture;
      if (voiceFallbackStopRequestedRef.current) capture.stop();
    } catch (error) {
      voiceFallbackActiveRef.current = false;
      setVoiceRecording(false);
      setTemporaryVoiceStatus(formatVoiceCaptureError(error));
    }
  }

  function armVoiceInput() {
    voiceSendSuppressClickRef.current = false;
    voicePressActiveRef.current = true;
    beginVoiceInput();
  }

  function releaseVoiceInput() {
    if (voicePressActiveRef.current) {
      voicePressActiveRef.current = false;
      setVoiceRecording(false);
      triggerHaptic("stop");
      voiceSendSuppressClickRef.current = true;
      if (voiceFallbackActiveRef.current) {
        voiceFallbackStopRequestedRef.current = true;
        voiceFallbackCaptureRef.current?.stop();
        setVoiceRecording(false);
        return;
      }
      voiceRecognitionRef.current?.stop();
      voiceRecognitionRef.current = null;
      setVoiceRecording(false);
    }
  }

  function applyVoiceTranscript(transcript: string) {
    const point = voiceInsertionRef.current;
    if (!point) return;
    setVoiceTranscriptPreview(transcript.trim());
    const next = insertVoiceTranscript(point, transcript);
    handleInputChange(next.value);
    if (point.keepKeyboardOpen) {
      window.requestAnimationFrame(() => {
        baseInputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    }
  }

  function keepKeyboardDockFocused() {
    window.requestAnimationFrame(() => {
      baseInputRef.current?.focus({ preventScroll: true });
    });
  }

  function handleAttachmentClick() {
    baseFileInputRef.current?.click();
  }

  async function handleComposerUploadResources(files: File[]) {
    const uploadPrompt = `上传附件：${files.map((file) => file.name).join("、")}`;
    ensureActiveComposerSession();
    beginAssistantTurn(uploadPrompt);

    let outcome: ResourceUploadOutcome;
    try {
      outcome = await onUploadResources(files);
    } catch (error) {
      outcome = {
        answer: error instanceof Error ? `附件上传失败：${error.message}` : "附件上传失败，请重试。",
        state: "error",
        voiceStatus: "附件上传失败"
      };
    }

    if (outcome.activeResource) activeResourceRef.current = outcome.activeResource;

    void appendUiConversationTurn(uploadPrompt, outcome.answer, outcome.activeResource ? {
      activeResourceId: outcome.activeResource.id,
      activeResourceTitle: outcome.activeResource.title
    } : undefined);
    setAutomationFeedback(createAutomationFeedback(outcome.state, outcome.answer, undefined, {
      displayTarget: "inline_assistant",
      displayType: "chat_reply",
      links: false
    }));
    setTemporaryVoiceStatus(outcome.voiceStatus);
  }

  function renderAssistantResultSheet() {
    return (
      <AssistantResultSheet
        entries={composerSession.messages}
        familyInviteDraft={familyInviteDraft}
        inviterName={currentMemberName}
        onOpenLink={(link) => {
          onOpenRelatedRecord(link);
        }}
        onCancelSuggestion={pendingSuggestion ? handleCancelSuggestion : undefined}
        onConfirmAutomation={(confirmation) => void confirmPendingAutomation(confirmation)}
        onConfirmSuggestion={pendingSuggestion ? handleConfirmSuggestion : undefined}
        onClarificationChoice={(clarification, option) => void handleClarificationChoice(clarification, option)}
        onContinue={() => {
          setPendingSuggestion(null);
          setFamilyInviteDraft(null);
          setAutomationFeedback(null);
        }}
        onDismissFamilyInvite={() => setFamilyInviteDraft(null)}
        onSwipeDown={collapseComposerPanel}
      />
    );
  }

  async function handleClarificationChoice(clarification: AssistantClarification, option: AssistantRouteActionButton) {
    void enqueueMetaEvent({
      type: "assistant_clarification_choice",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      spaceId: coreSpaceId,
      text: option.label,
      metadata: {
        excludedFromFamilyMemory: true,
        options: clarification.options.map((item) => ({ label: item.label, value: item.value })),
        originalText: clarification.originalText,
        parentClarificationId: clarification.parentId,
        selectedPath: clarification.selectedPath || [],
        round: clarification.round,
        selectedValue: option.value,
        sessionId: conversationSessionIdRef.current
      }
    });
    beginAssistantTurn(`选择：${option.label}`);
    if (option.value === "revise_input") {
      setAutomationFeedback(null);
      setInputValue(clarification.originalText);
      window.requestAnimationFrame(() => focusComposerInput("base"));
      return;
    }
    if (option.value === "ask_member" && clarification.familyQuestionPlan) {
      const inquiryId = clarification.knowledgeInquiryId;
      if (inquiryId) {
        const result = await runAutomationAction("member.knowledge.ask", {
          inquiry_id: inquiryId,
          text: clarification.originalText
        });
        const payload = readAutomationResultPayload(result) as { familyQuestionPlan?: FamilyQuestionPlan } | undefined;
        createFamilyQuestionGroup(payload?.familyQuestionPlan || {
          ...clarification.familyQuestionPlan,
          knowledgeInquiryId: inquiryId
        });
      } else {
        createFamilyQuestionGroup(clarification.familyQuestionPlan);
      }
      setPendingKnowledgeInquiry(null);
      return;
    }
    if (option.value === "provide_input") {
      setAutomationFeedback(null);
      if (clarification.knowledgeInquiryId) {
        setPendingKnowledgeInquiry({
          id: clarification.knowledgeInquiryId,
          memberName: clarification.memberName || "这位家人",
          status: "awaiting_user_input"
        });
      }
      setInputValue(clarification.memberName ? `关于${clarification.memberName}，我知道：` : "我来补充：");
      window.requestAnimationFrame(() => focusComposerInput("base"));
      return;
    }
    if (option.value === "dismiss") {
      if (clarification.knowledgeInquiryId) {
        await runAutomationAction("member.knowledge.dismiss", {
          inquiry_id: clarification.knowledgeInquiryId,
          text: clarification.originalText
        });
      }
      setPendingKnowledgeInquiry(null);
      setAutomationFeedback(null);
      setTemporaryVoiceStatus("已暂不处理");
      return;
    }
    const sourceText = clarification.originalText;
    const route = resolveAssistantClarification(clarification, option);
    if (route.kind === "fallback" && route.clarification) {
      setAutomationFeedback({
        clarification: route.clarification,
        displayTarget: "inline_assistant",
        displayType: "confirmation_card",
        state: "done",
        text: route.clarification.prompt
      });
      return;
    }
    if (route.kind === "fallback" && route.suggestedAction === "task.create.input") {
      await continueClarifiedTask(route.focusText || selectAssistantRoutingFocus(sourceText));
      return;
    }
    if (route.kind === "fallback" && route.suggestedAction === "memory.save") {
      await runGenericAssistantAction("memory.save", route.focusText || sourceText);
      return;
    }
    if (route.kind === "action" && route.id === "app.chat") {
      await runCasualChatAction(route.parameters.text);
      return;
    }
    if (route.kind === "action" && route.id === "web.search.duckduckgo") {
      await runWebSearchAction(route.parameters.text);
      return;
    }
    if (route.kind === "action" && route.id === "app.answer") {
      await runAppAnswerAction(route.parameters.text, route.parameters.queryType, route.parameters.recordDate);
    }
  }

  async function continueClarifiedTask(sourceText: string) {
    setAutomationFeedback({ state: "running", text: "正在整理任务..." });
    const localSuggestion = suggestOpenVolunteerQuestion(sourceText, members) || suggestAssignment(sourceText, members, currentMemberId, []);
    const requestedSuggestion = (await requestAssignmentSuggestion(sourceText, [], activeTab, 4200)) || localSuggestion;
    const rawSuggestion = keepLocalSelfAssignment(localSuggestion, [], currentMemberId)
      ? { ...requestedSuggestion, suggestedAssignees: localSuggestion.suggestedAssignees, reason: localSuggestion.reason }
      : requestedSuggestion;
    const reminder = parseTaskReminder(sourceText);
    const suggestion = {
      ...rawSuggestion,
      displayTime: rawSuggestion.displayTime || reminder.displayTime,
      dueAt: rawSuggestion.dueAt || reminder.dueAt,
      sourceText: rawSuggestion.sourceText || sourceText,
      taskTitle: normalizeTaskTitle(rawSuggestion.taskTitle || reminder.title || sourceText, rawSuggestion.displayTime || reminder.displayTime),
      requiresClarification: rawSuggestion.requiresClarification || reminder.requiresClarification,
      clarificationMessage: rawSuggestion.clarificationMessage || reminder.clarificationMessage
    };
    if (suggestion.requiresClarification) {
      const text = suggestion.clarificationMessage || "还缺少任务内容或时间，请再补充一句。";
      setAutomationFeedback(createAutomationFeedback("done", text, undefined, { links: false }));
      return;
    }
    setPendingSuggestion(suggestion);
    const taskText = suggestion.taskTitle || sourceText;
    setPendingTaskText(taskText);
    setAutomationFeedback(createAutomationFeedback("done", formatTaskCandidateReply(taskText, suggestion), undefined, {
      displayTarget: "inline_assistant",
      displayType: "task_candidate",
      links: false
    }));
  }

  function renderComposerInputRow(variant: "base" | "dock") {
    const inputId = "family-main-composer";
    const fileInputRef = baseFileInputRef;
    const voiceReady = !inputValue.trim() && selectedMentionIds.length === 0;
    return (
      <>
        <SharedComposerInputRow
          beforeInput={(
            <>
              {showSearchSuggestions ? (
                <div className="composer-search-suggestions" aria-label="输入框匹配项">
                  {searchSuggestions.map((suggestion) => (
                    <button
                      key={suggestion.record.id}
                      type="button"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => {
                        handleInputChange(suggestion.record.title);
                        keepKeyboardDockFocused();
                      }}
                    >
                      <strong>{suggestion.record.title}</strong>
                      <span>{suggestion.hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {showMentionPicker ? (
                <MentionPicker
                  members={mentionableMembers}
                  selectedIds={selectedMentionIds}
                  onSelectAll={() => handleSelectAllMentions(variant)}
                  onToggle={(memberId) => handleToggleMention(memberId, variant)}
                />
              ) : null}
              {showSlashMenu ? <SlashCommandMenu commands={composerSlashCommands} onSelect={(command) => handleSlashCommand(command, variant)} /> : null}
            </>
          )}
          inputClassName={voiceRecording ? "voice-recording" : undefined}
          inputLeadingContent={(
            <>
              {selectedMentionMembers.length > 0 ? (
                <span className="composer-mention-chips" aria-label="已艾特成员">
                  {selectedMentionMembers.map((member) => (
                    <button
                      aria-label={`重新选择艾特成员；当前已选择${member.displayName}`}
                      className="composer-mention-chip"
                      key={member.id}
                      type="button"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => reopenMentionPicker(variant)}
                    >
                      <MemberAvatar member={member} />
                      <span className="sr-only">{member.displayName}</span>
                    </button>
                  ))}
                </span>
              ) : null}
              {voiceRecording ? <ComposerVoiceIndicator transcript={voiceTranscriptPreview} /> : null}
            </>
          )}
          inputControl={(
            <ComposerAutosizeTextarea
              ref={baseInputRef}
              aria-label="家庭输入"
              autoComplete="off"
              highlightTime
              id={inputId}
              name="composer"
              onContextMenu={(event) => event.preventDefault()}
              onChange={(event) => handleInputChange(event.target.value)}
              onCompositionEnd={(event) => {
                setIsComposingText(false);
                handleInputChange(event.currentTarget.value);
              }}
              onCompositionStart={() => setIsComposingText(true)}
              onBlur={() => setIsComposingText(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onFocus={() => {
                if (composerSession.messages.length > 0) setComposerSheetOpen(true);
              }}
              onPointerDown={focusComposerInputWithoutPageScroll}
              onTouchStart={focusComposerInputFromTouch}
              placeholder={voiceRecording ? "正在听，请说话…" : voiceStatus || (showComposerPanel ? "继续输入..." : "")}
              value={inputValue}
            />
          )}
          attachmentButtonProps={{
            "aria-label": "附件",
            onClick: handleAttachmentClick,
            type: "button"
          }}
          sendButtonProps={{
            "aria-label": voiceRecording ? "正在语音输入，松开结束" : isSuggesting ? "建议中" : voiceReady ? "发送；按住语音输入" : "发送",
            "aria-pressed": voiceRecording,
            className: voiceRecording ? "voice-active" : undefined,
            disabled: isSuggesting,
            onClick: (event) => {
              if (!voiceSendSuppressClickRef.current) return;
              event.preventDefault();
              voiceSendSuppressClickRef.current = false;
            },
            onContextMenu: (event) => event.preventDefault(),
            onPointerDown: (event) => {
              if (!voiceReady) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              armVoiceInput();
            },
            onPointerUp: (event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              releaseVoiceInput();
            },
            onPointerCancel: (event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              releaseVoiceInput();
            },
            onLostPointerCapture: releaseVoiceInput,
            type: "submit"
          }}
        />
        <input
          ref={fileInputRef}
          accept={RESOURCE_UPLOAD_ACCEPT}
          aria-label="选择附件"
          hidden
          multiple
          name="attachments"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            if (files.length > 0) {
              void handleComposerUploadResources(files);
            }
            event.currentTarget.value = "";
          }}
          type="file"
        />
      </>
    );
  }

  if (suspended) {
    return null;
  }

  return (
    <>
      {!showAvatarSheet ? (
        <form className={showComposerPanel ? "composer composer-with-sheet" : "composer"} onSubmit={handleSubmit}>
          {showComposerPanel ? renderAssistantResultSheet() : null}
          {renderComposerInputRow("base")}
        </form>
      ) : null}
      {showAvatarSheet ? (
        <AvatarPickerSheet
          currentProfile={avatarProfile}
          currentSeed={avatarSeed}
          currentMemberId={currentMemberId}
          members={members}
          onClose={closeAvatarSheetAndRestoreFocus}
          onSave={(profile) => {
            onAvatarSettingsSave({ displayName: profile.displayName, nickname: profile.nickname, title: profile.title }, profile.avatarSeed);
            closeAvatarSheetAndRestoreFocus();
          }}
        />
      ) : null}
    </>
  );

  function setTemporaryVoiceStatus(message: string | null, options: { sticky?: boolean } = {}) {
    clearLongPressTimer(voiceStatusTimerRef);
    setVoiceStatus(message);

    if (message && !options.sticky) {
      voiceStatusTimerRef.current = setTimeout(() => {
        setVoiceStatus(null);
      }, 2400);
    }
  }

  async function appendUiConversationTurn(
    userText: string,
    assistantText: string,
    entityState?: { activeResourceId?: string; activeResourceTitle?: string }
  ) {
    const promptResult = buildLifeLogPromptResult(userText, assistantText);
    await enqueueMetaEvent({
      type: "app_chat_turn",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      spaceId: coreSpaceId,
      text: userText,
      metadata: {
        assistantText,
        entityState,
        actionButtons: promptResult.action_buttons,
        lifeLogPromptResult: promptResult,
        modelName: "local-composer-router",
        model_name: "local-composer-router",
        promptVersion: lifeLogPromptVersion,
        prompt_version: lifeLogPromptVersion,
        rawMetaPolicy: {
          allow_reparse: true,
          do_not_overwrite_raw_record: true,
          preserve_uploaded_files: true,
          preserve_conversation_context: true,
          preserve_raw_input: true,
          source_record_ids_required_for_summary: true
        },
        structuredData: promptResult.structured_data,
        sessionId: conversationSessionIdRef.current,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        userText
      }
    });
  }

  function createAutomationFeedback(
    state: AutomationFeedback["state"],
    text: string,
    payload?: unknown,
    options: {
      confirmation?: AutomationFeedback["confirmation"];
      display?: AssistantDisplayPayload;
      displayTarget?: AutomationDisplayTarget;
      displayType?: AutomationDisplayType;
      links?: boolean;
    } = {}
  ): AutomationFeedback {
    const displayTarget = options.displayTarget || readDisplayTarget(payload) || "inline_assistant";
    const displayType = options.displayType || readDisplayType(payload) || "chat_reply";
    const shouldShowLinks = options.links !== false && shouldBuildAssistantResultLinks(displayTarget);
    return {
      confirmation: options.confirmation,
      display: undefined,
      displayTarget,
      displayType,
      links: shouldShowLinks ? buildAssistantResultLinks(text, payload, records, displayTarget) : [],
      state,
      text
    };
  }
}

function clearLongPressTimer(ref: { current: ReturnType<typeof setTimeout> | null }) {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

function clearPendingDeleteToast(ref: { current: ReturnType<typeof setTimeout> | null }) {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

function MentionPicker({
  className,
  members,
  onSelectAll,
  onToggle,
  selectedIds
}: {
  className?: string;
  members: FamilyMember[];
  onSelectAll: () => void;
  onToggle: (memberId: string) => void;
  selectedIds: string[];
}) {
  const hasHumanMember = members.some((member) => !member.householdRoles?.includes("assistant"));
  return (
    <div className={["mention-picker", className].filter(Boolean).join(" ")} aria-label="选择艾特成员">
      <div className="mention-options">
        {hasHumanMember ? <button
          className={selectedIds.length === members.length ? "mention-option mention-all-option active" : "mention-option mention-all-option"}
          type="button"
          aria-label="艾特全家"
          aria-pressed={selectedIds.length === members.length}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onSelectAll}
        >
          <span className="mention-avatar mention-all-avatar" aria-hidden="true">
            全
          </span>
          <span className="mention-relation">全家</span>
        </button> : null}
        {members.map((member) => (
          <button
            className={selectedIds.includes(member.id) ? "mention-option active" : "mention-option"}
            key={member.id}
            type="button"
            aria-label={`艾特${member.displayName}`}
            aria-pressed={selectedIds.includes(member.id)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onToggle(member.id)}
          >
            <span className="mention-avatar">
              <MemberAvatar member={member} />
            </span>
            <span className="mention-relation">{member.relationshipLabel === "配偶" ? member.displayName : member.relationshipLabel || member.displayName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SlashCommandMenu({ commands, onSelect }: { commands: SlashCommand[]; onSelect: (command: SlashCommand) => void }) {
  return (
    <div className="slash-menu" aria-label="选择快捷功能">
      <div className="slash-options">
        {commands.map((command) => (
          <button
            className="slash-command"
            key={command.action}
            type="button"
            aria-label={command.label}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onSelect(command)}
          >
            {command.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AvatarPickerSheet({
  currentProfile,
  currentSeed,
  currentMemberId: profileMemberId,
  members,
  onClose,
  onSave
}: {
  currentProfile: MemberAvatarProfile;
  currentSeed: string;
  currentMemberId: string;
  members: FamilyMember[];
  onClose: () => void;
  onSave: (profile: MemberAvatarProfile & { avatarSeed: string }) => void;
}) {
  const [batchIndex, setBatchIndex] = useState(0);
  const [cropSource, setCropSource] = useState<AvatarCropSource | null>(null);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState(currentProfile.displayName || defaultCurrentMemberName);
  const nickname = currentProfile.nickname;
  const [newPassword, setNewPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const initialSeed = familyAvatarSeeds.find((seed) => seed === currentSeed) || resolveMemberAvatarSeed({ avatarSeed: currentSeed, id: profileMemberId });
  const [selectedSeed, setSelectedSeed] = useState<string>(initialSeed);
  const [dismissDragging, setDismissDragging] = useState(false);
  const [dismissClosing, setDismissClosing] = useState(false);
  const [dismissX, setDismissX] = useState(0);
  const profileSheetRef = useRef<HTMLDivElement | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const dismissGestureRef = useRef<{
    activated: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const dismissTouchGestureRef = useRef<{
    activated: boolean;
    identifier: number;
    startX: number;
    startY: number;
  } | null>(null);
  const title = currentProfile.title;
  const occupiedAvatarSeeds = new Set(members.filter((member) => member.id !== profileMemberId).map(resolveMemberAvatarSeed));
  const availableAvatarSeeds = familyAvatarSeeds.filter((seed) => seed === selectedSeed || !occupiedAvatarSeeds.has(seed));
  const avatarBatchSize = 10;
  const avatarBatchCount = Math.max(1, Math.ceil(availableAvatarSeeds.length / avatarBatchSize));
  const avatarBatchStart = (batchIndex % avatarBatchCount) * avatarBatchSize;
  const avatarSeeds = availableAvatarSeeds.slice(avatarBatchStart, avatarBatchStart + avatarBatchSize);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  useEffect(() => {
    const surface = profileSheetRef.current;
    if (!surface) return;

    function canStartDismiss(target: EventTarget | null) {
      return !(target instanceof Element) || !target.closest(avatarProfileDismissBlockedTargets);
    }

    function trackDismiss(
      gesture: { activated: boolean; startX: number; startY: number },
      clientX: number,
      clientY: number
    ) {
      const deltaX = clientX - gesture.startX;
      const deltaY = clientY - gesture.startY;
      if (!gesture.activated) {
        if (Math.abs(deltaY) > 12 && Math.abs(deltaY) > Math.abs(deltaX)) return "cancel" as const;
        if (Math.abs(deltaX) < 12 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) return "pending" as const;
        gesture.activated = true;
        setDismissDragging(true);
      }
      setDismissX(deltaX);
      return "active" as const;
    }

    function finishDismiss(gesture: { activated: boolean; startX: number }, clientX: number) {
      if (!gesture.activated || dismissClosing) {
        setDismissDragging(false);
        setDismissX(0);
        return;
      }
      const deltaX = clientX - gesture.startX;
      const closeDistance = Math.min(104, window.innerWidth * 0.24);
      if (Math.abs(deltaX) < closeDistance) {
        setDismissDragging(false);
        setDismissX(0);
        return;
      }
      setDismissDragging(false);
      setDismissClosing(true);
      setDismissX(Math.sign(deltaX || 1) * window.innerWidth);
      dismissTimerRef.current = window.setTimeout(onClose, 230);
    }

    function startTouch(event: globalThis.TouchEvent) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !canStartDismiss(event.target)) return;
      dismissTouchGestureRef.current = {
        activated: false,
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY
      };
    }

    function moveTouch(event: globalThis.TouchEvent) {
      const gesture = dismissTouchGestureRef.current;
      const touch = Array.from(event.touches).find((item) => item.identifier === gesture?.identifier);
      if (!gesture || !touch) return;
      const status = trackDismiss(gesture, touch.clientX, touch.clientY);
      if (status === "cancel") {
        dismissTouchGestureRef.current = null;
        setDismissDragging(false);
        setDismissX(0);
      } else if (status === "active") {
        event.preventDefault();
      }
    }

    function endTouch(event: globalThis.TouchEvent) {
      const gesture = dismissTouchGestureRef.current;
      dismissTouchGestureRef.current = null;
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === gesture?.identifier);
      if (gesture && touch) finishDismiss(gesture, touch.clientX);
    }

    function cancelTouch() {
      dismissTouchGestureRef.current = null;
      setDismissDragging(false);
      setDismissX(0);
    }

    surface.addEventListener("touchstart", startTouch, { passive: true });
    surface.addEventListener("touchmove", moveTouch, { passive: false });
    surface.addEventListener("touchend", endTouch);
    surface.addEventListener("touchcancel", cancelTouch);
    return () => {
      surface.removeEventListener("touchstart", startTouch);
      surface.removeEventListener("touchmove", moveTouch);
      surface.removeEventListener("touchend", endTouch);
      surface.removeEventListener("touchcancel", cancelTouch);
    };
  }, [dismissClosing, onClose]);

  useEffect(() => () => {
    if (dismissTimerRef.current) window.clearTimeout(dismissTimerRef.current);
  }, []);

  function startPointerDismiss(event: PointerEvent<HTMLDivElement>) {
    if (
      !event.isPrimary
      || event.button !== 0
      || event.pointerType === "touch"
      || (event.target instanceof Element && event.target.closest(avatarProfileDismissBlockedTargets))
    ) return;
    dismissGestureRef.current = {
      activated: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
  }

  function movePointerDismiss(event: PointerEvent<HTMLDivElement>) {
    const gesture = dismissGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.activated) {
      if (Math.abs(deltaY) > 12 && Math.abs(deltaY) > Math.abs(deltaX)) {
        dismissGestureRef.current = null;
        return;
      }
      if (Math.abs(deltaX) < 12 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) return;
      gesture.activated = true;
      setDismissDragging(true);
    }
    event.preventDefault();
    setDismissX(deltaX);
  }

  function finishPointerDismiss(event: PointerEvent<HTMLDivElement>) {
    const gesture = dismissGestureRef.current;
    dismissGestureRef.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const closeDistance = Math.min(104, window.innerWidth * 0.24);
    setDismissDragging(false);
    if (!gesture.activated || Math.abs(deltaX) < closeDistance) {
      setDismissX(0);
      return;
    }
    setDismissClosing(true);
    setDismissX(Math.sign(deltaX || 1) * window.innerWidth);
    dismissTimerRef.current = window.setTimeout(onClose, 230);
  }

  function saveProfile() {
    onSave({ avatarSeed: selectedSeed, displayName: displayName.trim() || defaultCurrentMemberName, nickname: nickname.trim(), title });
  }

  async function handleAvatarFile(file?: File) {
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("请选择 JPG、PNG、WebP 等图片文件");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setError("图片请控制在 12MB 以内");
      return;
    }

    try {
      setError("");
      setCropSource(await readAvatarCropSource(file));
    } catch {
      setError("这张图片暂时无法读取，请换一张再试");
    }
  }

  async function updatePassword() {
    if (newPassword.length < 8) {
      setPasswordMessage("新密码至少需要 8 位");
      return;
    }
    if (newPassword !== passwordRepeat) {
      setPasswordMessage("两次输入的密码不一致");
      return;
    }
    setPasswordSaving(true);
    const response = await familyFetch("/api/auth/password", {
      body: JSON.stringify({ password: newPassword }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
    setPasswordSaving(false);
    if (!response?.ok) {
      setPasswordMessage(payload.detail || "密码修改失败，请重试。");
      return;
    }
    setNewPassword("");
    setPasswordRepeat("");
    setPasswordMessage("密码已更新");
  }

  return (
    <>
      <div
        className={`modal-sheet avatar-profile-sheet${dismissDragging ? " dragging" : ""}${dismissClosing ? " dismissing" : ""}`}
        ref={profileSheetRef}
        role="dialog"
        aria-label="编辑我的头像和资料"
        aria-modal="true"
        onPointerDown={startPointerDismiss}
        onPointerMove={movePointerDismiss}
        onPointerUp={finishPointerDismiss}
        onPointerCancel={() => {
          dismissGestureRef.current = null;
          setDismissDragging(false);
          setDismissX(0);
        }}
        style={{ "--avatar-profile-dismiss-x": `${dismissX}px` } as CSSProperties}
      >
        <header className="avatar-profile-close-row">
          <button aria-label="返回上一级" type="button" onClick={onClose}>
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <strong>我的资料</strong>
          <span aria-hidden="true" />
        </header>
        <div className="avatar-profile-scroll">
          <div className="avatar-profile-card">
            <AvatarImage alt="当前头像" label={displayName} seed={selectedSeed} />
            <div>
              <label>
                <span>名称</span>
                <input maxLength={16} onChange={(event) => setDisplayName(event.target.value)} placeholder="填写自己的名字" value={displayName} />
              </label>
            </div>
          </div>
          <details className="avatar-profile-disclosure">
            <summary><span>头像</span><small>更换或上传</small></summary>
            <div className="avatar-profile-disclosure-body">
              <div className="avatar-profile-inline-actions">
                <button className="avatar-upload-button" type="button" onClick={() => document.getElementById("my-avatar-upload")?.click()}>
                  <b aria-hidden="true">+</b> 上传头像
                </button>
                <button className="refresh-avatars" type="button" onClick={() => setBatchIndex((index) => index + 1)}>换一批</button>
              </div>
              <input
                accept="image/jpeg,image/png,image/webp,image/avif"
                aria-label="上传自己的头像"
                hidden
                id="my-avatar-upload"
                onChange={(event) => {
                  void handleAvatarFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
                type="file"
              />
              <div className="avatar-grid">
                {avatarSeeds.map((seed) => (
                  <button className={seed === selectedSeed ? "active" : ""} key={seed} type="button" onClick={() => setSelectedSeed(seed)}>
                    <AvatarImage alt="" decoding="sync" fetchPriority="high" loading="eager" seed={seed} />
                  </button>
                ))}
              </div>
              {error ? <p className="avatar-profile-error" role="alert">{error}</p> : null}
            </div>
          </details>
          <details className="avatar-profile-disclosure avatar-security-section">
            <summary><span>账号与安全</span><small>密码与登录</small></summary>
            <div className="avatar-profile-disclosure-body">
              <div className="avatar-profile-inline-actions">
                <button className="avatar-upload-button" type="button" onClick={() => setPasswordOpen((open) => !open)}>修改密码</button>
              </div>
              {passwordOpen ? (
                <div className="avatar-password-form">
                  <input autoComplete="new-password" minLength={8} onChange={(event) => setNewPassword(event.target.value)} placeholder="新密码（至少 8 位）" type="password" value={newPassword} />
                  <input autoComplete="new-password" minLength={8} onChange={(event) => setPasswordRepeat(event.target.value)} placeholder="再次输入新密码" type="password" value={passwordRepeat} />
                  <button disabled={passwordSaving} type="button" onClick={() => void updatePassword()}>{passwordSaving ? "更新中…" : "确认修改密码"}</button>
                  {passwordMessage ? <p className="avatar-profile-error" role="status">{passwordMessage}</p> : null}
                </div>
              ) : null}
            </div>
          </details>
          <button className="avatar-profile-save" type="button" onClick={() => void saveProfile()}>
            保存资料
          </button>
        </div>
      </div>
      {cropSource ? (
        <AvatarCropDialog
          source={cropSource}
          onCancel={() => setCropSource(null)}
          onSave={(avatarSeed) => {
            setSelectedSeed(avatarSeed);
            setCropSource(null);
          }}
        />
      ) : null}
    </>
  );
}

function AvatarCropDialog({ source, onCancel, onSave }: { source: AvatarCropSource; onCancel: () => void; onSave: (avatarSeed: string) => void }) {
  const cropSize = 264;
  const baseScale = cropSize / Math.min(source.width, source.height);
  const imageWidth = source.width * baseScale;
  const imageHeight = source.height * baseScale;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startOffset: { x: number; y: number }; startX: number; startY: number } | null>(null);

  function constrainOffset(nextOffset: { x: number; y: number }, nextScale = scale) {
    const maxX = Math.max(0, (imageWidth * nextScale - cropSize) / 2);
    const maxY = Math.max(0, (imageHeight * nextScale - cropSize) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, nextOffset.x)),
      y: Math.min(maxY, Math.max(-maxY, nextOffset.y))
    };
  }

  function updateScale(nextScale: number) {
    setScale(nextScale);
    setOffset((current) => constrainOffset(current, nextScale));
  }

  async function finishCrop() {
    onSave(await cropAvatarImage(source, cropSize, baseScale, scale, offset));
  }

  return (
    <div className="modal-sheet avatar-crop-modal" role="dialog" aria-label="裁剪头像" aria-modal="true">
      <div className="task-sheet-head">
        <div>
          <span>上传头像</span>
          <h3>移动和缩放到圆形范围内</h3>
        </div>
        <button type="button" onClick={onCancel}>取消</button>
      </div>
      <div
        className="avatar-crop-stage"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startOffset: offset, startX: event.clientX, startY: event.clientY };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          setOffset(constrainOffset({ x: drag.startOffset.x + event.clientX - drag.startX, y: drag.startOffset.y + event.clientY - drag.startY }));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      >
        <img alt="待裁剪的头像" draggable={false} src={source.src} style={{ height: `${imageHeight}px`, left: `${cropSize / 2 + offset.x}px`, top: `${cropSize / 2 + offset.y}px`, transform: `translate(-50%, -50%) scale(${scale})`, width: `${imageWidth}px` }} />
        <span aria-hidden="true" />
      </div>
      <label className="avatar-crop-zoom">
        <span>缩放</span>
        <input aria-label="头像缩放" max="3" min="1" onChange={(event) => updateScale(Number(event.target.value))} step="0.01" type="range" value={scale} />
        <span>{Math.round(scale * 100)}%</span>
      </label>
      <p className="avatar-crop-hint">拖动照片调整位置，保存后会压缩成正方形头像。</p>
      <button className="avatar-profile-save" type="button" onClick={() => void finishCrop()}>使用此头像</button>
    </div>
  );
}

function AssistantResultSheet({
  entries,
  familyInviteDraft,
  inviterName,
  onCancelSuggestion,
  onClarificationChoice,
  onConfirmAutomation,
  onConfirmSuggestion,
  onContinue,
  onOpenLink,
  onDismissFamilyInvite,
  onSwipeDown
}: {
  entries: ComposerChatMessage[];
  familyInviteDraft?: FamilyInviteDraft | null;
  inviterName: string;
  onCancelSuggestion?: () => void;
  onClarificationChoice: (clarification: AssistantClarification, option: AssistantRouteActionButton) => void;
  onConfirmAutomation: (confirmation: NonNullable<AutomationActionResponse["confirmation"]>) => void;
  onConfirmSuggestion?: () => void;
  onContinue?: () => void;
  onOpenLink: (link: AssistantResultLink) => void;
  onDismissFamilyInvite: () => void;
  onSwipeDown: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<{ pointerId: number; startY: number } | null>(null);
  const latestSuggestionEntry = onConfirmSuggestion
    ? entries.slice().reverse().find((entry) => entry.role === "assistant" && entry.state === "done")
    : undefined;
  const visibleEntries = latestSuggestionEntry ? [latestSuggestionEntry] : entries.slice(-8);
  useEffect(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }
    let animationFrame = 0;
    const scrollToLatest = () => {
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    };
    scrollToLatest();
    animationFrame = window.requestAnimationFrame(scrollToLatest);
    const settleTimer = window.setTimeout(scrollToLatest, 120);
    const resizeObserver = new ResizeObserver(scrollToLatest);
    resizeObserver.observe(element);
    Array.from(element.children).forEach((child) => resizeObserver.observe(child));
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      resizeObserver.disconnect();
    };
  }, [entries, onConfirmSuggestion]);

  return (
    <div
      className="assistant-result-sheet"
      role="dialog"
      aria-label="饭米粒家庭助手"
      onClick={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest("button, a, input, select, label, .family-invite-card")) {
          onSwipeDown();
        }
      }}
      onPointerDown={(event) => {
        swipeRef.current = { pointerId: event.pointerId, startY: event.clientY };
      }}
      onPointerUp={(event) => {
        const swipe = swipeRef.current;
        swipeRef.current = null;
        if (swipe?.pointerId === event.pointerId && event.clientY - swipe.startY > 42) {
          onSwipeDown();
        }
      }}
    >
      <div className="assistant-result-list" ref={listRef}>
        {visibleEntries.map((entry, index) => {
          return (
            <InlineAssistantCard
              entry={entry}
              key={entry.id}
              onCancelSuggestion={onCancelSuggestion}
              onClarificationChoice={onClarificationChoice}
              onConfirmAutomation={onConfirmAutomation}
              onConfirmSuggestion={onConfirmSuggestion}
              onContinue={onContinue}
              onOpenLink={onOpenLink}
              showSuggestionActions={index === visibleEntries.length - 1 && entry.role === "assistant" && entry.state === "done" && Boolean(onConfirmSuggestion)}
            />
          );
        })}
        {familyInviteDraft ? (
          <FamilyInviteCard draft={familyInviteDraft} inviterName={inviterName} onDismiss={onDismissFamilyInvite} />
        ) : null}
      </div>
    </div>
  );
}

const familyInviteRelationships = [...familyRelationshipOptions];
const familyInviteAvatarSeeds = ["young-mother", "young-father", "little-girl", "little-boy"];

function FamilyInviteCard({ draft, inviterName, onDismiss }: { draft: FamilyInviteDraft; inviterName: string; onDismiss: () => void }) {
  const [displayName, setDisplayName] = useState(draft.displayName);
  const [relationshipLabel, setRelationshipLabel] = useState(draft.relationshipLabel);
  const [avatarSeed, setAvatarSeed] = useState("");
  const [invite, setInvite] = useState<{ code: string; expiresAt: string; id: string; link: string } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const registrationLink = invite ? `${invite.link}?code=${encodeURIComponent(invite.code)}` : "";

  async function createFamilyInvite() {
    if (!relationshipLabel) return setError("请选择这位家人与你的关系。");
    if (!displayName.trim()) return setError("请填写这位家人的名字。");
    setBusy(true);
    setError("");
    const response = await familyFetch("/api/invites", {
      body: JSON.stringify({
        actor_name: inviterName,
        avatar_seed: avatarSeed,
        relationship_label: relationshipLabel,
        relationship_role: relationshipRoleForInvite(relationshipLabel),
        target_name: displayName.trim(),
        type: "family"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => ({})) as { detail?: string; invite?: { code: string; expiresAt: string; id: string; link: string } } : {};
    setBusy(false);
    if (!response?.ok || !payload.invite) return setError(payload.detail || "家庭邀请创建失败。");
    const fullLink = `${payload.invite.link}?code=${encodeURIComponent(payload.invite.code)}`;
    setInvite(payload.invite);
    setQrCode(await QRCode.toDataURL(fullLink, { color: { dark: "#18362a", light: "#ffffff" }, errorCorrectionLevel: "M", margin: 2, width: 224 }));
  }

  async function copyInvite() {
    if (!registrationLink) return;
    await copyTextToClipboard(registrationLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  if (invite) {
    return (
      <section className="family-invite-card family-invite-ready" aria-label="家庭成员邀请单">
        <header><span>家庭邀请</span><button aria-label="关闭邀请单" type="button" onClick={onDismiss}>×</button></header>
        <div className="family-invite-person">
          <div className="family-invite-avatar"><AvatarImage alt="" decoding="sync" height={52} label={displayName} loading="eager" seed={avatarSeed || displayName} width={52} /></div>
          <div><strong>{displayName}</strong><span>你的{relationshipLabel}</span></div>
        </div>
        {qrCode ? <img alt={`${displayName}的家庭注册二维码`} className="family-invite-qr" height={224} src={qrCode} width={224} /> : null}
        <p>扫码或打开链接注册。管理员确认后，才能进入家庭。</p>
        <button className="family-invite-primary" type="button" onClick={() => void copyInvite()}>{copied ? "已复制" : "复制注册链接"}</button>
        <small>24 小时有效 · 仅限 1 人 · 链接不是登录凭证</small>
      </section>
    );
  }

  return (
    <section className="family-invite-card" aria-label="填写家庭成员邀请">
      <header><span>邀请家人</span><button aria-label="关闭邀请单" type="button" onClick={onDismiss}>×</button></header>
      <h3>这位家人是你的谁？</h3>
      <div className="family-invite-relations" aria-label="选择亲属关系" role="group">
        {familyInviteRelationships.map((label) => <button aria-pressed={relationshipLabel === label} className={relationshipLabel === label ? "selected" : ""} key={label} type="button" onClick={() => { setRelationshipLabel(label); setError(""); }}><span>{label}</span>{relationshipLabel === label ? <i aria-hidden="true">✓</i> : null}</button>)}
      </div>
      <label className="family-invite-name"><span>姓名</span><input autoComplete="off" maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="输入真实姓名" value={displayName} /></label>
      <div className="family-invite-avatar-picker">
        <span>头像 <em>选填</em></span>
        <div>{familyInviteAvatarSeeds.map((seed) => <button aria-label={`选择头像 ${seed}`} aria-pressed={avatarSeed === seed} className={avatarSeed === seed ? "selected" : ""} key={seed} type="button" onClick={() => setAvatarSeed(seed)}><AvatarImage alt="" decoding="sync" height={38} label={displayName} loading="eager" seed={seed} width={38} /></button>)}<button aria-pressed={!avatarSeed} className={!avatarSeed ? "selected later" : "later"} type="button" onClick={() => setAvatarSeed("")}>稍后</button></div>
      </div>
      {error ? <p className="family-invite-error" role="alert">{error}</p> : null}
      <div className="family-invite-actions">
        <button className="family-invite-cancel" disabled={busy} type="button" onClick={onDismiss}>取消</button>
        <button className="family-invite-primary" disabled={busy} type="button" onClick={() => void createFamilyInvite()}>{busy ? "正在生成…" : "确认并生成邀请"}</button>
      </div>
      <small>对方注册后仍需家庭管理员确认</small>
    </section>
  );
}

function relationshipRoleForInvite(label: string) {
  return relationshipKindForLabel(label);
}

function InlineAssistantCard({
  entry,
  onCancelSuggestion,
  onClarificationChoice,
  onConfirmAutomation,
  onConfirmSuggestion,
  onContinue,
  onOpenLink,
  showSuggestionActions
}: {
  entry: ComposerChatMessage;
  onCancelSuggestion?: () => void;
  onClarificationChoice: (clarification: AssistantClarification, option: AssistantRouteActionButton) => void;
  onConfirmAutomation: (confirmation: NonNullable<AutomationActionResponse["confirmation"]>) => void;
  onConfirmSuggestion?: () => void;
  onContinue?: () => void;
  onOpenLink: (link: AssistantResultLink) => void;
  showSuggestionActions: boolean;
}) {
  const showAutomationConfirmation = entry.role === "assistant" && entry.state === "done" && Boolean(entry.confirmation);
  const pendingTaskSummary = entry.role === "assistant" && entry.state === "done"
    ? parsePendingTaskSummary(entry.text)
    : null;
  const recentRecordSummary = entry.role === "assistant" && entry.state === "done" ? parseRecentRecordSummary(entry.text) : null;
  const memberProfileSummary = entry.role === "assistant" && entry.state === "done" ? parseMemberProfileSummary(entry.text) : null;
  const resourceParsePresentation = entry.role === "assistant" && entry.state === "done" ? parseResourceParsePresentation(entry.text) : null;
  return (
    <section className={`assistant-result-item ${entry.role} ${entry.state || "done"} ${entry.displayType || ""}${pendingTaskSummary ? " suggestion-card" : ""}${recentRecordSummary ? " record-summary-card" : ""}${memberProfileSummary ? " profile-summary-card" : ""}${resourceParsePresentation ? " resource-parse-card" : ""}`.trim()}>
      {entry.role === "assistant" && entry.state === "running" ? (
        <span className="assistant-thinking-dots" aria-label={entry.text || "正在整理"} role="status">
          <i />
          <i />
          <i />
        </span>
      ) : pendingTaskSummary ? (
        <div className="assistant-task-summary">
          <strong>{pendingTaskSummary.title}</strong>
          <dl>
            {pendingTaskSummary.time ? <div><dt>时间</dt><dd><TimeHighlightedText text={pendingTaskSummary.time} /></dd></div> : null}
            <div><dt>负责人</dt><dd>{pendingTaskSummary.assignee}</dd></div>
          </dl>
        </div>
      ) : recentRecordSummary ? (
        <div className="assistant-record-summary">
          <strong>最近记录</strong>
          <div className="assistant-record-summary-list">
            {recentRecordSummary.map((item, index) => (
              <div key={`${item.time}-${index}`}>
                <time>{item.time}</time>
                <span>{item.title}</span>
              </div>
            ))}
          </div>
        </div>
      ) : memberProfileSummary ? (
        <div className="assistant-profile-summary">
          <header>
            <span>家庭画像</span>
            <strong>{memberProfileSummary.memberName}</strong>
          </header>
          <dl>
            {memberProfileSummary.items.map((item) => (
              <div key={`${item.label}-${item.value}`}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {memberProfileSummary.note ? <small>{memberProfileSummary.note}</small> : null}
        </div>
      ) : resourceParsePresentation ? (
        <div className="assistant-resource-parse">
          <header>
            <div>
              <span>资料解析</span>
              <strong>{resourceParsePresentation.title}</strong>
            </div>
            <em>{resourceParsePresentation.typeLabel}</em>
          </header>
          {resourceParsePresentation.items.length ? (
            <dl className="assistant-resource-parse-sections">
              {resourceParsePresentation.items.map((item, index) => (
                <div className={item.tone} key={`${item.label}-${index}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : <p>{resourceParsePresentation.preview}</p>}
          <details onClick={(event) => event.stopPropagation()}>
            <summary>
              <span>查看完整解析</span>
              <i aria-hidden="true">⌄</i>
            </summary>
            <pre>{resourceParsePresentation.content}</pre>
          </details>
        </div>
      ) : (
        entry.role === "assistant"
          ? <AssistantFormattedText text={entry.text} />
          : <pre><TimeHighlightedText text={entry.text} /></pre>
      )}
      {entry.links?.length ? (
        <div className="assistant-result-links">
          {entry.links.map((link) => (
            <button key={`${entry.id}-${link.kind}-${link.id}`} type="button" onClick={() => onOpenLink(link)}>
              {link.label}
            </button>
          ))}
        </div>
      ) : null}
      {entry.role === "assistant" && entry.state === "done" && entry.clarification?.options.length ? (
        <div className="assistant-result-actions assistant-clarification-actions">
          {entry.clarification.options.map((option) => (
            <button
              className="primary"
              key={`${entry.id}-${option.value}`}
              type="button"
              onClick={() => entry.clarification && onClarificationChoice(entry.clarification, option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {showSuggestionActions ? (
        <div className="assistant-result-actions">
          <button className="primary" type="button" onClick={onConfirmSuggestion}>
            加入任务
          </button>
          <button type="button" onClick={onContinue}>
            继续记录
          </button>
          <button type="button" onClick={onCancelSuggestion}>
            取消
          </button>
        </div>
      ) : null}
      {showAutomationConfirmation ? (
        <div className="assistant-result-actions">
          <button className="primary" type="button" onClick={() => entry.confirmation && onConfirmAutomation(entry.confirmation)}>
            确认执行
          </button>
          <button type="button" onClick={onContinue}>
            取消
          </button>
        </div>
      ) : null}
    </section>
  );
}

function AssistantFormattedText({ text }: { text: string }) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return <p className="assistant-formatted-text single">{text}</p>;
  return (
    <div className="assistant-formatted-text">
      {lines.map((line, index) => {
        const section = line.match(/^(结论|依据|下一步|建议|注意|说明|当前情况|成长变化)[：:]\s*(.+)$/);
        if (section) {
          return <div className="assistant-formatted-section" key={`${index}-${line}`}><strong>{section[1]}</strong><span>{section[2]}</span></div>;
        }
        const heading = line.match(/^(?:#{1,3}\s*|\*\*)([^*#]+?)(?:\*\*)?$/);
        if (heading || /^(结论|依据|下一步|建议|注意|说明|当前情况|成长变化)$/.test(line)) {
          return <strong className="assistant-formatted-heading" key={`${index}-${line}`}>{heading?.[1]?.trim() || line}</strong>;
        }
        const bullet = line.match(/^(?:[-*•]\s+|\d+[.)、]\s*)(.+)$/);
        if (bullet) {
          return <div className="assistant-formatted-bullet" key={`${index}-${line}`}><i aria-hidden="true" /><span>{bullet[1]}</span></div>;
        }
        return <p key={`${index}-${line}`}>{line}</p>;
      })}
    </div>
  );
}

function InviteLinkSheet({ record, onClose, onCopied }: { record: FamilyRecord; onClose: () => void; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string; id: string; link: string; source: "local" | "secure" } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [creating, setCreating] = useState(false);
  const clipboardText = invite ? `邀请链接：${invite.link}\n验证码：${invite.code}\n有效期：24 小时` : "";

  const createSecureInvite = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await familyFetch("/api/invites", {
        body: JSON.stringify({ max_use: 10, target_id: record.id, type: "group" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }).catch(() => null);
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string; invite?: { code: string; expiresAt: string; id: string; link: string } } : {};
      if (response?.ok && payload.invite) {
        setInvite({ ...payload.invite, source: "secure" });
        return;
      }
      if (payload.detail !== "邀请服务尚未配置。") {
        setError(payload.detail || "安全邀请创建失败。");
        return;
      }
      const localInviteLink = record.inviteLink || createGuestChatLink();
      const localResponse = await familyFetch("/api/guest-chat/invites", {
        body: JSON.stringify({
          chatMembers: record.chatMembers || [],
          chatMessages: record.chatMessages || [],
          create_access: true,
          id: record.id,
          inviteLink: localInviteLink,
          spaceId: record.spaceId,
          title: record.title
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }).catch(() => null);
      const localPayload = localResponse ? await localResponse.json().catch(() => ({})) as { detail?: string; invite?: { code: string; expiresAt: string; id: string; link: string } } : {};
      if (!localResponse?.ok || !localPayload.invite) {
        setError(localPayload.detail || "本地邀请服务暂时不可用。");
        return;
      }
      setInvite({ ...localPayload.invite, source: "local" });
    } finally {
      setCreating(false);
    }
  }, [creating, record]);

  useEffect(() => {
    let active = true;
    if (!invite?.link) {
      setQrCode("");
      return;
    }
    void QRCode.toDataURL(invite.link, { color: { dark: "#171a19", light: "#ffffff" }, errorCorrectionLevel: "M", margin: 2, width: 176 })
      .then((value) => { if (active) setQrCode(value); })
      .catch(() => { if (active) setQrCode(""); });
    return () => { active = false; };
  }, [invite?.link]);

  const copyLink = useCallback(async () => {
    if (!clipboardText) return;
    await copyTextToClipboard(clipboardText);
    setCopied(true);
    onCopied?.();
    window.setTimeout(() => setCopied(false), 1800);
  }, [clipboardText, onCopied]);

  const revoke = useCallback(async () => {
    if (!invite || revoking) return;
    setRevoking(true);
    const response = invite.source === "local"
      ? await familyFetch("/api/guest-chat/invites", {
          body: JSON.stringify({ invite_id: invite.id, slug: getGuestChatSlug(invite.link) }),
          headers: { "content-type": "application/json" },
          method: "DELETE"
        }).catch(() => null)
      : await familyFetch(`/api/invites/${invite.id}/revoke`, { method: "POST" }).catch(() => null);
    setRevoking(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
      setError(payload.detail || "撤销邀请失败。");
      return;
    }
    onClose();
  }, [invite, onClose, revoking]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="invite-link-backdrop">
      <button className="invite-link-dismiss" type="button" aria-label="关闭群聊邀请" onClick={onClose} />
      <div className="modal-sheet invite-link-sheet" role="dialog" aria-modal="true" aria-labelledby="invite-link-title">
        <span className="invite-link-handle" aria-hidden="true" />
        <div className="invite-link-head">
          <div className="invite-link-heading">
            <h3 id="invite-link-title">群聊邀请</h3>
            <span>一次创建 · 24 小时有效</span>
          </div>
          <button className="invite-link-close" type="button" aria-label="关闭" onClick={onClose}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </div>

        {!invite ? <p className="invite-link-description">生成临时访问链接和四位口令，家庭资料与其他群聊不会对外开放。</p> : null}
        {!invite ? <button className="invite-link-copy" disabled={creating} type="button" onClick={() => void createSecureInvite()}>{creating ? "正在创建…" : "生成邀请"}</button> : null}
        {invite ? <div className="invite-link-ready" aria-live="polite">
          {qrCode ? <img alt="群聊邀请二维码" className="invite-link-qr" src={qrCode} /> : null}
          <div className="invite-link-details">
            <div className="invite-link-code"><span>四位口令</span><strong>{invite.code}</strong></div>
            <div className="invite-link-address"><span>邀请链接</span><strong>{invite.link.replace(/^https?:\/\//, "")}</strong></div>
          </div>
        </div> : null}

        {invite ? <button className={`invite-link-copy${copied ? " copied" : ""}`} disabled={!invite} type="button" onClick={() => void copyLink()}>
          {copied ? "已复制链接和口令" : "复制邀请"}
        </button> : null}
        {invite ? <button className="invite-link-revoke" disabled={revoking} type="button" onClick={() => void revoke()}>{revoking ? "正在撤销…" : "撤销这次邀请"}</button> : null}
        {error ? <p className="invite-link-hint error" role="status">{error}</p> : null}
      </div>
    </div>
  );
}

function ResourcePreviewSheet({ onClose, record }: { onClose: () => void; record: FamilyRecord }) {
  if (isVoiceResource(record)) {
    return <VoiceNoteSheet onClose={onClose} record={record} />;
  }

  const isPhoto = record.assetType === "photo";
  const isTextResource = isTextPreviewResource(record);
  const documentPreviewKind = getResourceDocumentPreviewKind(record);
  const resourceTitle = record.fileName || record.title;
  const resourceUrl = getResourceDownloadUrl(record);
  const documentThumbnailUrl = getResourceDocumentThumbnailUrl(record);
  const imagePreviewUrl = getResourcePreviewImageUrl(record);
  const originalImageUrl = getResourceOriginalImageUrl(record);
  const [imageSource, setImageSource] = useState(imagePreviewUrl || fallbackPhoto(record.id));
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageMode, setImageMode] = useState<"original" | "preview">("preview");
  const [originalImageError, setOriginalImageError] = useState(false);
  const [textPreview, setTextPreview] = useState(() => buildFallbackTextPreview(record));
  const [textPreviewStatus, setTextPreviewStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!isTextResource) {
      return;
    }

    const fallbackText = buildFallbackTextPreview(record);
    if (!resourceUrl) {
      setTextPreview(fallbackText);
      setTextPreviewStatus("ready");
      return;
    }

    const controller = new AbortController();
    setTextPreview(fallbackText);
    setTextPreviewStatus("loading");

    familyFetch(resourceUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error("text_preview_fetch_failed");
        }
        return response.text();
      })
      .then((text) => {
        setTextPreview(text.trim() || fallbackText);
        setTextPreviewStatus("ready");
      })
      .catch((error) => {
        if ((error as Error).name === "AbortError") {
          return;
        }
        setTextPreview(fallbackText);
        setTextPreviewStatus("error");
      });

    return () => controller.abort();
  }, [isTextResource, record, resourceUrl]);

  return (
    <div className={`modal-sheet preview-sheet${documentPreviewKind ? " document-preview-sheet" : ""}`} role="dialog" aria-label="资料预览">
      {isPhoto ? (
        <>
          <button className="preview-content-button preview-image-frame" type="button" aria-label="收回图片" onClick={onClose}>
            {!imageLoaded ? <span className="preview-image-placeholder"><ResourceTypeIcon record={record} /></span> : null}
            <img
              alt=""
              className={`preview-image user-upload-image${imageLoaded ? " loaded" : ""}`}
              onLoad={() => {
                setImageLoaded(true);
                setOriginalImageError(false);
              }}
              onError={() => {
                setImageLoaded(false);
                if (imageMode === "original" && imagePreviewUrl) {
                  setImageMode("preview");
                  setOriginalImageError(true);
                  setImageSource(imagePreviewUrl);
                  return;
                }
                const fallback = fallbackPhoto(record.id);
                if (imageSource !== fallback) setImageSource(fallback);
              }}
              src={imageSource}
            />
          </button>
          <div className="preview-image-actions">
            <button
              disabled={!originalImageUrl || (imageMode === "original" && imageLoaded)}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (!originalImageUrl) return;
                setImageLoaded(false);
                setOriginalImageError(false);
                setImageMode("original");
                setImageSource(originalImageUrl);
              }}
            >
              {imageMode === "original" ? (imageLoaded ? "已是原图" : "正在加载原图…") : originalImageError ? "重试原图" : "查看原图"}
            </button>
            <button
              disabled={!resourceUrl}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void downloadResourceRecord(record);
              }}
            >
              下载
            </button>
          </div>
        </>
      ) : isTextResource ? (
        <article className="text-resource-preview">
          <header>
            <strong>{resourceTitle}</strong>
            <span className="document-preview-actions">
              <button disabled={!resourceUrl} type="button" onClick={() => void downloadResourceRecord(record)}>下载</button>
              <button type="button" onClick={onClose}>关闭</button>
            </span>
          </header>
          <p>{textPreviewStatus === "loading" && !textPreview ? "正在读取文本..." : textPreview}</p>
          {textPreviewStatus === "error" && resourceUrl ? (
            <a href={resourceUrl} target="_blank" rel="noreferrer">
              打开原文
            </a>
          ) : null}
        </article>
      ) : resourceUrl && documentPreviewKind ? (
        <article className="document-preview document-preview-rich">
          <header>
            <strong>{resourceTitle}</strong>
            <span className="document-preview-actions">
              <button className="document-download-button" type="button" onClick={() => void downloadResourceRecord(record)}>下载</button>
              <button type="button" onClick={onClose}>关闭</button>
            </span>
          </header>
          <ResourceDocumentPreview fallbackThumbnailUrl={documentThumbnailUrl} kind={documentPreviewKind} name={resourceTitle} url={resourceUrl} />
        </article>
      ) : resourceUrl ? (
        <article className="document-preview document-preview-rich">
          <header>
            <strong>{resourceTitle}</strong>
            <span className="document-preview-actions">
              <button className="document-download-button" type="button" onClick={() => void downloadResourceRecord(record)}>下载</button>
              <button type="button" onClick={onClose}>关闭</button>
            </span>
          </header>
          <ResourceDocumentThumbnailFallback name={resourceTitle} thumbnailUrl={documentThumbnailUrl} />
        </article>
      ) : (
        <button className="document-preview" type="button" onClick={onClose}>
          <strong>{resourceTitle}</strong>
        </button>
      )}
    </div>
  );
}

function VoiceNoteSheet({ onClose, record }: { onClose: () => void; record: FamilyRecord }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrl = getVoiceAudioUrl(record);
  const transcript = record.transcript || voiceTranscriptFromSummary(record.summary);
  const initialDuration = Math.max(voiceDurationFromRecord(record), 1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const waveform = useMemo(() => buildVoiceWaveform(record.id), [record.id]);
  const progress = duration > 0 ? currentTime / duration : 0;

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !audioUrl) {
      return;
    }
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  }

  function seek(nextTime: number) {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = nextTime;
    }
    setCurrentTime(nextTime);
  }

  function cyclePlaybackRate() {
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  }

  return (
    <div className="voice-note-backdrop" onClick={onClose}>
      <section
        aria-label={`${record.title}语音详情`}
        aria-modal="true"
        className="voice-note-sheet"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <span aria-hidden="true" className="voice-note-handle" />
        <header className="voice-note-head">
          <span aria-hidden="true" className="voice-note-mark">
            <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24">
              <rect height="11" rx="4" width="7" x="8.5" y="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
            </svg>
          </span>
          <div>
            <strong>{record.title}</strong>
            <span>{record.ownerName} · {record.updatedAt}</span>
          </div>
          <button aria-label="关闭语音卡片" className="voice-note-close" onClick={onClose} type="button">
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </header>

        <div className="voice-note-player">
          <button
            aria-label={audioUrl ? (isPlaying ? "暂停语音" : "播放语音") : "暂无可播放的语音文件"}
            className="voice-note-play"
            disabled={!audioUrl}
            onClick={() => void togglePlayback()}
            type="button"
          >
            {isPlaying ? (
              <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            ) : (
              <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z" /></svg>
            )}
          </button>
          <div className="voice-note-track">
            <div aria-hidden="true" className="voice-note-waveform">
              {waveform.map((height, index) => (
                <i className={index / (waveform.length - 1) <= progress ? "active" : ""} key={`${record.id}-wave-${index}`} style={{ height: `${height}%` }} />
              ))}
            </div>
            <input
              aria-label="语音播放进度"
              max={duration}
              min="0"
              onChange={(event) => seek(Number(event.target.value))}
              step="0.1"
              type="range"
              value={Math.min(currentTime, duration)}
            />
            <div className="voice-note-time">
              <span>{formatVoicePlaybackTime(currentTime)}</span>
              <span>{formatVoicePlaybackTime(duration)}</span>
            </div>
          </div>
          <button aria-label="调整播放速度" className="voice-note-speed" onClick={cyclePlaybackRate} type="button">
            {playbackRate.toFixed(playbackRate === 1 ? 1 : 1)}x
          </button>
          {audioUrl ? (
            <audio
              onDurationChange={(event) => {
                if (Number.isFinite(event.currentTarget.duration)) {
                  setDuration(event.currentTarget.duration);
                }
              }}
              onEnded={() => {
                setCurrentTime(duration);
                setIsPlaying(false);
              }}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              preload="metadata"
              ref={audioRef}
              src={audioUrl}
            />
          ) : null}
        </div>

        <div className="voice-note-transcript">
          <span>转写</span>
          <p>{transcript || "这条语音暂时没有转写内容。"}</p>
        </div>

        <footer className="voice-note-actions">
          <button
            disabled={!transcript}
            onClick={() => {
              void copyTextToClipboard(transcript);
              setCopyState("copied");
            }}
            type="button"
          >
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
              <rect height="13" rx="2" width="11" x="8" y="8" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </svg>
            {copyState === "copied" ? "已复制" : "复制转写"}
          </button>
          <button
            disabled={!audioUrl}
            onClick={() => downloadVoiceRecord(record, audioUrl)}
            type="button"
          >
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
            </svg>
            下载原音
          </button>
        </footer>
      </section>
    </div>
  );
}

function isVoiceResource(record: FamilyRecord) {
  return record.assetType === "audio" || Boolean(record.audioPath) || record.tags.includes("语音");
}

function getVoiceAudioUrl(record: FamilyRecord) {
  if (record.audioPath) {
    return `/api/voice-notes?path=${encodeURIComponent(record.audioPath)}`;
  }
  return getResourceDownloadUrl(record);
}

function voiceTranscriptFromSummary(summary: string) {
  const parts = summary.split("·").map((part) => part.trim()).filter(Boolean);
  return parts.length >= 3 && parts[0] === "语音" ? parts.slice(2).join(" · ") : "";
}

function voiceDurationFromRecord(record: FamilyRecord) {
  if (record.durationMs && record.durationMs > 0) {
    return record.durationMs / 1000;
  }
  const match = record.summary.match(/(?:语音\s*·\s*)?(\d+):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function formatVoicePlaybackTime(value: number) {
  const safeValue = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${Math.floor(safeValue / 60)}:${String(safeValue % 60).padStart(2, "0")}`;
}

function buildVoiceWaveform(seed: string) {
  let hash = [...seed].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  return Array.from({ length: 34 }, (_, index) => {
    hash = (hash * 1664525 + 1013904223 + index) >>> 0;
    return 22 + (hash % 66);
  });
}

function downloadVoiceRecord(record: FamilyRecord, audioUrl: string) {
  if (!audioUrl) {
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = audioUrl;
  anchor.download = record.fileName || `${record.title}.m4a`;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function isTextPreviewResource(record: FamilyRecord) {
  const fileName = record.fileName || "";
  return record.assetType === "text" || (!record.assetType && record.kind === "note") || /\.(txt|md|markdown|csv|log)$/i.test(fileName);
}

function getResourceDocumentPreviewKind(record: FamilyRecord): ResourceDocumentKind | null {
  const fileName = record.fileName || record.sourceFiles?.[0]?.name || "";
  const mimeType = record.sourceFiles?.[0]?.type || "";
  if (record.assetType === "pdf" || mimeType === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  if (record.assetType === "word" || /wordprocessingml|msword/i.test(mimeType) || /\.docx?$/i.test(fileName)) return "docx";
  if (record.assetType === "excel" || /spreadsheetml|ms-excel/i.test(mimeType) || /\.xlsx?$/i.test(fileName)) return "excel";
  return null;
}

function buildFallbackTextPreview(record: FamilyRecord) {
  return record.summary || "暂无文本内容";
}

function isBlobUrl(url: string | undefined) {
  return Boolean(url?.startsWith("blob:"));
}

async function clearLocalResourceCache() {
  navigator.serviceWorker?.controller?.postMessage({ type: "family-clear-resource-cache" });
  if (!("caches" in window)) return;
  const keys = await window.caches.keys();
  await Promise.all(keys
    .filter((key) => key === "family-app-shell-v1" || key.startsWith("family-app-resources-"))
    .map((key) => window.caches.delete(key)));
}

function preferPersistentUrl(...urls: (string | undefined)[]) {
  return urls.find((url) => Boolean(url) && !isBlobUrl(url)) || "";
}

function readPersistentPreviewUrl(file: { cacheUrl?: string; originalUrl?: string; previewUrl?: string; url?: string } | undefined) {
  return preferPersistentUrl(file?.previewUrl, file?.url, file?.originalUrl, file?.cacheUrl);
}

function readOriginalFileUrl(file: { cacheUrl?: string; originalUrl?: string; previewUrl?: string; url?: string } | undefined) {
  return preferPersistentUrl(file?.originalUrl, file?.url, file?.cacheUrl, file?.previewUrl);
}

function getFilePreviewUrl(file: { cacheUrl?: string; originalUrl?: string; previewUrl?: string; url?: string } | undefined) {
  return readPersistentPreviewUrl(file) || file?.previewUrl || "";
}

function getResourceDownloadUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.cacheUrl || file.url || file.originalUrl || file.previewUrl);
  return sourceFile?.originalUrl || sourceFile?.url || sourceFile?.cacheUrl || sourceFile?.previewUrl || record.previewUrl || "";
}

function getResourcePreviewImageUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.previewUrl || file.cacheUrl || file.url || file.originalUrl);
  return sourceFile?.cacheUrl || getResourceCompressedPreviewUrl(record);
}

function getResourceThumbnailUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.thumbnailUrl || file.previewUrl || file.url || file.originalUrl);
  if (sourceFile?.thumbnailUrl) return sourceFile.thumbnailUrl;
  const storedUrl = sourceFile?.originalUrl || sourceFile?.url || sourceFile?.previewUrl;
  if (storedUrl?.startsWith("/api/guest-uploads?")) {
    const separator = storedUrl.includes("&") ? "&" : "&";
    return `${storedUrl.replace(/&variant=(?:preview|thumbnail)/, "")}${separator}variant=thumbnail`;
  }
  return getResourceCompressedPreviewUrl(record);
}

function getResourceDocumentThumbnailUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.thumbnailUrl || file.originalUrl || file.url || file.previewUrl);
  if (sourceFile?.thumbnailUrl) return sourceFile.thumbnailUrl;
  const storedUrl = sourceFile?.originalUrl || sourceFile?.url || sourceFile?.previewUrl;
  if (storedUrl?.startsWith("/api/guest-uploads?")) {
    return `${storedUrl.replace(/&variant=(?:preview|thumbnail|document)/, "")}&variant=thumbnail`;
  }
  return "";
}

function getResourceCompressedPreviewUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.previewUrl || file.url || file.originalUrl);
  return preferPersistentUrl(sourceFile?.previewUrl, record.previewUrl) || record.previewUrl || "";
}

function getResourceOriginalImageUrl(record: FamilyRecord) {
  const sourceFile = record.sourceFiles?.find((file) => file.originalUrl || file.url || file.cacheUrl || file.previewUrl);
  const originalUrl = preferPersistentUrl(sourceFile?.originalUrl, sourceFile?.url, sourceFile?.cacheUrl, sourceFile?.previewUrl, record.previewUrl);
  if (!originalUrl?.startsWith("/api/guest-uploads?")) return originalUrl;
  return `${originalUrl.replace(/&variant=(?:preview|thumbnail|document|original)/, "")}&variant=original`;
}

async function downloadResourceRecord(record: FamilyRecord) {
  const resourceUrl = getResourceDownloadUrl(record);
  if (!resourceUrl) return;

  const downloadName = record.fileName || record.sourceFiles?.find((file) => file.name)?.name || record.title || "resource";
  try {
    const response = await familyFetch(resourceUrl, { credentials: "include" });
    if (!response.ok) throw new Error("resource_download_failed");
    const objectUrl = URL.createObjectURL(await response.blob());
    triggerResourceDownload(objectUrl, downloadName);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_500);
  } catch {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = resourceUrl;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), 8_000);
  }
}

function triggerResourceDownload(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  anchor.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function ResourceSelectionBar({
  count,
  onCancel,
  onDelete,
  onDownload
}: {
  count: number;
  onCancel: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <div className={confirmingDelete ? "task-selection-bar confirming-delete" : "task-selection-bar"} role="toolbar" aria-label="多选资料操作">
      <strong>{confirmingDelete ? `删除 ${count} 项？` : `已选 ${count}`}</strong>
      <span className="task-selection-actions">
        {confirmingDelete ? (
          <>
            <button type="button" onClick={() => setConfirmingDelete(false)}>保留</button>
            <button className="danger" disabled={count === 0} type="button" onClick={onDelete}>确认删除</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onCancel}>取消</button>
            <button className="primary" disabled={count === 0} type="button" onClick={onDownload}>下载</button>
            <button className="danger" disabled={count === 0} type="button" onClick={() => setConfirmingDelete(true)}>删除</button>
          </>
        )}
      </span>
    </div>
  );
}

function DecisionCreateSheet({ onClose, onCreated, roomRecord, sourceText }: { onClose: () => void; onCreated: (decision: FamilyDecision) => void; roomRecord: FamilyRecord; sourceText: string }) {
  const candidate = useMemo(() => parseDecisionCandidate(sourceText), [sourceText]);
  const [question, setQuestion] = useState(candidate.question);
  const [optionText, setOptionText] = useState(candidate.options.join("\n"));
  const [closesAt, setClosesAt] = useState(() => toDatetimeLocal(candidate.closesAt));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const options = optionText.split(/\n|，|、/u).map((item) => item.trim()).filter(Boolean);
    if (!question.trim() || options.length < 2) { setError("请填写问题和至少两个选项。"); return; }
    setSaving(true);
    try {
      await enqueueFamilyRecord(roomRecord);
      const response = await familyFetch("/api/family-decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomRecordId: roomRecord.id, question, options, closes_at: new Date(closesAt).toISOString(), source_text: sourceText }) });
      const payload = await response.json() as { decision?: FamilyDecision; detail?: string };
      if (!response.ok || !payload.decision) throw new Error(payload.detail || "创建失败。");
      onCreated(payload.decision);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败。"); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-sheet decision-create-sheet" role="dialog" aria-modal="true" aria-label="发起群聊投票">
      <form className="decision-card" onSubmit={submit}>
        <header><h2>投票</h2><button aria-label="关闭" type="button" onClick={onClose}>×</button></header>
        <input aria-label="问题" value={question} maxLength={80} onChange={(event) => setQuestion(event.target.value)} placeholder="问题" />
        <textarea aria-label="选项，每行一个" value={optionText} onChange={(event) => setOptionText(event.target.value)} placeholder={'选项 1\n选项 2'} rows={3} />
        <input aria-label="截止时间" type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} />
        {error ? <p className="decision-error" role="alert">{error}</p> : null}
        <button className="decision-primary" disabled={saving} type="submit">{saving ? "发布中…" : "确认发布"}</button>
      </form>
    </div>
  );
}

function toDatetimeLocal(iso: string) {
  const date = new Date(iso); const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function ChatPollCard({ decision, membersById, onAdoptTask, onChange }: {
  decision: FamilyDecision;
  membersById: Map<string, FamilyMember>;
  onAdoptTask: (selectedTitle?: string) => Promise<void>;
  onChange: (decision: FamilyDecision) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmTitle, setConfirmTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const [editQuestion, setEditQuestion] = useState(decision.question);
  const [editOptions, setEditOptions] = useState(decision.options.map((option) => option.label).join("\n"));
  const [editClosesAt, setEditClosesAt] = useState(() => toDatetimeLocal(decision.closesAt));
  const myBallot = decision.ballots.find((ballot) => ballot.memberId === currentMemberId);
  const votedCount = decision.participants.filter((participant) => participant.hasVoted).length;
  const recommendation = decision.summaryJson?.recommendation || "";
  const deadlinePassed = new Date(decision.closesAt).getTime() <= Date.now();
  const pollClosed = decision.status === "closed" || deadlinePassed;
  const needsFinalChoice = decision.status === "closed" && (!recommendation || recommendation === "未形成唯一多数");

  async function update(path: "vote" | "close", init: RequestInit) {
    setBusy(true); setError("");
    try {
      const response = await familyFetch(`/api/family-decisions/${encodeURIComponent(decision.id)}/${path}`, init);
      const payload = await response.json() as { decision?: FamilyDecision; detail?: string };
      if (!response.ok || !payload.decision) throw new Error(payload.detail || "操作失败。");
      onChange(payload.decision);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败。"); }
    finally { setBusy(false); }
  }

  async function adopt() {
    setBusy(true); setError("");
    try { await onAdoptTask(confirmTitle || undefined); setConfirmTitle(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "创建任务失败。"); }
    finally { setBusy(false); }
  }

  function vote(optionId: string) {
    if (pollClosed) {
      setError("投票已结束，不能再修改选择。");
      return;
    }
    void update("vote", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ option_id: optionId }) });
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await familyFetch(`/api/family-decisions/${encodeURIComponent(decision.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: editQuestion, options: editOptions.split(/\n|，|、/u).map((item) => item.trim()).filter(Boolean), closes_at: new Date(editClosesAt).toISOString() }) });
      const payload = await response.json() as { decision?: FamilyDecision; detail?: string };
      if (!response.ok || !payload.decision) throw new Error(payload.detail || "修改失败。");
      onChange(payload.decision); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "修改失败。"); }
    finally { setBusy(false); }
  }

  return (
    <article className="chat-poll-card" data-poll-id={decision.id} aria-label={`群聊投票：${decision.question}`}>
      <header>
        <div><p className="chat-poll-meta"><span>投票</span>{pollClosed ? "已结束" : `${votedCount}/${decision.participants.length} 已参与 · ${formatDecisionRemaining(decision.closesAt)}`}</p><h3>{decision.question}</h3></div>
        {decision.creatorMemberId === currentMemberId && decision.status === "open" && !deadlinePassed ? <div className="chat-poll-owner-actions">{decision.ballots.length === 0 ? <button disabled={busy} type="button" onClick={() => setEditing((value) => !value)}>修改</button> : null}<button disabled={busy} type="button" onClick={() => void update("close", { method: "POST" })}>结束</button></div> : null}
      </header>
      {editing ? <form className="chat-poll-edit" onSubmit={saveEdit}><input maxLength={80} value={editQuestion} onChange={(event) => setEditQuestion(event.target.value)} aria-label="修改投票问题" /><textarea rows={4} value={editOptions} onChange={(event) => setEditOptions(event.target.value)} aria-label="修改投票选项" /><input type="datetime-local" value={editClosesAt} onChange={(event) => setEditClosesAt(event.target.value)} aria-label="修改截止时间" /><div><button disabled={busy} type="submit">保存修改</button><button type="button" onClick={() => setEditing(false)}>取消</button></div></form> : null}
      <div className="decision-vote-card" aria-label="投票选项">
        {decision.options.map((option) => {
          const selected = myBallot?.optionId === option.id;
          const percentage = option.percentage || 0;
          return <button key={option.id} aria-disabled={busy || pollClosed} aria-pressed={selected} className={selected ? "decision-option selected" : "decision-option"} disabled={busy} type="button" onClick={() => vote(option.id)}><span className="decision-option-mark" aria-hidden="true" /><strong>{option.label}</strong>{decision.status === "closed" ? <><em>{option.voteCount || 0} 票 · {percentage}%</em><i style={{ width: `${percentage}%` }} />{option.voterMemberIds?.length ? <small>{option.voterMemberIds.map((id) => membersById.get(id)?.displayName || "家人").join("、")}</small> : null}</> : selected ? <em>已选</em> : null}</button>;
        })}
      </div>
      {decision.status === "closed" ? <details className="decision-summary-card"><summary>AI 总结</summary><p>{decision.summaryText || "AI 总结暂不可用，投票结果仍然有效。"}</p>{decision.adoptedTaskId ? <p className="decision-adopted">已创建任务</p> : needsFinalChoice && decision.creatorMemberId === currentMemberId ? <div className="decision-tie-choice"><span>未形成唯一多数，请选择最终方案后转为任务</span>{decision.options.map((option) => <button key={option.id} type="button" onClick={() => setConfirmTitle(option.label)}>{option.label}</button>)}</div> : recommendation && recommendation !== "未形成唯一多数" ? <button className="decision-primary" type="button" onClick={() => setConfirmTitle(recommendation)}>采纳“{recommendation}”，创建任务</button> : null}{confirmTitle ? <div className="decision-confirm"><span>确认创建任务“{confirmTitle}”？</span><button disabled={busy} type="button" onClick={() => void adopt()}>确认</button><button type="button" onClick={() => setConfirmTitle("")}>取消</button></div> : null}</details> : null}
      {error ? <p className="decision-error" role="alert">{error}</p> : null}
    </article>
  );
}

function ChatFullscreen({
  link,
  membersById,
  onClose,
  onCreateTaskFromMessage,
  onCreateTaskFromDecision,
  onMessagesChange,
  onMembersChange,
  onSaveMessagesAsResources,
  onTitleChange,
  record,
  suppressInputFocus
}: {
  link?: string;
  membersById: Map<string, FamilyMember>;
  onClose: () => void;
  onCreateTaskFromMessage: (message: RoomMessage) => void;
  onCreateTaskFromDecision: (decision: FamilyDecision, selectedTitle?: string) => Promise<void>;
  onMessagesChange: (messages: RoomMessage[]) => void;
  onMembersChange: (memberIds: string[]) => void;
  onSaveMessagesAsResources: (messages: RoomMessage[]) => void;
  onTitleChange: (title: string) => void;
  record: FamilyRecord;
  suppressInputFocus: boolean;
}) {
  const currentMemberAvatarSeed = membersById.get(currentMemberId)?.avatarSeed || "current-member";
  const currentMemberName = membersById.get(currentMemberId)?.displayName || defaultCurrentMemberName;
  const chatMemberIds = record.chatMembers || [];
  const members = (record.chatMembers || [])
    .map((memberId) => membersById.get(memberId) || createGuestMember(memberId))
    .filter(Boolean);
  const [messages, setMessages] = useState(record.chatMessages || []);
  const [messageInput, setMessageInput] = useState("");
  const [chatVoiceRecording, setChatVoiceRecording] = useState(false);
  const [chatVoiceTranscriptPreview, setChatVoiceTranscriptPreview] = useState("");
  const [isComposingText, setIsComposingText] = useState(false);
  const [polls, setPolls] = useState<FamilyDecision[]>([]);
  const [pollCreateOpen, setPollCreateOpen] = useState(false);

  const [judgements, setJudgements] = useState<GroupJudgement[]>([]);
  const [judgementCreateOpen, setJudgementCreateOpen] = useState(false);
  const [selectedJudgementId, setSelectedJudgementId] = useState<string | null>(null);
  const [selectedChatMemberIds, setSelectedChatMemberIds] = useState<string[]>([]);
  const { code } = useGuestInviteCode(link);
  useEffect(() => {
    if (link) void registerGuestChatInvite(record);
  }, [link, record.id]);
  const onlineMemberIds = useChatPresence(record.id, currentMemberId);
  const chatColorMemberIds = useMemo(() => {
    const memberIds = members.map((member) => member.id);
    messages.forEach((message) => {
      const messageMemberId = resolveMessageMember(message, members, membersById).id;
      if (!memberIds.includes(messageMemberId)) {
        memberIds.push(messageMemberId);
      }
    });
    return memberIds;
  }, [members, membersById, messages]);
  const [copied, setCopied] = useState(false);
  const [inviteSheetLink, setInviteSheetLink] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState(record.title);
  const [draftTitle, setDraftTitle] = useState(record.title);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const [messageActionMenuPosition, setMessageActionMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [savedResourceMessageIds, setSavedResourceMessageIds] = useState(() => new Set<string>());
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [messageSelectionMode, setMessageSelectionMode] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ cacheUrl?: string; originalUrl?: string; previewUrl: string; title: string } | null>(null);
  const [chatDismissMotion, setChatDismissMotion] = useState({ progress: 0, x: 0 });
  const [chatDismissDragging, setChatDismissDragging] = useState(false);
  const [chatDismissClosing, setChatDismissClosing] = useState(false);
  const [chatContextCollapsed, setChatContextCollapsed] = useState(false);
  const [chatGroupContinuationIds, setChatGroupContinuationIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatFullscreenRef = useRef<HTMLDivElement | null>(null);
  const chatComposerRef = useRef<HTMLDivElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatVoicePressActiveRef = useRef(false);
  const chatVoiceSendSuppressClickRef = useRef(false);
  const chatVoiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const chatVoiceInsertionRef = useRef<VoiceInsertionPoint | null>(null);
  const chatVoiceFallbackCaptureRef = useRef<FallbackVoiceCapture | null>(null);
  const chatVoiceFallbackActiveRef = useRef(false);
  const chatVoiceFallbackStopRequestedRef = useRef(false);
  const messagesRef = useRef<HTMLElement | null>(null);
  const chatKeyboardWakeScrolledRef = useRef(false);
  const chatInputTouchHandledAtRef = useRef<number | null>(null);
  const keepMessageKeyboardUntilRef = useRef(0);
  const chatDismissClosingRef = useRef(false);
  const chatDismissTimerRef = useRef<number | null>(null);
  const chatDismissGestureRef = useRef<{
    activated: boolean;
    lastTime: number;
    lastX: number;
    pointerId: number;
    startX: number;
    startY: number;
    velocityX: number;
  } | null>(null);
  const chatDismissTouchGestureRef = useRef<{
    activated: boolean;
    identifier: number;
    lastTime: number;
    lastX: number;
    startX: number;
    startY: number;
    velocityX: number;
  } | null>(null);

  useEffect(() => {
    if (!suppressInputFocus) return;
    keepMessageKeyboardUntilRef.current = 0;
    chatInputTouchHandledAtRef.current = null;
    messageInputRef.current?.blur();
  }, [suppressInputFocus]);

  const chatMentionableMembers = useMemo(() => {
    const existingMemberIds = new Set(chatMemberIds);
    return Array.from(membersById.values()).filter((member) => member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant") && !existingMemberIds.has(member.id));
  }, [chatMemberIds, membersById]);
  const showChatMentionPicker = /[@＠]/.test(messageInput) && chatMentionableMembers.length > 0;
  const judgementMembers = members.filter(isEligibleJudgementMember);
  const activeJudgement = judgements.find((item) => item.status === "active" && (!item.endsAt || new Date(item.endsAt) > new Date()));
  const displayedJudgement = activeJudgement;
  const collapsedContextItems = useMemo(() => [
    ...polls.filter((poll) => poll.status === "open").map((poll) => ({ createdAt: poll.createdAt, id: poll.id, kind: "poll" as const, poll })),
    ...judgements.filter((judgement) => judgement.status === "active" && (!judgement.endsAt || new Date(judgement.endsAt) > new Date())).map((judgement) => ({ createdAt: judgement.createdAt, id: judgement.id, judgement, kind: "judgement" as const }))
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 3), [judgements, polls]);
  const selectedJudgement = judgements.find((item) => item.id === selectedJudgementId) || null;

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const viewport = window.visualViewport;
    let animationFrame = 0;
    const updateGapProbe = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const composer = chatComposerRef.current;
        if (!composer) return;
        const rootStyle = window.getComputedStyle(document.documentElement);
        const keyboardBoundary = Number.parseFloat(rootStyle.getPropertyValue("--keyboard-viewport-bottom"));
        const gap = Number.isFinite(keyboardBoundary)
          ? Math.round(keyboardBoundary - composer.getBoundingClientRect().bottom)
          : 9999;
        composer.setAttribute("aria-label", `群聊输入 键盘间距 ${gap}px`);
      });
    };
    updateGapProbe();
    window.addEventListener("resize", updateGapProbe);
    document.addEventListener("focusin", updateGapProbe);
    document.addEventListener("input", updateGapProbe);
    viewport?.addEventListener("resize", updateGapProbe);
    viewport?.addEventListener("scroll", updateGapProbe);
    const settleTimers = [80, 160, 320].map((delay) => window.setTimeout(updateGapProbe, delay));
    return () => {
      window.cancelAnimationFrame(animationFrame);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", updateGapProbe);
      document.removeEventListener("focusin", updateGapProbe);
      document.removeEventListener("input", updateGapProbe);
      viewport?.removeEventListener("resize", updateGapProbe);
      viewport?.removeEventListener("scroll", updateGapProbe);
    };
  }, []);

  useEffect(() => {
    const surface = chatFullscreenRef.current;
    if (!surface) {
      return;
    }

    function startNativeChatDismissTouchGesture(event: globalThis.TouchEvent) {
      const target = event.target;
      const touch = event.touches[0];
      if (
        event.touches.length !== 1
        || !touch
        || !isChatDismissStartTarget(target)
      ) {
        return;
      }
      chatDismissTouchGestureRef.current = {
        activated: false,
        identifier: touch.identifier,
        lastTime: event.timeStamp,
        lastX: touch.clientX,
        startX: touch.clientX,
        startY: touch.clientY,
        velocityX: 0
      };
    }

    function trackNativeChatDismissTouchGesture(event: globalThis.TouchEvent) {
      const gesture = chatDismissTouchGestureRef.current;
      const touch = Array.from(event.touches).find((item) => item.identifier === gesture?.identifier);
      if (!gesture || !touch) {
        return;
      }
      const status = trackChatDismissMotion(gesture, touch.clientX, touch.clientY, event.timeStamp);
      if (status === "cancel") {
        chatDismissTouchGestureRef.current = null;
        resetChatDismissMotion();
        return;
      }
      if (status === "active") {
        event.preventDefault();
      }
    }

    function finishNativeChatDismissTouchGesture(event: globalThis.TouchEvent) {
      const gesture = chatDismissTouchGestureRef.current;
      chatDismissTouchGestureRef.current = null;
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === gesture?.identifier);
      if (!gesture || !touch) {
        return;
      }
      finishChatDismissMotion(gesture, touch.clientX);
    }

    function cancelNativeChatDismissTouchGesture() {
      chatDismissTouchGestureRef.current = null;
      resetChatDismissMotion();
    }

    surface.addEventListener("touchstart", startNativeChatDismissTouchGesture, { passive: true });
    surface.addEventListener("touchmove", trackNativeChatDismissTouchGesture, { passive: false });
    surface.addEventListener("touchend", finishNativeChatDismissTouchGesture, { passive: false });
    surface.addEventListener("touchcancel", cancelNativeChatDismissTouchGesture);
    return () => {
      surface.removeEventListener("touchstart", startNativeChatDismissTouchGesture);
      surface.removeEventListener("touchmove", trackNativeChatDismissTouchGesture);
      surface.removeEventListener("touchend", finishNativeChatDismissTouchGesture);
      surface.removeEventListener("touchcancel", cancelNativeChatDismissTouchGesture);
    };
  }, [onClose]);

  useEffect(() => () => {
    if (chatDismissTimerRef.current) window.clearTimeout(chatDismissTimerRef.current);
  }, []);

  const refreshPolls = useCallback(async () => {
    try {
      await familyFetch("/api/family-decisions/close-due", { method: "POST" }).catch(() => undefined);
      const response = await familyFetch(`/api/family-decisions?roomRecordId=${encodeURIComponent(record.id)}`, { cache: "no-store" });
      const payload = await response.json() as { decisions?: FamilyDecision[] };
      if (response.ok) setPolls(Array.isArray(payload.decisions) ? payload.decisions : []);
    } catch {
      // Group chat remains available when poll storage is unavailable.
    }
  }, [record.id]);

  useEffect(() => { void refreshPolls(); }, [refreshPolls]);

  const refreshJudgements = useCallback(async () => {
    try {
      const response = await familyFetch(`/api/group-judgements?roomRecordId=${encodeURIComponent(record.id)}`, { cache: "no-store" });
      const payload = await response.json() as { judgements?: GroupJudgement[] };
      if (response.ok) setJudgements(Array.isArray(payload.judgements) ? payload.judgements : []);
    } catch {
      // Group chat remains available when judgement storage is unavailable.
    }
  }, [record.id]);

  useEffect(() => { void refreshJudgements(); }, [refreshJudgements]);

  useEffect(() => {
    if (!activeJudgement?.endsAt) return;
    const delay = new Date(activeJudgement.endsAt).getTime() - Date.now();
    if (delay <= 0) {
      void refreshJudgements();
      return;
    }
    const timer = window.setTimeout(() => void refreshJudgements(), Math.min(delay + 100, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [activeJudgement?.endsAt, activeJudgement?.id, refreshJudgements]);

  const markInviteCopied = useCallback(() => {
    setCopied(true);
    void enqueueMetaEvent({
      type: "group_invite_copied",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: record.id,
      spaceId: record.spaceId || coreSpaceId,
      text: link,
      metadata: { code }
    });
  }, [code, link, record.id, record.spaceId]);

  function startTitleEdit() {
    setDraftTitle(chatTitle);
    setIsEditingTitle(true);
  }

  function saveTitleEdit() {
    const nextTitle = draftTitle.trim();
    const savedTitle = nextTitle || chatTitle;
    setChatTitle(savedTitle);
    setDraftTitle(savedTitle);
    setIsEditingTitle(false);
    if (savedTitle !== chatTitle) {
      onTitleChange(savedTitle);
      void enqueueMetaEvent({
        type: "group_title_update",
        actorMemberId: currentMemberId,
        actorName: currentMemberName,
        recordId: record.id,
        spaceId: record.spaceId || coreSpaceId,
        text: savedTitle,
        metadata: {
          previousTitle: chatTitle
        }
      });
    }
  }

  function cancelTitleEdit() {
    setDraftTitle(chatTitle);
    setIsEditingTitle(false);
  }

  function handleChatMessageInputChange(value: string) {
    setMessageInput(value);
    if (!/[@＠]/.test(value)) {
      setSelectedChatMemberIds([]);
    }
  }

  function beginChatVoiceInput() {
    setChatVoiceTranscriptPreview("");
    chatVoiceInsertionRef.current = captureVoiceInsertionPoint(messageInputRef.current, messageInput);
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition || shouldPreferReusableVoiceCapture()) {
      void beginFallbackChatVoiceInput();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join("")
        .trim();
      applyChatVoiceTranscript(transcript);
    };
    recognition.onerror = () => {
      chatVoiceRecognitionRef.current = null;
      if (chatVoicePressActiveRef.current) void beginFallbackChatVoiceInput();
    };
    recognition.onend = () => {
      chatVoiceRecognitionRef.current = null;
      if (chatVoicePressActiveRef.current && !chatVoiceFallbackActiveRef.current) {
        void beginFallbackChatVoiceInput();
      } else if (!chatVoiceFallbackActiveRef.current) {
        setChatVoiceRecording(false);
      }
    };
    chatVoiceRecognitionRef.current = recognition;
    try {
      recognition.start();
      triggerHaptic("start");
      setChatVoiceRecording(true);
    } catch {
      void beginFallbackChatVoiceInput();
    }
  }

  async function beginFallbackChatVoiceInput() {
    if (chatVoiceFallbackActiveRef.current) return;
    chatVoiceFallbackActiveRef.current = true;
    chatVoiceFallbackStopRequestedRef.current = false;
    triggerHaptic("start");
    setChatVoiceRecording(true);
    try {
      const capture = await startFallbackVoiceCapture({
        onTranscript: (transcript) => {
          applyChatVoiceTranscript(transcript);
          triggerHaptic("success");
          chatVoiceFallbackActiveRef.current = false;
          chatVoiceFallbackCaptureRef.current = null;
          setChatVoiceRecording(false);
        },
        onError: () => {
          chatVoiceFallbackActiveRef.current = false;
          chatVoiceFallbackCaptureRef.current = null;
          setChatVoiceRecording(false);
        }
      });
      chatVoiceFallbackCaptureRef.current = capture;
      if (chatVoiceFallbackStopRequestedRef.current) capture.stop();
    } catch {
      chatVoiceFallbackActiveRef.current = false;
      setChatVoiceRecording(false);
    }
  }

  function stopChatVoiceInput() {
    triggerHaptic("stop");
    if (chatVoiceFallbackActiveRef.current) {
      chatVoiceFallbackStopRequestedRef.current = true;
      chatVoiceFallbackCaptureRef.current?.stop();
      setChatVoiceRecording(false);
      return;
    }
    chatVoiceRecognitionRef.current?.stop();
    chatVoiceRecognitionRef.current = null;
    setChatVoiceRecording(false);
  }

  function applyChatVoiceTranscript(transcript: string) {
    const point = chatVoiceInsertionRef.current;
    if (!point) return;
    setChatVoiceTranscriptPreview(transcript.trim());
    const next = insertVoiceTranscript(point, transcript);
    handleChatMessageInputChange(next.value);
    if (point.keepKeyboardOpen) {
      window.requestAnimationFrame(() => {
        messageInputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    }
  }

  function armChatVoiceInput() {
    chatVoiceSendSuppressClickRef.current = false;
    chatVoicePressActiveRef.current = true;
    beginChatVoiceInput();
  }

  function releaseChatVoiceInput() {
    if (!chatVoicePressActiveRef.current) return;
    chatVoicePressActiveRef.current = false;
    chatVoiceSendSuppressClickRef.current = true;
    setChatVoiceRecording(false);
    stopChatVoiceInput();
  }

  function handleChatAttachmentClick() {
    fileInputRef.current?.click();
  }

  useEffect(() => () => {
    chatVoiceRecognitionRef.current?.stop();
    chatVoiceFallbackCaptureRef.current?.stop();
  }, []);

  function toggleSelectedChatMemberId(memberId: string) {
    setSelectedChatMemberIds((currentIds) => toggleMemberId(currentIds, memberId));
  }

  function selectAllChatMentionMembers() {
    setSelectedChatMemberIds((currentIds) => resolveAllMentionIds(chatMentionableMembers, currentIds));
  }

  function applySelectedChatMembers() {
    const memberIdsToAdd = selectedChatMemberIds.filter((memberId) => !chatMemberIds.includes(memberId));
    if (memberIdsToAdd.length === 0) {
      return [];
    }

    const addedMembers = memberIdsToAdd.map((memberId) => membersById.get(memberId)).filter(Boolean) as FamilyMember[];
    const nextMemberIds = [...chatMemberIds, ...memberIdsToAdd];
    onMembersChange(nextMemberIds);
    setSelectedChatMemberIds([]);

    return addedMembers;
  }

  function sendCurrentMessage() {
    const body = stripLatestMentionTrigger(messageInput).trim();
    if (!isComposingText && isJudgementWakeKeyword(body)) {
      keepMessageKeyboardUntilRef.current = 0;
      setMessageInput("");
      setSelectedChatMemberIds([]);
      messageInputRef.current?.blur();
      setJudgementCreateOpen(true);
      return;
    }
    if (!isComposingText && isPollWakeKeyword(body)) {
      keepMessageKeyboardUntilRef.current = 0;
      setMessageInput("");
      setSelectedChatMemberIds([]);
      messageInputRef.current?.blur();
      setPollCreateOpen(true);
      return;
    }
    if (!body && selectedChatMemberIds.length === 0) {
      focusActiveMessageInput();
      return;
    }

    keepMessageKeyboardUntilRef.current = Date.now() + 900;
    focusActiveMessageInput();
    const addedMembers = applySelectedChatMembers();
    const messageBody = body || (addedMembers.length ? `邀请 ${addedMembers.map((member) => member.displayName).join("、")} 加入群聊` : "");
    if (!messageBody) {
      focusActiveMessageInput();
      return;
    }

    const message: RoomMessage = {
      id: `local-${Date.now()}`,
      senderName: currentMemberName,
      senderAvatarSeed: currentMemberAvatarSeed,
      senderMemberId: currentMemberId,
      body: messageBody,
      sentAt: "刚刚",
      type: "text",
      mine: true
    };

    const nextMessages = [...messages, message];
    setMessages(nextMessages);
    onMessagesChange(nextMessages);
    const knowledgeInquiryId = messages.find((item) => item.knowledgeInquiryId)?.knowledgeInquiryId;
    if (knowledgeInquiryId) {
      void executeAutomationAction(
        "member.knowledge.collect_reply",
        { inquiry_id: knowledgeInquiryId, text: messageBody },
        { actorMemberId: currentMemberId, actorName: currentMemberName }
      ).then((result) => {
        const payload = readAutomationResultPayload(result) as { evidenceIds?: string[]; text?: string } | undefined;
        if (!result?.ok || !payload?.text) return;
        const assistant = [...membersById.values()].find((member) => member.householdRoles?.includes("assistant")) || membersById.get("fanmili");
        const evidenceReply: RoomMessage = {
          body: payload.text,
          id: `assistant-evidence-${Date.now()}`,
          senderAvatarSeed: assistant?.avatarSeed || "fanmili",
          senderMemberId: assistant?.id || "fanmili",
          senderName: assistant?.displayName || "饭米粒",
          sentAt: new Date().toISOString(),
          type: "text"
        };
        setMessages((current) => {
          const updated = [...current, evidenceReply];
          onMessagesChange(updated);
          return updated;
        });
      });
    }
    void enqueueMetaEvent({
      type: "group_chat_message",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: record.id,
      spaceId: record.spaceId || coreSpaceId,
      text: messageBody,
      metadata: {
        addedMemberIds: addedMembers.map((member) => member.id),
        addedMemberNames: addedMembers.map((member) => member.displayName),
        kind: addedMembers.length ? "group_member_added" : "group_chat_message",
        messageId: message.id,
        inviteLink: link,
        knowledgeInquiryId
      }
    });
    if (activeJudgement) {
      void familyFetch(`/api/group-judgements/${encodeURIComponent(activeJudgement.id)}/suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message_id: message.id, text: messageBody })
      }).then(async (response) => {
        const payload = await response.json() as { judgement?: GroupJudgement };
        if (response.ok && payload.judgement) updateJudgement(payload.judgement);
      }).catch(() => undefined);
    }
    setMessageInput("");
    focusActiveMessageInput();
    window.requestAnimationFrame(() => {
      focusActiveMessageInput();
      window.setTimeout(() => {
        if (Date.now() < keepMessageKeyboardUntilRef.current) {
          focusActiveMessageInput();
        }
      }, 80);
    });
  }

  function sendSticker(sticker: FanmiliSticker) {
    const message: RoomMessage = {
      id: `sticker-${Date.now()}`,
      senderName: currentMemberName,
      senderAvatarSeed: currentMemberAvatarSeed,
      senderMemberId: currentMemberId,
      stickerId: sticker.id,
      body: sticker.text,
      sentAt: "刚刚",
      type: "text",
      mine: true
    };
    const nextMessages = [...messages, message];
    setMessages(nextMessages);
    onMessagesChange(nextMessages);
    setMessageInput("");
    setSelectedChatMemberIds([]);
    void enqueueMetaEvent({
      type: "group_chat_message",
      actorMemberId: currentMemberId,
      actorName: currentMemberName,
      recordId: record.id,
      spaceId: record.spaceId || coreSpaceId,
      text: sticker.text,
      metadata: {
        inputText: sticker.text,
        kind: "group_chat_sticker",
        messageId: message.id,
        stickerId: sticker.id
      }
    });
    focusActiveMessageInput();
  }

  function focusActiveMessageInput() {
    if (suppressInputFocus) return;
    messageInputRef.current?.focus({ preventScroll: true });
  }

  function shouldPreventChatPageScroll() {
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 768;
  }

  function focusChatInputWithoutPageScroll(event: PointerEvent<HTMLTextAreaElement>) {
    if (!shouldPreventChatPageScroll()) return;
    event.preventDefault();
    if (event.pointerType === "touch") chatInputTouchHandledAtRef.current = window.performance.now();
    messageInputRef.current?.focus({ preventScroll: true });
  }

  function focusChatInputFromTouch(event: TouchEvent<HTMLTextAreaElement>) {
    const pointerHandledAt = chatInputTouchHandledAtRef.current;
    if (!shouldPreventChatPageScroll() || (pointerHandledAt !== null && window.performance.now() - pointerHandledAt < 700)) return;
    event.preventDefault();
    messageInputRef.current?.focus({ preventScroll: true });
  }

  function updateJudgement(next: GroupJudgement) {
    setJudgements((current) => current.some((item) => item.id === next.id)
      ? current.map((item) => item.id === next.id ? next : item)
      : [next, ...current]);
  }

  function appendJudgementLifecycle(judgement: GroupJudgement, lifecycle: "started" | "closed", body: string) {
    const nextMessages = [...messages, { id: `judgement-${Date.now()}`, senderName: "系统", body, judgementId: judgement.id, judgementLifecycle: lifecycle, sentAt: "刚刚", type: "system" as const }];
    setMessages(nextMessages);
    onMessagesChange(nextMessages);
  }

  function handleMessageInputBlur() {
    if (!suppressInputFocus && Date.now() < keepMessageKeyboardUntilRef.current) {
      window.requestAnimationFrame(() => focusActiveMessageInput());
    }
  }

  function startChatDismissGesture(event: PointerEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      !event.isPrimary
      || event.button !== 0
      || event.pointerType === "touch"
      || !isChatDismissStartTarget(target)
    ) {
      return;
    }

    chatDismissGestureRef.current = {
      activated: false,
      lastTime: event.timeStamp,
      lastX: event.clientX,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      velocityX: 0
    };
  }

  function trackChatDismissGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = chatDismissGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const status = trackChatDismissMotion(gesture, event.clientX, event.clientY, event.timeStamp);
    if (status === "cancel") {
      chatDismissGestureRef.current = null;
      resetChatDismissMotion();
      return;
    }
    if (status === "active") {
      event.preventDefault();
    }
  }

  function finishChatDismissGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = chatDismissGestureRef.current;
    chatDismissGestureRef.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    finishChatDismissMotion(gesture, event.clientX);
  }

  function cancelChatDismissGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = chatDismissGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    chatDismissGestureRef.current = null;
    resetChatDismissMotion();
  }

  function trackChatDismissMotion(
    gesture: { activated: boolean; lastTime: number; lastX: number; startX: number; startY: number; velocityX: number },
    clientX: number,
    clientY: number,
    timeStamp: number
  ) {
    const deltaX = clientX - gesture.startX;
    const deltaY = clientY - gesture.startY;
    if (!gesture.activated) {
      if (Math.abs(deltaY) >= chatDismissActivationDistance && Math.abs(deltaX) <= Math.abs(deltaY) * chatDismissHorizontalIntentRatio) return "cancel" as const;
      if (Math.abs(deltaX) < chatDismissActivationDistance || Math.abs(deltaX) <= Math.abs(deltaY) * chatDismissHorizontalIntentRatio) return "pending" as const;
      gesture.activated = true;
      setChatDismissDragging(true);
    }
    const elapsed = Math.max(1, timeStamp - gesture.lastTime);
    const instantaneousVelocityX = (clientX - gesture.lastX) / elapsed;
    gesture.velocityX = gesture.velocityX * 0.7 + instantaneousVelocityX * 0.3;
    gesture.lastX = clientX;
    gesture.lastTime = timeStamp;
    const travel = Math.max(1, window.innerWidth * chatDismissTravelRatio);
    setChatDismissMotion({ progress: Math.min(1, Math.abs(deltaX) / travel), x: deltaX });
    return "active" as const;
  }

  function finishChatDismissMotion(
    gesture: { activated: boolean; startX: number; velocityX: number },
    clientX: number
  ) {
    if (!gesture.activated || chatDismissClosingRef.current) {
      resetChatDismissMotion();
      return;
    }
    const deltaX = clientX - gesture.startX;
    const progress = Math.min(1, Math.abs(deltaX) / Math.max(1, window.innerWidth * chatDismissTravelRatio));
    const shouldClose = progress >= chatDismissCloseProgress || Math.abs(gesture.velocityX) >= chatDismissCloseVelocity;
    setChatDismissDragging(false);
    if (!shouldClose) {
      setChatDismissMotion({ progress: 0, x: 0 });
      return;
    }
    const direction = deltaX === 0 ? Math.sign(gesture.velocityX) || 1 : Math.sign(deltaX);
    chatDismissClosingRef.current = true;
    setChatDismissClosing(true);
    setChatDismissMotion({ progress: 1, x: direction * window.innerWidth * 1.04 });
    chatDismissTimerRef.current = window.setTimeout(onClose, 270);
  }

  function resetChatDismissMotion() {
    if (chatDismissClosingRef.current) return;
    setChatDismissDragging(false);
    setChatDismissMotion({ progress: 0, x: 0 });
  }

  function handleChatMessagesScroll(event: UIEvent<HTMLElement>) {
    const collapsed = event.currentTarget.scrollTop > 40;
    setChatContextCollapsed((current) => current === collapsed ? current : collapsed);
  }

  function locateChatContextItem(kind: "poll" | "judgement", id: string) {
    setChatContextCollapsed(false);
    window.requestAnimationFrame(() => {
      const messagesElement = messagesRef.current;
      const selector = kind === "poll" ? "[data-poll-id]" : "[data-judgement-id]";
      const target = Array.from(messagesElement?.querySelectorAll<HTMLElement>(selector) || []).find((element) => (
        kind === "poll" ? element.dataset.pollId === id : element.dataset.judgementId === id
      ));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (kind === "judgement") {
        setSelectedJudgementId(id);
      }
    });
  }

  function handleGroupAttachmentSelection(files: File[]) {
    if (files.length === 0) {
      return;
    }
    const validationResults = files.map((file) => ({ file, validation: validateResourceUploadFile(file) }));
    const acceptedFiles = validationResults.filter((item) => item.validation.ok).map((item) => item.file);
    const rejectedMessages = validationResults.flatMap((item) => item.validation.ok ? [] : [item.validation.message]);
    if (rejectedMessages.length > 0) {
      window.alert(rejectedMessages.join("\n"));
    }
    if (acceptedFiles.length === 0) return;

    const messageId = `file-${Date.now()}`;
    const localFiles = acceptedFiles.map((file) => {
      const cacheUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      return { cacheUrl, name: file.name, previewUrl: cacheUrl, size: file.size, type: file.type };
    });
    const message: RoomMessage = {
      id: messageId,
      senderName: currentMemberName,
      senderAvatarSeed: currentMemberAvatarSeed,
      senderMemberId: currentMemberId,
      body: acceptedFiles.map((file) => file.name).join("、"),
      sentAt: "刚刚",
      type: "file",
      files: localFiles,
      mine: true
    };
    const nextMessages = [...messages, message];
    setMessages(nextMessages);
    onMessagesChange(nextMessages);
    void import("@/lib/uploadQueue").then(({ uploadFilesWithTus }) => uploadFilesWithTus(acceptedFiles, { messageId })).then((uploadedFiles) => {
      const persistedFiles = localFiles.map((file, index) => {
        const uploadedFile = uploadedFiles[index];
        const persistentPreviewUrl = readPersistentPreviewUrl(uploadedFile);
        const originalUrl = readOriginalFileUrl(uploadedFile);
        if (file.cacheUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(file.cacheUrl);
        }
        return {
          ...file,
          ...(uploadedFile || {}),
          cacheUrl: undefined,
          originalUrl,
          previewUrl: persistentPreviewUrl || undefined,
          url: uploadedFile?.url
        };
      });
      const uploadedMessage = { ...message, files: persistedFiles };
      const uploadedMessages = nextMessages.map((item) => (item.id === messageId ? uploadedMessage : item));
      setMessages(uploadedMessages);
      onMessagesChange(uploadedMessages);
      return enqueueMetaEvent({
        type: "group_attachment_selected",
        actorMemberId: currentMemberId,
        actorName: currentMemberName,
        recordId: record.id,
        spaceId: record.spaceId || coreSpaceId,
        text: acceptedFiles.map((file) => file.name).join("、"),
        metadata: {
          concurrency: tusUploadConcurrency,
          files: persistedFiles,
          inputText: acceptedFiles.map((file) => file.name).join("、"),
          kind: "group_attachment_selected",
          messageId,
          originalFiles: persistedFiles.map((file) => ({
            name: file.name,
            originalUrl: file.originalUrl || file.url,
            size: file.size,
            storage: file.storage || "tus",
            type: file.type,
            url: file.url
          })),
          protocol: "tus",
          guestAvatarSeed: currentMemberAvatarSeed
        }
      });
    }).catch(() => {
      localFiles.forEach((file) => {
        if (file.cacheUrl?.startsWith("blob:")) URL.revokeObjectURL(file.cacheUrl);
      });
      const failedMessage = {
        ...message,
        files: localFiles.map((file) => ({ ...file, cacheUrl: undefined, previewUrl: undefined }))
      };
      const failedMessages = nextMessages.map((item) => (item.id === messageId ? failedMessage : item));
      setMessages(failedMessages);
      onMessagesChange(failedMessages);
    });
  }

  function renderChatComposerInputRow() {
    const chatVoiceReady = !messageInput.trim() && selectedChatMemberIds.length === 0;
    return (
      <SharedComposerInputRow
        beforeInput={(
          <>
            <FanmiliStickerSuggestions onSelect={sendSticker} query={messageInput} />
            {showChatMentionPicker ? (
              <MentionPicker
                className="chat-mention-picker"
                members={chatMentionableMembers}
                onSelectAll={selectAllChatMentionMembers}
                onToggle={toggleSelectedChatMemberId}
                selectedIds={selectedChatMemberIds}
              />
            ) : null}
          </>
        )}
        inputClassName={[
          chatVoiceRecording ? "voice-recording" : "",
          isJudgementWakeKeyword(messageInput.trim()) ? "judgement-wake" : ""
        ].filter(Boolean).join(" ")}
        inputLeadingContent={chatVoiceRecording ? <ComposerVoiceIndicator transcript={chatVoiceTranscriptPreview} /> : null}
        inputControl={(
          <ComposerAutosizeTextarea
            ref={messageInputRef}
            aria-label="群聊消息"
            autoComplete="off"
            id={`group-message-${record.id}`}
            name="groupMessage"
            onBlur={handleMessageInputBlur}
            onChange={(event) => handleChatMessageInputChange(event.target.value)}
            onCompositionEnd={() => setIsComposingText(false)}
            onCompositionStart={() => setIsComposingText(true)}
            onPointerDown={focusChatInputWithoutPageScroll}
            onTouchStart={focusChatInputFromTouch}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                sendCurrentMessage();
              }
            }}
            placeholder={chatVoiceRecording ? "正在听，请说话…" : ""}
            value={messageInput}
          />
        )}
        attachmentButtonProps={{
          "aria-label": "附件",
          onClick: handleChatAttachmentClick,
          type: "button"
        }}
        sendButtonProps={{
          "aria-label": chatVoiceRecording ? "正在语音输入，松开结束" : chatVoiceReady ? "发送；按住语音输入" : "发送",
          "aria-pressed": chatVoiceRecording,
          className: chatVoiceRecording ? "voice-active" : undefined,
          onClick: (event) => {
            if (chatVoiceSendSuppressClickRef.current) {
              event.preventDefault();
              chatVoiceSendSuppressClickRef.current = false;
              return;
            }
            sendCurrentMessage();
          },
          onMouseDown: (event) => event.preventDefault(),
          onPointerDown: (event) => {
            if (!chatVoiceReady) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            armChatVoiceInput();
          },
          onPointerUp: (event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            releaseChatVoiceInput();
          },
          onPointerCancel: (event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            releaseChatVoiceInput();
          },
          onLostPointerCapture: releaseChatVoiceInput,
          type: "button"
        }}
      />
    );
  }

  function saveMessagesToResource(messagesToSave: RoomMessage[]) {
    if (messagesToSave.length === 0) {
      return;
    }
    onSaveMessagesAsResources(messagesToSave);
    setSavedResourceMessageIds((current) => {
      const next = new Set(current);
      messagesToSave.forEach((message) => next.add(message.id));
      return next;
    });
    setActionMessageId(null);
    setSelectedMessageIds(new Set());
    setMessageSelectionMode(false);
  }

  function downloadMessages(messagesToDownload: RoomMessage[]) {
    for (const message of messagesToDownload) {
      const text = message.files?.length
        ? message.files.map((file) => `${file.name}${file.size ? ` (${file.size} bytes)` : ""}`).join("\n")
        : message.body;
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sanitizeFileName(message.senderName)}-${Date.now()}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }
    setActionMessageId(null);
    setSelectedMessageIds(new Set());
    setMessageSelectionMode(false);
  }

  async function copyMessage(message: RoomMessage) {
    await copyTextToClipboard(message.body);
    setActionMessageId(null);
  }

  function deleteMessage(messageId: string) {
    const nextMessages = messages.filter((message) => message.id !== messageId);
    setMessages(nextMessages);
    onMessagesChange(nextMessages);
    setActionMessageId(null);
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      next.delete(messageId);
      return next;
    });
  }

  function openMessageActionMenu(message: RoomMessage, target: HTMLElement) {
    const chatRect = chatFullscreenRef.current?.getBoundingClientRect();
    if (!chatRect) {
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const menuWidth = 156;
    const menuHeight = 176;
    const menuMargin = 10;
    const menuGap = 8;
    const left = Math.min(
      chatRect.width - menuWidth - menuMargin,
      Math.max(menuMargin, targetRect.left - chatRect.left)
    );
    const roomBelow = chatRect.bottom - targetRect.bottom - menuMargin;
    const preferredTop = roomBelow >= menuHeight + menuGap
      ? targetRect.bottom - chatRect.top + menuGap
      : targetRect.top - chatRect.top - menuHeight - menuGap;
    const top = Math.min(
      chatRect.height - menuHeight - menuMargin,
      Math.max(menuMargin, preferredTop)
    );

    setMessageActionMenuPosition({ left, top });
    setActionMessageId(message.id);
  }

  function toggleSelectedMessage(messageId: string) {
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  useEffect(() => {
    setMessages(record.chatMessages || []);
    setMessageInput("");
    setChatTitle(record.title);
    setDraftTitle(record.title);
    setIsEditingTitle(false);
    setActionMessageId(null);
    setSelectedMessageIds(new Set());
    setMessageSelectionMode(false);
    setInviteSheetLink(null);
    setPreviewImage(null);
  }, [record.id]);

  useEffect(() => {
    setMessages((currentMessages) => {
      const knownMessageIds = new Set(currentMessages.map((message) => message.id));
      const nextMessages = [
        ...currentMessages,
        ...(record.chatMessages || []).filter((message) => !knownMessageIds.has(message.id))
      ];

      return nextMessages.length === currentMessages.length ? currentMessages : nextMessages;
    });
  }, [record.chatMessages]);

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    const scrollToLatestMessage = () => {
      const keyboardOpen = document.documentElement.dataset.keyboard === "open";
      const composerHeight = chatComposerRef.current?.getBoundingClientRect().height || 0;
      if (keyboardOpen && composerHeight > 0) {
        messagesElement.style.setProperty("--chat-message-bottom-space", `${Math.ceil(composerHeight + 12)}px`);
      } else {
        messagesElement.style.removeProperty("--chat-message-bottom-space");
      }
      messagesElement.scrollTo({
        top: messagesElement.scrollHeight,
        behavior: "auto"
      });
    };
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToLatestMessage();
      window.requestAnimationFrame(scrollToLatestMessage);
    });

    return () => window.cancelAnimationFrame(firstFrame);
  }, [copied, messages.length]);

  useEffect(() => {
    const root = document.documentElement;
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    let animationFrame = 0;
    let settleTimers: number[] = [];
    const clearScheduledScrolls = () => {
      window.cancelAnimationFrame(animationFrame);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      settleTimers = [];
    };
    const alignLatestMessageAboveComposer = () => {
      const composerHeight = chatComposerRef.current?.getBoundingClientRect().height || 0;
      if (composerHeight > 0) {
        messagesElement.style.setProperty("--chat-message-bottom-space", `${Math.ceil(composerHeight + 12)}px`);
      }
      messagesElement.scrollTo({ top: messagesElement.scrollHeight, behavior: "auto" });
    };
    const handleKeyboardWake = () => {
      const keyboardOpen = root.dataset.keyboard === "open";
      if (!keyboardOpen) {
        chatKeyboardWakeScrolledRef.current = false;
        messagesElement.style.removeProperty("--chat-message-bottom-space");
        return;
      }
      if (document.activeElement !== messageInputRef.current || chatKeyboardWakeScrolledRef.current) {
        return;
      }

      chatKeyboardWakeScrolledRef.current = true;
      clearScheduledScrolls();
      animationFrame = window.requestAnimationFrame(() => {
        alignLatestMessageAboveComposer();
        animationFrame = window.requestAnimationFrame(alignLatestMessageAboveComposer);
      });
      settleTimers = [80, 180, 320].map((delay) => window.setTimeout(alignLatestMessageAboveComposer, delay));
    };

    const keyboardObserver = new MutationObserver(handleKeyboardWake);
    keyboardObserver.observe(root, { attributes: true, attributeFilter: ["data-keyboard"] });
    document.addEventListener("focusin", handleKeyboardWake);
    handleKeyboardWake();
    return () => {
      keyboardObserver.disconnect();
      document.removeEventListener("focusin", handleKeyboardWake);
      clearScheduledScrolls();
      messagesElement.style.removeProperty("--chat-message-bottom-space");
    };
  }, []);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = window.setTimeout(() => setCopied(false), 30000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const renderedMessages = useMemo(() => {
    const visibleMessages = messages.length > maxRenderedChatMessages ? messages.slice(-maxRenderedChatMessages) : messages;
    return visibleMessages.map((message) => {
      const mine = message.senderMemberId ? message.senderMemberId === currentMemberId : Boolean(message.mine);
      return mine === Boolean(message.mine) ? message : { ...message, mine };
    });
  }, [messages, currentMemberId]);
  const sourceMessageGroups = useMemo(() => groupChatMessages(renderedMessages), [renderedMessages]);
  const displayedMessageGroups = useMemo(
    () => splitChatMessageGroups(sourceMessageGroups, new Set(chatGroupContinuationIds)),
    [chatGroupContinuationIds, sourceMessageGroups]
  );
  const actionMessage = actionMessageId ? messages.find((message) => message.id === actionMessageId) : null;

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement || typeof ResizeObserver === "undefined") {
      return;
    }

    let measurementFrame = 0;
    const measureContinuationBoundaries = () => {
      const messageHeights = new Map<string, number>();
      messagesElement.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => {
        const messageId = element.dataset.messageId;
        if (messageId) {
          messageHeights.set(messageId, element.getBoundingClientRect().height);
        }
      });

      const maxSegmentHeight = Math.max(240, messagesElement.clientHeight - 24);
      const nextContinuationIds: string[] = [];
      sourceMessageGroups.forEach((messageGroup) => {
        let segmentHeight = 19;
        messageGroup.forEach((message, index) => {
          const messageHeight = messageHeights.get(message.id) || 0;
          const nextHeight = messageHeight + (index > 0 ? 7 : 0);
          if (index > 0 && segmentHeight + nextHeight > maxSegmentHeight) {
            nextContinuationIds.push(message.id);
            segmentHeight = 19 + messageHeight;
          } else {
            segmentHeight += nextHeight;
          }
        });
      });

      setChatGroupContinuationIds((current) => (
        current.length === nextContinuationIds.length
        && current.every((messageId, index) => messageId === nextContinuationIds[index])
          ? current
          : nextContinuationIds
      ));
    };
    const scheduleMeasurement = () => {
      window.cancelAnimationFrame(measurementFrame);
      measurementFrame = window.requestAnimationFrame(measureContinuationBoundaries);
    };
    const resizeObserver = new ResizeObserver(scheduleMeasurement);
    resizeObserver.observe(messagesElement);
    messagesElement.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => resizeObserver.observe(element));
    scheduleMeasurement();

    return () => {
      window.cancelAnimationFrame(measurementFrame);
      resizeObserver.disconnect();
    };
  }, [chatGroupContinuationIds, sourceMessageGroups]);

  return (
    <>
      <div
        aria-hidden="true"
        className={`chat-dismiss-underlay${chatDismissDragging ? " dragging" : ""}`}
        style={{ "--chat-dismiss-progress": chatDismissMotion.progress.toFixed(4) } as CSSProperties}
      />
      <div
      ref={chatFullscreenRef}
      className={`chat-fullscreen${chatDismissDragging ? " dragging" : ""}${chatDismissClosing ? " dismissing" : ""}`}
      role="dialog"
      aria-label="群聊界面"
      style={{
        "--chat-dismiss-progress": chatDismissMotion.progress.toFixed(4),
        "--chat-dismiss-x": `${chatDismissMotion.x.toFixed(2)}px`
      } as CSSProperties}
      onPointerCancelCapture={cancelChatDismissGesture}
      onPointerDownCapture={startChatDismissGesture}
      onPointerMoveCapture={trackChatDismissGesture}
      onPointerUpCapture={finishChatDismissGesture}
    >
      <SharedGroupChatHeader
        title={isEditingTitle ? (
            <input
              aria-label="修改群聊名称"
              autoFocus
              className="chat-title-input"
              onBlur={saveTitleEdit}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                  cancelTitleEdit();
                }
              }}
              style={{ "--title-chars": Math.max(4, draftTitle.length) } as CSSProperties}
              value={draftTitle}
            />
          ) : (
            <button
              className="chat-title-button"
              aria-label="点击修改群名"
              style={{ "--title-chars": Math.max(4, chatTitle.length) } as CSSProperties}
              type="button"
              onContextMenu={(event) => event.preventDefault()}
              onClick={startTitleEdit}
            >
              {chatTitle}
            </button>
          )}
      />

      <div className={`chat-context-stack${chatContextCollapsed ? " compact" : ""}`}>
        <SharedGroupMemberStrip label="群成员">
          {members.map((member) => (
            <i className={onlineMemberIds.has(member.id) ? "online" : "offline"} key={member.id} title={`${member.displayName} ${onlineMemberIds.has(member.id) ? "在线" : "离线"}`}>
              <MemberAvatar member={member} />
            </i>
          ))}
          <button className="chat-invite-button" type="button" aria-label="邀请外人加入群聊" onClick={() => setInviteSheetLink(link || record.id)}>
            <svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 6h7M6 2.5v7" /></svg>
          </button>
        </SharedGroupMemberStrip>
        {chatContextCollapsed ? collapsedContextItems.map((item) => item.kind === "poll" ? (
          <button className="chat-context-collapse-bar chat-poll-collapse-bar" data-created-at={item.createdAt} key={`poll-${item.id}`} type="button" onClick={() => locateChatContextItem("poll", item.id)} aria-label={`定位完整投票：${item.poll.question}`}>
            <b><i aria-hidden="true" />{item.poll.status === "closed" ? "已结束" : "投票"}</b>
            <strong>{item.poll.question}</strong>
            <em>{item.poll.participants.filter((participant) => participant.hasVoted).length}/{item.poll.participants.length}</em>
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          <GroupJudgementBar compact dataCreatedAt={item.createdAt} judgement={item.judgement} key={`judgement-${item.id}`} membersById={membersById} onOpen={() => locateChatContextItem("judgement", item.id)} />
        )) : displayedJudgement ? <GroupJudgementBar judgement={displayedJudgement} membersById={membersById} onOpen={() => setSelectedJudgementId(displayedJudgement.id)} /> : null}
      </div>
      {inviteSheetLink ? <InviteLinkSheet record={record} onClose={() => setInviteSheetLink(null)} onCopied={markInviteCopied} /> : null}

      <main className="chat-fullscreen-messages" ref={messagesRef} onScroll={handleChatMessagesScroll}>
        {polls.map((decision) => <ChatPollCard key={decision.id} decision={decision} membersById={membersById} onAdoptTask={(selectedTitle) => onCreateTaskFromDecision(decision, selectedTitle)} onChange={(next) => setPolls((current) => current.map((item) => item.id === next.id ? next : item))} />)}
        {displayedMessageGroups.map(({ messages: messageGroup, sourceGroupId }, groupIndex) => {
          const firstMessage = messageGroup[0];
          const previousMessageGroup = displayedMessageGroups[groupIndex - 1]?.messages;
          const previousMessage = previousMessageGroup?.[previousMessageGroup.length - 1];
          const messageMember = resolveMessageMember(firstMessage, members, membersById);
          const messageBubbleColor = chatMemberBubbleColor(messageMember, chatColorMemberIds);
          return (
            <SharedGroupMessage
              avatar={<MemberAvatar member={messageMember} />}
              key={`message-group-${sourceGroupId}-${firstMessage.id}`}
              mine={Boolean(firstMessage.mine)}
              senderName={firstMessage.senderName}
              sourceGroupId={sourceGroupId}
              style={{ "--chat-sender-color": messageBubbleColor } as CSSProperties}
              timeLabel={shouldShowChatTimestamp(previousMessage, firstMessage) ? formatChatTimestamp(firstMessage.sentAt) : undefined}
            >
                  {messageGroup.map((message) => {
                    const isSelected = selectedMessageIds.has(message.id);
                    const isSaved = savedResourceMessageIds.has(message.id);
                    const canSync = true;
                    return (
            <div
              className={[message.mine ? "chat-message mine" : "chat-message", message.presentation === "activity_plan" || isActivityPlanBody(message.body) ? "activity-plan-message" : "", isSelected ? "selected" : "", isSaved ? "synced" : ""].filter(Boolean).join(" ")}
              data-judgement-id={message.judgementId}
              data-message-id={message.id}
              key={message.id}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, input, a")) {
                  return;
                }
                openMessageActionMenu(message, event.currentTarget);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openMessageActionMenu(message, event.currentTarget);
              }}
            >
              <div className="chat-message-content">
                {message.judgementLifecycle && message.judgementId ? <article className="judgement-lifecycle-message"><p>{message.body}</p><button type="button" onClick={() => setSelectedJudgementId(message.judgementId || null)}>{message.judgementLifecycle === "started" ? "查看并表态" : "查看结果"}</button></article> : message.type === "file" ? <ChatAttachmentMessage message={message} onPreviewImage={setPreviewImage} /> : message.stickerId ? <FanmiliStickerMessage fallbackText={message.body} stickerId={message.stickerId} /> : message.presentation === "activity_plan" || isActivityPlanBody(message.body) ? <ActivityPlanCard body={message.body} /> : <p>{message.body}</p>}
                {messageSelectionMode && canSync ? (
                  <input
                    aria-label={`选择 ${message.body}`}
                    checked={isSelected}
                    className="chat-message-check"
                    onChange={() => toggleSelectedMessage(message.id)}
                    type="checkbox"
                  />
                ) : null}
              </div>
            </div>
                    );
                  })}
            </SharedGroupMessage>
          );
        })}
        {copied ? <div className="chat-local-notice">链接和口令已复制</div> : null}
      </main>
      {actionMessage && messageActionMenuPosition ? (
        <>
          <button
            aria-label="关闭消息菜单"
            className="chat-message-action-backdrop"
            type="button"
            onClick={() => setActionMessageId(null)}
          />
          <div
            aria-label="消息操作"
            className="chat-message-action-menu"
            role="menu"
            style={{ left: messageActionMenuPosition.left, top: messageActionMenuPosition.top }}
          >
            <button type="button" onClick={() => setActionMessageId(null)}>引用</button>
            <button type="button" onClick={() => void copyMessage(actionMessage)}>复制</button>
            <button type="button" onClick={() => saveMessagesToResource([actionMessage])}>保存</button>
            <button className="danger" type="button" onClick={() => deleteMessage(actionMessage.id)}>删除</button>
          </div>
        </>
      ) : null}
      {previewImage ? (
        <ChatImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />
      ) : null}
      {activeJudgement ? <StanceConfirmationCard judgement={activeJudgement} memberId={currentMemberId} onChange={updateJudgement} /> : null}
      {judgementCreateOpen ? <CreateJudgementSheet members={judgementMembers} roomRecord={record} onClose={() => setJudgementCreateOpen(false)} onCreated={(judgement) => { updateJudgement(judgement); setJudgementCreateOpen(false); appendJudgementLifecycle(judgement, "started", `${currentMemberName}发起了评评理：${judgement.title}`); }} /> : null}
      {selectedJudgement ? <GroupJudgementSheet currentMemberId={currentMemberId} judgement={selectedJudgement} members={judgementMembers} membersById={membersById} onClose={() => setSelectedJudgementId(null)} onChange={(next) => { const wasActive = selectedJudgement.status === "active"; updateJudgement(next); if (wasActive && next.status === "closed") appendJudgementLifecycle(next, "closed", `评评理已结束：${next.leftLabel} ${next.stances.filter((item) => item.source !== "ai_suggested" && item.stance === "left").length} 票，${next.rightLabel} ${next.stances.filter((item) => item.source !== "ai_suggested" && item.stance === "right").length} 票。`); }} /> : null}
      {pollCreateOpen ? <DecisionCreateSheet roomRecord={record} sourceText="" onClose={() => setPollCreateOpen(false)} onCreated={(decision) => { setPolls((current) => [...current, decision]); setPollCreateOpen(false); }} /> : null}
      {messageSelectionMode ? (
        <div className="chat-selection-bar">
          <strong>已选 {selectedMessageIds.size}</strong>
          <button type="button" disabled={selectedMessageIds.size === 0} onClick={() => downloadMessages(messages.filter((message) => selectedMessageIds.has(message.id)))}>
            下载
          </button>
          <button type="button" disabled={selectedMessageIds.size === 0} onClick={() => saveMessagesToResource(messages.filter((message) => selectedMessageIds.has(message.id)))}>
            同步资料库
          </button>
          <button
            type="button"
            onClick={() => {
              setMessageSelectionMode(false);
              setSelectedMessageIds(new Set());
            }}
          >
            取消
          </button>
        </div>
      ) : null}

      <div ref={chatComposerRef} className="composer chat-fullscreen-composer" role="group" aria-label="群聊输入">
        {renderChatComposerInputRow()}
        <input
          ref={fileInputRef}
          accept={RESOURCE_UPLOAD_ACCEPT}
          aria-label={`选择附件：Word、TXT、PDF、Excel 或常见图片，单个文件最大 ${RESOURCE_UPLOAD_MAX_LABEL}`}
          hidden
          multiple
          name="groupAttachments"
          onChange={(event) => {
            handleGroupAttachmentSelection(Array.from(event.currentTarget.files || []));
            event.currentTarget.value = "";
          }}
          type="file"
        />
      </div>
      </div>
    </>
  );
}

function ChatAttachmentMessage({
  message,
  onPreviewImage
}: {
  message: RoomMessage;
  onPreviewImage: (image: { cacheUrl?: string; originalUrl?: string; previewUrl: string; title: string }) => void;
}) {
  const files = message.files?.length ? message.files : [{ name: message.body }];
  const photoFiles = files.filter((file) => assetTypeFromFile(file) === "photo");
  const documentFiles = files.filter((file) => !photoFiles.includes(file));

  return (
    <div className="chat-attachment-message">
      {photoFiles.length ? (
        <div className={photoFiles.length === 1 ? "chat-photo-strip single" : "chat-photo-strip"}>
          {photoFiles.slice(0, 4).map((file) => (
            <ChatPhotoAttachment file={file} key={`${message.id}-${file.name}`} onPreviewImage={onPreviewImage} />
          ))}
        </div>
      ) : null}
      {documentFiles.map((file) => (
        <div className="chat-file-pill" key={`${message.id}-${file.name}`}>
          <span aria-hidden="true">{fileIcon(file)}</span>
          <strong title={file.name}>{stripFileExtension(file.name)}</strong>
        </div>
      ))}
    </div>
  );
}

function ChatPhotoAttachment({
  file,
  onPreviewImage
}: {
  file: NonNullable<RoomMessage["files"]>[number];
  onPreviewImage: (image: { cacheUrl?: string; originalUrl?: string; previewUrl: string; title: string }) => void;
}) {
  const sources = Array.from(new Set([file.cacheUrl, file.previewUrl, file.url, file.originalUrl].filter((url): url is string => Boolean(url))));
  const sourceKey = sources.join("|");
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => setSourceIndex(0), [sourceKey]);

  const source = sources[sourceIndex];
  const previewUrl = preferPersistentUrl(file.previewUrl, file.url, file.originalUrl) || source || "";
  return (
    <button
      aria-disabled={!source}
      className={!source ? "missing-preview" : undefined}
      type="button"
      onClick={() => source && onPreviewImage({ cacheUrl: isBlobUrl(source) ? source : undefined, originalUrl: readOriginalFileUrl(file), previewUrl, title: stripFileExtension(file.name) })}
    >
      {source ? (
        <img alt="" className="user-upload-image" onError={() => setSourceIndex((index) => index + 1)} src={source} />
      ) : (
        <span>图片已失效</span>
      )}
    </button>
  );
}

function ChatImagePreview({ image, onClose }: { image: { cacheUrl?: string; originalUrl?: string; previewUrl: string; title: string }; onClose: () => void }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [source, setSource] = useState(image.cacheUrl || image.previewUrl);

  return (
    <div className="chat-image-preview" role="dialog" aria-label={`${image.title}预览`}>
      <button className="preview-content-button" type="button" aria-label="关闭图片预览" onClick={onClose}>
        <img alt="" className="user-upload-image" onError={() => !showOriginal && setSource(image.previewUrl)} src={source} />
      </button>
      {image.originalUrl ? (
        <button className="original-image-link" type="button" onClick={() => {
          setShowOriginal(true);
          setSource(image.originalUrl || image.previewUrl);
        }}>
          {showOriginal ? "正在查看原图" : "查看原图"}
        </button>
      ) : null}
    </div>
  );
}

function TaskActionSheet({
  membersById,
  onClose,
  onComplete,
  onDelete,
  onRespond,
  record
}: {
  membersById: Map<string, FamilyMember>;
  onClose: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onRespond: (response: TaskResponse) => void;
  record: FamilyRecord;
}) {
  const [textAnswer, setTextAnswer] = useState("");
  const [selectedChoices, setSelectedChoices] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const currentMemberName = membersById.get(currentMemberId)?.displayName || defaultCurrentMemberName;
  const isSentByMe = record.createdByMemberId === currentMemberId;
  const myResponse = record.taskResponses?.find((response) => response.memberId === currentMemberId);
  const actionType = normalizeTaskActionType(record.taskActionType);
  const options = record.taskOptions?.length ? record.taskOptions : defaultTaskOptions(record);
  const assigneeMembers = record.assigneeMemberIds?.map((id) => membersById.get(id)).filter(Boolean) as FamilyMember[] | undefined;
  const isPersonalTask = isSentByMe && !record.assigneeMemberIds?.some((memberId) => memberId !== currentMemberId);
  const taskTime = formatTaskTimeMeta(record);

  function submitResponse(response: Omit<TaskResponse, "memberId" | "memberName" | "updatedAt">) {
    onRespond({
      memberId: currentMemberId,
      memberName: currentMemberName,
      updatedAt: "刚刚",
      ...response
    });
    onClose();
  }

  async function reviewFamilyJoinRequest(decision: "approve" | "reject") {
    if (!record.joinRequestId || reviewBusy) return;
    setReviewBusy(true);
    setReviewError("");
    const response = await familyFetch(`/api/family-join-requests/${encodeURIComponent(record.joinRequestId)}/review`, {
      body: JSON.stringify({ decision }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }).catch(() => null);
    setReviewBusy(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
      setReviewError(payload.detail || "审核失败，请稍后再试。");
      return;
    }
    onComplete();
  }

  if (record.joinRequestId) {
    return (
      <div className="task-sheet family-join-review-sheet" role="dialog" aria-label="确认家庭成员加入">
        <div className="task-sheet-head"><h3>{record.title}</h3><button aria-label="关闭" className="task-sheet-close" type="button" onClick={onClose}>×</button></div>
        <div className="family-join-review-person"><span>{record.relationshipLabel || "亲属"}</span><p>{record.summary}</p></div>
        <p className="family-join-review-note">确认后，这个账号才会成为家庭成员。手机号和密码将作为对方今后的登录凭证。</p>
        {reviewError ? <p className="family-invite-error" role="alert">{reviewError}</p> : null}
        <div className="task-action-grid">
          <button disabled={reviewBusy} type="button" onClick={() => void reviewFamilyJoinRequest("approve")}>{reviewBusy ? "正在处理…" : "确认加入"}</button>
          <button disabled={reviewBusy} type="button" onClick={() => void reviewFamilyJoinRequest("reject")}>拒绝</button>
        </div>
      </div>
    );
  }

  if (isPersonalTask) {
    return (
      <div className="task-sheet personal-task-sheet" role="dialog" aria-label="任务详情">
        <div className="task-sheet-head">
          <div>
            <h3>{record.displayTime ? stripTaskTimeFromTitle(record.title, record.displayTime) : record.title}</h3>
            {taskTime ? <span>{taskTime}</span> : null}
          </div>
          <button aria-label="关闭任务" className="task-sheet-close" type="button" onClick={onClose}>×</button>
        </div>
        <div className="personal-task-actions">
          <button
            aria-label={record.status === "done" ? "复原为待办" : "完成任务"}
            className="primary"
            type="button"
            onClick={onComplete}
          >
            {record.status === "done" ? "复原为待办" : "完成"}
          </button>
          <button className="danger" type="button" onClick={onDelete}>删除</button>
        </div>
      </div>
    );
  }

  return (
    <div className="task-sheet" role="dialog" aria-label="处理任务">
      <div className="task-sheet-head">
        <h3>{record.title}</h3>
        <button aria-label="关闭任务" className="task-sheet-close" type="button" onClick={onClose}>×</button>
      </div>

      {isSentByMe ? (
        <div className="task-response-list">
          {(assigneeMembers || []).map((member) => {
            const response = record.taskResponses?.find((item) => item.memberId === member.id);
            return (
              <div className="task-response-row" key={member.id}>
                <span className="mention-avatar">
                  <MemberAvatar member={member} />
                </span>
                <strong>{member.displayName}</strong>
                <em>{formatResponseStatus(response)}</em>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="task-actions">
          {myResponse && myResponse.status !== "pending" ? (
            <span className="task-done"><small>已处理</small><strong>{formatResponseStatus(myResponse)}</strong></span>
          ) : null}
          {actionType === "approval" ? (
            <div className="task-action-grid">
              <button className="task-response-accept" type="button" onClick={() => submitResponse({ status: "accepted", text: "同意" })}>
                同意
              </button>
              <button className="task-response-reject" type="button" onClick={() => submitResponse({ status: "rejected", text: "不同意" })}>
                不同意
              </button>
            </div>
          ) : null}
          {actionType === "input" ? (
            <form
              className="task-text-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = textAnswer.trim();
                if (value) {
                  submitResponse({ status: "answered", text: value });
                }
              }}
            >
              <input
                autoComplete="off"
                id={`task-response-${record.id}`}
                name="taskResponse"
                placeholder="输入你的回复..."
                value={textAnswer}
                onChange={(event) => setTextAnswer(event.target.value)}
              />
              <button type="submit">提交</button>
            </form>
          ) : null}
          {actionType === "multiple_choice" ? (
            <>
              <div className="task-choice-list">
                {options.map((option) => (
                  <button
                    className={selectedChoices.includes(option) ? "active" : ""}
                    key={option}
                    type="button"
                    onClick={() => setSelectedChoices((choices) => toggleChoice(choices, option))}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <button
                className="task-submit"
                disabled={selectedChoices.length === 0}
                type="button"
                onClick={() => submitResponse({ choices: selectedChoices, status: "answered", text: selectedChoices.join("、") })}
              >
                提交选择
              </button>
            </>
          ) : null}
        </div>
      )}

    </div>
  );
}

function loadStoredString(key: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(key);
}

function loadStoredJson<T>(key: string) {
  const value = loadStoredString(key);
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function memberScopedStorageKey(key: string, memberId: string) {
  return `${key}.${encodeURIComponent(memberId.trim() || "me")}`;
}

function memberScopedStorage(storage: Pick<Storage, "getItem" | "setItem">, memberId: string) {
  return {
    getItem: (key: string) => storage.getItem(memberScopedStorageKey(key, memberId)),
    setItem: (key: string, value: string) => storage.setItem(memberScopedStorageKey(key, memberId), value)
  };
}

function loadMemberAvatarProfile(key: string, member?: FamilyMember): MemberAvatarProfile {
  const stored = loadStoredJson<Partial<MemberAvatarProfile>>(key);
  const storedDisplayName = typeof stored?.displayName === "string" ? stored.displayName.trim().slice(0, 16) : "";
  const displayName = storedDisplayName === defaultCurrentMemberName
    && member?.displayName
    && member.displayName !== defaultCurrentMemberName
    ? member.displayName
    : storedDisplayName || member?.displayName || defaultCurrentMemberName;
  return {
    displayName,
    nickname: typeof stored?.nickname === "string" ? stored.nickname.slice(0, 16) : "",
    title: typeof stored?.title === "string" && stored.title.trim() ? stored.title.trim().slice(0, 24) : member?.role || "家庭成员"
  };
}

function parsePendingTaskSummary(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "待确认任务" || !lines[1]) return null;
  const time = lines.find((line) => line.startsWith("时间："))?.slice("时间：".length).trim() || "";
  const assignee = mentionLabelsForPlainDisplay(lines.find((line) => line.startsWith("负责人："))?.slice("负责人：".length).trim() || "待确认");
  return { assignee, time, title: lines[1] };
}

function parseRecentRecordSummary(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "最近记录") return null;
  const rows = lines.slice(lines[1]?.includes("时间") ? 2 : 1).flatMap((line) => {
    const match = line.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
    return match ? [{ time: match[1], title: match[2] }] : [];
  });
  return rows.length ? rows : null;
}

function parseMemberProfileSummary(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0]?.match(/^(.+?)目前的画像[：:]$/);
  if (!heading) return null;
  const note = lines.find((line) => line.startsWith("这些内容来自")) || "";
  const items = lines.slice(1).flatMap((line) => {
    if (line === note) return [];
    const match = line.match(/^([^：:]{2,12})[：:]\s*(.+)$/);
    return match ? [{ label: match[1].trim(), value: match[2].trim() }] : [];
  });
  if (!items.length) return null;
  return { items, memberName: heading[1].trim(), note };
}

async function syncMemberProfile(profile: MemberAvatarProfile, avatarSeed: string) {
  await familyFetch("/api/family-members", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ avatarSeed, displayName: profile.displayName })
  });
}

async function readAvatarCropSource(file: File): Promise<AvatarCropSource> {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("avatar_read_failed")));
    reader.readAsDataURL(file);
  });
  const dimensions = await new Promise<{ height: number; width: number }>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("avatar_decode_failed"));
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.src = src;
  });

  if (!dimensions.width || !dimensions.height) {
    throw new Error("avatar_invalid_dimensions");
  }

  return { name: file.name, src, ...dimensions };
}

async function cropAvatarImage(source: AvatarCropSource, cropSize: number, baseScale: number, scale: number, offset: { x: number; y: number }) {
  const renderScale = baseScale * scale;
  const sourceCropSize = cropSize / renderScale;
  const sourceX = Math.min(source.width - sourceCropSize, Math.max(0, source.width / 2 + (-cropSize / 2 - offset.x) / renderScale));
  const sourceY = Math.min(source.height - sourceCropSize, Math.max(0, source.height / 2 + (-cropSize / 2 - offset.y) / renderScale));
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 384;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("avatar_canvas_unavailable");
  }

  const image = await loadAvatarImage(source.src);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sourceX, sourceY, sourceCropSize, sourceCropSize, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

function loadAvatarImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("avatar_decode_failed"));
    image.onload = () => resolve(image);
    image.src = src;
  });
}

function loadCollapsedGroups() {
  const stored = loadStoredJson<Record<string, unknown>>(recordListStorageKeys.collapsedGroups);
  if (!stored) {
    return defaultCollapsedGroups;
  }

  return Object.fromEntries(
    Object.entries(defaultCollapsedGroups).map(([title, defaultCollapsed]) => [
      title,
      typeof stored[title] === "boolean" ? stored[title] : defaultCollapsed
    ])
  );
}

function createComposerSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptyComposerSessionState(): ComposerSessionState {
  return {
    id: "session-initial",
    messages: [],
    updatedAt: 0
  };
}

function loadComposerSessionState(): ComposerSessionState {
  const stored = loadStoredJson<ComposerSessionState>("family-app.composer-session");
  const now = Date.now();
  if (!stored || !stored.id || now - Number(stored.updatedAt || 0) > composerSessionTimeoutMs) {
    return {
      id: createComposerSessionId(),
      messages: [],
      updatedAt: now
    };
  }

  return {
    id: stored.id,
    messages: Array.isArray(stored.messages) ? stored.messages.filter((message) => message.text.trim() !== "我听到了。").slice(-12) : [],
    updatedAt: Number(stored.updatedAt) || now
  };
}

function storeComposerSessionState(session: ComposerSessionState) {
  storeJson("family-app.composer-session", session);
}

function storeString(key: string, value: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, value);
}

function storeJson(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

function storeJsonWhenBrowserIdle(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  return runWhenBrowserIdle(() => {
    storeJson(key, value);
  });
}

function readFamilyRecordsResponse(payload: unknown): FamilyRecord[] {
  if (!payload || typeof payload !== "object" || !("records" in payload)) {
    return [];
  }

  const records = (payload as { records?: unknown }).records;
  if (!Array.isArray(records)) {
    return [];
  }

  return records.filter(isFamilyRecordLike);
}

function isFamilyRecordLike(record: unknown): record is FamilyRecord {
  if (!record || typeof record !== "object") {
    return false;
  }

  const item = record as Partial<FamilyRecord>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.summary === "string" &&
    typeof item.ownerName === "string" &&
    typeof item.updatedAt === "string" &&
    Array.isArray(item.tags) &&
    ["task", "note", "link", "media"].includes(String(item.kind)) &&
    ["todo", "doing", "done", "saved"].includes(String(item.status))
  );
}

function mergeServerRecords(serverRecords: FamilyRecord[], currentRecords: FamilyRecord[]) {
  const serverIds = new Set(serverRecords.map((record) => record.id));
  const serverResourceKeys = new Set(serverRecords.map(uploadedResourcePersistenceKey).filter(Boolean));
  const mergedRecords = [
    ...serverRecords,
    ...currentRecords.filter((record) => {
      if (serverIds.has(record.id)) return false;
      const resourceKey = uploadedResourcePersistenceKey(record);
      return !resourceKey || !serverResourceKeys.has(resourceKey);
    })
  ];

  // Polling returns fresh objects even when no record changed. Reusing the
  // current array prevents the entire home list (including images and open
  // cards) from repainting every three seconds.
  return sameFamilyRecordSnapshot(mergedRecords, currentRecords) ? currentRecords : mergedRecords;
}

function sameFamilyRecordSnapshot(left: FamilyRecord[], right: FamilyRecord[]) {
  if (left.length !== right.length) return false;
  return left.every((record, index) => JSON.stringify(record) === JSON.stringify(right[index]));
}

function uploadedResourcePersistenceKey(record: FamilyRecord) {
  if (!isResourceRecord(record)) return "";
  for (const file of record.sourceFiles || []) {
    const persistentUrl = [file.originalUrl, file.url, file.previewUrl, file.cacheUrl]
      .find((url) => typeof url === "string" && Boolean(url) && !isBlobUrl(url));
    if (persistentUrl) return `${record.kind}:${persistentUrl}`;
  }
  return "";
}

function mergeRecordDisplayDefaults(storedRecords: FamilyRecord[] | null, defaults: FamilyRecord[]) {
  if (!storedRecords) {
    return defaults;
  }
  const defaultsById = new Map(defaults.map((record) => [record.id, record]));
  return storedRecords.map((record) => {
    const fallback = defaultsById.get(record.id);
    if (!fallback) {
      return record;
    }
    return {
      ...record,
      assetType: record.assetType || fallback.assetType,
      audioPath: record.audioPath || fallback.audioPath,
      durationMs: record.durationMs || fallback.durationMs,
      fileName: record.fileName || fallback.fileName,
      transcript: record.transcript || fallback.transcript
    };
  });
}

function createQuickRecord(text: string, suggestion: AssignmentSuggestion, options: { ownerName?: string; personalTodo?: boolean } = {}): FamilyRecord {
  const taskActionType = suggestion.taskActionType || inferTaskActionType(text);
  const assigneeIds = suggestion.suggestedAssignees.map((assignee) => assignee.id);
  const reminder = parseTaskReminder(suggestion.sourceText || text);
  const displayTime = suggestion.displayTime || reminder.displayTime;
  const title = normalizeTaskTitle(suggestion.taskTitle || reminder.title || text, displayTime);
  const taskResponses = options.personalTodo
    ? []
    : suggestion.suggestedAssignees.map((assignee) => ({
        memberId: assignee.id,
        memberName: assignee.displayName,
        status: "pending" as const
      }));

  return {
    id: crypto.randomUUID(),
    kind: "task",
    title,
    summary: suggestion.reason,
    ownerName: options.ownerName || defaultCurrentMemberName,
    createdByMemberId: currentMemberId,
    displayTime,
    dueAt: suggestion.dueAt || reminder.dueAt,
    reminderOffsets: [15, 0],
    recurrence: suggestion.recurrence || reminder.recurrence,
    assigneeMemberIds: assigneeIds,
    spaceId: coreSpaceId,
    audience: "core",
    assignmentStatus: "assigned",
    assignmentReason: suggestion.reason,
    taskActionType,
    taskOptions: suggestion.taskOptions || (taskActionType === "multiple_choice" ? defaultTaskOptionsFromText(text) : undefined),
    taskResponses,
    status: "todo",
    updatedAt: "刚刚",
    tags: ["待办"]
  };
}

function suggestOpenVolunteerQuestion(text: string, members: FamilyMember[]): AssignmentSuggestion | null {
  if (!isOpenVolunteerQuestion(text)) {
    return null;
  }

  const assignees = members
    .filter((member) => member.id !== currentMemberId && member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"))
    .map((member) => ({
      id: member.id,
      displayName: member.displayName,
      avatarSeed: member.avatarSeed,
      color: member.color
    }));

  if (assignees.length === 0) {
    return null;
  }

  return {
    suggestedAssignees: assignees,
    suggestedRoles: [],
    reason: "这是开放报名问题，默认发给所有人回答愿意或不愿意",
    confidence: 0.92,
    source: "local",
    taskTitle: text.replace(/[。？！?!.]+$/, "").slice(0, 24),
    taskActionType: "approval",
    taskOptions: ["愿意", "不愿意"]
  };
}

function isPersonalSuggestion(suggestion: AssignmentSuggestion) {
  const assigneeIds = suggestion.suggestedAssignees.map((assignee) => assignee.id);
  return assigneeIds.length === 0 || (assigneeIds.length === 1 && assigneeIds[0] === currentMemberId);
}

function formatTaskCandidateReply(title: string, suggestion: AssignmentSuggestion) {
  const timeLine = suggestion.recurrence
    ? `\n重复：${suggestion.recurrence.label}`
    : suggestion.displayTime
      ? `\n时间：${suggestion.displayTime}`
      : "";
  return `待确认任务\n${title}${timeLine}\n负责人：${formatAssigneeMentions(suggestion)}`;
}

function shouldOfferComposerTaskCard(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (/(不想吃|没想吃|别提醒|不要提醒|不用提醒|取消提醒|不必提醒)/.test(normalized)) {
    return false;
  }

  return /(想吃|吃什么|早餐|午餐|晚餐|提醒|记到任务|加入.*任务|记录[:：]|记录一下|分给|安排|待办)/.test(normalized);
}

function isPendingSuggestionConfirmation(text: string) {
  return /^(好|好的|可以|行|嗯|确认|确定|加入|加入任务|添加|添加任务|记到任务|放到任务|就这样|对)$/i.test(text.trim());
}

function buildLifeLogPromptResult(userText: string, assistantText: string): LifeLogPromptResult {
  const intent = classifyLifeLogIntent(userText, assistantText);
  const food = extractLifeLogMatches(userText, /(早餐|午餐|晚餐|夜宵|吃|喝|饭|菜|鸡蛋|牛奶|豆浆|粥|鱼|面|水果|西红柿|大餐)/);
  const health = extractLifeLogMatches(userText, /(睡|累|疼|痛|发烧|咳嗽|感冒|不舒服|医院|药|体检)/);
  const work = extractLifeLogMatches(userText, /(工作|会议|项目|客户|加班|代码|需求|上线|汇报)/);
  const family = extractLifeLogMatches(userText, /(老婆|老公|爸爸|妈妈|孩子|儿子|女儿|姐姐|哥哥|妹妹|弟弟|家里|家庭)/);
  const money = extractLifeLogMatches(userText, /(买|花了|付款|转账|收入|支出|钱|预算|账单|报销)/);
  const tags = Array.from(
    new Set([
      ...intent.map((item) => intentTagMap[item]).filter(Boolean),
      ...(food.length ? ["饮食"] : []),
      ...(health.length ? ["健康"] : []),
      ...(work.length ? ["工作"] : []),
      ...(family.length ? ["家庭"] : []),
      ...(money.length ? ["财务"] : [])
    ])
  );
  const needUserConfirmation = intent.some((item) => ["task", "reminder", "knowledge"].includes(item));

  return {
    user_reply: trimLifeLogReply(assistantText),
    structured_data: {
      intent,
      date: inferLifeLogDate(userText),
      time: extractTaskDisplayTime(userText) || null,
      people: extractMentionedPeople(userText),
      location: null,
      events: [userText.trim()].filter(Boolean),
      mood: inferLifeLogMood(userText),
      food,
      health,
      work,
      family,
      money,
      tags,
      summary: userText.trim(),
      task_candidate: intent.includes("task"),
      reminder_candidate: intent.includes("reminder"),
      knowledge_candidate: intent.includes("knowledge"),
      need_user_confirmation: needUserConfirmation,
      confidence: intent.includes("ambiguous") ? 0.46 : 0.82
    },
    raw_meta_policy: {
      allow_reparse: true,
      do_not_overwrite_raw_record: true,
      preserve_conversation_context: true,
      preserve_raw_input: true,
      preserve_uploaded_files: true,
      source_record_ids_required_for_summary: true
    },
    action_buttons: resolveLifeLogActionButtons(intent, needUserConfirmation)
  };
}

const intentTagMap: Record<LifeLogIntent, string> = {
  ambiguous: "待确认",
  daily_log: "生活记录",
  knowledge: "资料",
  question: "问题",
  reminder: "提醒",
  search: "查询",
  summary_request: "总结",
  task: "任务"
};

function classifyLifeLogIntent(text: string, assistantText: string): LifeLogIntent[] {
  const normalized = text.trim();
  const intents = new Set<LifeLogIntent>();

  if (/(查|找|搜索|以前|之前|历史|有没有|查看)/.test(normalized)) {
    intents.add("search");
  }

  if (/(总结|汇总|复盘|日报|周报|月报)/.test(normalized) || isAmbiguousOrganizationRequest(normalized)) {
    intents.add("summary_request");
  }

  if (/(提醒|闹钟|到点|别忘|记得)/.test(normalized)) {
    intents.add("reminder");
  }

  if (/(加入任务|记到任务|待办|分给|安排|负责|交给|派给|去做|做一下|处理|完成|洗|打扫|买|取|送)/.test(normalized) || /加入任务|任务/.test(assistantText)) {
    intents.add("task");
  }

  if (/^(记录|保存|资料|记住|偏好|喜欢|地址|证件|规则|习惯)/.test(normalized) || /(喜欢|习惯|地址|电话|生日|资料)/.test(normalized)) {
    intents.add("knowledge");
  }

  if (/[?？]$/.test(normalized) || /(天气|怎么|为什么|为啥|多少|几点|是什么|能不能|可以吗)/.test(normalized)) {
    intents.add("question");
  }

  if (!intents.has("summary_request") && !intents.has("question") && /(今天|明天|昨天|周末|吃|喝|去了|看到|感觉|觉得|开心|累|生气|难受|记录一下)/.test(normalized)) {
    intents.add("daily_log");
  }

  if (intents.size === 0) {
    intents.add(normalized.length < 3 ? "ambiguous" : "daily_log");
  }

  return Array.from(intents);
}

function extractLifeLogMatches(text: string, pattern: RegExp) {
  return pattern.test(text) ? [text.trim()] : [];
}

function extractMentionedPeople(text: string) {
  const matches = text.match(/我|老婆|老公|爸爸|妈妈|孩子|儿子|女儿|姐姐|哥哥|妹妹|弟弟|小明/g);
  return Array.from(new Set(matches || []));
}

function inferLifeLogDate(text: string) {
  const now = new Date();
  if (/后天/.test(text)) {
    now.setDate(now.getDate() + 2);
  } else if (/明天/.test(text)) {
    now.setDate(now.getDate() + 1);
  } else if (/昨天/.test(text)) {
    now.setDate(now.getDate() - 1);
  }
  return now.toISOString().slice(0, 10);
}

function inferLifeLogMood(text: string) {
  if (/(开心|高兴|期待|舒服)/.test(text)) {
    return "开心";
  }
  if (/(累|疲惫|烦|焦虑|生气|难受|低落)/.test(text)) {
    return "未知";
  }
  return null;
}

function trimLifeLogReply(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function resolveLifeLogActionButtons(intent: LifeLogIntent[], needsConfirmation: boolean) {
  if (intent.includes("task")) {
    return ["加入任务", "继续聊", "取消"];
  }
  if (intent.includes("reminder")) {
    return ["创建提醒", "修改一下", "取消"];
  }
  if (intent.includes("knowledge")) {
    return ["保存资料", "继续聊", "取消"];
  }
  if (intent.includes("question")) {
    return ["继续聊", "保存记录"];
  }
  return needsConfirmation ? ["保存记录", "修改一下", "取消"] : ["保存记录", "继续聊"];
}

function updatePendingSuggestionFromFollowUp(text: string, suggestion: AssignmentSuggestion, members: FamilyMember[]) {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  if (/(?:不|别|不要|不用|取消|撤销|not|cancel)/i.test(normalized)) {
    return null;
  }

  const hasTimeUpdate =
    extractTaskTimeMentions(normalized).length > 0 ||
    /^(?:早上|上午|中午|下午|晚上|今晚|夜里|凌晨|\d{1,2}\s*(?:am|pm))$/i.test(normalized);
  if (hasTimeUpdate) {
    const mergedSource = [suggestion.sourceText, normalized].filter(Boolean).join(" ");
    const reminder = parseTaskReminder(mergedSource);
    if (reminder.displayTime) {
      return {
        ...suggestion,
        confidence: Math.max(suggestion.confidence, 0.96),
        displayTime: reminder.displayTime,
        dueAt: reminder.dueAt,
        reason: `已按你的补充更新时间为 ${reminder.displayTime}`,
        sourceText: mergedSource
      } satisfies AssignmentSuggestion;
    }
  }

  const member = resolveFamilyMemberMention(normalized, members, { includeSelfPronouns: true });
  if (!member) {
    return null;
  }

  const looksLikeAssigneeChange = /(做|去做|来做|负责|交给|分给|派给|让|安排|换成|改成)/.test(normalized) || normalized === member.displayName;
  if (!looksLikeAssigneeChange) {
    return null;
  }

  return {
    ...suggestion,
    confidence: Math.max(suggestion.confidence, 0.96),
    reason: `已按你的补充把负责人改为 ${member.displayName}`,
    suggestedAssignees: [
      {
        id: member.id,
        displayName: member.displayName,
        avatarSeed: member.avatarSeed,
        color: member.color
      }
    ],
    suggestedRoles: []
  } satisfies AssignmentSuggestion;
}

function extractTaskDisplayTime(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match =
    normalized.match(/((?:今天|明天|后天|周末|本周|下周|这周|下星期)?\s*(?:早上|上午|中午|下午|晚上|今晚|夜里)?\s*\d{1,2}\s*(?:点|:|：)\s*\d{0,2}\s*(?:半|分)?)/) ||
    normalized.match(/((?:今天|明天|后天|周末|本周|下周|这周|下星期)\s*(?:早上|上午|中午|下午|晚上|今晚|夜里)?)/) ||
    normalized.match(/((?:早上|上午|中午|下午|晚上|今晚|夜里)\s*\d{1,2}\s*(?:点|:|：)\s*\d{0,2}\s*(?:半|分)?)/);

  return match ? match[1].replace(/\s+/g, " ").trim() : undefined;
}

function cleanTaskTitleTime(title: string, displayTime?: string) {
  if (!displayTime) {
    return title;
  }

  const cleaned = title
    .replace(displayTime, "")
    .replace(/\s+/g, " ")
    .replace(/^(今天|明天|后天|周末|本周|下周|这周|下星期)(?=\S)/, "")
    .replace(/^(早上|上午|中午|下午|晚上|今晚|夜里)(?=\S)/, "")
    .trim();

  return cleaned || title;
}

function stripTaskTimeFromTitle(title: string, displayTime: string) {
  return cleanTaskTitleTime(title, displayTime);
}

function formatTaskTimeMeta(record: FamilyRecord) {
  if (record.recurrence?.label?.trim()) {
    return `重复 · ${record.recurrence.label.trim().replace(/\s+/g, " ")}`;
  }
  if (!record.displayTime?.trim() || !record.dueAt) {
    return null;
  }
  return formatTaskListDateTime(record.dueAt);
}

function toggleMemberId(ids: string[], memberId: string) {
  return ids.includes(memberId) ? ids.filter((id) => id !== memberId) : [...ids, memberId];
}

function resolveAllMentionIds(members: FamilyMember[], selectedIds: string[]) {
  return selectedIds.length === members.length ? [] : members.map((member) => member.id);
}

function stripLatestMentionTrigger(value: string) {
  const triggerIndex = Math.max(value.lastIndexOf("@"), value.lastIndexOf("＠"));
  if (triggerIndex < 0) {
    return value;
  }

  const nextValue = `${value.slice(0, triggerIndex)}${value.slice(triggerIndex + 1)}`.replace(/[ \t]{2,}/g, " ");
  return nextValue.trim().length > 0 ? nextValue : "";
}

function stripLatestSlashTrigger(value: string) {
  const triggerIndex = value.lastIndexOf("/");
  if (triggerIndex < 0) {
    return value;
  }

  const nextValue = `${value.slice(0, triggerIndex)}${value.slice(triggerIndex + 1)}`.replace(/[ \t]{2,}/g, " ");
  return nextValue.trim().length > 0 ? nextValue : "";
}

function hasComposerSlashTrigger(value: string) {
  return /(?:^|\s)\/$/.test(value);
}

type ComposerSearchIndexItem = {
  haystack: string;
  hint: string;
  record: FamilyRecord;
  title: string;
};

function buildComposerSearchIndex(records: FamilyRecord[]): ComposerSearchIndexItem[] {
  return records.map((record) => ({
    haystack: [
      record.title,
      record.ownerName,
      record.fileName,
      record.kind,
      record.status,
      ...(record.tags || [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    hint: formatComposerSuggestionHint(record),
    record,
    title: record.title.toLowerCase()
  }));
}

function buildComposerSearchSuggestions(inputValue: string, searchIndex: ComposerSearchIndexItem[]) {
  const query = inputValue.trim().toLowerCase();
  if (query.length < 2) {
    return [];
  }

  const terms = query.split(/\s+/).filter(Boolean);

  return searchIndex
    .map((item) => {
      if (!terms.every((term) => item.haystack.includes(term))) {
        return null;
      }

      const score =
        (item.title === query ? 80 : 0) +
        (item.title.startsWith(query) ? 40 : 0) +
        (item.title.includes(query) ? 20 : 0) +
        terms.reduce((total, term) => total + (item.title.includes(term) ? 6 : 2), 0);

      return {
        hint: item.hint,
        record: item.record,
        score
      };
    })
    .filter((item): item is { hint: string; record: FamilyRecord; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title, "zh-Hans-CN"))
    .slice(0, 3);
}

function formatComposerSuggestionHint(record: FamilyRecord) {
  if (record.inviteLink || record.chatMembers?.length) {
    return `群组 · ${record.summary}`;
  }

  if (record.kind === "task") {
    return `${record.status === "todo" ? "待办" : "任务"} · ${record.assignmentReason || record.summary}`;
  }

  if (["note", "link", "media"].includes(record.kind)) {
    return `资料 · ${record.ownerName}`;
  }

  return `${record.ownerName} · ${record.updatedAt}`;
}

function formatAutomationResultText(unit: AutomationUnitDefinition) {
  if (unit.id === "pipeline.meta.profile_learning") {
    return "已根据历史信息更新大家的人物画像。";
  }

  if (unit.id === "pipeline.meta.daily_rollup") {
    return "已完成今天的信息整理。";
  }

  if (unit.id === "meta.profiles.refresh") {
    return "已刷新大家的人物画像。";
  }

  return "处理完成。";
}

function formatAutomationFeedbackText(unit: AutomationUnitDefinition) {
  return formatAutomationResultText(unit);
}

function isGroupChatRecord(record: FamilyRecord) {
  return Boolean(record.inviteLink || record.chatMembers?.length || record.tags.includes("群组"));
}

function isResourceRecord(record: FamilyRecord) {
  return ["note", "link", "media"].includes(record.kind);
}

function assetTypeFromFile(file?: { name: string; type?: string }): FamilyAssetType {
  const type = file?.type || "";
  const name = file?.name || "";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name)) {
    return "photo";
  }
  if (type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(name)) {
    return "video";
  }
  if (type.startsWith("audio/") || /\.(mp3|m4a|wav|aac)$/i.test(name)) {
    return "audio";
  }
  if (/pdf$/i.test(type) || /\.pdf$/i.test(name)) {
    return "pdf";
  }
  if (/\.(docx?|pages)$/i.test(name)) {
    return "word";
  }
  if (/\.(xlsx?|csv|numbers)$/i.test(name)) {
    return "excel";
  }
  if (isArchiveFile({ name, type })) {
    return "archive";
  }
  return "text";
}

function isArchiveFile(file?: { name: string; type?: string }) {
  const type = file?.type || "";
  const name = file?.name || "";
  return (
    /^(application\/(zip|x-zip-compressed|x-rar-compressed|x-7z-compressed|x-tar|gzip)|multipart\/x-zip)$/i.test(type) ||
    /\.(zip|rar|7z|tar|tgz|gz|bz2|xz)$/i.test(name) ||
    /\.tar\.(gz|bz2|xz)$/i.test(name)
  );
}

function fileIcon(file?: { name: string; type?: string }) {
  const assetType = assetTypeFromFile(file);
  if (assetType === "pdf") {
    return "PDF";
  }
  if (assetType === "word") {
    return "W";
  }
  if (assetType === "excel") {
    return "X";
  }
  if (assetType === "video") {
    return "▶";
  }
  if (assetType === "audio") {
    return "♪";
  }
  if (assetType === "photo") {
    return "图";
  }
  if (assetType === "archive") {
    return "ZIP";
  }
  return "文";
}

function stripFileExtension(name: string) {
  return name.replace(/\.[^./\\]+$/, "");
}

function sanitizeFileName(name: string) {
  return stripFileExtension(name).replace(/[\\/:*?"<>|]+/g, "-").trim() || "group-message";
}

function buildResourcesFromChatMessages(
  chatRecord: FamilyRecord,
  messagesToSave: RoomMessage[],
  members: FamilyMember[],
  membersById: Map<string, FamilyMember>,
  savedAt: string
) {
  const resources: FamilyRecord[] = [];
  type ChatFile = NonNullable<RoomMessage["files"]>[number];
  const photoFiles: { file: ChatFile; message: RoomMessage }[] = [];
  const otherFiles: { file: ChatFile; message: RoomMessage }[] = [];
  const textMessages: RoomMessage[] = [];

  for (const message of messagesToSave) {
    if (message.files?.length) {
      for (const file of message.files) {
        const bucket = assetTypeFromFile(file) === "photo" ? photoFiles : otherFiles;
        bucket.push({ file, message });
      }
    } else if (message.body.trim()) {
      textMessages.push(message);
    }
  }

  if (photoFiles.length) {
    const firstMessage = photoFiles[0].message;
    const sourceMember = resolveMessageMember(firstMessage, members, membersById);
    resources.push({
      id: createResourceId(),
      kind: "media",
      title: `群聊照片 ${photoFiles.length} 张`,
      summary: `来自 ${firstMessage.senderName} · ${chatRecord.title} · ${firstMessage.sentAt || savedAt}`,
      ownerName: firstMessage.senderName,
      createdByMemberId: firstMessage.senderMemberId || sourceMember.id,
      spaceId: coreSpaceId,
      audience: "core",
      assignmentStatus: "accepted",
      assignmentReason: `从群聊「${chatRecord.title}」加入资料`,
      assetType: "photo",
      fileName: photoFiles.map((item) => item.file.name).join("、"),
      previewUrl: getFilePreviewUrl(photoFiles[0].file),
      sourceAvatarSeed: firstMessage.senderAvatarSeed || sourceMember.avatarSeed,
      sourceFiles: photoFiles.map((item) => item.file),
      sourceMemberId: firstMessage.senderMemberId || sourceMember.id,
      sourceMessageId: firstMessage.id,
      status: "saved",
      updatedAt: savedAt,
      tags: ["群聊照片", "资料"]
    });
  }

  for (const { file, message } of otherFiles) {
    const sourceMember = resolveMessageMember(message, members, membersById);
    resources.push({
      id: createResourceId(),
      kind: "media",
      title: file.name || message.body || "群聊附件",
      summary: `来自 ${message.senderName} · ${chatRecord.title} · ${message.sentAt || savedAt}`,
      ownerName: message.senderName,
      createdByMemberId: message.senderMemberId || sourceMember.id,
      spaceId: coreSpaceId,
      audience: "core",
      assignmentStatus: "accepted",
      assignmentReason: `从群聊「${chatRecord.title}」加入资料`,
      assetType: assetTypeFromFile(file),
      fileName: file.name,
      previewUrl: getFilePreviewUrl(file),
      sourceAvatarSeed: message.senderAvatarSeed || sourceMember.avatarSeed,
      sourceFiles: [file],
      sourceMemberId: message.senderMemberId || sourceMember.id,
      sourceMessageId: message.id,
      status: "saved",
      updatedAt: savedAt,
      tags: ["群聊附件", "资料"]
    });
  }

  for (const message of textMessages) {
    const sourceMember = resolveMessageMember(message, members, membersById);
    resources.push({
      id: createResourceId(),
      kind: "note",
      title: message.body.slice(0, 24) || "群聊文字",
      summary: `来自 ${message.senderName} · ${chatRecord.title} · ${message.sentAt || savedAt}`,
      ownerName: message.senderName,
      createdByMemberId: message.senderMemberId || sourceMember.id,
      spaceId: coreSpaceId,
      audience: "core",
      assignmentStatus: "accepted",
      assignmentReason: `从群聊「${chatRecord.title}」加入资料`,
      assetType: "text",
      sourceAvatarSeed: message.senderAvatarSeed || sourceMember.avatarSeed,
      sourceMemberId: message.senderMemberId || sourceMember.id,
      sourceMessageId: message.id,
      status: "saved",
      updatedAt: savedAt,
      tags: ["群聊文字", "资料"]
    });
  }

  return resources;
}

function createResourceId() {
  return crypto.randomUUID();
}

function inferTaskActionType(text: string) {
  if (isOpenVolunteerQuestion(text)) {
    return "approval";
  }

  if (/哪几|哪些|选择|多选|分配|区域|清单|选一下/i.test(text)) {
    return "multiple_choice";
  }

  if (/是不是|是否|能不能|可不可以|要不要|同意|确认|可以吗|\?$|？$|agree|ok/i.test(text)) {
    return "approval";
  }

  return "input";
}

function normalizeTaskActionType(actionType: unknown) {
  if (actionType === "text") {
    return "input";
  }
  if (actionType === "multi_select") {
    return "multiple_choice";
  }
  if (actionType === "approval" || actionType === "input" || actionType === "multiple_choice") {
    return actionType;
  }
  return "approval";
}

function defaultTaskOptions(record: FamilyRecord) {
  return record.taskOptions?.length ? record.taskOptions : defaultTaskOptionsFromText(record.title);
}

function defaultTaskOptionsFromText(text: string) {
  if (isOpenVolunteerQuestion(text)) {
    return ["愿意", "不愿意"];
  }

  if (/清洁|打扫|扫除|床单|洗|区域/i.test(text)) {
    return ["客厅", "厨房", "卫生间", "卧室"];
  }

  if (/吃|饭|菜|早餐|午餐|晚餐/i.test(text)) {
    return ["可以", "换一个", "稍后决定"];
  }

  return ["我来处理", "需要别人帮忙", "稍后确认"];
}

function isOpenVolunteerQuestion(text: string) {
  return isOpenVolunteerTaskQuestion(text);
}

function toggleChoice(choices: string[], choice: string) {
  return choices.includes(choice) ? choices.filter((item) => item !== choice) : [...choices, choice];
}

function getTaskProgress(record: FamilyRecord) {
  const responses = record.taskResponses || [];
  if (responses.length === 0) {
    return null;
  }

  const doneCount = responses.filter((response) => response.status !== "pending").length;
  return {
    complete: doneCount === responses.length,
    done: doneCount,
    total: responses.length
  };
}

function getDelegatedTaskAssignees(record: FamilyRecord, membersById: Map<string, FamilyMember>) {
  if (record.kind !== "task" || record.createdByMemberId !== currentMemberId) {
    return [];
  }

  const assigneeIds = (record.assigneeMemberIds || []).filter((memberId) => memberId !== currentMemberId);
  if (assigneeIds.length === 0) {
    return [];
  }

  return assigneeIds.map((memberId) => membersById.get(memberId)).filter(Boolean) as FamilyMember[];
}

function formatResponseStatus(response?: TaskResponse) {
  if (!response || response.status === "pending") {
    return "未处理";
  }

  if (response.status === "accepted") {
    return "同意";
  }

  if (response.status === "rejected") {
    return "不同意";
  }

  return response.text || response.choices?.join("、") || "已回复";
}

function formatAssetType(record: FamilyRecord) {
  const labels: Record<string, string> = {
    audio: "语音",
    archive: "压缩包",
    excel: "Excel",
    link: "链接",
    pdf: "PDF",
    photo: "照片",
    text: "文本",
    video: "视频",
    word: "Word"
  };

  return labels[record.assetType || "text"] || "资料";
}

function formatDocumentTypeBadge(record: FamilyRecord) {
  if (record.assetType === "pdf") return "PDF";
  if (record.assetType === "word") return "DOCX";
  return "TXT";
}

function isJudgementWakeKeyword(value: string) {
  return /^(?:评评理|请评评理|帮我评评理)[。！!？?]?$/.test(value.trim());
}

function fallbackPhoto(seed: string) {
  const label = seed.slice(0, 1).toUpperCase() || "图";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 720"><rect width="720" height="720" rx="72" fill="#eef3f1"/><path d="M155 500l130-150 90 95 70-76 120 131H155z" fill="#b9cbc5"/><circle cx="250" cy="245" r="52" fill="#94b4aa"/><text x="360" y="620" text-anchor="middle" font-family="sans-serif" font-size="54" fill="#60746e">${label}</text></svg>`)}`;
}

function formatResourceDate(record: FamilyRecord) {
  const source = record.occurredAt || record.occurredOn;
  const parsed = source ? new Date(source) : new Date();
  if (Number.isNaN(parsed.getTime())) return record.updatedAt || "今天";
  const now = new Date();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(parsed.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric"
  }).format(parsed);
}

function moveSelfToEndInGroupTitle(title: string) {
  const parts = title.trim().split(/\s+/);
  if (!parts.includes("我")) return title;
  return [...parts.filter((part) => part !== "我"), "我"].join(" ");
}

function createGuestMember(memberId: string, displayName?: string, avatarSeed?: string): FamilyMember {
  const names: Record<string, string> = {
    "guest-cousin": "表哥",
    "guest-friend": "朋友"
  };

  return {
    id: memberId,
    displayName: displayName || names[memberId] || "访客",
    role: "访客",
    relationshipRole: "guest",
    profile: {},
    status: "online",
    avatarSeed: avatarSeed || memberId,
    color: "#6f7f8f"
  };
}

function createMessageGuestMember(senderName: string, avatarSeed?: string, memberId?: string): FamilyMember {
  return {
    id: memberId || `message-${senderName}`,
    displayName: senderName,
    role: "群成员",
    relationshipRole: "guest",
    profile: {},
    status: "online",
    avatarSeed: avatarSeed || senderName,
    color: "#6f7f8f"
  };
}

function resolveMessageMember(message: RoomMessage, members: FamilyMember[], membersById: Map<string, FamilyMember>) {
  if (message.mine) {
    return membersById.get(currentMemberId) || createMessageGuestMember(defaultCurrentMemberName);
  }

  return (
    (message.senderMemberId && membersById.get(message.senderMemberId)) ||
    findMemberByName(membersById, message.senderName) ||
    members.find((member) => member.displayName === message.senderName) ||
    createMessageGuestMember(message.senderName, message.senderAvatarSeed, message.senderMemberId)
  );
}

function findMemberByName(membersById: Map<string, FamilyMember>, name: string) {
  return [...membersById.values()].find((member) => member.displayName === name);
}

function readAutomationResultPayload(response: unknown) {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  if ("data" in response) {
    return (response as AutomationActionResponse).data;
  }

  const apiResult = "result" in response ? (response as { result?: unknown }).result : undefined;
  if (apiResult && typeof apiResult === "object" && "result" in apiResult) {
    return (apiResult as { result?: unknown }).result;
  }

  return apiResult;
}

function readNestedAutomationResultPayloads(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || !("results" in payload)) {
    return [];
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .map((item) => (item && typeof item === "object" && "result" in item ? (item as { result?: unknown }).result : undefined))
    .filter((item) => item !== undefined);
}

function readDisplayTarget(payload: unknown): AutomationDisplayTarget | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const display = (payload as { display?: unknown }).display;
  if (display && typeof display === "object") {
    const target = (display as { target?: unknown }).target;
    if (isDisplayTarget(target)) {
      return target;
    }
  }
  const value = (payload as { displayTarget?: unknown }).displayTarget;
  return isDisplayTarget(value) ? value : undefined;
}

function readDisplayType(payload: unknown): AutomationDisplayType | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const display = (payload as { display?: unknown }).display;
  if (display && typeof display === "object") {
    const type = (display as { type?: unknown }).type;
    if (isDisplayType(type)) {
      return type;
    }
  }
  const value = (payload as { displayType?: unknown }).displayType;
  return isDisplayType(value) ? value : undefined;
}

function isDisplayTarget(value: unknown): value is AutomationDisplayTarget {
  return value === "inline_assistant" || value === "task_list" || value === "resource_list" || value === "group_chat" || value === "modal" || value === "toast" || value === "none";
}

function isDisplayType(value: unknown): value is AutomationDisplayType {
  return (
    value === "chat_reply" ||
    value === "task_candidate" ||
    value === "task_item" ||
    value === "resource_item" ||
    value === "profile_card" ||
    value === "summary_card" ||
    value === "web_search_result" ||
    value === "confirmation_card" ||
    value === "error_card"
  );
}

function shouldBuildAssistantResultLinks(displayTarget: AutomationDisplayTarget) {
  return displayTarget === "task_list" || displayTarget === "resource_list" || displayTarget === "group_chat";
}

function shouldApplyAutomationRecords(displayTarget: AutomationDisplayTarget) {
  return displayTarget === "task_list" || displayTarget === "resource_list" || displayTarget === "group_chat";
}

function readAutomationRecordPayload(payload: unknown): FamilyRecord[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const records: FamilyRecord[] = [];
  const record = "record" in payload ? (payload as { record?: FamilyRecord }).record : undefined;
  if (record) {
    records.push(record);
  }

  const recordsPayload = "records" in payload ? (payload as { records?: FamilyRecord[] }).records : undefined;
  if (Array.isArray(recordsPayload)) {
    records.push(...recordsPayload.filter(Boolean));
  }

  for (const nestedPayload of readNestedAutomationResultPayloads(payload)) {
    records.push(...readAutomationRecordPayload(nestedPayload));
  }

  return records;
}

function recordMatchesDisplayTarget(record: FamilyRecord, displayTarget: AutomationDisplayTarget) {
  if (displayTarget === "task_list") {
    return record.kind === "task" && !isGroupChatRecord(record);
  }
  if (displayTarget === "resource_list") {
    return isResourceRecord(record);
  }
  if (displayTarget === "group_chat") {
    return isGroupChatRecord(record);
  }
  return false;
}

function buildAssistantResultLinks(text: string, payload: unknown, records: FamilyRecord[], displayTarget: AutomationDisplayTarget = "inline_assistant"): AssistantResultLink[] {
  const links = new Map<string, AssistantResultLink>();
  const webResults = readWebSearchResults(payload);
  if (webResults.length > 0) {
    return webResults.slice(0, 4).map((item, index) => ({
      id: item.link || `web-${index}`,
      kind: "web",
      label: `打开：${compactLinkTitle(item.title || item.link || `结果 ${index + 1}`)}`,
      url: item.link
    }));
  }

  const addRecord = (record: FamilyRecord | undefined, labelPrefix?: string) => {
    if (!record) {
      return;
    }
    const kind: AssistantResultLink["kind"] = ["note", "link", "media"].includes(record.kind) ? "resource" : record.inviteLink ? "group" : "task";
    if (
      (displayTarget === "task_list" && kind !== "task") ||
      (displayTarget === "resource_list" && kind !== "resource") ||
      (displayTarget === "group_chat" && kind !== "group")
    ) {
      return;
    }
    const fallbackLabel = kind === "resource" ? "查看资料" : kind === "group" ? "进入群组" : "查看任务";
    links.set(record.id, {
      id: record.id,
      kind,
      label: `${labelPrefix || fallbackLabel}：${compactLinkTitle(record.title)}`
    });
  };

  if (payload && typeof payload === "object") {
    const record = "record" in payload ? (payload as { record?: FamilyRecord }).record : undefined;
    addRecord(record);
    const recordsPayload = "records" in payload ? (payload as { records?: FamilyRecord[] }).records : undefined;
    if (Array.isArray(recordsPayload)) {
      recordsPayload.slice(0, 4).forEach((item) => addRecord(item));
    }
  }

  for (const record of records) {
    if (links.size >= 4) {
      break;
    }
    if (text.includes(record.title)) {
      addRecord(record);
    }
  }

  if (/资料|文件|照片/.test(text)) {
    records
      .filter((record) => ["note", "link", "media"].includes(record.kind))
      .slice(0, 3)
      .forEach((record) => addRecord(record, "查看资料"));
  }

  if (/群组|群聊/.test(text)) {
    records
      .filter((record) => Boolean(record.inviteLink))
      .slice(0, 3)
      .forEach((record) => addRecord(record, "进入群组"));
  }

  if (/任务|待办|派给你|派给我的|派发/.test(text)) {
    records
      .filter((record) => record.kind === "task" && !record.inviteLink && (text.includes(record.title) || record.assigneeMemberIds?.includes(currentMemberId)))
      .slice(0, 4)
      .forEach((record) => addRecord(record, "查看任务"));
  }

  return [...links.values()].slice(0, 4);
}

function compactLinkTitle(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function normalizeWebSearchQuery(text: string) {
  const query = text
    .trim()
    .replace(/^(帮我|请|麻烦)?\s*(联网搜索|网络搜索|搜索一下|搜一下|查一下|查下|帮我搜|帮我查|上网查|网上查)\s*/i, "")
    .replace(/[。！？!?]+$/g, "")
    .trim();
  return query || text.trim();
}

function formatWebSearchFeedback(query: string, payload: unknown) {
  const results = readWebSearchResults(payload);
  if (!results.length) {
    return `没有搜到可用结果：${query}`;
  }

  const lines = results.slice(0, 3).map((item, index) => {
    const title = item.title || item.link || `结果 ${index + 1}`;
    const snippet = item.snippet ? `\n${item.snippet}` : "";
    return `${index + 1}. ${title}${snippet}`;
  });
  return `已联网搜索：${query}\n\n${lines.join("\n\n")}`;
}

function readWebSearchResults(payload: unknown): WebSearchResultItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = "results" in payload ? (payload as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      link: typeof item.link === "string" ? item.link : undefined,
      snippet: typeof item.snippet === "string" ? item.snippet : undefined,
      title: typeof item.title === "string" ? item.title : undefined
    }))
    .filter((item) => item.title || item.link || item.snippet);
}

async function hashResourceFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function resolveResourceOwnerFromText(text: string, members: FamilyMember[], currentMemberId: string) {
  const normalized = text.trim().replace(/\s+/g, "");
  if (!/^(?:(?:这份|这个|该)?(?:报告|资料|文件)?)?(?:属于|归属(?:到)?|归到|算作|改成|设为)|^(?:这份|这个|该)(?:报告|资料|文件)?是/.test(normalized)) return null;

  const nonAssistantMembers = members.filter((member) =>
    member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant")
  );
  const aliasGroups = nonAssistantMembers
    .filter((member) => member.id !== currentMemberId)
    .map((member) => ({
      member,
      aliases: [
        member.displayName,
        member.relationshipLabel,
        ...(member.householdRoles || []),
        ...(member.relationshipRole === "spouse" ? ["老婆", "媳妇", "媳妇儿", "妻子", "爱人", "老公", "丈夫", "先生"] : [])
      ].filter((value): value is string => Boolean(value?.trim()))
    }));
  const matched = aliasGroups.find(({ aliases }) => aliases.some((alias) => normalized.includes(alias.replace(/\s+/g, ""))));
  if (matched) return matched.member;

  if (/(?:属于|归属|归到|算作|是)(?:我|我的)(?:$|资料|报告|文件)/.test(normalized)) {
    return nonAssistantMembers.find((member) => member.id === currentMemberId) || null;
  }
  return null;
}

function resolveGroupMemberIdsFromText(text: string, members: FamilyMember[], currentMemberId: string) {
  const normalized = text.replace(/[\s@，,、]/g, "");
  const aliasesByMember = members
    .filter((member) => member.id !== currentMemberId && member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant"))
    .map((member) => ({
      aliases: [
        member.displayName,
        member.relationshipLabel,
        ...(member.householdRoles || []),
        ...(member.id === "mom" ? ["妈妈", "老妈", "妈"] : []),
        ...(member.id === "dad" ? ["爸爸", "老爸", "爸"] : []),
        ...(member.id === "sister" ? ["姐姐", "老姐", "姐"] : []),
        ...(member.id === "wife" || member.relationshipRole === "spouse" ? ["老婆", "媳妇", "媳妇儿", "妻子", "爱人"] : [])
      ].filter((value): value is string => Boolean(value?.trim())),
      member
    }));
  return aliasesByMember
    .filter(({ aliases }) => aliases.some((alias) => normalized.includes(alias.replace(/\s+/g, ""))))
    .map(({ member }) => member.id);
}

function stableMemberColor(member?: FamilyMember) {
  if (member?.color) {
    return member.color;
  }

  const seed = member?.id || member?.avatarSeed || "family";
  const colors = ["#2f6f68", "#9b6a42", "#5e6fb2", "#b15d6a", "#6f7f8f"];
  const index = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

function chatMemberBubbleColor(member: FamilyMember, memberIds: string[]) {
  const dopaminePalette = ["#ff5e7a", "#ff9f43", "#f1c40f", "#35bd7f", "#31a8ff", "#6f67ff", "#a855f7", "#e952a8", "#ff7849", "#62c9c2", "#8f7dff", "#ef6a89"];
  const memberIndex = memberIds.indexOf(member.id);

  if (memberIndex >= 0 && memberIndex < dopaminePalette.length) {
    return dopaminePalette[memberIndex];
  }

  const uniqueIndex = memberIndex >= 0 ? memberIndex : memberIds.length;
  const hue = Math.round((17 + uniqueIndex * 137.508) % 360);
  return `hsl(${hue} 78% 58%)`;
}

function formatAssigneeNames(suggestion: AssignmentSuggestion) {
  const names = suggestion.suggestedAssignees.map((assignee) => assignee.displayName);
  return names.length > 0 ? names.join("、") : "家庭整理员";
}

function formatAssigneeMentions(suggestion: AssignmentSuggestion) {
  const names = suggestion.suggestedAssignees.map((assignee) => `@${assignee.displayName}`);
  return names.length > 0 ? names.join("、") : "家庭整理员";
}
