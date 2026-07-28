"use client";

import { useEffect, useState } from "react";
import { PWA_INSTALL_REQUEST_EVENT } from "@/lib/pwaInstallRequest";
import { withAppBasePath } from "@/lib/appBasePath";

const DISMISS_STORAGE_KEY = "family-pwa-install-dismissed-until";
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_COLLAPSE_MS = 8_000;

type DeferredInstallPrompt = {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type InstallPreviewMode = "installable" | "ios" | null;

function readLocalPreviewMode(): InstallPreviewMode {
  if (window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost") return null;
  const mode = new URLSearchParams(window.location.search).get("pwa-install-preview");
  return mode === "installable" || mode === "ios" ? mode : null;
}

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function isIosSafari() {
  const iosDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const competingIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(navigator.userAgent);
  return iosDevice && /Safari/i.test(navigator.userAgent) && !competingIosBrowser;
}

function isDismissed() {
  try {
    const dismissedUntil = Number(window.localStorage.getItem(DISMISS_STORAGE_KEY) || 0);
    if (dismissedUntil > Date.now()) return true;
    window.localStorage.removeItem(DISMISS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing; the prompt still works for this visit.
  }
  return false;
}

function InstallGlyph({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "pwa-install-glyph compact" : "pwa-install-glyph"} aria-hidden="true">
      <img src={withAppBasePath("/family-logo-v2-192.png")} alt="" width={compact ? 42 : 48} height={compact ? 42 : 48} />
      <span>
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

export function PwaInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    const previewMode = readLocalPreviewMode();
    if (!previewMode && (!window.isSecureContext || isStandaloneMode() || isDismissed())) return;

    if (previewMode === "ios") {
      setIsIos(true);
      setCanInstall(true);
    } else if (previewMode === "installable") {
      setInstallPrompt({
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: "dismissed", platform: "local-preview" })
      });
      setCanInstall(true);
    }

    const iosSafari = isIosSafari();
    if (!previewMode) {
      setIsIos(iosSafari);
      if (iosSafari) setCanInstall(true);
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as Event & DeferredInstallPrompt);
      setCanInstall(true);
    };
    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setIsVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (!canInstall) return;
    const handleInstallRequest = () => {
      setShowIosSteps(false);
      setIsExpanded(true);
      setIsVisible(true);
    };
    window.addEventListener(PWA_INSTALL_REQUEST_EVENT, handleInstallRequest);
    return () => window.removeEventListener(PWA_INSTALL_REQUEST_EVENT, handleInstallRequest);
  }, [canInstall]);

  useEffect(() => {
    if (!isVisible || !isExpanded || showIosSteps) return;
    const collapseTimer = window.setTimeout(() => setIsExpanded(false), AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(collapseTimer);
  }, [isExpanded, isVisible, showIosSteps]);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now() + DISMISS_DURATION_MS));
    } catch {
      // Keep dismissal scoped to this visit when storage is unavailable.
    }
    setIsVisible(false);
  };

  const install = async () => {
    if (isIos) {
      setShowIosSteps(true);
      return;
    }
    if (!installPrompt) return;

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") {
        setIsVisible(false);
        return;
      }
      setIsExpanded(false);
    } catch {
      setInstallPrompt(null);
      setIsExpanded(false);
    }
  };

  if (!isVisible) return null;

  if (!isExpanded) {
    return (
      <aside className="pwa-install-prompt collapsed" data-platform={isIos ? "ios" : "installable"}>
        <button
          className="pwa-install-fab"
          type="button"
          aria-label="安装 Fanmili"
          onClick={() => setIsExpanded(true)}
        >
          <InstallGlyph compact />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="pwa-install-prompt expanded"
      data-platform={isIos ? "ios" : "installable"}
      aria-label="安装 Fanmili"
    >
      <button className="pwa-install-dismiss" type="button" aria-label="关闭安装提示，七天内不再显示" onClick={dismiss}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {showIosSteps ? (
        <div className="pwa-install-ios-steps" role="dialog" aria-label="添加到主屏幕步骤">
          <div className="pwa-install-title-row">
            <InstallGlyph />
            <div>
              <strong>添加到主屏幕</strong>
              <span>在 Safari 中完成以下两步</span>
            </div>
          </div>
          <ol>
            <li><span aria-hidden="true">1</span>点击浏览器底部的“分享”按钮</li>
            <li><span aria-hidden="true">2</span>选择“添加到主屏幕”，再点“添加”</li>
          </ol>
          <button className="pwa-install-secondary" type="button" onClick={() => setShowIosSteps(false)}>返回</button>
        </div>
      ) : (
        <>
          <div className="pwa-install-title-row">
            <InstallGlyph />
            <div>
              <strong>安装 Fanmili</strong>
              <span>像 App 一样打开，及时收到家庭提醒</span>
            </div>
          </div>
          <button className="pwa-install-primary" type="button" onClick={() => void install()}>
            {isIos ? "查看添加步骤" : "添加到桌面"}
          </button>
        </>
      )}
    </aside>
  );
}
