/**
 * AI Analysis — ChatGPT-style thread + fixed composer (/api/chat).
 * Assistant replies stream from POST /api/chat/message/stream (SSE).
 */

import { marked } from "marked";

import { downloadInspectionPdfFromApi } from "./lib/inspection-pdf-api.js";
import { isHeicLike, normalizeImageFileForUpload } from "./heic-utils.js";

marked.setOptions({ breaks: true, gfm: true });

const _scrollPxRaw = import.meta.env.VITE_CHAT_SCROLL_NEAR_BOTTOM_PX;
const _scrollPxParsed = Number.parseInt(String(_scrollPxRaw ?? ""), 10);
const SCROLL_NEAR_BOTTOM_PX =
  Number.isFinite(_scrollPxParsed) && _scrollPxParsed > 0 ? _scrollPxParsed : 100;

function apiBase() {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (typeof base === "string" && base.trim() !== "") {
    return base.trim().replace(/\/$/, "");
  }
  return "";
}

function chatSessionUrl() {
  return `${apiBase()}/api/chat/session`;
}
function chatMessageStreamUrl() {
  return `${apiBase()}/api/chat/message/stream`;
}
function chatDeleteUrl(id) {
  return `${apiBase()}/api/chat/session/${encodeURIComponent(id)}`;
}

function isLikelyNetworkFailure(err) {
  if (err instanceof TypeError) {
    const m = String(err.message || "").toLowerCase();
    return (
      m.includes("fetch") ||
      m.includes("failed to fetch") ||
      m.includes("load failed") ||
      m.includes("networkerror")
    );
  }
  return err instanceof DOMException && err.name === "AbortError";
}

async function parseErrorDetail(res) {
  try {
    const j = await res.json();
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) {
      return j.detail.map((x) => x.msg || JSON.stringify(x)).join("; ");
    }
    return JSON.stringify(j.detail ?? j);
  } catch {
    return await res.text();
  }
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Raster image data URLs we persist and render.
 * (Mitigates tampered localStorage; excludes svg+xml and exotic vectors.)
 */
function isSafeStoredImageDataUrl(s) {
  return (
    typeof s === "string" &&
    s.length > 32 &&
    /^data:image\/(png|jpe?g|pjpeg|webp|gif|avif|bmp);base64,/i.test(s) &&
    !/data:image\/svg/i.test(s)
  );
}

/** Any non-SVG data-URL image from the file picker / DOM (broader than persist allowlist). */
function isRenderableRasterDataUrl(s) {
  return (
    typeof s === "string" &&
    s.length > 200 &&
    /^data:image\//i.test(s) &&
    /base64,/i.test(s) &&
    !/data:image\/svg/i.test(s)
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const u = r.result;
      if (typeof u === "string" && u.startsWith("data:image/")) resolve(u);
      else reject(new Error("Could not read image."));
    };
    r.onerror = () => reject(r.error || new Error("Could not read image."));
    r.readAsDataURL(file);
  });
}

async function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const u = r.result;
      if (typeof u === "string") resolve(u);
      else reject(new Error("Could not read image."));
    };
    r.onerror = () => reject(r.error || new Error("Could not read image."));
    r.readAsDataURL(blob);
  });
}

