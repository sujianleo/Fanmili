"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";
import { familyFetch, isFamilyAuthRequired } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import { normalizePhoneNumber } from "@/lib/phoneAuth";
import { refreshPwaAppShell } from "./pwa-service-worker";
import styles from "./family-access-gate.module.css";

const rememberedAccountKey = "family-app-remembered-account";

export function FamilyAccessGate({ children, initialSignedIn }: { children: ReactNode; initialSignedIn: boolean }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(initialSignedIn);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    const rememberedAccount = window.localStorage.getItem(rememberedAccountKey);
    if (rememberedAccount) {
      setPhone(rememberedAccount);
    }
    void Promise.all([
      familyFetch("/api/auth/session", { cache: "no-store" }).then((response) => response.ok).catch(() => false),
      familyFetch("/api/setup/status", { cache: "no-store" }).then(async (response) => ({ ok: response.ok, payload: await response.json().catch(() => ({})) as { detail?: string; setupRequired?: boolean } })).catch(() => null)
    ]).then(([hasSession, statusResult]) => {
      setSignedIn(hasSession);
      if (!statusResult?.ok) {
        setMessage(statusResult?.payload.detail || "暂时无法读取本地家庭数据。");
        setSetupRequired(false);
        return;
      }
      setSetupRequired(Boolean(statusResult.payload.setupRequired));
    });
  }, []);

  if (!isFamilyAuthRequired() || signedIn) {
    return <>{children}</>;
  }

  async function signInWithPhone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      setMessage("请输入正确的手机号，例如 13812345678。");
      return;
    }
    if (!password) {
      setMessage("请输入密码。");
      return;
    }
    setSubmitting(true);
    setMessage("");
    const response = await familyFetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: normalizedPhone, password })
    }).catch(() => null);
    setSubmitting(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
      setMessage(payload.detail || "暂时无法登录，请稍后重试。");
      return;
    }
    window.localStorage.setItem(rememberedAccountKey, phone.trim());
    setPassword("");
    setSignedIn(true);
    refreshPwaAppShell();
  }

  async function createFamily(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!displayName.trim() || !familyName.trim()) {
      setMessage("请填写你的名字和家庭名称。");
      return;
    }
    if (!normalizedPhone) {
      setMessage("请输入正确的手机号，例如 13812345678。");
      return;
    }
    if (password.length < 8) {
      setMessage("密码至少需要 8 个字符。");
      return;
    }
    setSubmitting(true);
    setMessage("");
    const response = await familyFetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, familyName, password, phone: normalizedPhone })
    }).catch(() => null);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
      setSubmitting(false);
      setMessage(payload.detail || "创建家庭失败，请重试。");
      return;
    }
    const signInResult = await familyFetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: normalizedPhone, password })
    }).then((response) => ({ error: response.ok ? null : new Error("local sign-in failed") })).catch(() => null);
    setSubmitting(false);
    if (!signInResult || signInResult.error) {
      setSetupRequired(false);
      setMessage("家庭已创建，请使用刚才的账号登录。");
      return;
    }
    window.localStorage.setItem(rememberedAccountKey, phone.trim());
    setSignedIn(true);
    refreshPwaAppShell();
  }

  if (setupRequired === null) {
    return (
      <main className={`app-shell ${styles.state}`}>
        <div className={`${styles.card} ${styles.loading}`} aria-label="正在连接家庭数据库">
          <Image alt="" className={styles.logo} height={112} priority src={withAppBasePath("/family-logo-v2.png")} width={112} />
        </div>
      </main>
    );
  }

  return (
    <main className={`app-shell ${styles.state}`}>
      <form className={styles.card} onSubmit={setupRequired ? createFamily : signInWithPhone}>
        <Image alt="Fanmili" className={styles.logo} height={112} priority src={withAppBasePath("/family-logo-v2.png")} width={112} />
        {setupRequired ? <div className={styles.intro}><h1>创建家庭</h1><p>第一位成员将成为管理员。</p></div> : null}
        {setupRequired ? <label className={styles.field}>
          <input aria-label="你的名字" autoComplete="name" maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="你的名字" required value={displayName} />
        </label> : null}
        {setupRequired ? <label className={styles.field}>
          <input aria-label="家庭名称" autoComplete="organization" maxLength={40} onChange={(event) => setFamilyName(event.target.value)} placeholder="家庭名称" required value={familyName} />
        </label> : null}
        <label className={styles.field}>
          <input aria-label="账户" autoComplete="username" inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder="手机号" required type="tel" value={phone} />
        </label>
        <label className={styles.field}>
          <input aria-label="密码" autoComplete={setupRequired ? "new-password" : "current-password"} minLength={setupRequired ? 8 : undefined} onChange={(event) => setPassword(event.target.value)} placeholder={setupRequired ? "设置密码（至少 8 位）" : "密码"} required type="password" value={password} />
        </label>
        <button className={styles.submit} disabled={submitting} type="submit">{submitting ? (setupRequired ? "正在创建…" : "正在登录…") : (setupRequired ? "创建并进入" : "登录")}</button>
        {message ? <small className={styles.message} role="alert">{message}</small> : null}
      </form>
    </main>
  );
}
