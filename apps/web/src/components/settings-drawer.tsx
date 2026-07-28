"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { runAutomationAction } from "@/lib/automations";
import { DEFAULT_ASSISTANT_NAME } from "@/lib/assistantIdentity";
import { familyFetch, isFamilyAuthRequired } from "@/lib/familyApi";
import { normalizeFamilyRelationshipLabel } from "@/lib/familyRelationships";
import { calculateMemberAge, formatMemberBirthDateInput, memberBirthDatePickerMax, parseMemberBirthDateInput } from "@/lib/memberProfileAge";
import { useHomeDrawerSwipe } from "@/lib/homeDrawerGesture";
import { buildConnectivityTarget, buildLanConnectivityTarget, isCompleteLanAddress, selectFastestNetwork } from "@/lib/networkConnectivity";
import { clearStoredNetworkAddressesOnce } from "@/lib/clientPrivacyMigrations";
import { withAppBasePath } from "@/lib/appBasePath";
import { usePageScrollLock } from "@/lib/pageScrollLock";
import { NotificationSystemSettings } from "./notification-system-settings";
import type { FamilyMember, MemberProfile } from "@/lib/types";
import { AvatarImage } from "./avatar";
import navStyles from "./settings-nav.module.css";
import networkStyles from "./settings-network.module.css";

type SettingsSection = "appearance" | "network" | "ai" | "members" | "general";
type GeneralDetail = "storage" | "feedback" | "about";
type ThemeFamily = "mono" | "dopamine";
type ThemeMode = "auto" | "light" | "dark";
type NetworkMode = "internet" | "local" | "auto";
type ActiveNetwork = "internet" | "local" | null;
type ProviderStatus = "connected" | "failed" | "idle" | "testing";
type ConnectivityStatus = "idle" | "testing" | "success" | "failed";
type ProviderKind =
  | "deepseek"
  | "kimi"
  | "qwen"
  | "zhipu"
  | "volcengine"
  | "hunyuan"
  | "gemini"
  | "anthropic"
  | "openai"
  | "kimi_coding"
  | "minimax_plan"
  | "qwen_coding"
  | "zhipu_coding"
  | "hunyuan_coding"
  | "volcengine_coding"
  | "custom";

type ConnectivityTest = {
  status: ConnectivityStatus;
  latencyMs?: number;
  detail?: string;
};

type NetworkDefaults = {
  lanAddress?: string;
  publicDomain?: string;
  servicePort?: string;
};

type ApiUsageRollup = {
  completionTokens: number;
  inputCostCny: number;
  inputCostUsd: number;
  outputCostCny: number;
  outputCostUsd: number;
  promptTokens: number;
  requestCount: number;
  totalCostCny: number;
  totalCostUsd: number;
  totalTokens: number;
};

type ApiUsageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; usage: ApiUsageRollup }
  | { status: "error"; detail: string };

type AiTuningProfile = {
  averageLatencyMs: number;
  maxRetries: number;
  model: string;
  passedVectors: number;
  score: number;
  temperature: number;
  timeoutMs: number;
  totalVectors: number;
  tunedAt: string;
};

type AiTuningState = {
  detail?: string;
  profile: AiTuningProfile | null;
  status: "idle" | "loading" | "running" | "ready" | "error";
};

const AI_TUNING_VISIBLE = false;
const TRIAL_PUBLIC_HOST = "fanmili.superjunior.online";

type AiProvider = {
  id: string;
  kind?: ProviderKind;
  name: string;
  endpoint: string;
  apiKey: string;
  model?: string;
  deepModel: string;
  fastModel: string;
  status: ProviderStatus;
  testDetail?: string;
};

type ProviderPreset = {
  endpoint: string;
  kind: ProviderKind;
  label: string;
  group: "通用 API" | "Coding Plan" | "其他";
  usageNote?: string;
  deepModels: Array<{ id: string; label: string }>;
  fastModels: Array<{ id: string; label: string }>;
};

type SettingsDropdownOption = {
  group?: string;
  label: string;
  value: string;
};

type SettingsDrawerProps = {
  authRequired: boolean;
  currentMemberId: string;
  isFamilyAdmin: boolean;
  members: FamilyMember[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAiConnected: () => void;
  onOpenAccount: () => void;
  onMemberRemoved: (memberId: string) => void;
  onMemberUpdated: (memberId: string, profile: MemberProfile) => void;
  onSignOut: () => void;
};

const storageKey = "family-app.settings.v1";
const aiPersonalityPresets = [
  { id: "default", label: "默认", value: "开朗、务实" },
  { id: "concise", label: "简洁直接", value: "回答简洁直接，先给结论，再补充必要信息。" },
  { id: "warm", label: "温和体贴", value: "语气温和体贴，遇到焦虑或冲突时先理解感受，再给建议。" },
  { id: "clear", label: "理性清晰", value: "保持理性清晰，主动整理重点、依据和下一步。" },
  { id: "natural", label: "轻松自然", value: "表达轻松自然，可以有一点幽默，但不要油腻或夸张。" }
] as const;
const sections: Array<{ id: SettingsSection; title: string; description: string }> = [
  { id: "appearance", title: "外观", description: "主题与颜色" },
  { id: "network", title: "网络", description: "连接方式" },
  { id: "ai", title: "AI", description: "模型服务" },
  { id: "members", title: "成员", description: "家庭成员" },
  { id: "general", title: "通用", description: "账户与数据" }
];

const providerPresets: ProviderPreset[] = [
  {
    kind: "deepseek",
    label: "DeepSeek",
    group: "通用 API",
    endpoint: "https://api.deepseek.com",
    deepModels: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
    fastModels: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }
    ]
  },
  {
    kind: "kimi",
    label: "Kimi",
    group: "通用 API",
    endpoint: "https://api.moonshot.cn/v1",
    deepModels: [
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code（深度思考）" },
      { id: "kimi-k2.6", label: "Kimi K2.6（开启思考）" }
    ],
    fastModels: [
      { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code 高速版" },
      { id: "kimi-k2.6", label: "Kimi K2.6（关闭思考）" }
    ]
  },
  {
    kind: "qwen",
    label: "通义千问",
    group: "通用 API",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    deepModels: [
      { id: "qwen3.7-max", label: "Qwen 3.7 Max" },
      { id: "qwen3.7-plus", label: "Qwen 3.7 Plus" }
    ],
    fastModels: [
      { id: "qwen3.6-flash", label: "Qwen 3.6 Flash" },
      { id: "qwen3.6-plus", label: "Qwen 3.6 Plus" }
    ]
  },
  {
    kind: "zhipu",
    label: "智谱 GLM",
    group: "通用 API",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    deepModels: [
      { id: "glm-5.2", label: "GLM-5.2" },
      { id: "glm-5.1", label: "GLM-5.1" }
    ],
    fastModels: [
      { id: "glm-4.7-flashx", label: "GLM-4.7 FlashX" },
      { id: "glm-4.7-flash", label: "GLM-4.7 Flash" }
    ]
  },
  {
    kind: "volcengine",
    label: "火山方舟",
    group: "通用 API",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    deepModels: [
      { id: "doubao-seed-2-0-pro-260215", label: "Doubao Seed 2.0 Pro" },
      { id: "doubao-seed-1-8-251228", label: "Doubao Seed 1.8" }
    ],
    fastModels: [
      { id: "doubao-seed-2-0-lite-260215", label: "Doubao Seed 2.0 Lite" },
      { id: "doubao-seed-1-8-251228", label: "Doubao Seed 1.8（关闭思考）" }
    ]
  },
  {
    kind: "hunyuan",
    label: "腾讯混元",
    group: "通用 API",
    endpoint: "https://api.hunyuan.cloud.tencent.com/v1",
    deepModels: [
      { id: "hunyuan-turbos-latest", label: "Hunyuan TurboS Latest" }
    ],
    fastModels: [
      { id: "hunyuan-lite", label: "Hunyuan Lite" },
      { id: "hunyuan-turbos-latest", label: "Hunyuan TurboS Latest" }
    ]
  },
  {
    kind: "gemini",
    label: "Google Gemini",
    group: "通用 API",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    deepModels: [
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" }
    ],
    fastModels: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" }
    ]
  },
  {
    kind: "anthropic",
    label: "Anthropic Claude",
    group: "通用 API",
    endpoint: "https://api.anthropic.com/v1",
    deepModels: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }
    ],
    fastModels: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }
    ]
  },
  {
    kind: "openai",
    label: "OpenAI",
    group: "通用 API",
    endpoint: "https://api.openai.com/v1",
    deepModels: [
      { id: "gpt-5.2", label: "GPT-5.2" }
    ],
    fastModels: [
      { id: "gpt-5-mini", label: "GPT-5 mini" }
    ]
  },
  {
    kind: "kimi_coding",
    label: "Kimi Code",
    group: "Coding Plan",
    usageNote: "仅用于支持的编程工具；Kimi Code Key 与 Moonshot 开放平台 Key 不互通。",
    endpoint: "https://api.kimi.com/coding/v1",
    deepModels: [
      { id: "k3", label: "Kimi K3" },
      { id: "kimi-for-coding", label: "Kimi K2.7 Code" }
    ],
    fastModels: [
      { id: "kimi-for-coding-highspeed", label: "Kimi K2.7 Code HighSpeed" },
      { id: "kimi-for-coding", label: "Kimi K2.7 Code" }
    ]
  },
  {
    kind: "minimax_plan",
    label: "MiniMax Token Plan",
    group: "Coding Plan",
    usageNote: "需要 Token Plan 专属 Key；该 Key 与按量计费 API Key 不互通。",
    endpoint: "https://api.minimaxi.com/v1",
    deepModels: [
      { id: "MiniMax-M2.7", label: "MiniMax M2.7" }
    ],
    fastModels: [
      { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 HighSpeed" },
      { id: "MiniMax-M2.7", label: "MiniMax M2.7" }
    ]
  },
  {
    kind: "qwen_coding",
    label: "阿里云百炼 Coding Plan",
    group: "Coding Plan",
    usageNote: "仅限支持的交互式编程工具；请使用 sk-sp- 开头的套餐专属 Key。",
    endpoint: "https://coding.dashscope.aliyuncs.com/v1",
    deepModels: [
      { id: "qwen3.7-plus", label: "Qwen 3.7 Plus" },
      { id: "glm-5", label: "GLM-5" },
      { id: "qwen3-coder-plus", label: "Qwen 3 Coder Plus" }
    ],
    fastModels: [
      { id: "qwen3.6-plus", label: "Qwen 3.6 Plus" },
      { id: "qwen3-coder-next", label: "Qwen 3 Coder Next" },
      { id: "MiniMax-M2.5", label: "MiniMax M2.5" }
    ]
  },
  {
    kind: "zhipu_coding",
    label: "智谱 GLM Coding Plan",
    group: "Coding Plan",
    usageNote: "仅限智谱官方支持的 Coding Agent 与指定工具；套餐 Key 需使用专属编程端点。",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
    deepModels: [
      { id: "glm-5.2", label: "GLM-5.2" },
      { id: "glm-4.7", label: "GLM-4.7" }
    ],
    fastModels: [
      { id: "glm-4.7", label: "GLM-4.7" }
    ]
  },
  {
    kind: "hunyuan_coding",
    label: "腾讯云 TokenHub Coding Plan",
    group: "Coding Plan",
    usageNote: "仅用于腾讯云允许的 AI Coding 工具；请使用 sk-sp- 开头的套餐专属 Key。",
    endpoint: "https://api.lkeap.cloud.tencent.com/coding/v3",
    deepModels: [
      { id: "glm-5", label: "GLM-5" },
      { id: "kimi-k2.5", label: "Kimi K2.5" }
    ],
    fastModels: [
      { id: "MiniMax-M2.5", label: "MiniMax M2.5" },
      { id: "kimi-k2.5", label: "Kimi K2.5" }
    ]
  },
  {
    kind: "volcengine_coding",
    label: "火山方舟 Coding Plan",
    group: "Coding Plan",
    usageNote: "仅用于支持的 AI 编程工具；请勿与火山方舟按量 API 地址混用。",
    endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
    deepModels: [
      { id: "ark-code-latest", label: "Ark Code Latest" },
      { id: "doubao-seed-2-0-code", label: "Doubao Seed 2.0 Code" }
    ],
    fastModels: [
      { id: "kimi-k2.5", label: "Kimi K2.5" },
      { id: "deepseek-v3.2", label: "DeepSeek V3.2" }
    ]
  },
  {
    kind: "custom",
    label: "自定义服务",
    group: "其他",
    endpoint: "https://",
    deepModels: [],
    fastModels: []
  }
];

