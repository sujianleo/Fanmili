"use client";

import { use, useEffect, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { familyMembers } from "@/lib/mockData";
import { metaEventsToRoomMessages } from "@/lib/meta";
import { normalizePhoneNumber } from "@/lib/phoneAuth";
import { familyFetch } from "@/lib/familyApi";
import { withAppBasePath } from "@/lib/appBasePath";
import { formatChatTimestamp, shouldShowChatTimestamp } from "@/lib/chatMessageTime";
import type { FanmiliSticker } from "@/lib/fanmiliStickers";
import type { FamilyRecord, RoomMessage } from "@/lib/types";
import type { MetaEvent } from "@/lib/meta";
import { useChatPresence } from "@/lib/useChatPresence";
import { AvatarImage, MemberAvatar } from "@/components/avatar";
import { ComposerAutosizeTextarea } from "@/components/composer-autosize-textarea";
import { FanmiliStickerMessage, FanmiliStickerSuggestions } from "@/components/fanmili-stickers";
import { SharedGroupChatHeader, SharedGroupMemberStrip, SharedGroupMessage } from "@/components/shared-group-chat";

const GUEST_PHOTO_CACHE = "family-guest-photo-cache-v1";
const TUS_UPLOAD_CONCURRENCY = 2;

export default function GuestChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [phone, setPhone] = useState("");
  const [codeInput, setCodeInput] = useState<string[]>(["", "", "", ""]);
  const [unlocked, setUnlocked] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [guestIdentityId, setGuestIdentityId] = useState("guest");
  const [guestAvatarSeed, setGuestAvatarSeed] = useState("guest-friend");
  const [guestName, setGuestName] = useState("访客");
  const [inputValue, setInputValue] = useState("");
  const [showNameEditor, setShowNameEditor] = useState(false);
  const [avatarBatchIndex, setAvatarBatchIndex] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const codeInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [record, setRecord] = useState<GuestRoomRecord | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const members = (record?.chatMembers || [])
    .map((memberId) => familyMembers.find((member) => member.id === memberId))
    .filter(Boolean);
  const onlineMemberIds = useChatPresence(record?.id || slug, `guest:${guestIdentityId}`, unlocked && Boolean(record));
  const onlineCount = members.filter((member) => member && onlineMemberIds.has(member.id)).length;

  useEffect(() => {
    let active = true;
    familyFetch(`/api/guest-chat/session?slug=${encodeURIComponent(slug)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as GuestSessionResponse;
      })
      .then((payload) => {
        if (!active || !payload) return;
        enterGuestRoom(payload);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    if (!record?.id || !unlocked) {
      return;
    }

    let active = true;
    fetchGuestChatEvents(slug).then(async (events) => {
      events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      if (!active || events.length === 0) {
        return;
      }

      const hydratedMessages = await hydrateCachedPhotoPreviews(metaEventsToRoomMessages(events, guestIdentityId));
      if (!active) {
        return;
      }

      setMessages((currentMessages) => {
        const knownMessageIds = new Set(currentMessages.map((message) => message.id));
        const persistedMessages = hydratedMessages.filter((message) => !knownMessageIds.has(message.id));
        return persistedMessages.length ? [...currentMessages, ...persistedMessages] : currentMessages;
      });
    });

    return () => {
      active = false;
    };
  }, [guestIdentityId, record?.id, slug, unlocked]);

  useEffect(() => {
    if (!unlocked) {
      return;
    }

    const messagesNode = messagesRef.current;
    if (!messagesNode) {
      return;
    }

    requestAnimationFrame(() => {
      messagesNode.scrollTo({
        top: messagesNode.scrollHeight,
        behavior: "smooth"
      });
    });
  }, [messages.length, unlocked]);

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void authenticate(codeInput.join(""));
  }

  async function authenticate(code: string) {
    if (authSubmitting) return;
    if (!normalizePhoneNumber(phone)) {
      setAuthMessage("请输入正确的手机号，例如 13812345678。");
      return;
    }
    if (!/^\d{4}$/.test(code)) {
      setAuthMessage("请输入完整的四位口令。");
      return;
    }
    setAuthSubmitting(true);
    setAuthMessage("");
    const response = await familyFetch("/api/guest-chat/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code, slug })
    }).catch(() => null);
    setAuthSubmitting(false);
    if (!response?.ok) {
      const payload = response ? await response.json().catch(() => ({})) as { detail?: string } : {};
      setAuthMessage(payload.detail || "暂时无法进入群聊，请稍后重试。");
      setCodeInput(["", "", "", ""]);
      codeInputRefs.current[0]?.focus();
      return;
    }
    enterGuestRoom(await response.json() as GuestSessionResponse);
  }

  function enterGuestRoom(payload: GuestSessionResponse) {
    setGuestIdentityId(payload.identity.id);
    setGuestName(payload.identity.displayName);
    setRecord(payload.room);
    setMessages((payload.room.chatMessages || []).map((message) => ({ ...message, mine: message.senderMemberId === payload.identity.id })));
    setUnlocked(true);
    setCheckingSession(false);
  }

  function handleCodeCellChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, "");
    if (!digits) {
      const nextCode = replaceCodeDigit(codeInput, index, "");
      setCodeInput(nextCode);
      return;
    }

    const nextCode = mergeCodeDigits(codeInput, index, digits);
    const nextCodeText = nextCode.join("");
    setCodeInput(nextCode);

    const nextIndex = Math.min(3, index + digits.length);
    if (nextCodeText.length < 4) {
      codeInputRefs.current[nextIndex]?.focus();
      return;
    }

    codeInputRefs.current[3]?.blur();
    void authenticate(nextCodeText);
  }

  function handleCodeCellKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Backspace" || codeInput[index]) {
      return;
    }

    codeInputRefs.current[Math.max(0, index - 1)]?.focus();
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = inputValue.trim();
    if (!body || body.startsWith("/")) {
      return;
    }
    const message = {
      id: `guest-local-${Date.now()}`,
      senderName: guestName,
      senderAvatarSeed: guestAvatarSeed,
      senderMemberId: guestIdentityId,
      body,
      sentAt: "刚刚",
      mine: true
    };
    setMessages((currentMessages) => [...currentMessages, message]);
    void enqueueGuestChatEvent({
      slug,
      type: "group_chat_message",
      actorName: guestName,
      text: body,
      metadata: {
        inputText: body,
        kind: "group_chat_message",
        messageId: message.id,
        guestAvatarSeed,
        slug
      }
    });
    setInputValue("");
  }

  function sendSticker(sticker: FanmiliSticker) {
    const message: RoomMessage = {
      id: `guest-sticker-${Date.now()}`,
      senderName: guestName,
      senderAvatarSeed: guestAvatarSeed,
      senderMemberId: guestIdentityId,
      stickerId: sticker.id,
      body: sticker.text,
      sentAt: "刚刚",
      type: "text",
      mine: true
    };
    setMessages((currentMessages) => [...currentMessages, message]);
    setInputValue("");
    void enqueueGuestChatEvent({
      slug,
      type: "group_chat_message",
      actorName: guestName,
      text: sticker.text,
      metadata: {
        inputText: sticker.text,
        kind: "group_chat_sticker",
        messageId: message.id,
        guestAvatarSeed,
        stickerId: sticker.id,
        slug
      }
    });
  }

  async function handleAttachmentSelection(files: File[]) {
    if (!record || files.length === 0) {
      return;
    }

    const messageId = `guest-file-${Date.now()}`;
    setUploadProgress(8);
    const attachmentFiles = await Promise.all(files.map((file, index) => prepareAttachmentFile(file, messageId, index)));
    const message: RoomMessage = {
      id: messageId,
      senderName: guestName,
      senderAvatarSeed: guestAvatarSeed,
      senderMemberId: guestIdentityId,
      body: files.map((file) => file.name).join("、"),
      sentAt: "刚刚",
      type: "file",
      files: attachmentFiles,
      mine: true
    };

    setMessages((currentMessages) => [...currentMessages, message]);
    setUploadProgress(24);

    window.setTimeout(() => setUploadProgress((progress) => (progress > 0 && progress < 42 ? 42 : progress)), 160);
    window.setTimeout(() => setUploadProgress((progress) => (progress > 0 && progress < 75 ? 75 : progress)), 360);

    try {
      const { uploadFilesWithTus } = await import("@/lib/uploadQueue");
      const uploadedFiles = await uploadFilesWithTus(files, {
        messageId,
        onProgress: (progress) => setUploadProgress(Math.max(75, Math.min(99, progress)))
      });
      const persistedAttachmentFiles = attachmentFiles.map(({ previewUrl, ...file }, index) => ({
        ...file,
        ...(uploadedFiles[index] || {}),
        cacheUrl: uploadedFiles[index]?.previewUrl ? undefined : file.cacheUrl
      }));
      const hydratedAttachmentFiles = persistedAttachmentFiles.map((file, index) => ({
        ...file,
        previewUrl: file.previewUrl || attachmentFiles[index]?.previewUrl
      }));

      for (const [index, attachment] of attachmentFiles.entries()) {
        if (!uploadedFiles[index]?.previewUrl) {
          continue;
        }
        if (attachment.previewUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        const cacheUrl = attachment.cacheUrl;
        if (cacheUrl && typeof caches !== "undefined") {
          void caches.open(GUEST_PHOTO_CACHE).then((cache) => cache.delete(cacheUrl)).catch(() => undefined);
        }
      }

      setMessages((currentMessages) => currentMessages.map((item) => (item.id === messageId ? { ...item, files: hydratedAttachmentFiles } : item)));

      const [result] = await Promise.all([
        enqueueGuestChatEvent({
          slug,
          type: "group_attachment_selected",
          actorName: guestName,
          text: files.map((file) => file.name).join("、"),
          metadata: {
            cacheName: GUEST_PHOTO_CACHE,
            concurrency: TUS_UPLOAD_CONCURRENCY,
            files: persistedAttachmentFiles,
            inputText: files.map((file) => file.name).join("、"),
            kind: "group_attachment_selected",
            messageId: message.id,
            originalFiles: persistedAttachmentFiles.map((file) => ({
              cacheUrl: file.cacheUrl,
              name: file.name,
              originalUrl: file.originalUrl || file.url,
              size: file.size,
              storage: file.storage || (file.url ? "tus" : file.cacheUrl ? "browser-cache" : "metadata"),
              type: file.type,
              url: file.url
            })),
            protocol: "tus",
            guestAvatarSeed,
            slug
          }
        }),
        wait(760)
      ]);

      setUploadProgress(result ? 100 : 0);
      window.setTimeout(() => setUploadProgress(0), 1800);
    } catch {
      setUploadProgress(0);
    }
  }

  const avatarSeeds = [
    ["guest-friend", "guest-cousin", "mint-kid"],
    ["rice-a", "rice-b", "family-c"]
  ][avatarBatchIndex % 2];
  const showGuestCommands = inputValue.trimStart().startsWith("/");

  if (checkingSession) {
    return (
      <main className="guest-chat-shell guest-code-shell">
        <section aria-live="polite" className="guest-chat-card guest-code-card">
          <img alt="Fanmili" className="guest-code-logo" src={withAppBasePath("/family-logo-v2-192.png")} />
          <p>正在打开群聊…</p>
        </section>
      </main>
    );
  }

  if (!unlocked) {
    return (
      <main className="guest-chat-shell guest-code-shell">
        <form aria-label="访客登录" className="guest-chat-card guest-code-card" onSubmit={submitCode}>
          <img alt="Fanmili" className="guest-code-logo" src={withAppBasePath("/family-logo-v2-192.png")} />
          <h1>进入群聊</h1>
          <p>输入手机号和邀请人提供的四位口令。临时访客身份只保留在当前设备 24 小时；登录账号后才能跨设备找回。</p>
          <label className="guest-phone-field">
            <span className="sr-only">手机号</span>
            <input
              aria-label="手机号"
              autoComplete="tel"
              inputMode="tel"
              name="guestPhone"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="手机号"
              required
              type="tel"
              value={phone}
            />
          </label>
          <div className="guest-code-grid" role="group" aria-label="4 位口令">
            {Array.from({ length: 4 }).map((_, index) => (
              <input
                aria-label={`口令第 ${index + 1} 位`}
                autoComplete={index === 0 ? "one-time-code" : "off"}
                className="guest-code-cell"
                inputMode="numeric"
                key={index}
                maxLength={1}
                name={`inviteCode${index + 1}`}
                onChange={(event) => handleCodeCellChange(index, event)}
                onKeyDown={(event) => handleCodeCellKeyDown(index, event)}
                ref={(node) => {
                  codeInputRefs.current[index] = node;
                }}
                value={codeInput[index] || ""}
              />
            ))}
          </div>
          <button className="guest-enter-button" disabled={authSubmitting} type="submit">
            {authSubmitting ? "正在进入…" : "进入群聊"}
          </button>
          {authMessage ? <small className="guest-auth-message" role="alert">{authMessage}</small> : null}
        </form>
      </main>
    );
  }

  if (!record) {
    return (
      <main className="guest-chat-shell">
        <section className="guest-chat-card">
          <h1>群聊不存在</h1>
          <p>这个邀请可能已经失效。</p>
        </section>
      </main>
    );
  }

  return (
    <div className="chat-fullscreen guest-chat-fullscreen" role="dialog" aria-label="群聊界面">
        <SharedGroupChatHeader
          title={<div className="chat-title-button guest-chat-title">{record.title}</div>}
          trailing={<span className="guest-role-badge">访客</span>}
        />
        <div className="chat-context-stack">
        <SharedGroupMemberStrip label={`群成员，在线 ${onlineCount + 1}/${Math.max(members.length + 1, (record.chatMembers?.length || 0) + 1)}`}>
          {members.map((member) => (
            <i className={member && onlineMemberIds.has(member.id) ? "online" : "offline"} key={member?.id} title={`${member?.displayName} ${member && onlineMemberIds.has(member.id) ? "在线" : "离线"}`}>
              {member ? <MemberAvatar member={member} /> : null}
            </i>
          ))}
          <i className="online guest-current-member" title={`${guestName} 访客`}>
            <AvatarImage alt="" label={guestName} seed={guestAvatarSeed} />
          </i>
        </SharedGroupMemberStrip>
        </div>
        <main className="chat-fullscreen-messages" ref={messagesRef}>
          {messages.map((message, index) => (
            <GuestChatMessage key={message.id} message={message} timeLabel={shouldShowChatTimestamp(messages[index - 1], message) ? formatChatTimestamp(message.sentAt) : undefined} />
          ))}
        </main>
        <form className="composer chat-fullscreen-composer guest-chat-composer" onSubmit={submitMessage}>
          <FanmiliStickerSuggestions onSelect={sendSticker} query={inputValue} />
          {showGuestCommands ? (
            <div className="slash-menu guest-command-menu" aria-label="访客命令">
              <button type="button" onClick={() => setAvatarBatchIndex((index) => index + 1)}>
                <strong>换头像</strong>
                <span>切换一个临时头像</span>
              </button>
              <button type="button" onClick={() => setShowNameEditor(true)}>
                <strong>换昵称</strong>
                <span>设置这个群里的显示名</span>
              </button>
              <div className="guest-avatar-options" aria-label="选择访客头像">
                {avatarSeeds.map((seed) => (
                  <button
                    className={seed === guestAvatarSeed ? "active" : ""}
                    key={seed}
                    type="button"
                    onClick={() => {
                      setGuestAvatarSeed(seed);
                      setInputValue("");
                    }}
                  >
                    <AvatarImage alt="" label={guestName} seed={seed} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {showNameEditor ? (
            <div className="guest-name-editor">
              <input
                aria-label="访客昵称"
                autoComplete="nickname"
                id="guest-display-name"
                name="guestName"
                onChange={(event) => setGuestName(event.target.value || "访客")}
                value={guestName}
              />
              <button type="button" onClick={() => setShowNameEditor(false)}>
                完成
              </button>
            </div>
          ) : null}
          <span aria-label={guestName} className="home-avatar" role="img">
            <AvatarImage alt="" label={guestName} seed={guestAvatarSeed} />
          </span>
          <label className="composer-input-wrap">
            <ComposerAutosizeTextarea
              aria-label="群聊消息"
              autoComplete="off"
              id="guest-group-message"
              name="groupMessage"
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="说点什么..."
              value={inputValue}
            />
          </label>
          <input
            ref={fileInputRef}
            aria-label="选择附件"
            hidden
            name="groupAttachments"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              void handleAttachmentSelection(files);
              event.currentTarget.value = "";
            }}
            type="file"
          />
          <button className="guest-attachment-button" type="button" onClick={() => fileInputRef.current?.click()}>
            {uploadProgress > 0 ? (
              <span
                aria-label={`上传进度 ${uploadProgress}%`}
                className="guest-upload-progress-ring"
                role="status"
                style={{ "--upload-progress": `${uploadProgress * 3.6}deg` } as CSSProperties}
              />
            ) : null}
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
              <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
            </svg>
            <span className="sr-only">{uploadProgress > 0 ? `上传进度 ${uploadProgress}%` : "附件"}</span>
          </button>
          <button type="submit" aria-label="发送">
            <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" viewBox="0 0 24 24">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </form>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function replaceCodeDigit(code: string[], index: number, value: string) {
  const digits = [...code];
  digits[index] = value;
  return digits.slice(0, 4);
}

function mergeCodeDigits(code: string[], index: number, value: string) {
  const digits = [...code];
  for (const [offset, digit] of value.slice(0, 4 - index).split("").entries()) {
    digits[index + offset] = digit;
  }
  return digits.slice(0, 4);
}

type GuestRoomRecord = Pick<FamilyRecord, "id" | "spaceId" | "title" | "chatMembers" | "chatMessages">;
type GuestSessionResponse = {
  identity: { id: string; displayName: string; phoneLast4: string };
  room: GuestRoomRecord;
};

async function fetchGuestChatEvents(slug: string) {
  const response = await familyFetch(`/api/guest-chat/messages?slug=${encodeURIComponent(slug)}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return [];
  const payload = await response.json() as { events?: MetaEvent[] };
  return payload.events || [];
}

async function enqueueGuestChatEvent(event: { slug: string; type: "group_chat_message" | "group_attachment_selected"; actorName: string; text: string; metadata: Record<string, unknown> }) {
  const response = await familyFetch("/api/guest-chat/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: event.slug, type: event.type, actor_name: event.actorName, text: event.text, metadata: event.metadata })
  }).catch(() => null);
  return response?.ok ? await response.json() as { id: string } : null;
}

function GuestAttachmentMessage({ message }: { message: RoomMessage }) {
  const files = message.files?.length ? message.files : [{ name: message.body }];
  const photoFiles = files.filter(isPhotoFile);
  const otherFiles = files.filter((file) => !isPhotoFile(file));

  return (
    <div className="guest-attachment-message">
      {photoFiles.length ? (
        <div className="guest-photo-preview">
          {photoFiles.slice(0, 4).map((file) => (
            file.previewUrl || file.url || file.originalUrl ? (
              <img alt={file.name} className="user-upload-image" key={`${message.id}-${file.name}`} src={photoPreviewSrc(file)} />
            ) : (
              <div className="guest-missing-preview" key={`${message.id}-${file.name}`}>
                图片已失效
              </div>
            )
          ))}
        </div>
      ) : null}
      {otherFiles.map((file) => (
        <div className="guest-file-pill" key={`${message.id}-${file.name}`}>
          <span className="guest-file-pill-text">
            <strong>{file.name}</strong>
            <small>{formatFileSize(file.size)}</small>
          </span>
          <span className="guest-file-pill-icon" aria-hidden="true">
            {fileIcon(file)}
          </span>
        </div>
      ))}
    </div>
  );
}

function GuestChatMessage({ message, timeLabel }: { message: RoomMessage; timeLabel?: string }) {
  const avatarSeed = message.senderAvatarSeed || familyMembers.find((member) => member.id === message.senderMemberId)?.avatarSeed || message.senderMemberId || message.senderName;

  return (
    <SharedGroupMessage
      avatar={<AvatarImage alt="" decoding="sync" fetchPriority="high" label={message.senderName} loading="eager" seed={avatarSeed} />}
      mine={Boolean(message.mine)}
      senderName={message.senderName}
      timeLabel={timeLabel}
    >
          <div className={message.mine ? "chat-message mine" : "chat-message"} data-message-id={message.id}>
            <div className="chat-message-content">
              {message.type === "file" ? <GuestAttachmentMessage message={message} /> : <FanmiliStickerMessage fallbackText={message.body} stickerId={message.stickerId} />}
            </div>
          </div>
    </SharedGroupMessage>
  );
}

function isPhotoFile(file?: { name: string; type?: string }) {
  const type = file?.type || "";
  const name = file?.name || "";
  return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name);
}

function photoPreviewSrc(file: { cacheUrl?: string; name: string; originalUrl?: string; previewUrl?: string; url?: string }) {
  const storedUrl = file.cacheUrl || file.previewUrl || file.url || file.originalUrl;
  if (storedUrl) {
    return storedUrl;
  }

  const title = escapeSvgText(stripFileExtension(file.name).slice(0, 18) || "图片");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 476 268"><defs><linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#2f7d74"/><stop offset=".58" stop-color="#5aa098"/><stop offset="1" stop-color="#d9e9e4"/></linearGradient></defs><rect width="476" height="268" rx="18" fill="url(#bg)"/><rect x="34" y="34" width="408" height="200" rx="13" fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width="4"/><circle cx="148" cy="98" r="28" fill="#fff" fill-opacity=".82"/><path d="M54 218l96-78 65 46 53-38 154 70H54Z" fill="#fff" fill-opacity=".78"/><text x="238" y="151" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="800" fill="#35514e" opacity=".72">${title}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function prepareAttachmentFile(file: File, messageId: string, index: number) {
  const cacheUrl = isPhotoFile(file) ? await cacheGuestPhoto(file, messageId, index) : undefined;

  return {
    cacheUrl,
    name: file.name,
    previewUrl: isPhotoFile(file) ? URL.createObjectURL(file) : undefined,
    size: file.size,
    type: file.type
  };
}

async function cacheGuestPhoto(file: File, messageId: string, index: number) {
  if (typeof caches === "undefined") {
    return undefined;
  }

  try {
    const cache = await caches.open(GUEST_PHOTO_CACHE);
    const cacheUrl = `/guest-photo-cache/${encodeURIComponent(messageId)}/${index}-${encodeURIComponent(file.name)}`;
    await cache.put(cacheUrl, new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } }));
    return cacheUrl;
  } catch {
    return undefined;
  }
}


