"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { clearStoredNetworkAddressesOnce } from "@/lib/clientPrivacyMigrations";
import { familyFetch } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import styles from "./onboarding-gate.module.css";

const onboardingStorageKey = "family-app.onboarding.v1";
const settingsStorageKey = "family-app.settings.v1";

type OnboardingStep = "welcome" | "network" | "ai" | "install";
type ThemeFamily = "mono" | "dopamine";
type InstallPlatform = "ios" | "android" | "desktop";
type OnboardingProviderKind = "deepseek" | "kimi" | "qwen" | "zhipu" | "volcengine" | "hunyuan" | "gemini" | "anthropic" | "openai";

const onboardingProviderPresets: Array<{
  deepModel: string;
  endpoint: string;
  fastModel: string;
  kind: OnboardingProviderKind;
  label: string;
}> = [
  { kind: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com", deepModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash" },
  { kind: "kimi", label: "Kimi", endpoint: "https://api.moonshot.cn/v1", deepModel: "kimi-k2.7-code", fastModel: "kimi-k2.7-code-highspeed" },
  { kind: "qwen", label: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", deepModel: "qwen3.7-max", fastModel: "qwen3.6-flash" },
  { kind: "zhipu", label: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", deepModel: "glm-5.2", fastModel: "glm-4.7-flashx" },
  { kind: "volcengine", label: "火山方舟", endpoint: "https://ark.cn-beijing.volces.com/api/v3", deepModel: "doubao-seed-2-0-pro-260215", fastModel: "doubao-seed-2-0-lite-260215" },
  { kind: "hunyuan", label: "腾讯混元", endpoint: "https://api.hunyuan.cloud.tencent.com/v1", deepModel: "hunyuan-turbos-latest", fastModel: "hunyuan-lite" },
  { kind: "gemini", label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", deepModel: "gemini-3.1-pro-preview", fastModel: "gemini-3.5-flash" },
  { kind: "anthropic", label: "Anthropic Claude", endpoint: "https://api.anthropic.com/v1", deepModel: "claude-opus-4-7", fastModel: "claude-sonnet-4-6" },
  { kind: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", deepModel: "gpt-5.2", fastModel: "gpt-5-mini" }
];

type StoredSettings = {
  activeNetwork?: "internet" | "local" | null;
  lanIp?: string;
  lanPort?: string;
  networkMode?: "internet" | "local" | "auto";
  providers?: Array<Record<string, unknown>>;
  serverPort?: string;
  serverUrl?: string;
  themeFamily?: ThemeFamily;
  [key: string]: unknown;
};

export function OnboardingGate({ children }: { children: ReactNode }) {
  const isLite = process.env.NEXT_PUBLIC_FAMILY_APP_BACKEND === "sqlite";
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [publicDomain, setPublicDomain] = useState("");
  const [lanAddress, setLanAddress] = useState("");
  const [lanPort, setLanPort] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [themeFamily, setThemeFamily] = useState<ThemeFamily>("mono");
  const [providerKind, setProviderKind] = useState<OnboardingProviderKind>("deepseek");
  const [installPlatform, setInstallPlatform] = useState<InstallPlatform>("desktop");

  useEffect(() => {
    let cancelled = false;
    setInstallPlatform(detectInstallPlatform());
    try {
      clearStoredNetworkAddressesOnce(window.localStorage);
      const storedSettings = JSON.parse(window.localStorage.getItem(settingsStorageKey) || "{}") as StoredSettings;
      const storedThemeFamily = storedSettings.themeFamily === "dopamine" ? "dopamine" : "mono";
      const storedProviderKind = storedSettings.providers?.find((provider) =>
        onboardingProviderPresets.some((preset) => preset.kind === provider.kind)
      )?.kind;
      setThemeFamily(storedThemeFamily);
      if (typeof storedProviderKind === "string") setProviderKind(storedProviderKind as OnboardingProviderKind);
      applyThemeFamily(storedThemeFamily);
      const onboarding = JSON.parse(window.localStorage.getItem(onboardingStorageKey) || "null") as { completed?: boolean } | null;
      if (onboarding?.completed) {
        setReady(true);
        return;
      }
      setPublicDomain(resolveInitialPublicDomain(storedSettings.serverUrl));
      setLanAddress(resolveInitialLanAddress(storedSettings.lanIp));
      setLanPort(normalizePort(storedSettings.lanPort) || "3001");
    } catch {
      setPublicDomain(resolveInitialPublicDomain());
      setLanAddress(resolveInitialLanAddress());
      setLanPort("3001");
    }

    void familyFetch("/api/network-defaults", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<NetworkDefaults> : null)
      .then((defaults) => {
        if (!defaults || cancelled) return;
        setPublicDomain((current) => current || normalizePublicDomain(defaults.publicDomain || ""));
        setLanAddress((current) => normalizeLanAddress(defaults.lanAddress || "") || current);
        setLanPort((current) => normalizePort(defaults.servicePort) || current || "3001");
      })
      .catch(() => null);

    return () => {
      cancelled = true;
    };
  }, []);

  if (ready) return <>{children}</>;

  function continueFromNetwork(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = normalizePublicDomain(publicDomain);
    setPublicDomain(domain);
    setLanAddress(normalizeLanAddress(lanAddress));
    setStep("ai");
  }

  async function completeOnboarding() {
    const publicTarget = parsePublicTarget(publicDomain);
    const normalizedLan = normalizeLanAddress(lanAddress);
    let storedSettings: StoredSettings = {};
    try {
      storedSettings = JSON.parse(window.localStorage.getItem(settingsStorageKey) || "{}") as StoredSettings;
    } catch {
      storedSettings = {};
    }

    const providers = upsertAiProvider(storedSettings.providers, providerKind, apiKey.trim());
    if (isLite && providerKind === "deepseek" && apiKey.trim()) {
      await familyFetch("/api/ai-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          deepModel: "deepseek-v4-pro",
          fastModel: "deepseek-v4-flash"
        })
      }).catch(() => null);
    }
    window.localStorage.setItem(settingsStorageKey, JSON.stringify({
      ...storedSettings,
      activeNetwork: publicTarget.host ? "internet" : normalizedLan ? "local" : null,
      lanIp: normalizedLan,
      lanPort: normalizePort(lanPort) || "3001",
      networkMode: "auto",
      providers,
      serverPort: publicTarget.port,
      serverUrl: publicTarget.host,
      themeFamily
    }));
    window.localStorage.setItem(onboardingStorageKey, JSON.stringify({
      aiConfigured: Boolean(apiKey.trim()),
      completed: true,
      completedAt: new Date().toISOString(),
      lanAddress: normalizedLan,
      publicDomain: publicTarget.host
    }));
    setReady(true);
  }

  return (
    <main className={`${styles.shell} ${themeFamily === "dopamine" ? styles.dopamine : ""}`.trim()}>
      <section aria-label="新用户引导" className={styles.card}>
        {step === "welcome" ? (
          <div className={styles.welcome}>
            <Brand className={styles.welcomeBrand} isLite={isLite} />
            <div aria-label="选择配色" className={styles.themeChoice} role="group">
              <button
                aria-pressed={themeFamily === "mono"}
                className={themeFamily === "mono" ? styles.themeSelected : ""}
                onClick={() => selectThemeFamily("mono")}
                type="button"
              >
                <i aria-hidden="true" className={styles.monoSwatch} />
                黑白配
              </button>
              <button
                aria-pressed={themeFamily === "dopamine"}
                className={themeFamily === "dopamine" ? styles.themeSelected : ""}
                onClick={() => selectThemeFamily("dopamine")}
                type="button"
              >
                <i aria-hidden="true" className={styles.dopamineSwatch} />
                多巴胺
              </button>
            </div>
            <button className={styles.primary} onClick={() => setStep("network")} type="button">开始</button>
          </div>
        ) : null}

        {step === "network" ? (
          <form className={styles.form} onSubmit={continueFromNetwork}>
            <StepHeader current={1} title="设置访问地址" />
            <label className={styles.field}>
              <span>公网地址</span>
              <input autoCapitalize="none" autoCorrect="off" onChange={(event) => setPublicDomain(event.target.value)} placeholder="family.example.com" spellCheck={false} value={publicDomain} />
            </label>
            <label className={styles.field}>
              <span>局域网地址 <em>可修改</em></span>
              <input autoCapitalize="none" autoCorrect="off" onChange={(event) => setLanAddress(event.target.value)} placeholder="192.168.1.100" spellCheck={false} value={lanAddress} />
            </label>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setStep("welcome")} type="button">返回</button>
              <button className={styles.primary} type="submit">下一步</button>
            </div>
          </form>
        ) : null}

        {step === "ai" ? (
          <div className={styles.form}>
            <StepHeader current={2} title="连接 AI" description="可选，稍后也能设置。" />
            <label className={styles.field}>
              <span>AI 提供商</span>
              <select aria-label="AI 提供商" onChange={(event) => {
                setProviderKind(event.target.value as OnboardingProviderKind);
                setApiKey("");
              }} value={providerKind}>
                {onboardingProviderPresets.map((provider) => <option key={provider.kind} value={provider.kind}>{provider.label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>{onboardingProviderPresets.find((provider) => provider.kind === providerKind)?.label} API Key <em>可选</em></span>
              <input autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="sk-••••••••" type="password" value={apiKey} />
              <small>{isLite ? "加密保存在这台设备的 Fanmili 数据库中。" : "仅保存在当前浏览器。"}</small>
            </label>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setStep("network")} type="button">返回</button>
              <button className={styles.primary} onClick={() => setStep("install")} type="button">下一步</button>
            </div>
          </div>
        ) : null}

        {step === "install" ? (
          <div className={styles.form}>
            <StepHeader current={3} title="添加到桌面" description="可选，随时可以完成。" />
            <div className={styles.installGuide}>
              <strong>{installPlatformCopy[installPlatform].label}</strong>
              <p>{installPlatformCopy[installPlatform].instruction}</p>
            </div>
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setStep("ai")} type="button">返回</button>
              <button className={styles.primary} onClick={() => void completeOnboarding()} type="button">进入家庭空间</button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );

  function selectThemeFamily(nextThemeFamily: ThemeFamily) {
    setThemeFamily(nextThemeFamily);
    applyThemeFamily(nextThemeFamily);
  }
}

function Brand({ className = "", isLite = false }: { className?: string; isLite?: boolean }) {
  return (
    <header className={`${styles.brand} ${className}`.trim()}>
      <Image alt="Fanmili" className={styles.logo} height={72} priority src={withAppBasePath("/family-logo-v2.png")} width={72} />
      <div>
        <small>{isLite ? "Fanmili · 数据保存在本机" : "用心记录 · 守护家庭"}</small>
      </div>
    </header>
  );
}

function StepHeader({ current, description, title }: { current: 1 | 2 | 3; description?: string; title: string }) {
  return (
    <header className={styles.stepHeader}>
      <div aria-label={`设置进度 ${current}/3`} className={styles.progress}>
        {[1, 2, 3].map((step) => <i aria-current={current === step ? "step" : undefined} className={current >= step ? styles.active : ""} key={step} />)}
      </div>
      <p className={styles.eyebrow}>{current} / 3</p>
      <h1>{title}</h1>
      {description ? <p className={styles.lead}>{description}</p> : null}
    </header>
  );
}

const installPlatformCopy: Record<InstallPlatform, { instruction: string; label: string }> = {
  ios: {
    label: "iPhone / iPad",
    instruction: "在 Safari 中点分享按钮，再选择“添加到主屏幕”。"
  },
  android: {
    label: "Android",
    instruction: "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。"
  },
  desktop: {
    label: "电脑",
    instruction: "点击地址栏右侧的安装图标，再选择“安装”。"
  }
};

function detectInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent;
  if (/iPad|iPhone|iPod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

function normalizePublicDomain(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).host;
  } catch {
    return "";
  }
}

type NetworkDefaults = {
  lanAddress?: string;
  publicDomain?: string;
  servicePort?: string;
};

function resolveInitialPublicDomain(storedPublicDomain = "") {
  const stored = normalizePublicDomain(storedPublicDomain);
  if (stored) return stored;
  const hostname = window.location.hostname;
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || isPrivateIpv4Address(hostname)) return "";
  return window.location.host;
}

function normalizePort(value = "") {
  const normalized = value.trim();
  if (!/^\d{1,5}$/.test(normalized)) return "";
  const port = Number(normalized);
  return port >= 1 && port <= 65535 ? String(port) : "";
}

function applyThemeFamily(themeFamily: ThemeFamily) {
  const root = document.documentElement;
  root.dataset.visualTheme = themeFamily;
  root.dataset.colorScheme ||= window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function normalizeLanAddress(value: string) {
  return value.trim().replace(/^https?:\/\//i, "").split("/")[0] || "";
}

function resolveInitialLanAddress(storedLanAddress = "") {
  const stored = normalizeLanAddress(storedLanAddress);
  if (stored) return stored;
  const built = normalizeLanAddress(process.env.NEXT_PUBLIC_FAMILY_APP_LAN_ADDRESS || "");
  if (built) return built;
  return isPrivateIpv4Address(window.location.hostname) ? window.location.hostname : "";
}

function isPrivateIpv4Address(hostname: string) {
  const segments = hostname.split(".").map(Number);
  if (segments.length !== 4 || segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) return false;
  return segments[0] === 10
    || (segments[0] === 100 && segments[1] >= 64 && segments[1] <= 127)
    || segments[0] === 127
    || (segments[0] === 172 && segments[1] >= 16 && segments[1] <= 31)
    || (segments[0] === 192 && segments[1] === 168);
}

function parsePublicTarget(value: string) {
  if (!value.trim()) return { host: "", port: "" };
  const target = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return { host: target.hostname, port: target.port || (target.protocol === "http:" ? "80" : "443") };
}

function upsertAiProvider(providers: Array<Record<string, unknown>> | undefined, providerKind: OnboardingProviderKind, apiKey: string) {
  const next = Array.isArray(providers) ? [...providers] : [];
  const preset = onboardingProviderPresets.find((provider) => provider.kind === providerKind) || onboardingProviderPresets[0];
  const existing = next.find((item) => item.id === providerKind || item.kind === providerKind);
  const provider = {
    ...existing,
    apiKey: apiKey || (typeof existing?.apiKey === "string" ? existing.apiKey : ""),
    deepModel: preset.deepModel,
    endpoint: preset.endpoint,
    fastModel: preset.fastModel,
    id: preset.kind,
    kind: preset.kind,
    name: preset.label,
    status: apiKey ? "connected" : existing?.status || "failed"
  };
  const index = next.findIndex((item) => item.id === providerKind || item.kind === providerKind);
  if (index >= 0) next[index] = { ...next[index], ...provider };
  else next.unshift(provider);
  return next;
}