function SettingsNavIcon({ section }: { section: SettingsSection }) {
  if (section === "appearance") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path className={navStyles.appearanceFill} d="M12 3.5a8.5 8.5 0 0 0 0 17Z" />
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5v17" />
      </svg>
    );
  }

  if (section === "network") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3.2 8.7a13.1 13.1 0 0 1 17.6 0" />
        <path d="M6.4 12a8.5 8.5 0 0 1 11.2 0" />
        <path d="M9.5 15.3a3.9 3.9 0 0 1 5 0" />
        <circle className={navStyles.signalDot} cx="12" cy="18.4" r="1" />
      </svg>
    );
  }

  if (section === "ai") {
    return (
      <svg aria-hidden="true" className={navStyles.aiSparkles} viewBox="0 0 24 24">
        <path d="M9.15 3.15c.42 3.76 2.03 5.37 5.79 5.79-3.76.42-5.37 2.03-5.79 5.79-.42-3.76-2.03-5.37-5.79-5.79 3.76-.42 5.37-2.03 5.79-5.79Z" />
        <path d="M17.2 12.35c.28 2.63 1.4 3.75 4.03 4.03-2.63.28-3.75 1.4-4.03 4.03-.28-2.63-1.4-3.75-4.03-4.03 2.63-.28 3.75-1.4 4.03-4.03Z" />
        <circle cx="18.25" cy="5.15" r=".72" />
      </svg>
    );
  }

  if (section === "members") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3" />
        <path d="M3.8 18.5c.45-3.25 2.2-5 5.2-5s4.75 1.75 5.2 5" />
        <circle cx="17.2" cy="9.2" r="2.25" />
        <path d="M15.2 14.2c2.9-.45 4.7 1 5 3.65" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle className={navStyles.menuDot} cx="5.5" cy="12" r="1.35" />
      <circle className={navStyles.menuDot} cx="12" cy="12" r="1.35" />
      <circle className={navStyles.menuDot} cx="18.5" cy="12" r="1.35" />
    </svg>
  );
}

const defaultProviders: AiProvider[] = [
  {
    id: "deepseek",
    kind: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    apiKey: "",
    deepModel: "deepseek-v4-pro",
    fastModel: "deepseek-v4-flash",
    status: "idle"
  }
];

