import type { FamilyNotification } from "./notifications";
import { buildTaskReminderNotificationCopy } from "./taskNotificationCopy";
import type { FamilyRecord } from "./types";
import { withAppBasePath } from "./appBasePath";

export const localTaskReminderEventType = "family-task-reminder";
export const firedLocalTaskReminderIdsStorageKey = "family-app.notifications.fired-local-task-reminders-v2";
export const maxFiredLocalTaskReminderIds = 200;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function buildDueLocalTaskReminders(
  records: FamilyRecord[],
  firedIds: ReadonlySet<string>,
  now = Date.now()
): FamilyNotification[] {
  return records.flatMap((record) => {
    if (record.kind !== "task" || record.status === "done" || !record.dueAt) {
      return [];
    }
    const dueAt = new Date(record.dueAt).getTime();
    if (!Number.isFinite(dueAt) || dueAt > now) {
      return [];
    }
    const id = localTaskReminderId(record.id, record.dueAt);
    if (firedIds.has(id)) {
      return [];
    }
    const copy = buildTaskReminderNotificationCopy(record.title);
    return [{
      id,
      type: "task_due" as const,
      title: copy.title,
      body: copy.body,
      deepLink: withAppBasePath(`/?record=${encodeURIComponent(record.id)}`),
      actorMemberId: record.createdByMemberId || null,
      scheduledFor: record.dueAt,
      createdAt: new Date(dueAt).toISOString(),
      readAt: null
    }];
  });
}

export function isTaskOverdue(record: Pick<FamilyRecord, "dueAt" | "status">, now = Date.now()) {
  if (record.status === "done" || !record.dueAt) return false;
  const dueAt = new Date(record.dueAt).getTime();
  return Number.isFinite(dueAt) && dueAt <= now;
}

export function nextLocalTaskReminderDelay(
  records: FamilyRecord[],
  firedIds: ReadonlySet<string>,
  now = Date.now(),
  maximumDelayMs = 30_000
) {
  let nextDueAt = Number.POSITIVE_INFINITY;
  for (const record of records) {
    if (record.kind !== "task" || record.status === "done" || !record.dueAt) continue;
    if (firedIds.has(localTaskReminderId(record.id, record.dueAt))) continue;
    const dueAt = new Date(record.dueAt).getTime();
    if (Number.isFinite(dueAt)) nextDueAt = Math.min(nextDueAt, dueAt);
  }
  if (!Number.isFinite(nextDueAt)) return maximumDelayMs;
  return Math.max(0, Math.min(maximumDelayMs, nextDueAt - now));
}

export function readFiredLocalTaskReminderIds(storage?: StorageLike) {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(firedLocalTaskReminderIdsStorageKey) || "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(-maxFiredLocalTaskReminderIds)
      : [];
  } catch {
    return [];
  }
}

export function writeFiredLocalTaskReminderIds(storage: StorageLike | undefined, ids: Iterable<string>) {
  if (!storage) return;
  storage.setItem(firedLocalTaskReminderIdsStorageKey, JSON.stringify([...ids].slice(-maxFiredLocalTaskReminderIds)));
}

export function requestSystemNotificationPermission() {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") {
    return;
  }
  void Notification.requestPermission().catch(() => undefined);
}

function localTaskReminderId(recordId: string, dueAt: string) {
  return `local-task-due:${recordId}:${dueAt}`;
}
