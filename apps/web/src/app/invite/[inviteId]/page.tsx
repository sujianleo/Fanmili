"use client";

import Image from "next/image";
import { use, useEffect, useState } from "react";
import { AvatarImage } from "@/components/avatar";
import { familyFetch } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import { normalizePhoneNumber } from "@/lib/phoneAuth";
import styles from "./invite.module.css";

type InvitePreview = {
  expiresAt: string;
  familyName?: string;
  id: string;
  inviterName?: string;
  relationshipLabel?: string;
  avatarSeed?: string;
  remainingUses: number;
  status: "active" | "expired" | "revoked";
  targetName?: string;
  title?: string;
  type: "family" | "group";
  verified: boolean;
};

const avatarOptions = ["youth-man", "long-haired-woman", "teen-boy", "glasses-woman"];

export default function InvitePage({ params }: { params: Promise<{ inviteId: string }> }) {
  const { inviteId } = use(params);
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [avatarSeed, setAvatarSeed] = useState(avatarOptions[0]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const embeddedCode = new URLSearchParams(window.location.search).get("code")?.replace(/\D/g, "").slice(0, 4) || "";
    if (embeddedCode) setCode(embeddedCode);
    familyFetch(embeddedCode.length === 4 ? `/api/invites/${encodeURIComponent(inviteId)}/verify` : `/api/invites/${encodeURIComponent(inviteId)}`, embeddedCode.length === 4 ? { body: JSON.stringify({ code: embeddedCode }), headers: { "content-type": "application/json" }, method: "POST" } : { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { detail?: string; invite?: InvitePreview };
        if (!response.ok || !payload.invite) throw new Error(payload.detail || "邀请不存在。");
        setInvite(payload.invite);
        if (payload.invite.verified) setDisplayName(payload.invite.targetName || "");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "邀请不存在。"));
  }, [inviteId]);

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4}$/.test(code)) return setMessage("请输入 4 位验证码。");
    setBusy(true);
    setMessage("");
    const response = await familyFetch(`/api/invites/${encodeURIComponent(inviteId)}/verify`, { body: JSON.stringify({ code }), headers: { "content-type": "application/json" }, method: "POST" }).catch(() => null);
    setBusy(false);
    const payload = response ? await response.json().catch(() => ({})) as { detail?: string; invite?: InvitePreview } : {};
    if (!response?.ok || !payload.invite) return setMessage(payload.detail || "暂时无法验证邀请。");
    setInvite(payload.invite);
    setDisplayName(payload.invite.targetName || "");
  }

  async function registerFamilyAccount() {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized) return setMessage("请输入正确的手机号。");
    if (password.length < 8) return setMessage("密码至少需要 8 位。");
    if (password !== passwordRepeat) return setMessage("两次输入的密码不一致。");
    setBusy(true);
    setMessage("");
    const response = await familyFetch(`/api/invites/${encodeURIComponent(inviteId)}/accept`, {
      body: JSON.stringify({
        avatar_seed: avatarSeed,
        code,
        display_name: displayName.trim(),
        password,
        phone: normalized
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }).catch(() => null);
    setBusy(false);
    const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
    if (!response?.ok) return setMessage(payload.detail || "加入申请提交失败，请稍后重试。");
    setSubmitted(true);
    setMessage("加入申请已发送给家庭管理员。确认后，你就可以用这个手机号和密码登录。");
  }

  const unavailable = invite && invite.status !== "active";
  return (
    <main className={styles.shell}>
      <section className={styles.card}>
        <Image alt="Fanmili" className={styles.logo} height={72} priority src={withAppBasePath("/family-logo-v2-192.png")} width={72} />
        <span className={styles.eyebrow}>{invite?.type === "family" ? "邀请家人" : "邀请朋友加入讨论"}</span>
        <h1>{invite?.verified ? (invite.title || (invite.type === "family" ? "加入这个家庭" : "加入这个群聊")) : "验证邀请"}</h1>

        {!invite && !message ? <p className={styles.muted}>正在检查邀请…</p> : null}
        {unavailable ? <div className={styles.notice}>{invite.status === "revoked" ? "这个邀请已经撤销。" : "这个邀请已经过期或使用次数已满。"}</div> : null}

        {invite && !invite.verified && !unavailable ? (
          <form className={styles.stack} onSubmit={verifyCode}>
            <p className={styles.muted}>链接只用于找到邀请。请输入邀请人提供的 4 位验证码，验证后才会显示家庭或群聊信息。</p>
            <input aria-label="4 位邀请验证码" autoComplete="one-time-code" className={styles.code} inputMode="numeric" maxLength={4} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="0000" value={code} />
            <button className={styles.primary} disabled={busy} type="submit">{busy ? "正在验证…" : "验证邀请"}</button>
          </form>
        ) : null}

        {invite?.verified ? (
          <div className={styles.stack}>
            <dl className={styles.summary}>
              {invite.inviterName ? <><dt>邀请人</dt><dd>{invite.inviterName}</dd></> : null}
              {invite.familyName ? <><dt>家庭</dt><dd>{invite.familyName}</dd></> : null}
              {invite.relationshipLabel ? <><dt>身份</dt><dd>{invite.relationshipLabel}</dd></> : null}
              <dt>有效期</dt><dd>{formatExpiry(invite.expiresAt)}</dd>
            </dl>

            {submitted ? (
              <div className={styles.notice}>申请已提交，请等待家庭管理员确认。</div>
            ) : (
              <div className={styles.signIn}>
                <h2>创建你的家庭账号</h2>
                <p className={styles.muted}>手机号和密码会加密保存在这台设备中。管理员确认后才能登录。</p>
                <label>你的称呼<input maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：小王" value={displayName} /></label>
                <div className={styles.avatars} aria-label="选择头像">{avatarOptions.map((seed) => <button aria-pressed={avatarSeed === seed} className={avatarSeed === seed ? styles.selected : ""} key={seed} onClick={() => setAvatarSeed(seed)} type="button"><AvatarImage alt="" decoding="sync" height={48} label={displayName} loading="eager" seed={seed} width={48} /></button>)}</div>
                <input aria-label="手机号" autoComplete="tel" inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder="手机号" value={phone} />
                <input aria-label="设置密码" autoComplete="new-password" minLength={8} onChange={(event) => setPassword(event.target.value)} placeholder="设置密码（至少 8 位）" type="password" value={password} />
                <input aria-label="确认密码" autoComplete="new-password" minLength={8} onChange={(event) => setPasswordRepeat(event.target.value)} placeholder="再次输入密码" type="password" value={passwordRepeat} />
                <button className={styles.primary} disabled={busy} onClick={() => void registerFamilyAccount()} type="button">{busy ? "正在提交…" : "提交注册申请"}</button>
              </div>
            )}
          </div>
        ) : null}

        {message ? <p className={styles.message} role="status">{message}</p> : null}
        <p className={styles.boundary}>{invite?.type === "group" ? "访客只能看到当前群聊和群文件，不能查看家庭资料、成员画像、历史记录或 AI 记忆。" : "注册不会自动授予家庭权限；只有管理员确认后，账号才会绑定家庭成员身份。"}</p>
      </section>
    </main>
  );
}

function formatExpiry(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "24 小时内" : date.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
