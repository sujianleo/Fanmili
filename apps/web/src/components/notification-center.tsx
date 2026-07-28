"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { FamilyMember } from "@/lib/types";
import { familyFetch } from "@/lib/familyApi";
import { appScope, withAppBasePath } from "@/lib/appBasePath";
import { useHomeDrawerSwipe } from "@/lib/homeDrawerGesture";
import type { FamilyNotification } from "@/lib/notifications";
import { buildNotificationPresentation } from "@/lib/notificationPresentation";
import { mergeDismissedNotificationIds, readDismissedNotificationIds, writeDismissedNotificationIds } from "@/lib/notificationPopup";
import { localTaskReminderEventType } from "@/lib/localTaskReminders";
import { familyRecordStatusChangedEventType } from "@/lib/records";
import { usePageScrollLock } from "@/lib/pageScrollLock";
import { AvatarImage } from "./avatar";

const notificationRefreshIntervalMs = 5_000;
const notificationReceivedMessageType = "family-notification-received";
const notificationOpenMessageType = "family-notification-open";

export function NotificationCenter({ members }: { members: FamilyMember[] }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FamilyNotification[]>([]);
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const dismissedIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const response = await familyFetch("/api/notifications?limit=50", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readResponseDetail(response, "通知刷新失败，请稍后重试。"));
      }
      const data = await response.json() as { notifications?: FamilyNotification[]; unreadCount?: number };
      const notifications = data.notifications || [];
      setItems(notifications);
      setMessage("");

      const unreadCount = data.unreadCount ?? notifications.filter((item) => !item.readAt).length;
      const nav = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      if (unreadCount > 0) void nav.setAppBadge?.(unreadCount); else void nav.clearAppBadge?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "通知刷新失败，请稍后重试。");
    }
  }, []);

  const dismissForSession = useCallback(() => {
    dismissedIdsRef.current = new Set(mergeDismissedNotificationIds(
      dismissedIdsRef.current,
      items.filter((item) => !item.readAt).map((item) => item.id)
    ));
    writeDismissedNotificationIds(window.sessionStorage, dismissedIdsRef.current);
    setMessage("");
    setOpen(false);
  }, [items]);

  const drawer = useHomeDrawerSwipe({
    side: "right",
    open,
    onOpen: () => {
      setOpen(true);
      setMessage("");
      void refresh();
    },
    onClose: dismissForSession
  });
  usePageScrollLock(open);

  useEffect(() => {
    dismissedIdsRef.current = new Set(readDismissedNotificationIds(window.sessionStorage));
    void refresh();
    const timer = window.setInterval(() => void refresh(), notificationRefreshIntervalMs);
    const handleFocus = () => void refresh();
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === "object" && event.data.type === notificationReceivedMessageType) {
        void refresh();
      } else if (event.data && typeof event.data === "object" && event.data.type === notificationOpenMessageType) {
        const id = typeof event.data.id === "string" ? event.data.id : "";
        const deepLink = typeof event.data.deepLink === "string" ? event.data.deepLink : "/";
        void (async () => {
          if (id) await patchReadState({ id }).catch(() => undefined);
          setOpen(false);
          replaceNotificationLocation(deepLink);
        })();
      }
    };
    const handleLocalTaskReminder = (event: Event) => {
      const item = (event as CustomEvent<FamilyNotification>).detail;
      if (!item?.id || item.type !== "task_due") return;
      setItems((current) => [item, ...current.filter((notification) => notification.id !== item.id)]);
      void showLocalSystemNotificationFallback(item);
    };
    const handleRecordStatusChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: unknown; status?: unknown }>).detail;
      if (typeof detail?.id !== "string" || detail.status !== "done") return;
      setItems((current) => current.filter((item) => notificationRecordId(item.deepLink) !== detail.id));
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener(localTaskReminderEventType, handleLocalTaskReminder);
    window.addEventListener(familyRecordStatusChangedEventType, handleRecordStatusChanged);
    navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener(localTaskReminderEventType, handleLocalTaskReminder);
      window.removeEventListener(familyRecordStatusChangedEventType, handleRecordStatusChanged);
      navigator.serviceWorker?.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismissForSession();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dismissForSession, open]);

  async function openNotification(item: FamilyNotification) {
    setMessage("");
    setOpen(false);
    replaceNotificationLocation(item.deepLink || "/");
    if (!item.readAt) {
      setPendingAction(item.id);
      try {
        await patchReadState({ id: item.id });
        const readAt = new Date().toISOString();
        setItems((current) => current.map((notification) => notification.id === item.id ? { ...notification, readAt } : notification));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "通知标记失败，请稍后重试。");
      }
    }
    setPendingAction(null);
  }

  async function clearAllNotifications() {
    setMessage("");
    setPendingAction("__clear__");
    const previousItems = items;
    dismissedIdsRef.current = new Set(mergeDismissedNotificationIds(dismissedIdsRef.current, previousItems.map((item) => item.id)));
    writeDismissedNotificationIds(window.sessionStorage, dismissedIdsRef.current);
    setItems([]);
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    void nav.clearAppBadge?.();
    try {
      const response = await familyFetch("/api/notifications", { method: "DELETE" });
      if (!response.ok) throw new Error(await readResponseDetail(response, "通知清除失败，请稍后重试。"));
    } catch (error) {
      setItems(previousItems);
      setMessage(error instanceof Error ? error.message : "通知清除失败，请稍后重试。");
    } finally {
      setPendingAction(null);
    }
  }

  async function retryNotifications() {
    setPendingAction("__refresh__");
    await refresh();
    setPendingAction(null);
  }

  return (
    <div
      className={`notification-backdrop${drawer.active ? " active" : ""}${open ? " open" : ""}${drawer.dragging ? " dragging" : ""}`}
      aria-hidden={!drawer.active}
      data-home-drawer-layer
      style={drawer.layerStyle}
    >
      <button aria-hidden="true" className="notification-scrim" onClick={dismissForSession} tabIndex={-1} type="button" />
      <section
        className="notification-panel"
        data-home-drawer-panel="right"
        role="dialog"
        aria-label="家庭提醒流"
        aria-modal="true"
      >
        <div className="notification-panel-body">
          {message ? (
            <section className="notification-status-card" role="alert">
              <span className="notification-status-mark" aria-hidden="true">!</span>
              <div>
                <strong>暂时无法更新提醒</strong>
                <p>{message}</p>
              </div>
              <button disabled={pendingAction !== null} type="button" onClick={() => void retryNotifications()}>
                {pendingAction === "__refresh__" ? "刷新中…" : "重试"}
              </button>
            </section>
          ) : null}
          {items.length === 0 ? (
            <section className="notification-empty" aria-label="暂无家庭提醒">
              <strong>暂无</strong>
            </section>
          ) : <div className="notification-list">
            <div className="notification-list-group">
              {items.map((item, index) => {
                const presentation = buildNotificationPresentation(item, members);
                return (
                  <button
                    className={`notification-item ${item.readAt ? "read" : "unread"}`}
                    disabled={pendingAction !== null}
                    key={item.id}
                    style={{ "--notification-index": index } as CSSProperties}
                    type="button"
                    onClick={() => void openNotification(item)}
                  >
                    <span className={`notification-avatar ${presentation.state}`} aria-hidden="true">
                      <AvatarImage alt="" label={presentation.member.displayName} seed={presentation.member.id || presentation.member.avatarSeed} />
                    </span>
                    <span className="notification-item-copy">
                      <strong>{presentation.title}</strong>
                    </span>
                    <span className="notification-item-side"><time>{formatNotificationTime(item.createdAt)}</time></span>
                  </button>
                );
              })}
            </div>
            <button aria-label="一键清除通知" className="notification-clear" disabled={pendingAction !== null} type="button" onClick={() => void clearAllNotifications()}>
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>}
        </div>
      </section>
    </div>
  );
}