/** Resize to fit in localStorage; keeps JPEG for smaller payloads. */
function compressImageDataUrl(dataUrl, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
      resolve("");
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(dataUrl);
          return;
        }
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const cw = Math.round(w * scale);
        const ch = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        const out = canvas.toDataURL("image/jpeg", quality);
        resolve(out && out.length > 0 ? out : dataUrl);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const shell = document.getElementById("cht-shell");
  const dockEl = shell?.querySelector(".cht-dock");
  const topbarActionsEl = shell?.querySelector(".cht-topbar__actions");
  const emptyState = document.getElementById("gem-empty-state");
  const messagesEl = document.getElementById("gem-messages");
  const workspaceError = document.getElementById("workspace-error");
  const sendBtn = document.getElementById("gem-send-btn");
  const attachBtn = document.getElementById("gem-attach-btn");
  const fileInput = document.getElementById("gem-file-input");
  const inputEl = document.getElementById("gem-input");
  const uploadCard = document.getElementById("gem-upload-card");
  const pendingWrap = document.getElementById("gem-pending");
  const pendingImg = document.getElementById("gem-pending-img");
  const pendingRemove = document.getElementById("gem-pending-remove");
  const photoReadyHint = document.getElementById("gem-photo-ready-hint");
  const downloadBtn = document.getElementById("gem-download-btn");

  // Inspection stage (analysis-first UI). Shown between "image attached" and "first AI report".
  const stageEl = document.getElementById("cht-stage");
  const stageImg = document.getElementById("cht-stage-img");
  const stageStartBtn = document.getElementById("cht-stage-start");
  const stageReplaceBtn = document.getElementById("cht-stage-replace");
  const stageActions = document.getElementById("cht-stage-actions");
  const stageLoading = document.getElementById("cht-stage-loading");

  /**
   * Flow states (the sole source of truth for pre-analysis vs chat visibility):
   *   idle              → empty upload card.
   *   image_uploaded    → inspection stage (image + "Start Analysis"); dock hidden.
   *   analyzing         → inspection stage (image + spinner); dock hidden.
   *   analysis_complete → chat thread + dock visible; stage hidden forever for this session.
   */
  let flowState = "idle";
  let sessionId = "";
  let hasAnalysis = false;
  let pendingFile = null;
  let pendingDataUrl = "";
  let transcript = [];
  let busy = false;
  let activeController = null;
  let stopRequested = false;
  const showError = (msg) => {
    if (!workspaceError) return;
    workspaceError.textContent = msg;
    workspaceError.classList.remove("hidden");
    workspaceError.removeAttribute("hidden");
  };
  const hideError = () => {
    if (!workspaceError) return;
    workspaceError.textContent = "";
    workspaceError.classList.add("hidden");
    workspaceError.setAttribute("hidden", "");
  };

  const SEND_ICON = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7"/>
    </svg>`;

  const STOP_ICON = `
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="0" y="0" width="12" height="12" rx="2" fill="currentColor"/>
    </svg>`;

  const refreshSendButton = () => {
    if (!sendBtn) return;
    sendBtn.disabled = false;
    if (busy) {
      sendBtn.classList.add("is-stop");
      sendBtn.setAttribute("aria-label", "Stop generating");
      sendBtn.title = "Stop";
      sendBtn.innerHTML = STOP_ICON;
      return;
    }
    sendBtn.classList.remove("is-stop");
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.title = "Send";
    sendBtn.innerHTML = SEND_ICON;
  };

  /**
   * Sticky-bottom auto-scroll (vanilla DOM — no React “state”; plain refs/flags).
   *
   * Two signals:
   * - `isNearBottom` — geometry: within SCROLL_NEAR_BOTTOM_PX of the bottom.
   * - `userHasScrolledUp` — intent: any user-driven scroll with scrollTop decreasing (wheel/trackpad up).
   *
   * Auto-follow while streaming only if near bottom AND user has not scrolled up since last “pinned”
   * (`captureStickyBottom` = `!userHasScrolledUp && isNearBottom` before DOM grows).
   * Programmatic scroll sets `programmaticScroll` so we do not treat our own scroll as “user scrolled down”.
   * Resuming: when the user scrolls back into the bottom band, `userHasScrolledUp` clears.
   */
  const scrollWrap = document.getElementById("gem-messages-wrap");

  const getScrollWrap = () => scrollWrap || document.getElementById("gem-messages-wrap");

  const distanceFromBottom = (wrap) => {
    if (!wrap) return Number.POSITIVE_INFINITY;
    return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
  };

  const isNearBottom = (wrap, threshold = SCROLL_NEAR_BOTTOM_PX) =>
    !!wrap && distanceFromBottom(wrap) <= threshold;

  let isUserNearBottom = true;
  /** Any upward user scroll disables follow-until-bottom; cleared when user re-enters bottom band. */
  let userHasScrolledUp = false;
  /** Last scrollTop for direction detection (user events only). */
  let lastScrollTop = 0;
  /** True while we set scrollTop programmatically (avoid mis-classifying as user scroll-down). */
  let programmaticScroll = false;

  if (scrollWrap) {
    lastScrollTop = scrollWrap.scrollTop;
    scrollWrap.addEventListener(
      "scroll",
      () => {
        const wrap = scrollWrap;
        if (!wrap) return;
        if (programmaticScroll) {
          lastScrollTop = wrap.scrollTop;
          programmaticScroll = false;
          isUserNearBottom = isNearBottom(wrap);
          if (isNearBottom(wrap)) {
            userHasScrolledUp = false;
          }
          return;
        }
        const st = wrap.scrollTop;
        if (st < lastScrollTop - 0.5) {
          userHasScrolledUp = true;
        }
        lastScrollTop = st;
        isUserNearBottom = isNearBottom(wrap);
        if (isNearBottom(wrap)) {
          userHasScrolledUp = false;
        }
      },
      { passive: true },
    );
    isUserNearBottom = isNearBottom(scrollWrap);
  }

  const captureStickyBottom = () => {
    const wrap = getScrollWrap();
    if (!wrap || userHasScrolledUp) return false;
    return isNearBottom(wrap);
  };

  const applyStickyScrollAfter = (wasNearBottom) => {
    if (!wasNearBottom) return;
    const wrap = getScrollWrap();
    if (!wrap) return;
    programmaticScroll = true;
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
      lastScrollTop = wrap.scrollTop;
      isUserNearBottom = true;
      queueMicrotask(() => {
        if (programmaticScroll) programmaticScroll = false;
      });
    });
  };

  /** force=true: new chat / session restore — resets follow intent and jumps. */
  const scrollDown = (force = false) => {
    const wrap = getScrollWrap();
    if (!wrap) return;
    if (!force) {
      if (userHasScrolledUp || !isNearBottom(wrap)) return;
    } else {
      userHasScrolledUp = false;
    }
    programmaticScroll = true;
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
      lastScrollTop = wrap.scrollTop;
      isUserNearBottom = true;
      queueMicrotask(() => {
        if (programmaticScroll) programmaticScroll = false;
      });
    });
  };

  /** Keep textarea compact at start, then grow to 5 lines max. */
  const COMPOSER_LINES_MIN = 1;
  const COMPOSER_LINES_MAX = 5;
  const syncComposerHeight = () => {
    if (!inputEl) return;
    const cs = getComputedStyle(inputEl);
    let linePx = parseFloat(cs.lineHeight);
    if (Number.isNaN(linePx) || linePx <= 0) {
      const fs = parseFloat(cs.fontSize) || 16;
      linePx = fs * 1.5;
    }
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const minPx = linePx * COMPOSER_LINES_MIN + padY;
    const maxPx = linePx * COMPOSER_LINES_MAX + padY;
    inputEl.style.height = "auto";
    const sh = inputEl.scrollHeight;
    inputEl.style.height = `${Math.min(maxPx, Math.max(minPx, sh))}px`;
  };

  /**
   * Single source of truth for which surface is visible. Driven by `flowState`.
   * - `idle`              → upload card, no stage, dock blurred (legacy `awaiting-upload`).
   * - `image_uploaded`    → inspection stage w/ "Start Analysis"; dock hidden.
   * - `analyzing`         → inspection stage w/ spinner; dock hidden.
   * - `analysis_complete` → chat thread + dock. Stage hidden; legacy blur off.
   */
  function syncShellLayout() {
    if (!shell) return;

    const inspecting = flowState === "image_uploaded" || flowState === "analyzing";
    const chatting = flowState === "analysis_complete";
    const idle = flowState === "idle";

    shell.classList.toggle("cht-shell--inspecting", inspecting);
    shell.classList.toggle("cht-shell--chatted", chatting);
    shell.classList.toggle("cht-shell--awaiting-upload", idle);
    shell.classList.remove("cht-shell--photo-ready");

    if (emptyState) {
      emptyState.classList.toggle("hidden", !idle);
      if (!idle) emptyState.setAttribute("hidden", "");
      else emptyState.removeAttribute("hidden");
    }

    if (stageEl) {
      stageEl.classList.toggle("hidden", !inspecting);
      if (inspecting) stageEl.removeAttribute("hidden");
      else stageEl.setAttribute("hidden", "");
    }

    // Dock is only interactive + focusable in chat state.
    if (dockEl) {
      if (chatting) dockEl.removeAttribute("inert");
      else dockEl.setAttribute("inert", "");
    }
    if (topbarActionsEl) {
      if (chatting) topbarActionsEl.removeAttribute("inert");
      else topbarActionsEl.setAttribute("inert", "");
    }

    // Stage loading/actions toggle.
    if (stageActions && stageLoading) {
      const showLoading = flowState === "analyzing";
      stageActions.classList.toggle("hidden", showLoading);
      stageLoading.classList.toggle("hidden", !showLoading);
      if (showLoading) {
        stageLoading.removeAttribute("hidden");
        stageActions.setAttribute("hidden", "");
        if (stageStartBtn) stageStartBtn.disabled = true;
      } else {
        stageLoading.setAttribute("hidden", "");
        stageActions.removeAttribute("hidden");
        if (stageStartBtn) stageStartBtn.disabled = false;
      }
    }

    // Dead legacy element — keep hidden.
    if (photoReadyHint) {
      photoReadyHint.classList.add("hidden");
      photoReadyHint.setAttribute("hidden", "");
    }

    if (chatting) {
      requestAnimationFrame(() => {
        inputEl?.focus();
        syncComposerHeight();
      });
    }
  }

  const setFlowState = (next) => {
    if (flowState === next) return;
    flowState = next;
    syncShellLayout();
  };

  const appendMessage = (role, innerHtml) => {
    const letter = role === "user" ? "Y" : "AI";
    const label = role === "user" ? "You" : "AI";
    const row = el(`
      <div class="insp-msg insp-msg--${role}">
        <div class="insp-msg__head">
          <span class="insp-msg__avatar insp-msg__avatar--${role === "user" ? "you" : "ai"}">${letter}</span>
          <span class="insp-msg__name">${label}</span>
        </div>
        <div class="insp-msg__content">
          <div class="insp-msg__body">${innerHtml}</div>
        </div>
      </div>`);
    const wasNearBottom = captureStickyBottom();
    messagesEl?.appendChild(row);
    applyStickyScrollAfter(wasNearBottom);
  };

  const appendStreamingAssistantShell = () => {
    const row = el(`
      <div class="insp-msg insp-msg--assistant insp-msg--streaming" data-streaming="1">
        <div class="insp-msg__head">
          <span class="insp-msg__avatar insp-msg__avatar--ai">AI</span>
          <span class="insp-msg__name">AI</span>
        </div>
        <div class="insp-msg__content">
          <div class="insp-msg__body">
            <div class="insp-msg__md insp-msg__md--stream insp-msg__md--pending" aria-live="polite" aria-busy="true">
              <span class="insp-msg__stream-wait">
                <span class="analysis-spinner cht-spinner" aria-hidden="true"></span>
                <span>Thinking…</span>
              </span>
            </div>
          </div>
        </div>
      </div>`);
    const wasNearBottom = captureStickyBottom();
    messagesEl?.appendChild(row);
    applyStickyScrollAfter(wasNearBottom);
    const mdEl = row.querySelector(".insp-msg__md");
    return { row, mdEl };
  };

  const removeStreamingShell = () => {
    messagesEl?.querySelector("[data-streaming]")?.remove();
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    document.body.removeChild(ta);
  };

  const appendActionBar = (streamRow, getText) => {
    const bar = el(`
      <div class="insp-msg__actions" role="group" aria-label="Message actions">
        <button type="button" class="insp-msg__action" data-action="copy" aria-label="Copy response" title="Copy">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button type="button" class="insp-msg__action" data-action="like" aria-label="Good response" title="Good response">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
        </button>
        <button type="button" class="insp-msg__action" data-action="dislike" aria-label="Bad response" title="Bad response">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
        </button>
      </div>`);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === "copy") {
        const text = getText();
        const markCopied = () => {
          btn.classList.add("is-active");
          btn.setAttribute("aria-label", "Copied!");
          btn.title = "Copied!";
          btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
          setTimeout(() => {
            btn.classList.remove("is-active");
            btn.setAttribute("aria-label", "Copy response");
            btn.title = "Copy";
            btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
          }, 2000);
        };
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(markCopied).catch(() => {
            fallbackCopy(text);
            markCopied();
          });
        } else {
          fallbackCopy(text);
          markCopied();
        }
      } else if (action === "like") {
        const active = btn.classList.toggle("is-active");
        bar.querySelector("[data-action='dislike']")?.classList.remove("is-active");
        btn.setAttribute("aria-label", active ? "Liked" : "Good response");
      } else if (action === "dislike") {
        const active = btn.classList.toggle("is-active");
        bar.querySelector("[data-action='like']")?.classList.remove("is-active");
        btn.setAttribute("aria-label", active ? "Disliked" : "Bad response");
      }
    });

    streamRow?.querySelector(".insp-msg__content")?.appendChild(bar);
  };

  const lightbox = document.getElementById("cht-lightbox");
  const lightboxImg = document.getElementById("cht-lightbox-img");
  const lightboxClose = document.getElementById("cht-lightbox-close");

  const openLightbox = (src) => {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightbox.classList.remove("hidden");
    lightbox.removeAttribute("hidden");
    lightboxClose?.focus();
  };
  const closeLightbox = () => {
    if (!lightbox) return;
    lightbox.classList.add("hidden");
    lightbox.setAttribute("hidden", "");
    lightboxImg && (lightboxImg.src = "");
  };
  lightboxClose?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightbox && !lightbox.hasAttribute("hidden")) closeLightbox();
  });

  const buildUserHtml = (text, dataUrl) => {
    const t = escapeHtml(text || "").replace(/\n/g, "<br>");
    const safe =
      dataUrl && (isSafeStoredImageDataUrl(dataUrl) || isRenderableRasterDataUrl(dataUrl))
        ? dataUrl
        : "";
    const img = safe
      ? `<img class="insp-msg__img insp-msg__img--clickable" src="${safe}" alt="Uploaded site photo" width="280" height="200" data-preview-src="${safe}">`
      : "";
    return `${img}${img && t ? "<br>" : ""}${t || (img ? "" : "<i>(photo)</i>")}`;
  };

  const siteJson = () => "{}";

  const setPending = (file) => {
    pendingFile = file;
    if (!file) {
      pendingDataUrl = "";
      pendingWrap?.classList.add("hidden");
      pendingWrap?.setAttribute("hidden", "");
      if (fileInput) fileInput.value = "";
      // Keep the staged preview image during `analyzing` — the spec says the
      // image must remain visible while the spinner runs.
      if (flowState === "image_uploaded") {
        if (stageImg) stageImg.src = "";
        setFlowState("idle");
      } else {
        syncShellLayout();
      }
      return;
    }
    const r = new FileReader();
    r.onload = (ev) => {
      const u = ev.target?.result;
      if (typeof u === "string") {
        pendingDataUrl = u;
        if (pendingImg) {
          pendingImg.src = u;
          pendingImg.alt = "Attached preview";
        }
        pendingWrap?.classList.remove("hidden");
        pendingWrap?.removeAttribute("hidden");
        if (stageImg) {
          stageImg.src = u;
          stageImg.alt = "Uploaded site photo preview";
        }
      }
      // Before the first analysis: route the upload into the inspection stage.
      // After the first analysis: keep chat visible, show the pending chip in the dock.
      if (!hasAnalysis) {
        setFlowState("image_uploaded");
      } else {
        syncShellLayout();
      }
    };
    r.readAsDataURL(file);
  };

  const refreshToolbar = () => {
    if (downloadBtn) downloadBtn.disabled = !transcript.length;
    if (attachBtn) {
      attachBtn.disabled = false;
      attachBtn.title = "Attach site photo (replaces current analysis when you send)";
    }
  };

  const recordTx = (role, text, extra = {}) => {
    transcript.push({ role, text, ...extra });
    refreshToolbar();
  };

  const createSession = async () => {
    const res = await fetch(chatSessionUrl(), { method: "POST" });
    if (!res.ok) throw new Error(await parseErrorDetail(res));
    const j = await res.json();
    if (!j.session_id) throw new Error("No session from server.");
    sessionId = j.session_id;
  };

  const bootstrap = async () => {
    hideError();
    try {
      await createSession();
    } catch (e) {
      showError(
        isLikelyNetworkFailure(e)
          ? "Could not reach the API. Start the FastAPI backend (same port as VITE_API_PROXY_TARGET in .env, often 8010) and keep Vite dev running."
          : String(e.message || e),
      );
    }
  };

  const resetChat = async () => {
    persistCurrentSession();
    hideError();
    busy = false;
    if (sessionId) {
      try {
        await fetch(chatDeleteUrl(sessionId), { method: "DELETE" });
      } catch {
        /* ignore */
      }
    }
    sessionId = "";
    hasAnalysis = false;
    pendingFile = null;
    pendingDataUrl = "";
    transcript = [];
    if (messagesEl) messagesEl.innerHTML = "";
    if (stageImg) stageImg.src = "";
    flowState = "idle";
    setPending(null);
    if (inputEl) inputEl.value = "";
    syncComposerHeight();
    await bootstrap();
    refreshToolbar();
    scrollDown(true);
    renderSidebar();
  };

  /**
   * @returns {Promise<{ ok: boolean, accumulated?: string, usedVision?: boolean }>}
   */
  const consumeChatSse = async (res, mdEl, streamRow) => {
    if (!res.ok) {
      const detail = await parseErrorDetail(res);
      return { ok: false, error: detail };
    }
    if (!res.body) {
      return { ok: false, error: "No response body." };
    }

    let acc = "";
    let rafId = 0;
    const render = () => {
      rafId = 0;
      if (!mdEl) return;
      const wasNearBottom = captureStickyBottom();
      const src = acc.trim() ? acc : " ";
      mdEl.innerHTML = `<div class="insp-msg__md-inner">${marked.parse(src)}</div>`;
      applyStickyScrollAfter(wasNearBottom);
    };
    const scheduleRender = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(render);
    };

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    let usedVision = false;

    const applyFirstChunkUi = () => {
      if (!mdEl) return;
      mdEl.classList.remove("insp-msg__md--pending");
      mdEl.removeAttribute("aria-busy");
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of block.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = 0;
            }
            render();
            streamRow?.classList.remove("insp-msg--streaming");
            streamRow?.removeAttribute("data-streaming");
            const stickyForActions = captureStickyBottom();
            appendActionBar(streamRow, () => acc);
            applyStickyScrollAfter(stickyForActions);
            return { ok: true, accumulated: acc, usedVision };
          }
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (!obj || typeof obj !== "object") continue;
          if (obj.type === "chunk" && typeof obj.text === "string") {
            applyFirstChunkUi();
            acc += obj.text;
            scheduleRender();
          } else if (obj.type === "done") {
            usedVision = !!obj.used_vision;
          } else if (obj.type === "error") {
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = 0;
            }
            streamRow?.classList.remove("insp-msg--streaming");
            streamRow?.removeAttribute("data-streaming");
            return { ok: false, error: String(obj.detail || "Stream error"), accumulated: acc };
          }
        }
      }
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    render();
    streamRow?.classList.remove("insp-msg--streaming");
    streamRow?.removeAttribute("data-streaming");
    const stickyForActions = captureStickyBottom();
    appendActionBar(streamRow, () => acc);
    applyStickyScrollAfter(stickyForActions);
    return { ok: true, accumulated: acc, usedVision };
  };

  const send = async () => {
    if (busy) {
      if (activeController) {
        stopRequested = true;
        activeController.abort();
      }
      return;
    }
    if (!sessionId) return;
    const text = (inputEl?.value || "").trim();
    if (!hasAnalysis && !pendingFile && !text) {
      showError("Attach a site photo (and optional notes), then send.");
      return;
    }
    if (hasAnalysis && !pendingFile && !text) {
      showError("Type a follow-up question, or attach a new site photo to re-analyze.");
      return;
    }

    hideError();
    busy = true;
    stopRequested = false;
    activeController = new AbortController();
    refreshSendButton();

    // Analysis-first: the moment a first-analysis send begins, reveal the
    // chat surface so the user watches the AI response stream in live,
    // rather than waiting on the stage for the whole reply.
    const isFirstAnalysisSend = !hasAnalysis && Boolean(pendingFile);
    if (isFirstAnalysisSend) {
      setFlowState("analysis_complete");
    }

    // Snapshot file before clearing UI — always have bytes for transcript + PDF (FileReader is async).
    const fileToSend = pendingFile;
    let dataUrlSnapshot = pendingDataUrl;
    if (fileToSend) {
      if (!dataUrlSnapshot || !String(dataUrlSnapshot).startsWith("data:image/")) {
        try {
          dataUrlSnapshot = await readFileAsDataUrl(fileToSend);
        } catch {
          showError("Could not read the attached image. Wait for the preview, then try again.");
          busy = false;
          refreshSendButton();
          return;
        }
      }
    }

    appendMessage("user", buildUserHtml(text, fileToSend ? dataUrlSnapshot : ""));
    recordTx("user", text, { image: fileToSend ? dataUrlSnapshot : null });

    if (inputEl) inputEl.value = "";
    syncComposerHeight();
    setPending(null);

    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("message", text);
    if (fileToSend) {
      form.append("site_context", siteJson());
      form.append("image", fileToSend, fileToSend.name);
    }

    const { row: streamRow, mdEl } = appendStreamingAssistantShell();

    try {
      const res = await fetch(chatMessageStreamUrl(), {
        method: "POST",
        body: form,
        signal: activeController.signal,
      });
      const outcome = await consumeChatSse(res, mdEl, streamRow);

      if (!outcome.ok) {
        const detail = outcome.error || "Request failed";
        showError(detail);
        if (streamRow?.isConnected) {
          streamRow.classList.remove("insp-msg--streaming");
          streamRow.removeAttribute("data-streaming");
          if (mdEl) {
            mdEl.classList.remove("insp-msg__md--pending");
            mdEl.innerHTML = `<div class="insp-msg__md-inner"><p><strong>Something went wrong.</strong> ${escapeHtml(detail)}</p></div>`;
          }
        } else {
          appendMessage(
            "assistant",
            `<div class="insp-msg__md"><p><strong>Something went wrong.</strong> ${escapeHtml(detail)}</p></div>`,
          );
        }
        return;
      }

      const md = outcome.accumulated || "";
      recordTx("assistant", md);
      if (outcome.usedVision) {
        hasAnalysis = true;
      }
      const lastUserTx = [...transcript].reverse().find((t) => t.role === "user");
      if (lastUserTx?.image && typeof lastUserTx.image === "string") {
        const compressed = await compressImageDataUrl(lastUserTx.image);
        if (compressed) lastUserTx.image = compressed;
      }
      refreshToolbar();
      persistCurrentSession();
      renderSidebar();
    } catch (e) {
      const abortedByUser =
        stopRequested || (e instanceof DOMException && e.name === "AbortError");
      if (abortedByUser) {
        hideError();
        if (streamRow?.isConnected) {
          streamRow.classList.remove("insp-msg--streaming");
          streamRow.removeAttribute("data-streaming");
          if (mdEl && !mdEl.textContent?.trim()) {
            mdEl.classList.remove("insp-msg__md--pending");
            mdEl.innerHTML = "<div class=\"insp-msg__md-inner\"><p><em>Stopped.</em></p></div>";
          }
        }
        return;
      }
      removeStreamingShell();
      const msg = isLikelyNetworkFailure(e) ? "Network error — check API and proxy." : String(e.message || e);
      showError(msg);
      appendMessage("assistant", `<div class="insp-msg__md"><p>${escapeHtml(msg)}</p></div>`);
    } finally {
      busy = false;
      activeController = null;
      stopRequested = false;
      refreshSendButton();
      syncShellLayout();
      scrollDown();
    }
  };

  /**
   * Copy user photos from the live thread into transcript when storage stripped `image`
   * or MIME checks differed (e.g. AVIF preview in DOM).
   */
  const hydrateUserImagesFromDomForPdf = async () => {
    if (!messagesEl) return;
    const rows = [...messagesEl.querySelectorAll(".insp-msg--user")];
    const imgs = rows.map((row) => row.querySelector(".insp-msg__body img"));
    let ui = 0;
    for (const t of transcript) {
      if (t.role !== "user") continue;
      let domSrc = imgs[ui]?.getAttribute("src") || imgs[ui]?.src || "";
      ui += 1;
      if (domSrc.startsWith("blob:")) {
        try {
          const b = await fetch(domSrc).then((r) => r.blob());
          domSrc = await readBlobAsDataUrl(b);
        } catch {
          continue;
        }
      }
      if (!domSrc.startsWith("data:image/")) continue;
      if (t.image && (isSafeStoredImageDataUrl(t.image) || isRenderableRasterDataUrl(t.image)))
        continue;
      if (
        isSafeStoredImageDataUrl(domSrc) ||
        isRenderableRasterDataUrl(domSrc) ||
        domSrc.length > 400
      ) {
        t.image = domSrc;
      }
    }
  };

  const downloadMd = async () => {
    if (!transcript.length) return;
    if (downloadBtn) downloadBtn.disabled = true;
    try {
      await hydrateUserImagesFromDomForPdf();
      await downloadInspectionPdfFromApi({
        apiBase: apiBase(),
        sessionId,
        transcript,
      });
    } catch (e) {
      console.error("PDF export failed", e);
      showError(`Couldn't export PDF — ${String(e?.message || e)}`);
    } finally {
      if (downloadBtn) downloadBtn.disabled = !transcript.length;
    }
  };

  // ── Sidebar / session persistence ──────────────────────────────────────────

  const SESSIONS_KEY = "defectra_ai_sessions_v1";
  const MAX_SESSIONS = 50;

  const sidebarEl = document.getElementById("cht-sidebar");
  const sidebarSessionsEl = document.getElementById("cht-sidebar-sessions");
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebarNewBtn = document.getElementById("sidebar-new-btn");
  const sidebarBackdrop = document.getElementById("cht-sidebar-backdrop");

  const loadStoredSessions = () => {
    try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch { return []; }
  };

  const saveStoredSessions = (sessions) => {
    const slice = sessions.slice(0, MAX_SESSIONS);
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(slice));
    } catch {
      try {
        const stripped = slice.map((s) => ({
          ...s,
          msgs: (s.msgs || []).map((m) =>
            m.role === "user" ? { role: m.role, text: m.text || "", image: null, hasImage: !!(m.image || m.hasImage) } : m,
          ),
        }));
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(stripped));
      } catch {
        /* quota */
      }
    }
  };

  const persistCurrentSession = () => {
    if (!sessionId || !transcript.length) return;
    const firstUser = transcript.find((t) => t.role === "user");
    const title = (firstUser?.text || "").trim().slice(0, 80) || "New chat";
    const msgs = transcript.map((t) => ({
      role: t.role,
      text: t.text || "",
      image:
        t.role === "user" &&
        t.image &&
        (isSafeStoredImageDataUrl(t.image) || isRenderableRasterDataUrl(t.image))
          ? t.image
          : null,
    }));
    const sessions = loadStoredSessions();
    const idx = sessions.findIndex((s) => s.id === sessionId);
    const entry = { id: sessionId, title, createdAt: Date.now(), msgs };
    if (idx >= 0) sessions[idx] = entry;
    else sessions.unshift(entry);
    saveStoredSessions(sessions);
  };

  const renderRestoredMessages = (msgs) => {
    if (!messagesEl) return;
    for (const m of msgs) {
      const letter = m.role === "user" ? "Y" : "AI";
      const label = m.role === "user" ? "You" : "AI";
      let innerHtml;
      if (m.role === "user") {
        const stored =
          m.image && (isSafeStoredImageDataUrl(m.image) || isRenderableRasterDataUrl(m.image))
            ? m.image
            : "";
        if (stored) {
          innerHtml = buildUserHtml(m.text || "", stored);
        } else {
          const escaped = escapeHtml(m.text || "").replace(/\n/g, "<br>");
          const imgNote = m.hasImage ? `<p class="insp-msg__img-note">[Photo attached — re-upload if needed]</p>` : "";
          innerHtml = `${imgNote}${escaped}`;
        }
      } else {
        innerHtml = `<div class="insp-msg__md"><div class="insp-msg__md-inner">${marked.parse(m.text || "")}</div></div>`;
      }
      const row = el(`
        <div class="insp-msg insp-msg--${m.role === "user" ? "user" : "assistant"}">
          <div class="insp-msg__head">
            <span class="insp-msg__avatar insp-msg__avatar--${m.role === "user" ? "you" : "ai"}">${letter}</span>
            <span class="insp-msg__name">${label}</span>
          </div>
          <div class="insp-msg__content">
            <div class="insp-msg__body">${innerHtml}</div>
          </div>
        </div>`);
      messagesEl.appendChild(row);
    }
  };

  const openSidebar = () => {
    sidebarEl?.classList.add("is-open");
    sidebarBackdrop?.classList.remove("hidden");
    sidebarToggleBtn?.setAttribute("aria-expanded", "true");
  };

  const closeSidebar = () => {
    sidebarEl?.classList.remove("is-open");
    sidebarBackdrop?.classList.add("hidden");
    sidebarToggleBtn?.setAttribute("aria-expanded", "false");
  };

  const groupByDate = (sessions) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 6);
    const groups = { today: [], week: [], older: [] };
    for (const s of sessions) {
      if (s.createdAt >= todayStart.getTime()) groups.today.push(s);
      else if (s.createdAt >= weekStart.getTime()) groups.week.push(s);
      else groups.older.push(s);
    }
    return groups;
  };

  const renderSidebar = () => {
    if (!sidebarSessionsEl) return;
    const sessions = loadStoredSessions();
    if (!sessions.length) {
      sidebarSessionsEl.innerHTML = `<p class="cht-sidebar__empty">No previous chats</p>`;
      return;
    }
    const groups = groupByDate(sessions);
    const parts = [];
    const renderGroup = (label, items) => {
      if (!items.length) return;
      parts.push(`<div class="cht-sidebar__group"><div class="cht-sidebar__group-label">${label}</div>`);
      for (const s of items) {
        const active = s.id === sessionId ? " is-active" : "";
        const DEL_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
        parts.push(`
          <div class="cht-sidebar__item${active}" data-sid="${escapeHtml(s.id)}" role="button" tabindex="0">
            <span class="cht-sidebar__item-text">${escapeHtml(s.title)}</span>
            <button type="button" class="cht-sidebar__item-del" data-del="${escapeHtml(s.id)}" aria-label="Delete chat" title="Delete">${DEL_ICON}</button>
          </div>`);
      }
      parts.push(`</div>`);
    };
    renderGroup("Today", groups.today);
    renderGroup("Previous 7 days", groups.week);
    renderGroup("Older", groups.older);
    sidebarSessionsEl.innerHTML = parts.join("");

    sidebarSessionsEl.querySelectorAll(".cht-sidebar__item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (e.target.closest(".cht-sidebar__item-del")) return;
        const id = item.dataset.sid;
        if (id === sessionId) { closeSidebar(); return; }
        const entry = loadStoredSessions().find((s) => s.id === id);
        if (!entry) return;
        persistCurrentSession();
        sessionId = entry.id;
        hasAnalysis = entry.msgs.some((m) => !!(m.image || m.hasImage));
        transcript = entry.msgs.map((m) => ({
          role: m.role,
          text: m.text || "",
          image:
            m.image && (isSafeStoredImageDataUrl(m.image) || isRenderableRasterDataUrl(m.image))
              ? m.image
              : null,
        }));
        if (messagesEl) messagesEl.innerHTML = "";
        renderRestoredMessages(entry.msgs);
        // Restored sessions always bypass the inspection stage — user already
        // has analysis history, we drop straight into chat mode.
        flowState = entry.msgs.length ? "analysis_complete" : "idle";
        syncShellLayout();
        scrollDown(true);
        closeSidebar();
        renderSidebar();
        refreshToolbar();
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); item.click(); }
      });
    });

    sidebarSessionsEl.querySelectorAll(".cht-sidebar__item-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.del;
        let sessions = loadStoredSessions();
        sessions = sessions.filter((s) => s.id !== id);
        saveStoredSessions(sessions);
        if (id === sessionId) void resetChat();
        else renderSidebar();
      });
    });
  };

  sidebarToggleBtn?.addEventListener("click", () => {
    if (sidebarEl?.classList.contains("is-open")) closeSidebar();
    else openSidebar();
  });
  sidebarBackdrop?.addEventListener("click", closeSidebar);
  sidebarNewBtn?.addEventListener("click", () => {
    closeSidebar();
    void resetChat();
  });
  window.addEventListener("beforeunload", () => persistCurrentSession());

  attachBtn?.addEventListener("click", () => {
    if (fileInput) fileInput.value = "";
    fileInput?.click();
  });
  uploadCard?.addEventListener("click", () => {
    if (fileInput) fileInput.value = "";
    fileInput?.click();
  });
  fileInput?.addEventListener("change", async (e) => {
    const [f] = e.target.files || [];
    if (!f) return;
    const allowed = f.type.startsWith("image/") || isHeicLike(f);
    if (!allowed) {
      showError("Please choose an image (PNG, JPEG, WebP, HEIC, …).");
      if (fileInput) fileInput.value = "";
      return;
    }
    try {
      const normalized = await normalizeImageFileForUpload(f);
      if (!normalized) {
        showError("Could not process this file.");
        if (fileInput) fileInput.value = "";
        return;
      }
      setPending(normalized);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      if (fileInput) fileInput.value = "";
    }
  });
  pendingRemove?.addEventListener("click", () => setPending(null));
  pendingImg?.addEventListener("click", () => {
    if (pendingImg.src && pendingImg.src !== location.href) openLightbox(pendingImg.src);
  });

  // Inspection stage: "Start Analysis" kicks off the vision call with no text
  // payload (image-only). The stage switches to its loading state and stays
  // pinned until the first AI report arrives, then chat is revealed.
  stageStartBtn?.addEventListener("click", () => {
    if (busy) return;
    if (!pendingFile) {
      showError("Attach a site photo before starting analysis.");
      return;
    }
    if (inputEl) inputEl.value = "";
    void send();
  });
  stageReplaceBtn?.addEventListener("click", () => {
    if (busy) return;
    if (fileInput) fileInput.value = "";
    fileInput?.click();
  });
  stageImg?.addEventListener("click", () => {
    const src = stageImg.src || "";
    if (src && src !== location.href) openLightbox(src);
  });

  sendBtn?.addEventListener("click", () => void send());
  inputEl?.addEventListener("input", () => syncComposerHeight());
  inputEl?.addEventListener("focus", () => syncComposerHeight());
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  downloadBtn?.addEventListener("click", () => downloadMd());

  messagesEl?.addEventListener("click", (e) => {
    const img = e.target.closest(".insp-msg__img--clickable");
    if (img) {
      const src = img.getAttribute("data-preview-src") || img.src;
      if (src) openLightbox(src);
    }
  });

  syncShellLayout();
  void bootstrap().then(() => renderSidebar());
  refreshToolbar();
  refreshSendButton();
  requestAnimationFrame(() => syncComposerHeight());
});


