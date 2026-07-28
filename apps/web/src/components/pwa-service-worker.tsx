"use client";

import { useEffect } from "react";
import { appScope, withAppBasePath } from "@/lib/appBasePath";

const refreshAppShellMessage = { type: "family-refresh-app-shell" } as const;

export function refreshPwaAppShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      (navigator.serviceWorker.controller || registration.active)?.postMessage(refreshAppShellMessage);
    })
    .catch(() => undefined);
}

export function PwaServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then(async () => {
          if (!("caches" in window)) return;
          const keys = await window.caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("family-app-pwa-")).map((key) => window.caches.delete(key)));
        })
        .catch(() => undefined);
      return;
    }

    const registerServiceWorker = () => {
      void navigator.serviceWorker.register(withAppBasePath("/sw.js"), { scope: appScope(), updateViaCache: "none" })
        .then(async (registration) => {
          await registration.update();
          refreshPwaAppShell();
        })
        .catch(() => undefined);
    };

    if (document.readyState === "complete") {
      registerServiceWorker();
      return;
    }

    window.addEventListener("load", registerServiceWorker, { once: true });
    return () => window.removeEventListener("load", registerServiceWorker);
  }, []);

  return null;
}
