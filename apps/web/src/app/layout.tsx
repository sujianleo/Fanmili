import type { Metadata, Viewport } from "next";
import { withAppBasePath } from "@/lib/appBasePath";
import { KeyboardViewport } from "@/components/keyboard-viewport";
import { PwaServiceWorker } from "@/components/pwa-service-worker";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Fanmili",
  title: "Fanmili · 家庭生活记录与 AI 协作空间",
  description: "管理个人待办，保存家庭照片与资料，让 AI 帮忙整理。",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Fanmili"
  },
  icons: {
    icon: [
      { url: withAppBasePath("/family-logo-v2-192.png"), sizes: "192x192", type: "image/png" },
      { url: withAppBasePath("/family-logo-v2-512.png"), sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: withAppBasePath("/family-logo-v2-apple-touch.png"), sizes: "180x180", type: "image/png" }]
  },
  other: {
    "apple-mobile-web-app-capable": "yes"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#202321"
};

const developmentCacheResetScript = `
(() => {
  if (!("serviceWorker" in navigator)) return;
  const reloadMarker = "family-app-dev-sw-reset-v1";
  Promise.all([
    navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    ),
    "caches" in window
      ? window.caches.keys().then((keys) =>
          Promise.all(keys.filter((key) => key.startsWith("family-app-pwa-")).map((key) => window.caches.delete(key)))
        )
      : Promise.resolve()
  ]).then(() => {
    if (navigator.serviceWorker.controller && sessionStorage.getItem(reloadMarker) !== "done") {
      sessionStorage.setItem(reloadMarker, "done");
      location.reload();
      return;
    }
    sessionStorage.removeItem(reloadMarker);
  }).catch(() => undefined);
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      {process.env.NODE_ENV !== "production" ? (
        <head><script dangerouslySetInnerHTML={{ __html: developmentCacheResetScript }} /></head>
      ) : null}
      <body>
        <KeyboardViewport />
        <PwaServiceWorker />
        {children}
      </body>
    </html>
  );
}
