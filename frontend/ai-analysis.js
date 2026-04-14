/**
 * AI Analysis: upload → streamed PMO report (vLLM via Defectra API).
 * Dev: Vite proxies /api, or set VITE_API_BASE_URL.
 */

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

/** Markdown while tokens arrive: close a trailing unpaired `**` so bold renders instead of literal asterisks. */
function parseMarkdownStreaming(raw) {
  const s = raw ?? "";
  if (s.length === 0) return "";
  let fix = s;
  const delims = s.match(/\*\*/g);
  if (delims && delims.length % 2 === 1) {
    fix = `${s}**`;
  }
  try {
    return marked.parse(fix);
  } catch {
    return "";
  }
}

function apiBase() {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (typeof base === "string" && base.trim() !== "") {
    return base.trim().replace(/\/$/, "");
  }
  return "";
}

function analyzeStreamUrl() {
  return `${apiBase()}/api/ai-analysis/analyze-stream`;
}

function isLikelyNetworkFailure(err) {
  if (err instanceof TypeError) {
    const m = String(err.message || "").toLowerCase();
    return (
      m.includes("fetch") ||
      m.includes("failed to fetch") ||
      m.includes("load failed") ||
      m.includes("networkerror") ||
      m.includes("network request failed")
    );
  }
  return err instanceof DOMException && err.name === "AbortError";
}

function parseSseDataLine(line) {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;
  const payload = t.slice(5).trimStart();
  if (payload === "[DONE]") return { done: true };
  try {
    return { json: JSON.parse(payload) };
  } catch {
    return null;
  }
}

const AI_SNAPSHOT_IDB = "defectra-ai-analysis";
const AI_SNAPSHOT_STORE = "snapshots";
const AI_SNAPSHOT_KEY = "current";
const AI_SNAPSHOT_IDB_VER = 1;

function openAiSnapshotDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AI_SNAPSHOT_IDB, AI_SNAPSHOT_IDB_VER);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(AI_SNAPSHOT_STORE)) {
        db.createObjectStore(AI_SNAPSHOT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function saveAiSnapshot(payload) {
  try {
    const db = await openAiSnapshotDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AI_SNAPSHOT_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(AI_SNAPSHOT_STORE).put(payload, AI_SNAPSHOT_KEY);
    });
    db.close();
  } catch (e) {
    console.warn("saveAiSnapshot", e);
  }
}

async function loadAiSnapshot() {
  try {
    const db = await openAiSnapshotDb();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction(AI_SNAPSHOT_STORE, "readonly");
      const rq = tx.objectStore(AI_SNAPSHOT_STORE).get(AI_SNAPSHOT_KEY);
      rq.onsuccess = () => resolve(rq.result ?? null);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return data;
  } catch {
    return null;
  }
}