function normalizeStoredProviders(providers: AiProvider[] | undefined) {
  if (!providers?.length) return defaultProviders;
  const seen = new Set<string>();
  const normalized = providers
    .map(normalizeStoredProvider)
    .filter((provider) => !(provider.id === "openai" && !provider.apiKey.trim() && provider.status === "failed"))
    .filter((provider) => {
      const key = `${provider.kind}:${provider.endpoint.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return normalized.length ? normalized : defaultProviders;
}

function normalizeStoredProvider(provider: AiProvider): AiProvider {
  const inferredKind = provider.kind || providerPresets.find((preset) => preset.label.toLowerCase() === provider.name.toLowerCase())?.kind || "custom";
  const preset = providerPresets.find((candidate) => candidate.kind === inferredKind) || providerPresets.at(-1)!;
  const legacyModel = provider.model || "";
  return {
    ...provider,
    kind: inferredKind,
    endpoint: inferredKind === "custom" ? provider.endpoint : preset.endpoint,
    deepModel: provider.deepModel || legacyModel || preset.deepModels[0]?.id || "",
    fastModel: provider.fastModel || legacyModel || preset.fastModels[0]?.id || ""
  };
}

export function SettingsDrawer({ authRequired, currentMemberId, isFamilyAdmin, members, open, onOpen, onClose, onAiConnected, onOpenAccount, onMemberRemoved, onMemberUpdated, onSignOut }: SettingsDrawerProps) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  const [generalDetail, setGeneralDetail] = useState<GeneralDetail | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<{ quota?: number; usage?: number } | null>(null);
  const [themeFamily, setThemeFamily] = useState<ThemeFamily>("mono");
  const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
  const [networkMode, setNetworkMode] = useState<NetworkMode>("auto");
  const [activeNetwork, setActiveNetwork] = useState<ActiveNetwork>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [serverPort, setServerPort] = useState("");
  const [lanIp, setLanIp] = useState("");
  const [lanPort, setLanPort] = useState("3001");
  const [internetConnectivity, setInternetConnectivity] = useState<ConnectivityTest>({ status: "idle" });
  const [lanConnectivity, setLanConnectivity] = useState<ConnectivityTest>({ status: "idle" });
  const [ownNasSwitchOpen, setOwnNasSwitchOpen] = useState(false);
  const [ownNasAddress, setOwnNasAddress] = useState("");
  const [ownNasConnectivity, setOwnNasConnectivity] = useState<ConnectivityTest>({ status: "idle" });
  const [ownNasMessage, setOwnNasMessage] = useState("");
  const [ownNasConfirming, setOwnNasConfirming] = useState(false);
  const [providers, setProviders] = useState<AiProvider[]>(defaultProviders);
  const [apiUsage, setApiUsage] = useState<ApiUsageState>({ status: "idle" });
  const [aiTuning, setAiTuning] = useState<AiTuningState>({ profile: null, status: "idle" });
  const [assistantConfigField, setAssistantConfigField] = useState<"name" | "personality" | "memory" | null>(null);
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);
  const [assistantPersonality, setAssistantPersonality] = useState("开朗、务实");
  const [assistantMemory, setAssistantMemory] = useState("");
  const [assistantConfigSaving, setAssistantConfigSaving] = useState(false);
  const [assistantConfigMessage, setAssistantConfigMessage] = useState("");
  const [assistantConfigLoaded, setAssistantConfigLoaded] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [sync, setSync] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [memberDeleteCandidate, setMemberDeleteCandidate] = useState("");
  const [memberDetailId, setMemberDetailId] = useState("");
  const [memberDeleteBusy, setMemberDeleteBusy] = useState(false);
  const [memberDeleteMessage, setMemberDeleteMessage] = useState("");
  const autoNetworkTestSequenceRef = useRef(0);
  const drawer = useHomeDrawerSwipe({ side: "left", open, onOpen, onClose });
  usePageScrollLock(open);

  useEffect(() => {
    if (!isFamilyAdmin && section === "members") setSection("appearance");
  }, [isFamilyAdmin, section]);

  async function removeMember(memberId: string) {
    setMemberDeleteBusy(true);
    setMemberDeleteMessage("");
    const response = await familyFetch("/api/family-members", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId })
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
    setMemberDeleteBusy(false);
    if (!response?.ok) {
      setMemberDeleteMessage(payload.detail || "成员移除失败，请稍后重试。");
      return;
    }
    setMemberDeleteCandidate("");
    setMemberDeleteMessage("成员已移除。");
    onMemberRemoved(memberId);
  }

  useEffect(() => {
    try {
      clearStoredNetworkAddressesOnce(localStorage);
      const stored = JSON.parse(localStorage.getItem(storageKey) || "{}") as Partial<{
        themeFamily: ThemeFamily;
        themeMode: ThemeMode;
        networkMode: NetworkMode;
        activeNetwork: ActiveNetwork;
        serverUrl: string;
        serverPort: string;
        lanIp: string;
        lanPort: string;
        providers: AiProvider[];
        notifications: boolean;
        sync: boolean;
      }>;
      if (stored.themeFamily) setThemeFamily(stored.themeFamily);
      const autoThemeDefaultApplied = localStorage.getItem("family-app.settings.auto-theme-default.v2") === "1";
      if (autoThemeDefaultApplied && stored.themeMode) {
        setThemeMode(stored.themeMode);
      } else {
        setThemeMode("auto");
        localStorage.setItem("family-app.settings.auto-theme-default.v2", "1");
      }
      if (stored.networkMode) setNetworkMode(stored.networkMode);
      if (stored.activeNetwork === "internet" || stored.activeNetwork === "local") setActiveNetwork(stored.activeNetwork);
      if (typeof stored.serverUrl === "string" && !isFnosRemoteAddress(stored.serverUrl)) {
        setServerUrl(stored.serverUrl);
        if (typeof stored.serverPort === "string") setServerPort(stored.serverPort);
      }
      if (stored.lanIp) setLanIp(stored.lanIp);
      if (typeof stored.lanPort === "string") setLanPort(stored.lanPort);
      setProviders(normalizeStoredProviders(stored.providers));
      if (typeof stored.notifications === "boolean") setNotifications(stored.notifications);
      if (typeof stored.sync === "boolean") setSync(stored.sync);
    } catch {
      // Keep safe defaults if a previous local preference is malformed.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void familyFetch("/api/network-defaults", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<NetworkDefaults> : null)
      .then((defaults) => {
        if (!defaults || cancelled) return;
        const publicTarget = parseNetworkDefaultEndpoint(defaults.publicDomain || "");
        setServerUrl((current) => current || publicTarget.host);
        setServerPort((current) => current || publicTarget.port);
        setLanIp((current) => current || normalizeNetworkDefaultLan(defaults.lanAddress || ""));
        setLanPort((current) => normalizeNetworkDefaultPort(defaults.servicePort || "") || current || "3001");
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  useEffect(() => {
    const root = document.documentElement;
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      root.dataset.visualTheme = themeFamily;
      root.dataset.colorScheme = themeMode === "auto" ? (darkQuery.matches ? "dark" : "light") : themeMode;
      root.style.removeProperty("--user-accent");
    };
    applyTheme();
    darkQuery.addEventListener("change", applyTheme);
    return () => darkQuery.removeEventListener("change", applyTheme);
  }, [themeFamily, themeMode]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(storageKey, JSON.stringify({
      themeFamily,
      themeMode,
      networkMode,
      activeNetwork,
      serverUrl,
      serverPort,
      lanIp,
      lanPort,
      providers,
      notifications,
      sync
    }));
  }, [activeNetwork, hydrated, lanIp, lanPort, networkMode, notifications, providers, serverPort, serverUrl, sync, themeFamily, themeMode]);

  useEffect(() => {
    const localConfigured = isCompleteLanAddress(lanIp);
    if (networkMode === "internet") {
      setActiveNetwork("internet");
      return;
    }
    if (networkMode === "local") {
      setActiveNetwork(localConfigured ? "local" : null);
      return;
    }
    setActiveNetwork(selectFastestNetwork(internetConnectivity, lanConnectivity, localConfigured));
  }, [
    internetConnectivity.latencyMs,
    internetConnectivity.status,
    lanIp,
    lanConnectivity.latencyMs,
    lanConnectivity.status,
    networkMode
  ]);

  useEffect(() => {
    if (!open || section !== "network" || networkMode !== "auto") return;
    const timer = window.setTimeout(() => {
      void testAutomaticNetwork();
    }, 240);
    return () => window.clearTimeout(timer);
  }, [lanIp, lanPort, networkMode, open, section, serverPort, serverUrl]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open || section !== "ai" || assistantConfigLoaded) return;
    let cancelled = false;
    void familyFetch("/api/assistant-config", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { detail?: string; name?: string; personality?: string };
        if (!response.ok) throw new Error(payload.detail || "读取助手配置失败。");
        if (cancelled) return;
        setAssistantName(payload.name?.trim() || DEFAULT_ASSISTANT_NAME);
        setAssistantPersonality(payload.personality?.trim() || "开朗、务实");
        setAssistantConfigLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) setAssistantConfigMessage(error instanceof Error ? error.message : "读取助手配置失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [assistantConfigLoaded, open, section]);

  useEffect(() => {
    if (!AI_TUNING_VISIBLE || !open || section !== "ai") return;
    let cancelled = false;
    setApiUsage({ status: "loading" });
    void familyFetch("/api/api-usage", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { detail?: string; usage?: ApiUsageRollup };
        if (!response.ok || !payload.usage) throw new Error(payload.detail || "API 使用量读取失败。");
        if (!cancelled) setApiUsage({ status: "ready", usage: payload.usage });
      })
      .catch((error) => {
        if (!cancelled) {
          setApiUsage({
            status: "error",
            detail: error instanceof Error ? error.message : "API 使用量读取失败。"
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, section]);

  useEffect(() => {
    if (!open || section !== "ai") return;
    let cancelled = false;
    setAiTuning((current) => ({ ...current, status: "loading" }));
    void familyFetch("/api/ai-tuning", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { detail?: string; profile?: AiTuningProfile | null };
        if (!response.ok) throw new Error(payload.detail || "读取 AI 调参结果失败。");
        if (!cancelled) setAiTuning({ profile: payload.profile || null, status: payload.profile ? "ready" : "idle" });
      })
      .catch((error) => {
        if (!cancelled) setAiTuning({ detail: error instanceof Error ? error.message : "读取 AI 调参结果失败。", profile: null, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, section]);

  function updateProvider(id: string, patch: Partial<AiProvider>) {
    const configurationChanged = ["apiKey", "deepModel", "endpoint", "fastModel", "kind"].some((key) => key in patch);
    setProviders((current) => current.map((provider) => provider.id === id
      ? { ...provider, ...(configurationChanged ? { status: "idle" as const, testDetail: "" } : {}), ...patch }
      : provider));
  }

  async function testProvider(id: string) {
    const provider = providers.find((candidate) => candidate.id === id);
    if (!provider) return;
    updateProvider(id, { status: "testing", testDetail: "" });
    try {
      const response = await familyFetch("/api/ai-tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: provider.apiKey,
          endpoint: provider.endpoint,
          kind: provider.kind,
          model: provider.fastModel
        })
      });
      const payload = await response.json() as { detail?: string; profile?: AiTuningProfile };
      if (!response.ok || !payload.profile) throw new Error(payload.detail || "API 连接测试失败。");
      updateProvider(id, {
        status: "connected",
        testDetail: provider.apiKey.trim() ? "API 已通过真实请求验证。" : "服务器 API 配置已通过真实请求验证。"
      });
      window.setTimeout(onAiConnected, 450);
    } catch (error) {
      updateProvider(id, {
        status: "failed",
        testDetail: error instanceof Error ? error.message : "API 连接测试失败。"
      });
    }
  }

  async function runAiTuning() {
    const provider = providers.find((candidate) => candidate.kind === "deepseek");
    if (!provider) {
      setAiTuning({ detail: "请先添加 DeepSeek 服务商。", profile: null, status: "error" });
      return;
    }
    setAiTuning((current) => ({ ...current, detail: undefined, status: "running" }));
    try {
      const response = await familyFetch("/api/ai-tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: provider.apiKey,
          endpoint: provider.endpoint,
          kind: provider.kind,
          model: provider.fastModel
        })
      });
      const payload = await response.json() as { detail?: string; profile?: AiTuningProfile };
      if (!response.ok || !payload.profile) throw new Error(payload.detail || "AI 调参失败。");
      setAiTuning({ profile: payload.profile, status: "ready" });
      updateProvider(provider.id, { status: "connected" });
      setApiUsage({ status: "loading" });
      void familyFetch("/api/api-usage", { cache: "no-store" })
        .then((usageResponse) => usageResponse.json())
        .then((usagePayload: { usage?: ApiUsageRollup }) => {
          if (usagePayload.usage) setApiUsage({ status: "ready", usage: usagePayload.usage });
        });
    } catch (error) {
      updateProvider(provider.id, { status: "failed" });
      setAiTuning((current) => ({
        detail: error instanceof Error ? error.message : "AI 调参失败。",
        profile: current.profile,
        status: "error"
      }));
    }
  }

  async function testConnectivity(createTarget: () => URL, update: (test: ConnectivityTest) => void) {
    update({ status: "testing" });
    let target: URL;
    try {
      target = createTarget();
    } catch {
      const result = { status: "failed", detail: "地址格式不正确" } as const;
      update(result);
      return result;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const startedAt = performance.now();

    try {
      await fetch(target, {
        cache: "no-store",
        mode: "no-cors",
        signal: controller.signal
      });
      const result = { status: "success", latencyMs: Math.max(1, Math.round(performance.now() - startedAt)) } as const;
      update(result);
      return result;
    } catch (error) {
      const result = {
        status: "failed",
        detail: error instanceof DOMException && error.name === "AbortError" ? "连接超时" : "无法连接"
      } as const;
      update(result);
      return result;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function testAutomaticNetwork() {
    const sequence = ++autoNetworkTestSequenceRef.current;
    const internetPromise = testConnectivity(
      () => buildConnectivityTarget(serverUrl, serverPort),
      setInternetConnectivity
    );
    const localConfigured = isCompleteLanAddress(lanIp);
    const localPromise = localConfigured
      ? testConnectivity(() => buildLanConnectivityTarget(lanIp, lanPort), setLanConnectivity)
      : Promise.resolve({ status: "idle" } as ConnectivityTest);
    if (!localConfigured) setLanConnectivity({ status: "idle" });
    const [internetResult, localResult] = await Promise.all([internetPromise, localPromise]);
    if (sequence !== autoNetworkTestSequenceRef.current) return;
    setActiveNetwork(selectFastestNetwork(internetResult, localResult, localConfigured));
  }

  async function testOwnNasAddress() {
    setOwnNasMessage("");
    setOwnNasConfirming(false);
    let target: ReturnType<typeof parseOwnNasEndpoint>;
    try {
      target = parseOwnNasEndpoint(ownNasAddress);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "地址格式不正确";
      setOwnNasConnectivity({ status: "failed", detail });
      setOwnNasMessage(detail);
      return;
    }
    const result = await testConnectivity(
      () => buildConnectivityTarget(target.host, target.port),
      setOwnNasConnectivity
    );
    setOwnNasMessage(result.status === "success"
      ? "地址可以访问。请确认打开的是你自己的 Fanmili；切换后需要重新登录。"
      : result.detail || "无法连接，请检查域名、HTTPS 和反向代理设置。");
  }

  function completeOwnNasSwitch() {
    if (ownNasConnectivity.status !== "success") return;
    if (!ownNasConfirming) {
      setOwnNasConfirming(true);
      return;
    }
    let target: ReturnType<typeof parseOwnNasEndpoint>;
    try {
      target = parseOwnNasEndpoint(ownNasAddress);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "地址格式不正确";
      setOwnNasConnectivity({ status: "failed", detail });
      setOwnNasMessage(detail);
      setOwnNasConfirming(false);
      return;
    }
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(localStorage.getItem(storageKey) || "{}") as Record<string, unknown>;
    } catch {
      stored = {};
    }
    localStorage.setItem(storageKey, JSON.stringify({
      ...stored,
      activeNetwork: "internet",
      networkMode: "internet",
      serverPort: target.port,
      serverUrl: target.host
    }));
    setServerUrl(target.host);
    setServerPort(target.port);
    setNetworkMode("internet");
    setActiveNetwork("internet");
    window.location.assign(new URL(withAppBasePath("/"), target.origin).toString());
  }

  function addProvider() {
    const id = `provider-${Date.now()}`;
    const preset = providerPresets[0];
    setProviders((current) => [...current, {
      id,
      kind: preset.kind,
      name: preset.label,
      endpoint: preset.endpoint,
      apiKey: "",
      deepModel: preset.deepModels[0]?.id || "",
      fastModel: preset.fastModels[0]?.id || "",
      status: "failed"
    }]);
  }

  function removeProvider(id: string) {
    setProviders((current) => current.filter((provider) => provider.id !== id));
  }

  async function runConfirmedAssistantAction(
    actionId: "member.rename" | "memory.save",
    parameters: Record<string, unknown>
  ) {
    const candidate = await runAutomationAction(actionId, parameters);
    if (!candidate?.ok) throw new Error(candidate?.error || "保存失败，请稍后重试。");
    if (!candidate.confirmation) return candidate;
    const confirmed = await runAutomationAction(
      actionId,
      candidate.confirmation.parameters,
      { confirmationToken: candidate.confirmation.token }
    );
    if (!confirmed?.ok) throw new Error(confirmed?.error || "保存失败，请稍后重试。");
    return confirmed;
  }

  async function saveAssistantConfig(field: "name" | "personality" | "memory") {
    setAssistantConfigSaving(true);
    setAssistantConfigMessage("");
    try {
      if (field === "name") {
        const name = assistantName.trim().slice(0, 16);
        if (!name) throw new Error("请填写助手名称。");
        await runConfirmedAssistantAction("member.rename", {
          member: "fanmili",
          new_name: name,
          text: `把家庭助手改名为${name}`
        });
        setAssistantName(name);
        setAssistantConfigMessage("名称已更新，全家共用。");
      } else if (field === "personality") {
        const personality = assistantPersonality.trim().slice(0, 300) || "开朗、务实";
        const response = await familyFetch("/api/assistant-preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ personality })
        });
        if (!response.ok) throw new Error("个性保存失败，请重试。");
        setAssistantPersonality(personality);
        setAssistantConfigMessage("个性已保存，只影响你与助手的对话。");
      } else {
        const memory = assistantMemory.trim().slice(0, 500);
        if (!memory) throw new Error("请填写要记住的内容。");
        await runConfirmedAssistantAction("memory.save", {
          subject: "家庭",
          text: memory
        });
        setAssistantMemory("");
        setAssistantConfigMessage("记忆已确认保存。");
      }
    } catch (error) {
      setAssistantConfigMessage(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setAssistantConfigSaving(false);
    }
  }

  async function openGeneralDetail(detail: GeneralDetail) {
    setGeneralDetail(detail);
    if (detail !== "storage") return;
    try {
      setStorageEstimate(await navigator.storage?.estimate?.() || {});
    } catch {
      setStorageEstimate({});
    }
  }

  if (!hydrated) return null;

  return createPortal(
      <div
        className={`settings-layer${drawer.active ? " active" : ""}${open ? " open" : ""}${drawer.dragging ? " dragging" : ""}`}
        aria-hidden={!drawer.active}
        data-home-drawer-layer
        style={drawer.layerStyle}
      >
        <button aria-hidden="true" className="settings-backdrop" onClick={onClose} tabIndex={-1} type="button" />
        <aside
          aria-label="设置"
          aria-modal="true"
          className="settings-drawer"
          data-home-drawer-panel="left"
          role="dialog"
        >
          <div className="settings-layout">
            <nav aria-label="设置分类" className="settings-nav">
              {sections.filter((item) => !["ai", "members"].includes(item.id) || isFamilyAdmin).map((item) => (
                <button
                  className={`${navStyles.navButton}${section === item.id ? ` active ${navStyles.active}` : ""}`}
                  data-settings-section={item.id}
                  key={item.id}
                  onClick={() => {
                    setSection(item.id);
                    setGeneralDetail(null);
                  }}
                  type="button"
                >
                  <i aria-hidden="true" className={navStyles.icon}><SettingsNavIcon section={item.id} /></i>
                  <span><b>{item.title}</b><small>{item.description}</small></span>
                </button>
              ))}
            </nav>

            <div className="settings-content">
              {section === "appearance" ? (
                <SettingsPanel className="settings-panel-general">
                  <div className="theme-card-grid">
                    <button className={themeFamily === "mono" ? "theme-card selected" : "theme-card"} onClick={() => setThemeFamily("mono")} type="button">
                      <ThemePreview family="mono" />
                      <span><strong>黑白配</strong></span>
                    </button>
                    <button className={themeFamily === "dopamine" ? "theme-card selected" : "theme-card"} onClick={() => setThemeFamily("dopamine")} type="button">
                      <ThemePreview family="dopamine" />
                      <span><strong>多巴胺</strong></span>
                    </button>
                  </div>
                  <SegmentedControl value={themeMode} options={[{ value: "light", label: "浅色" }, { value: "auto", label: "自动" }, { value: "dark", label: "深色" }]} onChange={(value) => setThemeMode(value as ThemeMode)} />
                </SettingsPanel>
              ) : null}

              {section === "network" ? (
                <SettingsPanel>
                  {isTrialPublicAddress(serverUrl) ? (
                    <section className={networkStyles.trialSwitchCard} aria-label="从试用版切换到自己的 NAS">
                      <div className={networkStyles.trialSwitchCopy}>
                        <strong>正在使用公开试用版</strong>
                        <p>喜欢 Fanmili？你可以切换到自己的 NAS。试用版数据不会自动迁移，请勿在公开试用环境上传隐私资料。</p>
                      </div>
                      {!ownNasSwitchOpen ? (
                        <button className={networkStyles.switchPrimary} onClick={() => setOwnNasSwitchOpen(true)} type="button">切换到自己的 NAS</button>
                      ) : (
                        <div className={networkStyles.switchForm}>
                          <label>
                            <span>自己的 HTTPS 公网地址</span>
                            <input
                              aria-label="自己的 HTTPS 公网地址"
                              autoCapitalize="none"
                              autoCorrect="off"
                              inputMode="url"
                              onChange={(event) => {
                                setOwnNasAddress(event.target.value);
                                setOwnNasConnectivity({ status: "idle" });
                                setOwnNasMessage("");
                                setOwnNasConfirming(false);
                              }}
                              placeholder="https://family.example.com"
                              spellCheck={false}
                              type="url"
                              value={ownNasAddress}
                            />
                          </label>
                          <small>该地址必须已解析到你的 NAS，并配置有效的 HTTPS 证书和反向代理。</small>
                          <ConnectivityButton label="自己的 NAS" test={ownNasConnectivity} onTest={() => void testOwnNasAddress()} />
                          {ownNasMessage ? <p className={networkStyles.switchMessage} role="status">{ownNasMessage}</p> : null}
                          {ownNasConfirming ? (
                            <div className={networkStyles.switchConfirmation} role="group" aria-label="确认切换到自己的 NAS">
                              <strong>确认切换？</strong>
                              <p>试用版中的记录不会自动复制到你的 NAS。切换后需要使用自己 NAS 上的账号重新登录。</p>
                              <div>
                                <button onClick={() => setOwnNasConfirming(false)} type="button">返回检查</button>
                                <button className={networkStyles.switchDanger} onClick={completeOwnNasSwitch} type="button">确认切换</button>
                              </div>
                            </div>
                          ) : (
                            <div className={networkStyles.switchActions}>
                              <button onClick={() => {
                                setOwnNasSwitchOpen(false);
                                setOwnNasAddress("");
                                setOwnNasConnectivity({ status: "idle" });
                                setOwnNasMessage("");
                              }} type="button">暂不切换</button>
                              <button className={networkStyles.switchPrimary} disabled={ownNasConnectivity.status !== "success"} onClick={completeOwnNasSwitch} type="button">保存并切换</button>
                            </div>
                          )}
                        </div>
                      )}
                    </section>
                  ) : null}
                  <ConnectionCard
                    title="公网连接"
                    status={connectivityCardStatus(internetConnectivity)}
                    meta={connectivityMeta(internetConnectivity, "尚未检测")}
                  >
                    <EndpointField
                      host={serverUrl}
                      port={serverPort}
                      onHostChange={(value) => { setServerUrl(value); setInternetConnectivity({ status: "idle" }); }}
                      onPortChange={(value) => { setServerPort(value); setInternetConnectivity({ status: "idle" }); }}
                    />
                    {!serverUrl ? <p className={networkStyles.publicAddressNote}>未检测到可直接打开的公网地址。飞牛远程入口需先登录 fnOS 再打开 Fanmili；如需复制即开，请配置独立反向代理域名。</p> : null}
                    <ConnectivityButton label="公网" test={internetConnectivity} onTest={() => void testConnectivity(() => buildConnectivityTarget(serverUrl, serverPort), setInternetConnectivity)} />
                  </ConnectionCard>
                  <ConnectionCard
                    title="本地网络"
                    status={connectivityCardStatus(lanConnectivity)}
                    meta={connectivityMeta(lanConnectivity, "请输入地址并检测")}
                  >
                    <div className={networkStyles.localControls}>
                      <SegmentedIpField value={lanIp} onChange={(value) => { setLanIp(value); setLanConnectivity({ status: "idle" }); }} />
                      <label className={networkStyles.localPort}>
                        <span>端口</span>
                        <input aria-label="局域网端口" inputMode="numeric" onChange={(event) => { setLanPort(event.target.value.replace(/\D/g, "").slice(0, 5)); setLanConnectivity({ status: "idle" }); }} value={lanPort} />
                      </label>
                    </div>
                    <ConnectivityButton label="本地" test={lanConnectivity} onTest={() => void testConnectivity(() => buildLanConnectivityTarget(lanIp, lanPort), setLanConnectivity)} />
                  </ConnectionCard>
                  <SegmentedControl
                    value={networkMode}
                    options={[
                      { value: "internet", label: "公网" },
                      { value: "auto", label: "自动" },
                      { value: "local", label: "本地" }
                    ]}
                    onChange={(value) => setNetworkMode(value as NetworkMode)}
                  />
                </SettingsPanel>
              ) : null}

              {section === "ai" && isFamilyAdmin ? (
                <SettingsPanel action={<button className="settings-add" onClick={addProvider} type="button">＋ 添加</button>}>
                  <div className="provider-list">
                    {providers.map((provider) => (
                      <ProviderCard key={provider.id} provider={provider} usage={provider.kind === "deepseek" ? apiUsage : undefined} onChange={(patch) => updateProvider(provider.id, patch)} onRemove={() => removeProvider(provider.id)} onTest={() => testProvider(provider.id)} />
                    ))}
                  </div>
                  {AI_TUNING_VISIBLE ? <AiTuningCard state={aiTuning} onRun={() => void runAiTuning()} /> : null}
                  <AssistantConfigCard
                    activeField={assistantConfigField}
                    memory={assistantMemory}
                    message={assistantConfigMessage}
                    name={assistantName}
                    personality={assistantPersonality}
                    saving={assistantConfigSaving}
                    onFieldChange={(field) => {
                      setAssistantConfigMessage("");
                      setAssistantConfigField((current) => current === field ? null : field);
                    }}
                    onMemoryChange={setAssistantMemory}
                    onNameChange={setAssistantName}
                    onPersonalityChange={setAssistantPersonality}
                    onSave={(field) => void saveAssistantConfig(field)}
                  />
                </SettingsPanel>
              ) : null}

                  {section === "members" && isFamilyAdmin ? (
                    <SettingsPanel>
                  {memberDetailId && members.some((member) => member.id === memberDetailId) ? (
                    <MemberProfileEditor
                      member={members.find((member) => member.id === memberDetailId)!}
                      onBack={() => setMemberDetailId("")}
                      onSaved={(profile) => onMemberUpdated(memberDetailId, profile)}
                    />
                  ) : <section className="member-management-card" aria-label="成员">
                    <header><strong>成员</strong><small>仅家庭管理员可操作</small></header>
                    <div className="member-management-list">
                      {members.filter((member) => member.relationshipRole !== "guest" && !member.householdRoles?.includes("assistant")).map((member) => {
                        const isCurrentMember = member.id === currentMemberId;
                        const relationshipLabel = member.displayName
                          || normalizeFamilyRelationshipLabel(member.relationshipLabel || member.role || "家庭成员", member.displayName);
                        return (
                        <div className="member-management-row" key={member.id}>
                          <button className="member-management-main" type="button" onClick={() => {
                            setMemberDeleteCandidate("");
                            if (isCurrentMember) {
                              onClose();
                              onOpenAccount();
                              return;
                            }
                            setMemberDetailId(member.id);
                          }}>
                            <span className="member-management-avatar">
                              <AvatarImage alt="" decoding="sync" height={42} label={member.displayName} loading="eager" seed={member.avatarSeed} width={42} />
                            </span>
                            <span><strong>{relationshipLabel}{isCurrentMember ? <em>管理员</em> : null}</strong><small>{isCurrentMember ? "修改头像、姓名与密码" : formatMemberProfileSummary(member.profile)}</small></span>
                          </button>
                          {isCurrentMember ? null : memberDeleteCandidate === member.id ? (
                            <div className="member-delete-confirm">
                              <button disabled={memberDeleteBusy} type="button" onClick={() => void removeMember(member.id)}>确认</button>
                              <button disabled={memberDeleteBusy} type="button" onClick={() => setMemberDeleteCandidate("")}>取消</button>
                            </div>
                          ) : <button className="member-delete-trigger" type="button" onClick={() => { setMemberDeleteCandidate(member.id); setMemberDeleteMessage(""); }}>移除</button>}
                        </div>
                        );
                      })}
                    </div>
                    {memberDeleteMessage ? <p className="member-management-message" role="status">{memberDeleteMessage}</p> : null}
                  </section>}
                </SettingsPanel>
              ) : null}

              {section === "general" ? (
                <SettingsPanel>
                  {generalDetail ? (
                    <GeneralSettingsDetail
                      detail={generalDetail}
                      onBack={() => setGeneralDetail(null)}
                      storageEstimate={storageEstimate}
                    />
                  ) : (
                    <>
                      <SettingCard compact title="通知" description="重要家庭事项和提醒。"><ToggleRow label="允许通知" checked={notifications} onChange={setNotifications} /></SettingCard>
                      {notifications ? <NotificationSystemSettings /> : null}
                      <SettingCard compact title="数据同步" description="在你的设备之间保持最新。"><ToggleRow label="自动同步" checked={sync} onChange={setSync} /></SettingCard>
                      <div className="general-link-list">
                        <button onClick={() => void openGeneralDetail("storage")} type="button"><span><b>存储管理</b><small>查看本机网页数据占用</small></span><i>›</i></button>
                        <button onClick={() => void openGeneralDetail("feedback")} type="button"><span><b>意见反馈</b><small>发送文字和截图</small></span><i>›</i></button>
                        <button onClick={() => void openGeneralDetail("about")} type="button"><span><b>关于 Fanmili</b><small>版本 1.0.3</small></span><i>›</i></button>
                      </div>
                      {authRequired && isFamilyAuthRequired() ? <button className="settings-signout-button" type="button" onClick={onSignOut}>退出账号</button> : null}
                    </>
                  )}
                </SettingsPanel>
              ) : null}
            </div>
          </div>
        </aside>
      </div>,
    document.body
  );
}

function MemberProfileEditor({
  member,
  onBack,
  onSaved
}: {
  member: FamilyMember;
  onBack: () => void;
  onSaved: (profile: MemberProfile) => void;
}) {
  const [birthCalendar, setBirthCalendar] = useState<"lunar" | "solar">(member.profile?.birthCalendar || "solar");
  const [birthDateInput, setBirthDateInput] = useState(formatMemberBirthDateInput(member.profile?.birthDate || ""));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const birthDate = parseMemberBirthDateInput(birthDateInput, birthCalendar) || "";
  const age = birthDate ? calculateMemberAge(birthDate, birthCalendar) : undefined;

  useEffect(() => {
    setBirthCalendar(member.profile?.birthCalendar || "solar");
    setBirthDateInput(formatMemberBirthDateInput(member.profile?.birthDate || ""));
    setMessage("");
  }, [member.id, member.profile?.birthCalendar, member.profile?.birthDate]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!birthDate) {
      setMessage(birthDateInput.trim() ? "请输入正确的完整生日。" : "请输入或选择生日。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const response = await familyFetch("/api/family-members", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          birthCalendar,
          birthDate,
          memberId: member.id
        })
      });
      const payload = await response.json() as { detail?: string; member?: { profile?: MemberProfile } };
      if (!response.ok) throw new Error(payload.detail || "成员资料保存失败。");
      const profile = payload.member?.profile || { age, birthCalendar, birthDate };
      onSaved(profile);
      setMessage("资料已保存，AI 查询时会引用这条已确认资料。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "成员资料保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label={`${member.displayName}资料`} className="member-profile-editor">
      <header>
        <button aria-label="返回成员列表" onClick={onBack} type="button">‹</button>
        <span className="member-management-avatar"><AvatarImage alt="" decoding="sync" height={44} label={member.displayName} loading="eager" seed={member.avatarSeed} width={44} /></span>
        <span><strong>{member.displayName}</strong><small>已确认资料会成为 AI 回答依据</small></span>
      </header>
      <form onSubmit={saveProfile}>
        <fieldset>
          <legend>生日历法</legend>
          <div className="member-calendar-options">
            <button aria-pressed={birthCalendar === "solar"} className={birthCalendar === "solar" ? "selected" : ""} onClick={() => setBirthCalendar("solar")} type="button">公历</button>
            <button aria-pressed={birthCalendar === "lunar"} className={birthCalendar === "lunar" ? "selected" : ""} onClick={() => setBirthCalendar("lunar")} type="button">农历</button>
          </div>
        </fieldset>
        <label>
          <span>生日</span>
          <span className="member-birth-date-control">
            <input
              aria-label="手动输入生日"
              autoComplete="bday"
              inputMode="numeric"
              maxLength={14}
              onChange={(event) => setBirthDateInput(formatMemberBirthDateInput(event.target.value))}
              placeholder="YYYY / MM / DD"
              type="text"
              value={birthDateInput}
            />
            <span className="member-birth-date-picker" aria-hidden="true">
              <svg fill="none" viewBox="0 0 24 24"><path d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>
              <input
                aria-label="打开生日选择器"
                max={memberBirthDatePickerMax(birthCalendar)}
                min="1900-01-01"
                onChange={(event) => setBirthDateInput(formatMemberBirthDateInput(event.target.value))}
                tabIndex={-1}
                type="date"
                value={birthDate}
              />
            </span>
          </span>
          <small className="member-birth-date-hint">可直接输入，也可点击日历选择</small>
        </label>
        <label className="member-derived-age"><span>年龄</span><output aria-label="年龄">{age === undefined ? "填写生日后自动计算" : `${age} 岁`}</output><small>按当前日期自动更新</small></label>
        <button className="member-profile-save" disabled={saving} type="submit">{saving ? "保存中…" : "保存资料"}</button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

function formatMemberProfileSummary(profile?: MemberProfile) {
  const details = [];
  if (profile?.birthDate) {
    const [, month, day] = profile.birthDate.split("-").map(Number);
    details.push(`${profile.birthCalendar === "lunar" ? "农历" : "公历"} ${month}月${day}日`);
  }
  if (profile?.age !== undefined) details.push(`${profile.age}岁`);
  return details.join(" · ") || "点开补充生日、年龄";
}

function AssistantConfigCard({
  activeField,
  memory,
  message,
  name,
  personality,
  saving,
  onFieldChange,
  onMemoryChange,
  onNameChange,
  onPersonalityChange,
  onSave
}: {
  activeField: "name" | "personality" | "memory" | null;
  memory: string;
  message: string;
  name: string;
  personality: string;
  saving: boolean;
  onFieldChange: (field: "name" | "personality" | "memory") => void;
  onMemoryChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onPersonalityChange: (value: string) => void;
  onSave: (field: "name" | "personality" | "memory") => void;
}) {
  const rows = [
    { field: "name" as const, label: "名称", summary: name || DEFAULT_ASSISTANT_NAME },
    { field: "personality" as const, label: "个性", summary: personality || "开朗、务实" },
    { field: "memory" as const, label: "记忆", summary: memory.trim() ? "待保存" : "设置初始记忆" }
  ];

  return (
    <section className="assistant-config-card" aria-label="AI 助手配置">
      <div className="assistant-config-fields">
        {rows.map((row) => (
          <div className={activeField === row.field ? "assistant-config-field open" : "assistant-config-field"} key={row.field}>
            <button type="button" onClick={() => onFieldChange(row.field)} aria-expanded={activeField === row.field}>
              <span>{row.label}</span>
              <small>{row.summary}</small>
              <i aria-hidden="true">›</i>
            </button>
            {activeField === row.field ? (
              <div className="assistant-config-editor">
                {row.field === "name" ? (
                  <input autoFocus maxLength={16} value={name} onChange={(event) => onNameChange(event.target.value)} />
                ) : row.field === "personality" ? (
                  <AiPersonalityEditor value={personality} onChange={onPersonalityChange} />
                ) : (
                  <>
                    <textarea
                      autoFocus
                      maxLength={row.field === "memory" ? 500 : 300}
                      rows={4}
                      value={row.field === "memory" ? memory : personality}
                      onChange={(event) => row.field === "memory" ? onMemoryChange(event.target.value) : onPersonalityChange(event.target.value)}
                      placeholder={row.field === "memory" ? `写下希望${DEFAULT_ASSISTANT_NAME}最先了解的家庭信息` : "例如：开朗、务实，回答简洁"}
                    />
                    {row.field === "memory" ? <p className="assistant-memory-hint">这是初始记忆，之后会随家庭记录持续更新；你也可以随时补充或修正。</p> : null}
                  </>
                )}
                <button className="assistant-config-save" disabled={saving} type="button" onClick={() => onSave(row.field)}>
                  {saving ? "保存中…" : row.field === "memory" ? "确认保存记忆" : "保存"}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {message ? <p className="assistant-config-message" role="status">{message}</p> : null}
    </section>
  );
}

function AiTuningCard({ state, onRun }: { state: AiTuningState; onRun: () => void }) {
  const running = state.status === "running";
  const statusText = running
    ? "正在测试 3 组向量…"
    : state.status === "loading"
      ? "读取中…"
      : state.status === "ready"
        ? `已优化 · ${state.profile?.score || 0} 分`
        : state.status === "error"
          ? "调参未完成"
          : "尚未调参";
  return (
    <section className="ai-tuning-card" aria-label="AI 调参">
      <header>
        <div><strong>AI 调参</strong><small>固定测试向量 · 当前 API</small></div>
        <span className={`ai-tuning-status ${state.status}`}><i />{statusText}</span>
      </header>
      <p>测试结构化输出、指令遵循和响应速度，自动校准超时、重试与默认采样参数。</p>
      {state.profile ? (
        <div className="ai-tuning-metrics" aria-label="当前调参结果">
          <span><small>通过</small><strong>{state.profile.passedVectors}/{state.profile.totalVectors}</strong></span>
          <span><small>平均响应</small><strong>{state.profile.averageLatencyMs}ms</strong></span>
          <span><small>超时</small><strong>{state.profile.timeoutMs / 1000}s</strong></span>
          <span><small>重试</small><strong>{state.profile.maxRetries}</strong></span>
        </div>
      ) : null}
      {state.detail ? <p className="ai-tuning-detail" role="status">{state.detail}</p> : null}
      <button className="ai-tuning-run" disabled={running || state.status === "loading"} onClick={onRun} type="button">
        {running ? "正在调参…" : state.profile ? "重新调参" : "开始调参"}
      </button>
    </section>
  );
}

function AiPersonalityEditor({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const selectedPreset = aiPersonalityPresets.find((preset) => preset.value === value);
  const custom = !selectedPreset;
  return (
    <div className="ai-personality-editor">
      <div className="ai-personality-presets" aria-label="选择 AI 个性">
        {aiPersonalityPresets.map((preset) => (
          <button
            aria-pressed={selectedPreset?.id === preset.id}
            className={selectedPreset?.id === preset.id ? "selected" : ""}
            key={preset.id}
            type="button"
            onClick={() => onChange(preset.value)}
          >
            {preset.label}
          </button>
        ))}
        <button aria-pressed={custom} className={custom ? "selected" : ""} type="button" onClick={() => !custom && onChange("")}>自定义</button>
      </div>
      {custom ? <textarea autoFocus maxLength={300} rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder="写下你希望 AI 使用的语气和回答方式" /> : null}
    </div>
  );
}

function GeneralSettingsDetail({
  detail,
  onBack,
  storageEstimate
}: {
  detail: GeneralDetail;
  onBack: () => void;
  storageEstimate: { quota?: number; usage?: number } | null;
}) {
  const title = detail === "storage" ? "存储管理" : detail === "feedback" ? "意见反馈" : "关于 Fanmili";
  return (
    <section aria-label={`${title}详情`} className="settings-general-detail">
      <header>
        <button aria-label="返回通用设置" onClick={onBack} type="button">‹</button>
        <strong>{title}</strong>
      </header>
      {detail === "storage" ? (
        <div className="settings-detail-card">
          <span>本机网页数据</span>
          <strong>{storageEstimate === null ? "正在读取…" : formatStorageBytes(storageEstimate.usage)}</strong>
          <small>{storageEstimate?.quota ? `可用配额 ${formatStorageBytes(storageEstimate.quota)}` : "浏览器未提供存储配额详情"}</small>
        </div>
      ) : null}
      {detail === "feedback" ? <FeedbackSettingsDetail /> : null}
      {detail === "about" ? (
        <div className="settings-detail-card">
          <strong>Fanmili 1.0.3</strong>
          <small>爱上记录，守护家庭。</small>
          <p className="about-api-notice"><b>使用提示</b><span>Fanmili 不内置大模型；使用 AI 功能前，必须先在设置中配置可用的大模型 API。</span></p>
        </div>
      ) : null}
    </section>
  );
}

const feedbackEmail = "1219611671@qq.com";
const feedbackGitHubUrl = "https://github.com/sujianleo/Fanmili";
const maxFeedbackScreenshots = 4;
const maxFeedbackScreenshotBytes = 10 * 1024 * 1024;

type FeedbackScreenshot = {
  file: File;
  id: string;
  previewUrl: string;
};

function FeedbackSettingsDetail() {
  const [feedbackText, setFeedbackText] = useState("");
  const [screenshots, setScreenshots] = useState<FeedbackScreenshot[]>([]);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [sharing, setSharing] = useState(false);
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlsRef = useRef(new Set<string>());

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);

  function addScreenshots(files: FileList | null) {
    if (!files?.length) return;
    const availableSlots = maxFeedbackScreenshots - screenshots.length;
    const accepted = Array.from(files)
      .filter((file) => file.type.startsWith("image/") && file.size <= maxFeedbackScreenshotBytes)
      .slice(0, Math.max(0, availableSlots));

    if (!accepted.length) {
      setFeedbackMessage(availableSlots <= 0 ? `最多添加 ${maxFeedbackScreenshots} 张截图。` : "请选择 10 MB 以内的图片。");
      return;
    }

    const next = accepted.map((file, index) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.add(previewUrl);
      return {
        file,
        id: `${file.name}-${file.lastModified}-${file.size}-${index}`,
        previewUrl
      };
    });
    setScreenshots((current) => [...current, ...next]);
    setFeedbackMessage(accepted.length < files.length ? `已添加 ${accepted.length} 张；最多 ${maxFeedbackScreenshots} 张，且单张不超过 10 MB。` : "");
  }

  function removeScreenshot(id: string) {
    setScreenshots((current) => current.filter((item) => {
      if (item.id !== id) return true;
      URL.revokeObjectURL(item.previewUrl);
      previewUrlsRef.current.delete(item.previewUrl);
      return false;
    }));
    setFeedbackMessage("");
  }

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const description = feedbackText.trim();
    if (!description && screenshots.length === 0) {
      setFeedbackMessage("请填写反馈内容或添加截图。");
      return;
    }

    const subject = "Fanmili 意见反馈";
    const body = [
      "Fanmili 意见反馈",
      "",
      description || "（反馈见截图）",
      "",
      "应用版本：1.0.3",
      `项目地址：${feedbackGitHubUrl}`
    ].join("\n");
    const files = screenshots.map((item) => item.file);
    const sharePayload = { files, text: `${body}\n\n联系邮箱：${feedbackEmail}`, title: subject };
    const canShareFiles = files.length > 0
      && typeof navigator.canShare === "function"
      && navigator.canShare(sharePayload);

    setSharing(true);
    setFeedbackMessage("");
    try {
      if (typeof navigator.share === "function" && (files.length === 0 || canShareFiles)) {
        await navigator.share(files.length ? sharePayload : { text: sharePayload.text, title: subject });
        setFeedbackMessage(`已交给系统分享，请发送至 ${feedbackEmail}。`);
        return;
      }

      window.location.href = `mailto:${feedbackEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setFeedbackMessage(files.length
        ? `邮件草稿已打开，请将已选的 ${files.length} 张截图加入附件后发送。`
        : "邮件草稿已打开，请确认后发送。");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setFeedbackMessage("已取消发送，内容仍保留在这里。");
      } else {
        setFeedbackMessage(`暂时无法打开分享，请直接邮件联系 ${feedbackEmail}。`);
      }
    } finally {
      setSharing(false);
    }
  }

  async function copyFeedbackEmail() {
    try {
      await navigator.clipboard.writeText(feedbackEmail);
      setFeedbackMessage("邮箱已复制。");
    } catch {
      setFeedbackMessage(`请手动复制邮箱：${feedbackEmail}`);
    }
  }

  return (
    <form className="feedback-form" onSubmit={submitFeedback}>
      <label className="feedback-copy-field">
        <span>反馈内容</span>
        <textarea
          maxLength={2000}
          onChange={(event) => setFeedbackText(event.target.value)}
          placeholder="请描述遇到的问题、期望效果或建议…"
          rows={6}
          value={feedbackText}
        />
        <small>{feedbackText.length}/2000</small>
      </label>

      <div className="feedback-screenshot-field">
        <div>
          <span>截图</span>
          <small>最多 4 张，单张不超过 10 MB</small>
        </div>
        <input
          accept="image/png,image/jpeg,image/webp,image/avif"
          aria-label="选择反馈截图"
          hidden
          multiple
          onChange={(event) => {
            addScreenshots(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          ref={screenshotInputRef}
          type="file"
        />
        <button
          className="feedback-add-screenshot"
          disabled={screenshots.length >= maxFeedbackScreenshots}
          onClick={() => screenshotInputRef.current?.click()}
          type="button"
        >
          ＋ 选择截图
        </button>
        {screenshots.length ? (
          <div className="feedback-preview-grid">
            {screenshots.map((item, index) => (
              <figure key={item.id}>
                <img alt={`反馈截图 ${index + 1}`} src={item.previewUrl} />
                <button aria-label={`移除反馈截图 ${index + 1}`} onClick={() => removeScreenshot(item.id)} type="button">×</button>
              </figure>
            ))}
          </div>
        ) : null}
      </div>

      <div className="feedback-contact-card">
        <span>联系方式</span>
        <div><a href={`mailto:${feedbackEmail}`}>{feedbackEmail}</a><button onClick={() => void copyFeedbackEmail()} type="button">复制</button></div>
        <small>GitHub：<a href={feedbackGitHubUrl} rel="noreferrer" target="_blank">github.com/sujianleo/Fanmili</a></small>
      </div>

      <button className="settings-detail-primary feedback-submit" disabled={sharing} type="submit">
        {sharing ? "正在打开分享…" : "发送反馈"}
      </button>
      {feedbackMessage ? <p aria-live="polite" className="feedback-message" role="status">{feedbackMessage}</p> : null}
    </form>
  );
}

function formatStorageBytes(value?: number) {
  if (!Number.isFinite(value) || !value) return "0 MB";
  if (value < 1024 ** 3) return `${Math.max(0.1, value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function SettingsPanel({ action, children, className = "" }: { action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`settings-panel ${className}`.trim()}>{action ? <div className="settings-panel-action">{action}</div> : null}{children}</section>;
}

function SettingCard({ title, description, children, compact = false }: { title: string; description: string; children: React.ReactNode; compact?: boolean }) {
  return <article className={`settings-card${compact ? " settings-card-compact" : ""}`}><div className="settings-card-copy"><strong>{title}</strong><p>{description}</p></div>{children}</article>;
}

function ConnectionCard({ title, status, meta, children }: { title: string; status: "idle" | "connected" | "failed"; meta: string; children: React.ReactNode }) {
  return <article className="settings-card connection-card"><div className="connection-head"><div><span className={`status-dot ${status}`} /><strong>{title}</strong></div><small aria-live="polite">{meta}</small></div><div className="compact-fields">{children}</div></article>;
}

function connectivityCardStatus(test: ConnectivityTest): "idle" | "connected" | "failed" {
  if (test.status === "success") return "connected";
  if (test.status === "failed") return "failed";
  return "idle";
}

function connectivityMeta(test: ConnectivityTest, idleText: string) {
  if (test.status === "testing") return "正在检测连接…";
  if (test.status === "success") return `联通正常 · ${test.latencyMs} ms`;
  if (test.status === "failed") return test.detail || "连接失败";
  return idleText;
}

function ConnectivityButton({ label, test, onTest }: { label: string; test: ConnectivityTest; onTest: () => void }) {
  const text = test.status === "testing" ? "测试中…" : test.status === "success" ? "再次测试" : test.status === "failed" ? "重新测试" : "测试连接";
  return (
    <button aria-label={`测试${label}网络联通性`} className={`${networkStyles.networkTest} ${networkStyles[test.status]}`} disabled={test.status === "testing"} onClick={onTest} type="button">
      <span aria-hidden="true" className={networkStyles.icon}>{test.status === "success" ? "✓" : test.status === "failed" ? "!" : "⌁"}</span>
      <span>{text}</span>
    </button>
  );
}

function CompactField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="compact-field"><span>{label}</span><input onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}

function EndpointField({ host, port, onHostChange, onPortChange }: { host: string; port: string; onHostChange: (value: string) => void; onPortChange: (value: string) => void }) {
  return (
    <div className={networkStyles.endpointField}>
      <label className={networkStyles.endpointRow}>
        <span>域名</span>
        <input aria-label="域名" autoCapitalize="none" autoCorrect="off" onChange={(event) => onHostChange(event.target.value)} spellCheck={false} value={host} />
      </label>
      <label className={networkStyles.endpointRow}>
        <span>端口</span>
        <input aria-label="端口" className={networkStyles.portInput} inputMode="numeric" onChange={(event) => onPortChange(event.target.value.replace(/\D/g, "").slice(0, 5))} value={port} />
      </label>
    </div>
  );
}

function parseNetworkDefaultEndpoint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { host: "", port: "" };
  try {
    const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return isFnosRemoteAddress(target.hostname) ? { host: "", port: "" } : { host: target.hostname, port: target.port };
  } catch {
    return { host: "", port: "" };
  }
}

function isTrialPublicAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return target.hostname.toLowerCase() === TRIAL_PUBLIC_HOST;
  } catch {
    return trimmed.toLowerCase().split(":")[0] === TRIAL_PUBLIC_HOST;
  }
}

function parseOwnNasEndpoint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请填写自己的 HTTPS 公网地址。");
  const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  const hostname = target.hostname.toLowerCase();
  if (target.protocol !== "https:") throw new Error("公网地址必须使用 HTTPS。");
  if (hostname === TRIAL_PUBLIC_HOST) throw new Error("这是公开试用地址，请填写你自己的公网域名。");
  if (isFnosRemoteAddress(hostname)) throw new Error("飞牛远程入口不能作为独立公网地址。");
  if (hostname === "localhost" || hostname.endsWith(".local") || !hostname.includes(".") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    throw new Error("请填写可从互联网直接访问的域名。");
  }
  return { host: hostname, origin: target.origin, port: target.port };
}

function isFnosRemoteAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const target = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return target.hostname.toLowerCase().endsWith(".fnos.net");
  } catch {
    return trimmed.toLowerCase().split(":")[0]?.endsWith(".fnos.net") || false;
  }
}

function normalizeNetworkDefaultPort(value: string) {
  const normalized = value.trim();
  if (!/^\d{1,5}$/.test(normalized)) return "";
  const port = Number(normalized);
  return port >= 1 && port <= 65535 ? String(port) : "";
}

function normalizeNetworkDefaultLan(value: string) {
  const normalized = value.trim().replace(/^https?:\/\//i, "").split("/")[0]?.split(":")[0] || "";
  return isCompleteLanAddress(normalized) ? normalized : "";
}

function SegmentedIpField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const segments = [...value.split(".").slice(0, 4), "", "", "", ""].slice(0, 4);

  function updateSegment(index: number, nextValue: string) {
    const nextSegments = [...segments];
    nextSegments[index] = nextValue.replace(/\D/g, "").slice(0, 3);
    onChange(formatIpSegments(nextSegments));
    if (nextSegments[index].length === 3 && index < 3) inputs.current[index + 1]?.focus();
  }

  return (
    <div className={networkStyles.ipField}>
      <div className={networkStyles.ipSegments}>
        {segments.map((segment, index) => (
          <div className={networkStyles.ipSegment} key={index}>
            <input
              aria-label={`LAN IP 第 ${index + 1} 段`}
              inputMode="numeric"
              maxLength={3}
              onChange={(event) => updateSegment(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Backspace" && !segment && index > 0) inputs.current[index - 1]?.focus();
              }}
              ref={(node) => { inputs.current[index] = node; }}
              value={segment}
            />
            {index < 3 ? <i aria-hidden="true">·</i> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatIpSegments(segments: string[]) {
  if (segments.every((segment) => !segment)) return "";
  return segments.join(".").replace(/\.+$/, ".");
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><i /></label>;
}

function SegmentedControl({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <div className="settings-segmented">{options.map((option) => <button className={value === option.value ? "active" : ""} key={option.value} onClick={() => onChange(option.value)} type="button">{option.label}</button>)}</div>;
}

function ThemePreview({ family }: { family: ThemeFamily }) {
  return <div className={`theme-preview ${family}`} aria-hidden="true"><span className="preview-sidebar" /><span className="preview-title" /><span className="preview-line one" /><span className="preview-line two" /><span className="preview-card first" /><span className="preview-card second" /></div>;
}

function ProviderCard({ provider, usage, onChange, onRemove, onTest }: { provider: AiProvider; usage?: ApiUsageState; onChange: (patch: Partial<AiProvider>) => void; onRemove: () => void; onTest: () => void }) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const statusText = provider.status === "connected" ? "已连接" : provider.status === "testing" ? "测试中" : provider.status === "idle" ? "未测试" : "连接失败";
  const kind = provider.kind || "custom";
  const preset = providerPresets.find((candidate) => candidate.kind === kind) || providerPresets.at(-1)!;
  const codingPlanOnly = preset.group === "Coding Plan";
  const selectProvider = (nextKind: ProviderKind) => {
    const nextPreset = providerPresets.find((candidate) => candidate.kind === nextKind) || providerPresets.at(-1)!;
    onChange({
      kind: nextPreset.kind,
      name: nextPreset.label,
      endpoint: nextPreset.endpoint,
      deepModel: nextPreset.deepModels[0]?.id || "",
      fastModel: nextPreset.fastModels[0]?.id || "",
      status: "idle",
      testDetail: ""
    });
  };
  return (
    <article className="settings-card provider-card">
      <div className="provider-head">
        <div className="provider-head-picker">
          <SettingsDropdown
            ariaLabel="AI 服务商"
            floating
            options={providerPresets.map((option) => ({ group: option.group, label: option.label, value: option.kind }))}
            value={kind}
            onChange={(value) => selectProvider(value as ProviderKind)}
          />
        </div>
        <div className="provider-head-actions">
          <span className={`provider-status ${provider.status}`}><i />{statusText}</span>
          <button
            aria-label={`${confirmingRemove ? "确认删除" : "删除"}${provider.name}服务卡片`}
            className={`provider-remove${confirmingRemove ? " confirming" : ""}`}
            onBlur={() => setConfirmingRemove(false)}
            onClick={() => confirmingRemove ? onRemove() : setConfirmingRemove(true)}
            type="button"
          >
            {confirmingRemove ? "确认删除" : "删除"}
          </button>
        </div>
      </div>
      <div className="compact-fields">
        {kind === "custom" ? <CompactField label="API endpoint" value={provider.endpoint} onChange={(endpoint) => onChange({ endpoint })} /> : null}
        <label className="compact-field"><span>API key</span><input autoCapitalize="none" autoComplete="new-password" autoCorrect="off" name={`${kind}-api-key`} onChange={(event) => onChange({ apiKey: event.target.value })} placeholder="sk-••••••••" spellCheck={false} type="password" value={provider.apiKey} /></label>
        <ModelField
          custom={kind === "custom"}
          label="深度思考"
          models={preset.deepModels}
          onChange={(deepModel) => onChange({ deepModel })}
          value={provider.deepModel}
        />
        <ModelField
          custom={kind === "custom"}
          label="快速输出"
          models={preset.fastModels}
          onChange={(fastModel) => onChange({ fastModel })}
          value={provider.fastModel}
        />
      </div>
      {preset.usageNote ? <p className="provider-usage-note">{preset.usageNote}</p> : null}
      <div className="provider-usage-row" aria-label={`${provider.name} API 使用量统计`} title={usage?.status === "error" ? usage.detail : undefined}>
        <span>API 使用量统计</span>
        <strong>{formatApiUsageSummary(usage)}</strong>
      </div>
      <button className="provider-test" disabled={codingPlanOnly || provider.status === "testing"} onClick={onTest} type="button">
        {codingPlanOnly ? "仅供编程工具配置" : provider.status === "testing" ? "正在测试 API…" : "测试 API"}
      </button>
      {provider.testDetail ? <p className="provider-test-detail" role="status">{provider.testDetail}</p> : null}
    </article>
  );
}

function formatApiUsageSummary(usage?: ApiUsageState) {
  if (!usage) return "暂未接入";
  if (usage.status === "idle" || usage.status === "loading") return "读取中…";
  if (usage.status === "error") return "暂不可用";
  if (usage.usage.requestCount === 0) return "暂无记录";
  const requests = new Intl.NumberFormat("zh-CN").format(usage.usage.requestCount);
  const tokens = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(usage.usage.totalTokens);
  return `${requests} 次 · ${tokens} tokens · ${formatCnyCost(usage.usage.totalCostCny)}`;
}

function formatCnyCost(value: number) {
  if (value <= 0) return "¥0";
  if (value < 0.01) return "<¥0.01";
  return `¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)}`;
}

function ModelField({
  custom,
  label,
  models,
  onChange,
  value
}: {
  custom: boolean;
  label: string;
  models: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="compact-field provider-model-field">
      <span>{label}</span>
      {custom ? (
        <input onChange={(event) => onChange(event.target.value)} placeholder="填写模型 ID" value={value} />
      ) : (
        <SettingsDropdown ariaLabel={`${label}模型`} options={models.map((model) => ({ label: model.label, value: model.id }))} onChange={onChange} value={value} />
      )}
    </div>
  );
}

function SettingsDropdown({
  ariaLabel,
  floating = false,
  onChange,
  options,
  value
}: {
  ariaLabel: string;
  floating?: boolean;
  onChange: (value: string) => void;
  options: SettingsDropdownOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  return (
    <div className={`settings-dropdown${floating ? " floating" : ""}${open ? " open" : ""}`} ref={rootRef}>
      <button aria-expanded={open} aria-haspopup="listbox" aria-label={ariaLabel} className="settings-dropdown-trigger" onClick={() => setOpen((current) => !current)} type="button">
        <span>{selected?.label || value}</span><i aria-hidden="true" />
      </button>
      {open ? (
        <div aria-label={`${ariaLabel}选项`} className="settings-dropdown-menu" role="listbox">
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group && option.group !== options[index - 1]?.group ? <span className="settings-dropdown-group">{option.group}</span> : null}
              <button
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => { onChange(option.value); setOpen(false); }}
                role="option"
                type="button"
              >
                <span>{option.label}</span><i aria-hidden="true">✓</i>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