async function showLocalSystemNotificationFallback(item: FamilyNotification) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(appScope()) || await navigator.serviceWorker.ready;
  if (await registration.pushManager?.getSubscription().catch(() => null)) return;
  await registration.showNotification(item.title, {
    body: item.body,
    icon: withAppBasePath("/family-logo-v2-192.png"),
    badge: withAppBasePath("/family-logo-v2-192.png"),
    tag: item.id,
    data: { id: item.id, deepLink: item.deepLink }
  });
}

function notificationRecordId(deepLink: string) {
  try {
    return new URL(deepLink || "/", window.location.origin).searchParams.get("record");
  } catch {
    return null;
  }
}

function replaceNotificationLocation(deepLink: string) {
  const target = new URL(deepLink || "/", window.location.origin);
  if (target.origin !== window.location.origin) return;
  const targetLocation = `${target.pathname}${target.search}${target.hash}`;
  if (target.pathname === "/" && target.searchParams.has("record")) {
    window.history.replaceState(window.history.state, "", targetLocation);
    window.dispatchEvent(new Event("family-record-deep-link"));
    return;
  }
  const current = new URL(window.location.href);
  if (current.pathname === target.pathname && current.search === target.search && current.hash === target.hash) return;
  window.location.replace(targetLocation);
}

async function patchReadState(body: { id: string } | { all: true }) {
  const response = await familyFetch("/api/notifications", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await readResponseDetail(response, "通知标记失败，请稍后重试。"));
  }
}

async function readResponseDetail(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: unknown };
    return typeof body.detail === "string" && body.detail ? body.detail : fallback;
  } catch {
    return fallback;
  }
}

function formatNotificationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
