"use client";

import { useEffect, useMemo, useState } from "react";
import { familyFetch } from "@/lib/familyApi";
import { appScope, withAppBasePath } from "@/lib/appBasePath";
import type { NotificationPlatform } from "@/lib/notifications";
import { describeNotificationStatus, type NotificationPermissionState } from "@/lib/notificationPush";

export function NotificationSystemSettings() {
  const [permission, setPermission] = useState<NotificationPermissionState>("default");
  const [pushSupported, setPushSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const platform = useMemo<NotificationPlatform>(() => detectPlatform(), []);
  const iosNeedsInstall = platform === "ios_pwa" && typeof window !== "undefined" && !window.matchMedia("(display-mode: standalone)").matches;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

  useEffect(() => {
    const supported = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
    setPushSupported(supported);
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
    setTestSent(localStorage.getItem(systemNotificationTestKey) === "sent");
    if (Notification.permission !== "granted") {
      return;
    }
    void navigator.serviceWorker.getRegistration(appScope())
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setSubscribed(Boolean(subscription)))
      .catch(() => setSubscribed(false));
  }, []);

  async function registerCurrentDevice() {
    if (!pushSupported || iosNeedsInstall) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setMessage("系统通知权限未开启，请在浏览器或系统设置中允许通知。");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const sentTestNow = await showFirstSystemNotificationTest(registration);
      if (sentTestNow) setTestSent(true);
      if (!publicKey) {
        setMessage(sentTestNow ? "测试通知已发送。" : "通知已开启。");
        return;
      }
      // An existing subscription may have been created with an older VAPID
      // public key. Reusing it makes the registration API succeed while the
      // push service rejects every delivery. An explicit registration action
      // must therefore replace the browser subscription as well as the row on
      // the server.
      const existingSubscription = await registration.pushManager.getSubscription();
      if (existingSubscription) await existingSubscription.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
      });
      const json = subscription.toJSON();
      const response = await familyFetch("/api/notification-endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: getDeviceId(),
          platform,
          subscription: { endpoint: json.endpoint, keys: json.keys }
        })
      });
      if (!response.ok) {
        throw new Error(await readResponseDetail(response, "订阅保存失败，请稍后重试。"));
      }
      setSubscribed(true);
      const backgroundTestSent = await sendFirstBackgroundPushTest();
      setMessage(backgroundTestSent ? "后台通知测试已发送。" : sentTestNow ? "测试通知已发送。" : "通知已开启。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "系统通知订阅失败，App 内通知仍可使用。");
    } finally {
      setBusy(false);
    }
  }

  const status = describeNotificationStatus({ iosNeedsInstall, permission, publicKey, pushSupported, subscribed });
  const canRegister = pushSupported && !iosNeedsInstall && permission !== "denied" && (Boolean(publicKey) || permission !== "granted" || !testSent);

  return (
    <div className="notification-settings-card">
      <div>
        <strong>{status.title}</strong>
        <p>{status.description}</p>
      </div>
      {canRegister ? (
        <button className="avatar-upload-button" disabled={busy} type="button" onClick={() => void registerCurrentDevice()}>
          {busy ? "处理中…" : subscribed ? "重新注册" : permission === "granted" && publicKey ? "注册此设备" : permission === "granted" ? "发送测试通知" : "开启系统通知"}
        </button>
      ) : null}
      {message ? <p className="notification-settings-message" role="status">{message}</p> : null}
    </div>
  );
}

const systemNotificationTestKey = "family-app.system-notification-test-v1";

async function showFirstSystemNotificationTest(registration: ServiceWorkerRegistration) {
  if (localStorage.getItem(systemNotificationTestKey) === "sent") return false;
  await registration.showNotification("🎉 Fanmili 已就位", {
    body: "以后该喝水、下班、拿快递，我都会准时敲敲你。",
    icon: withAppBasePath("/family-logo-v2-192.png"),
    badge: withAppBasePath("/family-logo-v2-192.png"),
    tag: "family-notification-first-test",
    data: { id: "first-test", deepLink: "/" }
  });
  localStorage.setItem(systemNotificationTestKey, "sent");
  return true;
}

function detectPlatform(): NotificationPlatform {
  if (typeof navigator === "undefined") return "desktop_pwa";
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(value)) return "ios_pwa";
  if (/android/.test(value)) return "android_pwa";
  return "desktop_pwa";
}

function getDeviceId() {
  const key = "family-app.notification-device-id";
  const current = localStorage.getItem(key);
  if (current) return current;
  const next = crypto.randomUUID();
  localStorage.setItem(key, next);
  return next;
}

async function sendFirstBackgroundPushTest() {
  const key = "family-app.background-notification-test-v1";
  if (localStorage.getItem(key) === "sent") return false;
  const response = await familyFetch("/api/notification-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: getDeviceId() })
  });
  if (!response.ok) throw new Error(await readResponseDetail(response, "后台测试通知发送失败，请稍后重试。"));
  localStorage.setItem(key, "sent");
  return true;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function readResponseDetail(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: unknown };
    return typeof body.detail === "string" && body.detail ? body.detail : fallback;
  } catch {
    return fallback;
  }
}