async function clearAiSnapshot() {
  try {
    const db = await openAiSnapshotDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AI_SNAPSHOT_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(AI_SNAPSHOT_STORE).delete(AI_SNAPSHOT_KEY);
    });
    db.close();
  } catch (e) {
    console.warn("clearAiSnapshot", e);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const aiSection = document.getElementById("ai-analysis");
  const mainDash = document.querySelector("main.dashboard-main--ai-analysis");
  const liveDock = document.getElementById("ai-analysis-live-dock");
  const stageUpload = document.getElementById("stage-upload");
  const stageReady = document.getElementById("stage-ready");
  const stageLive = document.getElementById("stage-live");
  const stageResults = document.getElementById("stage-results");
  const uploadZone = document.getElementById("upload-zone");
  const imageInput = document.getElementById("image-input");
  const readyPreview = document.getElementById("ready-preview");
  const processingOverlay = document.getElementById("processing-overlay");
  const analysisError = document.getElementById("analysis-error");
  const workspaceError = document.getElementById("workspace-error");
  const runAnalysisBtn = document.getElementById("run-analysis-btn");
  const cancelReadyBtn = document.getElementById("cancel-ready-btn");
  const analyseMoreBtn = document.getElementById("analyse-more-btn");
  const liveStagePreview = document.getElementById("live-stage-preview");
  const liveStreamReport = document.getElementById("live-stream-report");
  const liveDoneBtn = document.getElementById("live-done-btn");

  let currentFile = null;
  let currentDataUrl = "";
  let isStreaming = false;
  let dockSyncRaf = 0;
  let dockLayoutWatch = null;
  let streamReportRaf = null;

  const clearLiveDockLayout = () => {
    if (!liveDock) return;
    liveDock.classList.remove("ai-live-dock--js-layout");
    liveDock.style.removeProperty("top");
    liveDock.style.removeProperty("height");
    liveDock.style.removeProperty("right");
    liveDock.style.removeProperty("width");
    liveDock.style.removeProperty("bottom");
    liveDock.style.removeProperty("max-height");
    mainDash?.style.removeProperty("padding-right");
  };

  const syncLiveDockToShell = () => {
    if (!liveDock || liveDock.classList.contains("hidden")) return;
    if (!window.matchMedia("(min-width: 901px)").matches) {
      clearLiveDockLayout();
      return;
    }
    const shell = document.querySelector(".dashboard-analysis-shell");
    if (!shell) return;
    const r = shell.getBoundingClientRect();
    const gutter = Math.max(12, Math.round(r.left));
    const gap = 18;
    const maxBySpace = window.innerWidth - r.right - gap - gutter;
    const preferred = Math.round(Math.min(960, Math.max(360, window.innerWidth * 0.46)));
    const w = Math.max(280, Math.min(preferred, maxBySpace));

    liveDock.style.top = `${Math.round(r.top)}px`;
    liveDock.style.height = `${Math.round(r.height)}px`;
    liveDock.style.right = `${gutter}px`;
    liveDock.style.bottom = "auto";
    liveDock.style.width = `${w}px`;
    liveDock.style.maxHeight = "none";
    liveDock.classList.add("ai-live-dock--js-layout");

    const pad = w + gap + gutter;
    mainDash?.style.setProperty("padding-right", `${Math.round(pad)}px`);
  };

  const scheduleDockSync = () => {
    if (!liveDock || liveDock.classList.contains("hidden")) return;
    cancelAnimationFrame(dockSyncRaf);
    dockSyncRaf = requestAnimationFrame(() => {
      dockSyncRaf = 0;
      syncLiveDockToShell();
    });
  };

  const stopDockLayoutWatch = () => {
    if (dockLayoutWatch) {
      dockLayoutWatch.ro?.disconnect();
      dockLayoutWatch.abort();
      dockLayoutWatch = null;
    }
    cancelAnimationFrame(dockSyncRaf);
    dockSyncRaf = 0;
  };

  const startDockLayoutWatch = () => {
    stopDockLayoutWatch();
    if (!window.matchMedia("(min-width: 901px)").matches) return;
    const shell = document.querySelector(".dashboard-analysis-shell");
    if (!shell || !liveDock) return;

    const ac = new AbortController();
    const { signal } = ac;
    window.addEventListener("scroll", scheduleDockSync, { passive: true, signal });
    window.addEventListener("resize", scheduleDockSync, { signal });

    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => scheduleDockSync());
      ro.observe(shell);
    }
    dockLayoutWatch = { abort: () => ac.abort(), ro };

    scheduleDockSync();
  };

  const hideLiveDock = () => {
    stopDockLayoutWatch();
    clearLiveDockLayout();
    liveDock?.classList.add("hidden");
    liveDock?.setAttribute("hidden", "");
    liveDock?.setAttribute("aria-hidden", "true");
    aiSection?.classList.remove("dashboard-analysis--live-dock-open");
  };

  const showLiveDock = () => {
    liveDock?.classList.remove("hidden");
    liveDock?.removeAttribute("hidden");
    liveDock?.setAttribute("aria-hidden", "false");
    aiSection?.classList.add("dashboard-analysis--live-dock-open");
  };

  const showUpload = () => {
    void clearAiSnapshot();
    currentFile = null;
    currentDataUrl = "";
    isStreaming = false;
    if (imageInput) imageInput.value = "";
    hideError();
    processingOverlay?.classList.add("hidden");
    processingOverlay?.setAttribute("hidden", "");
    stageUpload?.classList.remove("hidden");
    stageUpload?.removeAttribute("hidden");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageLive?.classList.add("hidden");
    stageLive?.setAttribute("hidden", "");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
    hideLiveDock();
    if (runAnalysisBtn) runAnalysisBtn.disabled = false;
    if (liveStreamReport) {
      liveStreamReport.textContent = "";
      liveStreamReport.innerHTML = "";
      liveStreamReport.classList.remove("ai-live-stream-report--plain");
      liveStreamReport.setAttribute("aria-busy", "false");
    }
  };

  const showReady = (file, dataUrl) => {
    currentFile = file;
    currentDataUrl = dataUrl;
    if (readyPreview) {
      readyPreview.src = dataUrl;
      readyPreview.alt = "Selected image preview";
    }
    processingOverlay?.classList.add("hidden");
    processingOverlay?.setAttribute("hidden", "");
    stageUpload?.classList.add("hidden");
    stageUpload?.setAttribute("hidden", "");
    stageReady?.classList.remove("hidden");
    stageReady?.removeAttribute("hidden");
    stageLive?.classList.add("hidden");
    stageLive?.setAttribute("hidden", "");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
    hideLiveDock();
    void saveAiSnapshot({
      markdown: "",
      dataUrl,
      fileName: file?.name || "photo.jpg",
      fileType: file?.type || "image/jpeg",
    });
  };

  const hideError = () => {
    for (const el of [analysisError, workspaceError]) {
      if (!el) continue;
      el.textContent = "";
      el.classList.add("hidden");
      el.setAttribute("hidden", "");
    }
  };

  const showWorkspaceError = (msg) => {
    if (!workspaceError) return;
    workspaceError.textContent = msg;
    workspaceError.classList.remove("hidden");
    workspaceError.removeAttribute("hidden");
  };

  const showLiveStage = () => {
    if (liveStagePreview && currentDataUrl) {
      liveStagePreview.src = currentDataUrl;
      liveStagePreview.alt = "Site photo under PMO review";
      liveStagePreview.onload = () => scheduleDockSync();
    }
    if (liveStreamReport) {
      liveStreamReport.textContent = "";
      liveStreamReport.innerHTML = "";
      liveStreamReport.classList.remove("ai-live-stream-report--plain");
      liveStreamReport.setAttribute("aria-busy", "true");
    }
    stageUpload?.classList.add("hidden");
    stageUpload?.setAttribute("hidden", "");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageLive?.classList.remove("hidden");
    stageLive?.removeAttribute("hidden");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
    showLiveDock();
    startDockLayoutWatch();
    requestAnimationFrame(() => scheduleDockSync());
    window.setTimeout(() => scheduleDockSync(), 220);
  };

  const parseErrorDetail = async (res) => {
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
  };

  const finalizeStreamReport = (accumulated) => {
    if (streamReportRaf != null) {
      cancelAnimationFrame(streamReportRaf);
      streamReportRaf = null;
    }
    if (!liveStreamReport) return;
    liveStreamReport.classList.remove("ai-live-stream-report--plain");
    liveStreamReport.innerHTML = accumulated
      ? marked.parse(accumulated)
      : "<p>(No text returned.)</p>";
    liveStreamReport.setAttribute("aria-busy", "false");
  };

  const runAnalysis = async () => {
    if (!currentFile || isStreaming) return;
    hideError();
    showLiveStage();
    isStreaming = true;
    if (runAnalysisBtn) runAnalysisBtn.disabled = true;
    const form = new FormData();
    form.append("file", currentFile, currentFile.name);

    let accumulated = "";

    try {
      const res = await fetch(analyzeStreamUrl(), {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const detail = await parseErrorDetail(res);
        isStreaming = false;
        if (runAnalysisBtn) runAnalysisBtn.disabled = false;
        stageLive?.classList.add("hidden");
        stageLive?.setAttribute("hidden", "");
        hideLiveDock();
        stageReady?.classList.remove("hidden");
        stageReady?.removeAttribute("hidden");
        showWorkspaceError(
          detail ||
            `Request failed (${res.status}). Ensure the Defectra API is on port 8000 and VLLM_BASE_URL is set.`,
        );
        return;
      }

      if (!res.body) {
        throw new Error("No response body from server.");
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let streamEnded = false;

      const scheduleStreamReportRender = () => {
        if (streamReportRaf != null) return;
        streamReportRaf = requestAnimationFrame(() => {
          streamReportRaf = null;
          if (!liveStreamReport) return;
          liveStreamReport.classList.remove("ai-live-stream-report--plain");
          liveStreamReport.innerHTML = parseMarkdownStreaming(accumulated);
          const wrap = liveStreamReport.closest(".ai-live-stream-scroll");
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        });
      };

      const consumeLine = (line) => {
        const parsed = parseSseDataLine(line);
        if (!parsed) return false;
        if (parsed.done) return true;
        if (parsed.json?.error) {
          throw new Error(parsed.json.error);
        }
        if (typeof parsed.json?.d === "string") {
          accumulated += parsed.json.d;
          scheduleStreamReportRender();
        }
        return false;
      };

      readLoop: while (!streamEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (consumeLine(line)) {
            streamEnded = true;
            break readLoop;
          }
        }
      }
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (consumeLine(line)) break;
        }
      }

      finalizeStreamReport(accumulated);
      void saveAiSnapshot({
        markdown: accumulated,
        dataUrl: currentDataUrl,
        fileName: currentFile?.name || "photo.jpg",
        fileType: currentFile?.type || "image/jpeg",
      });
      scheduleDockSync();
      hideError();
    } catch (e) {
      if (streamReportRaf != null) {
        cancelAnimationFrame(streamReportRaf);
        streamReportRaf = null;
      }
      const msg = isLikelyNetworkFailure(e)
        ? "Could not reach the Defectra API. Run uvicorn in backend on port 8000 and keep npm run dev running (Vite proxies /api). If FastAPI runs in WSL/Docker while Vite is on Windows, set VITE_API_PROXY_TARGET in frontend/.env.development — see frontend/.env.example. Optional same-machine bypass: VITE_API_BASE_URL=http://127.0.0.1:8000."
        : String(e.message || e);
      stageLive?.classList.add("hidden");
      stageLive?.setAttribute("hidden", "");
      hideLiveDock();
      stageReady?.classList.remove("hidden");
      stageReady?.removeAttribute("hidden");
      showWorkspaceError(msg);
    } finally {
      isStreaming = false;
      if (runAnalysisBtn) runAnalysisBtn.disabled = false;
    }
  };

  uploadZone?.addEventListener("click", () => {
    imageInput?.click();
  });

  uploadZone?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      imageInput?.click();
    }
  });

  let dragDepth = 0;
  const setDragOver = (on) => {
    uploadZone?.classList.toggle("is-dragover", on);
  };

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    uploadZone?.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  uploadZone?.addEventListener("dragenter", () => {
    dragDepth += 1;
    setDragOver(true);
  });

  uploadZone?.addEventListener("dragleave", () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      setDragOver(false);
    }
  });

  const loadFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result;
      if (typeof url === "string") showReady(file, url);
    };
    reader.readAsDataURL(file);
  };

  uploadZone?.addEventListener("drop", (e) => {
    dragDepth = 0;
    setDragOver(false);
    const [file] = e.dataTransfer.files || [];
    loadFile(file);
  });

  imageInput?.addEventListener("change", (e) => {
    const [file] = e.target.files || [];
    loadFile(file);
  });

  runAnalysisBtn?.addEventListener("click", () => {
    runAnalysis();
  });

  readyPreview?.addEventListener("click", () => {
    if (currentFile && !isStreaming) runAnalysis();
  });

  cancelReadyBtn?.addEventListener("click", () => {
    showUpload();
  });

  analyseMoreBtn?.addEventListener("click", () => {
    showUpload();
  });

  liveDoneBtn?.addEventListener("click", () => {
    showUpload();
  });

  (async function restoreFromSnapshot() {
    const navEntry = performance.getEntriesByType?.("navigation")?.[0];
    if (navEntry?.type === "reload") {
      await clearAiSnapshot();
      return;
    }

    const snap = await loadAiSnapshot();
    if (!snap?.dataUrl || typeof snap.dataUrl !== "string") return;

    currentDataUrl = snap.dataUrl;
    try {
      const res = await fetch(snap.dataUrl);
      const blob = await res.blob();
      currentFile = new File(
        [blob],
        typeof snap.fileName === "string" && snap.fileName ? snap.fileName : "photo.jpg",
        { type: typeof snap.fileType === "string" && snap.fileType ? snap.fileType : blob.type || "image/jpeg" },
      );
    } catch {
      currentFile = null;
    }

    const markdown = typeof snap.markdown === "string" ? snap.markdown : "";
    if (markdown.trim().length > 0) {
      if (liveStagePreview) {
        liveStagePreview.src = snap.dataUrl;
        liveStagePreview.alt = "Site photo under PMO review";
      }
      finalizeStreamReport(markdown);
      stageUpload?.classList.add("hidden");
      stageUpload?.setAttribute("hidden", "");
      stageReady?.classList.add("hidden");
      stageReady?.setAttribute("hidden", "");
      stageLive?.classList.remove("hidden");
      stageLive?.removeAttribute("hidden");
      stageResults?.classList.add("hidden");
      stageResults?.setAttribute("hidden", "");
      showLiveDock();
      startDockLayoutWatch();
      requestAnimationFrame(() => scheduleDockSync());
      window.setTimeout(() => scheduleDockSync(), 220);
      isStreaming = false;
      if (runAnalysisBtn) runAnalysisBtn.disabled = false;
    } else if (currentFile) {
      showReady(currentFile, snap.dataUrl);
    }
  })();
});