async function hydrateCachedPhotoPreviews(messages: RoomMessage[]) {
  if (typeof caches === "undefined") {
    return messages;
  }

  return Promise.all(
    messages.map(async (message) => {
      if (!message.files?.length) {
        return message;
      }

      const files = await Promise.all(
        message.files.map(async (file) => {
          if (file.previewUrl || !file.cacheUrl || !isPhotoFile(file)) {
            return file;
          }

          const previewUrl = await cachedPhotoObjectUrl(file.cacheUrl);
          return previewUrl ? { ...file, previewUrl } : file;
        })
      );

      return { ...message, files };
    })
  );
}

async function cachedPhotoObjectUrl(cacheUrl: string) {
  try {
    const cache = await caches.open(GUEST_PHOTO_CACHE);
    const cached = await cache.match(cacheUrl);
    if (!cached) {
      return undefined;
    }

    return URL.createObjectURL(await cached.blob());
  } catch {
    return undefined;
  }
}

function fileIcon(file?: { name: string; type?: string }) {
  const type = file?.type || "";
  const name = file?.name || "";
  if (/pdf$/i.test(type) || /\.pdf$/i.test(name)) {
    return "PDF";
  }
  if (type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(name)) {
    return "▶";
  }
  if (type.startsWith("audio/") || /\.(mp3|m4a|wav|aac)$/i.test(name)) {
    return "♪";
  }
  if (/\.(docx?|pages)$/i.test(name)) {
    return "W";
  }
  if (/\.(xlsx?|csv|numbers)$/i.test(name)) {
    return "X";
  }
  return "文";
}

function stripFileExtension(name: string) {
  return name.replace(/\.[^./\\]+$/, "");
}

function escapeSvgText(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] || char);
}

function formatFileSize(size?: number) {
  if (!size || size <= 0) {
    return "文件";
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))}KB`;
  }
  return `${Math.round(size / 1024 / 1024)}MB`;
}
