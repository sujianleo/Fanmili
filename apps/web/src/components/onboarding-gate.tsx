"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { clearStoredNetworkAddressesOnce } from "@/lib/clientPrivacyMigrations";
import { familyFetch } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import styles from "./onboarding-gate.module.css";

const onboardingStorageKey = "family-app.onboarding.v1";
const settingsStorageKey = "family-app.settings.v1";
const trialPublicHost = "fanmili.superjunior.online";

type OnboardingStep = "welcome" | "network" | "ai" | "install";
type ThemeFamily = "mono" | "dopamine";
type InstallPlatform = "ios" | "android" | "desktop";
type OnboardingProviderKind = "deepseek";
type VerificationState = "idle" | "testing" | "passed" | "failed";

const onboardingProviderPresets: Array<{
  deepModel: string;
  endpoint: string;
  fastModel: string;
  kind: OnboardingProviderKind;
  label: string;
}> = [
  { kind: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com", deepModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash" }
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

export function OnboardingGate({ children, trialMode = false }: { children: ReactNode; trialMode?: boolean }) {
  const isLite = process.env.NEXT_PUBLIC_FAMILY_APP_BACKEND === "sqlite";
  const [ready, setReady] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [publicDomain, setPublicDomain] = useState("");
  const [networkMessage, setNetworkMessage] = useState("");
  const [lanAddress, setLanAddress] = useState("");
  const [lanPort, setLanPort] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [aiVerification, setAiVerification] = useState<VerificationState>("idle");
  const [aiMessage, setAiMessage] = useState("");
  const [themeFamily, setThemeFamily] = useState<ThemeFamily>("mono");
  const [installPlatform, setInstallPlatform] = useState<InstallPlatform>("desktop");
  const providerKind: OnboardingProviderKind = "deepseek";
  const usingTrialDomain = isTrialPublicDomain(publicDomain);

  useEffect(() => {
    if (trialMode) {
      setReady(true);
      setInitializing(false);
      return;
    }
    let cancelled = false;
    let initialPublicDomain = "";
    let storedSettingsSnapshot: StoredSettings = {};
    let storedThemeFamilySnapshot: ThemeFamily = "mono";
    setInstallPlatform(detectInstallPlatform());
    try {
      clearStoredNetworkAddressesOnce(window.localStorage);
      const storedSettings = JSON.parse(window.localStorage.getItem(settingsStorageKey) || "{}") as StoredSettings;
      const storedThemeFamily = storedSettings.themeFamily === "dopamine" ? "dopamine" : "mono";
      storedSettingsSnapshot = storedSettings;
      storedThemeFamilySnapshot = storedThemeFamily;
      setThemeFamily(storedThemeFamily);
      applyThemeFamily(storedThemeFamily);
      const onboarding = JSON.parse(window.localStorage.getItem(onboardingStorageKey) || "null") as { completed?: boolean } | null;
      if (onboarding?.completed) {
        setReady(true);
        return;
      }
      initialPublicDomain = resolveInitialPublicDomain(storedSettings.serverUrl);
      setPublicDomain(initialPublicDomain);
      setLanAddress(resolveInitialLanAddress(storedSettings.lanIp));
      setLanPort(normalizePort(storedSettings.lanPort) || "3001");
      if (completeTrialOnboarding(window.localStorage, storedSettings, storedThemeFamily, initialPublicDomain)) {
        setReady(true);
        return;
      }
    } catch {
      initialPublicDomain = resolveInitialPublicDomain();
      setPublicDomain(initialPublicDomain);
      setLanAddress(resolveInitialLanAddress());
      setLanPort("3001");
      if (completeTrialOnboarding(window.localStorage, {}, "mono", initialPublicDomain)) {
        setReady(true);
        return;
      }
    }

    void familyFetch("/api/network-defaults", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<NetworkDefaults> : null)
      .then((defaults) => {
        if (cancelled) return;
        if (!defaults) {
          setInitializing(false);
          return;
        }
        const defaultPublicDomain = normalizePublicDomain(defaults.publicDomain || "");
        const nextPublicDomain = initialPublicDomain || defaultPublicDomain;
        setPublicDomain(nextPublicDomain);
        setLanAddress((current) => normalizeLanAddress(defaults.lanAddress || "") || current);
        setLanPort((current) => normalizePort(defaults.servicePort) || current || "3001");
        if (completeTrialOnboarding(window.localStorage, storedSettingsSnapshot, storedThemeFamilySnapshot, nextPublicDomain)) setReady(true);
        else setInitializing(false);
      })
      .catch(() => {
        if (!cancelled) setInitializing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [trialMode]);

  if (ready) return <>{children}</>;
  if (initializing) return null;

  function continueFromNetwork(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const domain = normalizePublicDomain(publicDomain);
    setPublicDomain(domain);
    if (!domain) {
      setNetworkMessage("请填写可直接打开的 HTTPS 公网地址；飞牛远程地址和局域网地址不能使用。");
      return;
    }
    setNetworkMessage("");
    setLanAddress(normalizeLanAddress(lanAddress));
    setStep("ai");
  }

  async function verifyAiAndContinue() {
    const key = apiKey.trim();
    if (!key || aiVerification === "testing") return;
    const preset = onboardingProviderPresets[0];
    setAiVerification("testing");
    setAiMessage("正在验证 API，请稍候…");
    try {
      const response = await familyFetch("/api/ai-tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: key,
          endpoint: preset.endpoint,
          kind: preset.kind,
          model: preset.fastModel
        })
      });
      const payload = await response.json().catch(() => ({})) as { detail?: string; profile?: unknown };
      if (!response.ok || !payload.profile) throw new Error(payload.detail || "API 验证失败，请检查 Key 后重试。");
      setAiVerification("passed");
      setAiMessage("API 已连接，可以继续。");
      setStep("install");
    } catch (error) {
      setAiVerification("failed");
      setAiMessage(error instanceof Error ? error.message : "API 验证失败，请检查 Key 后重试。");
    }
  }

  async function completeOnboarding() {
    const publicTarget = parsePublicTarget(publicDomain);
    if (!publicTarget.host || !apiKey.trim() || aiVerification !== "passed") {
      setStep(publicTarget.host ? "ai" : "network");
      return;
    }
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
            <div className={styles.requirements}>
              <strong>{usingTrialDomain ? "公开试用版已准备好" : "开始前请准备"}</strong>
              <span>{usingTrialDomain ? "使用 Fanmili 提供的公开试用服务" : "你自己的 Fanmili 公网地址"}</span>
              <span>{usingTrialDomain ? "以后可在设置中切换到自己的 NAS" : "可用的 DeepSeek API Key"}</span>
            </div>
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
            <StepHeader
              current={1}
              title={usingTrialDomain ? "确认试用地址" : "填写公网地址"}
              description={usingTrialDomain ? "先体验公开试用版，满意后可在设置中切换到自己的 NAS。" : "这是家人在外面打开 Fanmili 时使用的地址。"}
            />
            <label className={styles.field}>
              <span>公网地址 <em>必填</em></span>
              <input autoCapitalize="none" autoCorrect="off" inputMode="url" onChange={(event) => {
                setPublicDomain(event.target.value);
                setNetworkMessage("");
              }} placeholder="https://family.example.com" spellCheck={false} type="url" value={publicDomain} />
              <small>{usingTrialDomain ? "公开试用版使用共享体验环境，请勿上传个人隐私资料；切换自己的 NAS 时，试用数据不会自动迁移。" : "请先确认这个地址能在手机流量网络中直接打开。不能填写 *.fnos.net、192.168.x.x 或其他局域网地址。"}</small>
            </label>
            {networkMessage ? <p className={`${styles.verificationMessage} ${styles.verificationFailed}`} role="alert">{networkMessage}</p> : null}
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setStep("welcome")} type="button">返回</button>
              <button className={styles.primary} disabled={!normalizePublicDomain(publicDomain)} type="submit">下一步</button>
            </div>
          </form>
        ) : null}

        {step === "ai" ? (
          <div className={styles.form}>
            <StepHeader current={2} title="连接 AI" description="内测版必须连接可用的大模型 API。" />
            <label className={styles.field}>
              <span>DeepSeek API Key <em>必填</em></span>
              <input autoCapitalize="none" autoComplete="new-password" autoCorrect="off" onChange={(event) => {
                setApiKey(event.target.value);
                setAiVerification("idle");
                setAiMessage("");
              }} placeholder="sk-••••••••" spellCheck={false} type="password" value={apiKey} />
              <small>{isLite ? "加密保存在这台设备的 Fanmili 数据库中。" : "仅保存在当前浏览器。"}</small>
            </label>
            {aiMessage ? <p className={`${styles.verificationMessage} ${aiVerification === "passed" ? styles.verificationPassed : styles.verificationFailed}`.trim()} role="status">{aiMessage}</p> : null}
            <div className={styles.actions}>
              <button className={styles.secondary} onClick={() => setStep("network")} type="button">返回</button>
              <button className={styles.primary} disabled={!apiKey.trim() || aiVerification === "testing"} onClick={() => void verifyAiAndContinue()} type="button">{aiVerification === "testing" ? "正在验证…" : "验证并继续"}</button>
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
    const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return target.protocol !== "https:" || isUnsupportedPublicHostname(target.hostname)
      ? ""
      : target.origin;
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
  const hostname = window.location.hostname;
  if (hostname && !isUnsupportedPublicHostname(hostname) && window.location.protocol === "https:") {
    return window.location.origin;
  }
  return normalizePublicDomain(storedPublicDomain);
}

function isFnosRemoteHostname(hostname: string) {
  return hostname.toLowerCase().endsWith(".fnos.net");
}

function isTrialPublicDomain(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return target.hostname.toLowerCase() === trialPublicHost;
  } catch {
    return false;
  }
}

function isUnsupportedPublicHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".local")
    || isFnosRemoteHostname(normalized)
    || normalized.includes(":")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)
    || !normalized.includes(".");
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

function completeTrialOnboarding(storage: Storage, storedSettings: StoredSettings, themeFamily: ThemeFamily, publicDomain: string) {
  if (!isTrialPublicDomain(publicDomain)) return false;
  const publicTarget = parsePublicTarget(publicDomain);
  storage.setItem(settingsStorageKey, JSON.stringify({
    ...storedSettings,
    activeNetwork: "internet",
    networkMode: "auto",
    serverPort: publicTarget.port,
    serverUrl: publicTarget.host,
    themeFamily
  }));
  storage.setItem(onboardingStorageKey, JSON.stringify({
    aiConfigured: false,
    completed: true,
    completedAt: new Date().toISOString(),
    publicDomain: publicTarget.host,
    trial: true
  }));
  return true;
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
