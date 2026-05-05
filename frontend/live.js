import { getToken, getUser } from "/shared/auth.js";
import { mountDashboardNav } from "/shared/components/dashboard-nav.js";
import { mountDashboardFooter } from "/shared/components/dashboard-footer.js";
import { isHeicLike, normalizeImageFileForUpload } from "/heic-utils.js";
import { optimizeImageForInspection, TARGET_UPLOAD_MAX_BYTES } from "/image-optimize.js";

document.addEventListener("DOMContentLoaded", () => {
  mountDashboardNav("live");
  mountDashboardFooter();

  const token = getToken();
  const user  = getUser();
  if (!token || !user) return;

  /* ═══════════════════════════════════════════════
     DOM refs
     ═══════════════════════════════════════════════ */
  const panels     = ["step-capture", "step-preview", "step-form", "step-success"];
  const cameraIn   = document.getElementById("camera-input");
  const imageIn    = document.getElementById("image-input");
  const previewImg = document.getElementById("preview-img");
  const formThumb  = document.getElementById("form-thumb");
  const submitBtn  = document.getElementById("btn-submit");
  const submitText = document.getElementById("submit-text");
  const alertEl    = document.getElementById("insp-alert");
  const statusEl   = document.getElementById("capture-status");
  const tipEl      = document.getElementById("capture-tip");
  const cameraModal = document.getElementById("camera-modal");
  const cameraPreview = document.getElementById("camera-preview");
  const cameraCaptureBtn = document.getElementById("camera-capture-btn");
  const cameraCancelBtn = document.getElementById("camera-cancel-btn");
  const cameraModalCloseBtn = document.getElementById("camera-modal-close");

  const selTower = document.getElementById("sel-tower");
  const selFloor = document.getElementById("sel-floor");
  const selFlat  = document.getElementById("sel-flat");
  const selRoom  = document.getElementById("sel-room");
  const selDescription = document.getElementById("sel-description");
  const uploadProgressEl = document.getElementById("upload-progress");
  const uploadProgressFill = document.getElementById("upload-progress-fill");
  const uploadProgressLabel = document.getElementById("upload-progress-label");
  const collectionChipBtn = document.getElementById("btn-open-collection");
  const collectionCountBadgeEl = document.getElementById("collection-count-badge");
  const collectionListEl = document.getElementById("collection-list");
  const collectionEmptyEl = document.getElementById("collection-empty");
  const submitAllBtn = document.getElementById("btn-submit-all");
  const clearCollectionBtn = document.getElementById("btn-clear-collection");
  const backToCaptureBtn = document.getElementById("btn-back-to-capture");
  const collectionToastEl = document.getElementById("collection-toast");

  let selectedFile = null;
  let previewUrl   = "";
  let allUploadItems = [];
  let desktopCameraStream = null;
  const COLLECTION_STORAGE_KEY = "liveInspectionCollectionV1";
  let collectionItems = [];

  /* ═══════════════════════════════════════════════
     Rotating tips
     ═══════════════════════════════════════════════ */
  const TIPS = [
    "Capture the defect clearly for accurate AI detection",
    "Ensure proper lighting for better results",
    "Get close to the defect for a detailed view",
    "Include surrounding area for context",
    "Hold your device steady to avoid blur",
  ];
  let tipIdx = 0;
  let tipInterval;

  function showTip() {
    const svg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    tipEl.innerHTML = `<span>${svg} ${TIPS[tipIdx]}</span>`;
    tipIdx = (tipIdx + 1) % TIPS.length;
  }

  function startTips() {
    showTip();
    tipInterval = setInterval(showTip, 5000);
  }

  function stopTips() {
    clearInterval(tipInterval);
  }

  startTips();

  /* ═══════════════════════════════════════════════
     Populate selects
     ═══════════════════════════════════════════════ */
  for (let i = 0; i <= 25; i++) {
    const o = document.createElement("option");
    o.value = i === 0 ? "Ground" : String(i);
    o.textContent = i === 0 ? "Ground" : String(i);
    selFloor.appendChild(o);
  }
  for (let i = 1; i <= 16; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    selFlat.appendChild(o);
  }

  /* ═══════════════════════════════════════════════
     Step state machine
     ═══════════════════════════════════════════════ */
  function goTo(stepId) {
    panels.forEach((id) => {
      document.getElementById(id).classList.remove("step-panel--active");
    });
    document.getElementById(stepId).classList.add("step-panel--active");
    alertEl.className = "insp-alert";
    updateStepBar(stepId);

    if (stepId === "step-capture") startTips();
    else stopTips();
  }

  function updateStepBar(stepId) {
    const stepMap = { "step-capture": 1, "step-preview": 2, "step-form": 3, "step-success": 3 };
    const current = stepMap[stepId] || 1;

    document.querySelectorAll(".step-bar__step").forEach((stepEl) => {
      const n = Number(stepEl.dataset.step);
      stepEl.classList.remove("step-bar__step--active", "step-bar__step--done");
      if (n < current || stepId === "step-success") stepEl.classList.add("step-bar__step--done");
      else if (n === current) stepEl.classList.add("step-bar__step--active");
    });

    document.querySelectorAll(".step-bar__dot").forEach((dot) => {
      const n = Number(dot.dataset.step);
      dot.classList.remove("step-bar__dot--active", "step-bar__dot--done");
      if (n < current) dot.classList.add("step-bar__dot--done");
      else if (n === current) dot.classList.add("step-bar__dot--active");
      if (stepId === "step-success") {
        dot.classList.remove("step-bar__dot--active");
        dot.classList.add("step-bar__dot--done");
      }
    });

    document.querySelectorAll(".step-bar__line").forEach((line) => {
      const n = Number(line.dataset.line);
      line.classList.toggle("step-bar__line--done", n < current || stepId === "step-success");
    });
  }

  function formatMb(n) {
    return (n / (1024 * 1024)).toFixed(1);
  }

  function setUploadProgress(visible, fraction, label) {
    if (!uploadProgressEl) return;
    uploadProgressEl.hidden = !visible;
    const pct = Math.min(100, Math.max(0, Math.round((fraction || 0) * 100)));
    if (uploadProgressFill) uploadProgressFill.style.width = `${pct}%`;
    if (uploadProgressLabel) uploadProgressLabel.textContent = label || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function showCollectionToast(text) {
    if (!collectionToastEl) return;
    collectionToastEl.textContent = text;
    collectionToastEl.classList.add("collection-toast--show");
    window.setTimeout(() => collectionToastEl.classList.remove("collection-toast--show"), 1300);
  }

  async function fileToDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read image data"));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToFile(dataUrl, fallbackName) {
    const [header, payload] = String(dataUrl || "").split(",");
    const mimeMatch = /data:(.*?);base64/i.exec(header || "");
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const bin = atob(payload || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = (mime.split("/")[1] || "jpg").replace(/[^\w.-]/g, "");
    return new File([arr], fallbackName || `collection-${Date.now()}.${ext}`, { type: mime });
  }

  function saveCollectionToStorage() {
    try {
      localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(collectionItems));
    } catch {
      // Ignore storage quota issues; collection still works in-memory.
    }
  }

  function loadCollectionFromStorage() {
    try {
      const raw = localStorage.getItem(COLLECTION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) collectionItems = parsed;
    } catch {
      collectionItems = [];
    }
  }

  /* ═══════════════════════════════════════════════
     Step 1: Capture
     ═══════════════════════════════════════════════ */
  async function processPickedFile(rawFile) {
    if (!rawFile) return;
    const mime = String(rawFile.type || "").toLowerCase();
    if (!mime.startsWith("image/") && !isHeicLike(rawFile)) {
      setCaptureError("Please choose an image file.");
      return;
    }

    statusEl.className = "capture-status capture-status--busy";
    statusEl.textContent = "Processing image…";

    const originalSize = rawFile.size || 0;

    try {
      const normalized = await normalizeImageFileForUpload(rawFile);
      if (!normalized) {
        setCaptureError("Unsupported image format.");
        return;
      }

      const optimized = await optimizeImageForInspection(normalized, {
        status: (msg) => {
          statusEl.textContent = msg;
        },
      });

      selectedFile = optimized;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(optimized);
      previewImg.src = previewUrl;

      const newSize = optimized.size || 0;
      if (originalSize > newSize * 1.15 && originalSize > TARGET_UPLOAD_MAX_BYTES * 0.85) {
        statusEl.textContent = `Ready — optimized ${formatMb(originalSize)} MB → ${formatMb(newSize)} MB ✓`;
      } else {
        statusEl.textContent = "Image ready ✓";
      }
      statusEl.className = "capture-status capture-status--ready";

      goTo("step-preview");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCaptureError(msg || "Could not process this image.");
    }
  }

  function resetStatus() {
    statusEl.textContent = "No image selected";
    statusEl.className = "capture-status capture-status--empty";
  }

  function setCaptureError(msg) {
    statusEl.textContent = msg;
    statusEl.className = "capture-status capture-status--error";
  }

  function isMobileLikeDevice() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches;
  }

  async function stopDesktopCamera() {
    if (desktopCameraStream) {
      desktopCameraStream.getTracks().forEach((track) => track.stop());
      desktopCameraStream = null;
    }
    if (cameraPreview) cameraPreview.srcObject = null;
  }

  async function closeDesktopCameraModal() {
    cameraModal?.classList.remove("camera-modal--open");
    await stopDesktopCamera();
  }

  async function listVideoInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  function pickPreferredVideoInput(videoInputs) {
    if (!videoInputs.length) return null;
    if (videoInputs.length === 1) return videoInputs[0];

    const externalHint = /(usb|webcam|hd|logitech|brio|c9\d{2}|stream|external)/i;
    const internalHint = /(integrated|built[- ]in|internal|facetime)/i;

    const external = videoInputs.find((d) => externalHint.test(d.label || ""));
    if (external) return external;

    const nonInternal = videoInputs.find((d) => !internalHint.test(d.label || ""));
    return nonInternal || videoInputs[0];
  }

  async function openBestAvailableCameraStream() {
    // First permissive probe: this succeeds on most browsers/devices and unlocks labels.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

    const currentTrack = probe.getVideoTracks()[0];
    const currentSettings = currentTrack?.getSettings?.() || {};
    const currentDeviceId = currentSettings.deviceId || null;

    const videoInputs = await listVideoInputs();
    const preferred = pickPreferredVideoInput(videoInputs);
    const preferredId = preferred?.deviceId || null;

    // If there is no better camera candidate, keep the already-open stream.
    if (!preferredId || !currentDeviceId || preferredId === currentDeviceId) {
      return probe;
    }

    probe.getTracks().forEach((track) => track.stop());

    // Try selected external/preferred camera; fall back to permissive stream if unavailable.
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: preferredId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }

  async function openDesktopCameraModal() {
    if (!cameraModal || !cameraPreview) {
      cameraIn.click();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCaptureError("No camera detected on this device.");
      return;
    }
    try {
      await stopDesktopCamera();
      desktopCameraStream = await openBestAvailableCameraStream();
    } catch (err) {
      const name = err && err.name ? err.name : "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCaptureError("No camera detected on this device.");
      } else if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCaptureError("Camera access denied. Allow permission and try again.");
      } else if (name === "NotReadableError" || name === "TrackStartError") {
        setCaptureError("Camera is busy in another app. Close it there and try again.");
      } else {
        setCaptureError("Unable to open camera. Please use Upload Image.");
      }
      return;
    }
    cameraPreview.srcObject = desktopCameraStream;
    cameraModal.classList.add("camera-modal--open");
  }

  async function captureDesktopFrame() {
    if (!cameraPreview || !desktopCameraStream) return;
    const width = cameraPreview.videoWidth || 1280;
    const height = cameraPreview.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(cameraPreview, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setCaptureError("Could not capture image. Please try again.");
      return;
    }
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
    await closeDesktopCameraModal();
    await processPickedFile(file);
  }

  document.getElementById("btn-take-photo").addEventListener("click", () => {
    if (isMobileLikeDevice()) {
      cameraIn.click();
      return;
    }
    openDesktopCameraModal();
  });
  document.getElementById("btn-upload-image").addEventListener("click", () => imageIn.click());

  cameraCaptureBtn?.addEventListener("click", captureDesktopFrame);
  cameraCancelBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModalCloseBtn?.addEventListener("click", closeDesktopCameraModal);
  cameraModal?.addEventListener("click", (e) => {
    if (e.target === cameraModal) closeDesktopCameraModal();
  });

  cameraIn.addEventListener("change", async () => {
    const f = cameraIn.files && cameraIn.files[0];
    cameraIn.value = "";
    await processPickedFile(f);
  });
  imageIn.addEventListener("change", async () => {
    const f = imageIn.files && imageIn.files[0];
    imageIn.value = "";
    await processPickedFile(f);
  });

  /* ═══════════════════════════════════════════════
     Step 2: Preview
     ═══════════════════════════════════════════════ */
  previewImg.style.cursor = "zoom-in";
  previewImg.addEventListener("click", () => {
    if (previewUrl) openLightbox(previewUrl, "");
  });

  document.getElementById("btn-retake").addEventListener("click", () => {
    resetFile();
    goTo("step-capture");
  });

  document.getElementById("btn-continue").addEventListener("click", () => {
    formThumb.src = previewUrl;
    goTo("step-form");
    validateForm();
  });

  /* ═══════════════════════════════════════════════
     Step 3: Form
     ═══════════════════════════════════════════════ */
  document.getElementById("btn-back-to-preview").addEventListener("click", () => goTo("step-preview"));

  function validateForm() {
    const filled = selTower.value && selFloor.value && selFlat.value && selRoom.value && selectedFile;
    submitBtn.disabled = !filled;
  }

  [selTower, selFloor, selFlat, selRoom].forEach((sel) => sel.addEventListener("change", validateForm));

  function showAlert(msg) {
    alertEl.textContent = msg;
    alertEl.className = "insp-alert insp-alert--error";
  }

  function updateCollectionIndicator() {
    const n = collectionItems.length;
    if (collectionCountBadgeEl) collectionCountBadgeEl.textContent = String(n);
    if (collectionChipBtn) {
      collectionChipBtn.setAttribute(
        "aria-label",
        n === 0 ? "Open collection, currently empty" : `Open collection, ${n} items ready`,
      );
    }
    if (submitAllBtn) {
      submitAllBtn.textContent = `Submit All (${n})`;
      submitAllBtn.disabled = n === 0;
    }
  }

  function renderCollectionList() {
    if (!collectionListEl || !collectionEmptyEl) return;
    updateCollectionIndicator();
    if (!collectionItems.length) {
      collectionListEl.innerHTML = "";
      collectionEmptyEl.style.display = "block";
      return;
    }
    collectionEmptyEl.style.display = "none";
    collectionListEl.innerHTML = collectionItems.map((item, idx) => `
      <article class="collection-item" data-idx="${idx}">
        <div class="collection-item__top">
          <img class="collection-item__img" src="${escapeHtml(item.preview_url || item.image_data_url || "")}" alt="Collection item ${idx + 1}">
          <div class="collection-item__summary">
            <p class="collection-item__title">${escapeHtml(item.tower || "Tower")} • Floor ${escapeHtml(item.floor || "-")}</p>
            <p class="collection-item__line">Flat ${escapeHtml(item.flat || "-")} • ${escapeHtml(item.room || "Room")}</p>
            <p class="collection-item__line">${escapeHtml(item.description || "No description")}</p>
            <div class="collection-item__actions">
              <button type="button" class="collection-item__edit" data-edit="${idx}">Edit</button>
            </div>
            <div class="collection-item__edit-panel" data-panel="${idx}" hidden>
              <div class="collection-item__meta">
                <input data-field="tower" value="${escapeHtml(item.tower)}" placeholder="Tower">
                <input data-field="floor" value="${escapeHtml(item.floor)}" placeholder="Floor">
                <input data-field="flat" value="${escapeHtml(item.flat)}" placeholder="Flat">
                <input data-field="room" value="${escapeHtml(item.room)}" placeholder="Room">
                <textarea data-field="description" placeholder="Description">${escapeHtml(item.description || "")}</textarea>
              </div>
            </div>
          </div>
          <button type="button" class="collection-item__remove" data-remove="${idx}">Remove</button>
        </div>
      </article>
    `).join("");
  }

  collectionListEl?.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const card = target.closest(".collection-item");
    if (!card) return;
    const idx = Number(card.getAttribute("data-idx"));
    const field = target.getAttribute("data-field");
    if (!Number.isInteger(idx) || !field || !collectionItems[idx]) return;
    collectionItems[idx][field] = target.value;
    saveCollectionToStorage();
  });

  collectionListEl?.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const editIdx = Number(target.getAttribute("data-edit"));
    if (Number.isInteger(editIdx)) {
      const panel = collectionListEl.querySelector(`[data-panel="${editIdx}"]`);
      if (panel) panel.hidden = !panel.hidden;
      return;
    }
    const idx = Number(target.getAttribute("data-remove"));
    if (!Number.isInteger(idx)) return;
    collectionItems.splice(idx, 1);
    saveCollectionToStorage();
    renderCollectionList();
  });

  submitBtn.addEventListener("click", async () => {
    if (!selectedFile) { showAlert("No image selected."); return; }
    if (!selTower.value || !selFloor.value || !selFlat.value || !selRoom.value) {
      showAlert("Please fill all location fields.");
      return;
    }
    submitBtn.disabled = true;
    submitText.innerHTML = '<span class="btn-spinner"></span> Adding...';
    try {
      const imageDataUrl = await fileToDataUrl(selectedFile);
      collectionItems.push({
        id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        preview_url: imageDataUrl,
        image_data_url: imageDataUrl,
        file_name: selectedFile.name || `capture-${Date.now()}.jpg`,
        tower: selTower.value,
        floor: selFloor.value,
        flat: selFlat.value,
        room: selRoom.value,
        description: selDescription.value.trim(),
      });
      saveCollectionToStorage();
      renderCollectionList();
      showCollectionToast(`Added ✓ (${collectionItems.length} in collection)`);
      collectionChipBtn?.classList.add("collection-chip--pulse");
      window.setTimeout(() => collectionChipBtn?.classList.remove("collection-chip--pulse"), 900);
      fullReset();
      goTo("step-capture");
    } finally {
      submitText.textContent = "Add to Collection";
      validateForm();
    }
  });

  async function submitCollectionBatch() {
    if (!collectionItems.length || !submitAllBtn) return;
    submitAllBtn.disabled = true;
    submitAllBtn.innerHTML = '<span class="btn-spinner"></span> Submitting...';
    setUploadProgress(true, 0, "Submitting collection...");
    try {
      const fd = new FormData();
      fd.append("items_json", JSON.stringify(collectionItems.map((item) => ({
        tower: item.tower || "",
        floor: item.floor || "",
        flat: item.flat || "",
        room: item.room || "",
        description: item.description || "",
      }))));
      for (const item of collectionItems) {
        fd.append("images", dataUrlToFile(item.image_data_url, item.file_name));
      }

      const res = await fetch("/api/defects/upload-batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAlert(typeof data?.detail === "string" ? data.detail : "Batch submission failed.");
        return;
      }
      const failures = Array.isArray(data.results) ? data.results.filter((r) => !r.ok) : [];
      if (failures.length) {
        showAlert(`Submitted with ${failures.length} failure(s). Please review collection and retry.`);
        return;
      }
      collectionItems = [];
      saveCollectionToStorage();
      renderCollectionList();
      fullReset();
      showCollectionToast(`Submitted successfully (${data.success_count || 0})`);
      goTo("step-capture");
      loadUploads();
    } catch (err) {
      showAlert(err instanceof Error ? err.message : "Batch submission failed.");
    } finally {
      setUploadProgress(false, 0, "");
      updateCollectionIndicator();
    }
  }

  collectionChipBtn?.addEventListener("click", () => {
    renderCollectionList();
    goTo("step-success");
  });
  backToCaptureBtn?.addEventListener("click", () => goTo("step-capture"));
  clearCollectionBtn?.addEventListener("click", () => {
    collectionItems = [];
    saveCollectionToStorage();
    renderCollectionList();
  });
  submitAllBtn?.addEventListener("click", submitCollectionBatch);

  /* ═══════════════════════════════════════════════
     Reset helpers
     ═══════════════════════════════════════════════ */
  function resetFile() {
    selectedFile = null;
    cameraIn.value = "";
    imageIn.value = "";
    resetStatus();
  }

  function fullReset() {
    resetFile();
    selTower.value = "";
    selFloor.value = "";
    selFlat.value  = "";
    selRoom.value  = "";
    selDescription.value = "";
    submitBtn.disabled = true;
  }

  /* ═══════════════════════════════════════════════
     Lightbox
     ═══════════════════════════════════════════════ */
  const lightbox     = document.getElementById("lightbox");
  const lightboxImg  = document.getElementById("lightbox-img");
  const lightboxMeta = document.getElementById("lightbox-meta");

  function openLightbox(src, meta) {
    lightboxImg.src = src;
    lightboxMeta.textContent = meta || "";
    lightboxMeta.style.display = meta ? "block" : "none";
    lightbox.classList.add("lightbox--open");
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    lightbox.classList.remove("lightbox--open");
    document.body.style.overflow = "";
  }

  document.getElementById("lightbox-close")?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cameraModal?.classList.contains("camera-modal--open")) {
      closeDesktopCameraModal();
      return;
    }
    if (e.key === "Escape" && lightbox?.classList.contains("lightbox--open")) closeLightbox();
  });

  function wireGridLightbox(container) {
    container.querySelectorAll(".insp-item").forEach((item) => {
      const img = item.querySelector("img");
      const metaEl = item.querySelector(".meta");
      if (!img) return;
      img.addEventListener("click", () => openLightbox(img.src, metaEl?.textContent?.trim() || ""));
    });
  }

  function normalizeImageSrc(path) {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    return path.startsWith("/") ? path : `/${path}`;
  }

  /* ═══════════════════════════════════════════════
     Recent uploads — activity bar + expandable list
     ═══════════════════════════════════════════════ */
  const activityBar   = document.getElementById("activity-bar");
  const activityText  = document.getElementById("activity-text");
  const activityThumbs = document.getElementById("activity-thumbs");
  const toggleBtn     = document.getElementById("toggle-all");
  const recentSection = document.getElementById("recent-section");
  const uploadsGrid   = document.getElementById("uploads-grid");
  let recentVisible   = false;

  function todayCount() {
    const today = new Date().toDateString();
    return allUploadItems.filter((d) => new Date(d.created_at).toDateString() === today).length;
  }

  function renderUploads() {
    const grid  = uploadsGrid;
    const empty = document.getElementById("uploads-empty");

    if (allUploadItems.length === 0) {
      activityBar.style.display = "none";
      recentSection.style.display = "none";
      return;
    }

    /* Activity bar */
    const tc = todayCount();
    const total = allUploadItems.length;
    const summaryParts = [];
    if (tc > 0) summaryParts.push(`<strong>${tc}</strong> inspection${tc !== 1 ? "s" : ""} today`);
    if (total > tc) summaryParts.push(`<strong>${total}</strong> total`);
    if (summaryParts.length === 0) summaryParts.push(`<strong>${total}</strong> inspection${total !== 1 ? "s" : ""} uploaded`);
    activityText.innerHTML = summaryParts.join(" &middot; ");

    const thumbs = allUploadItems.slice(0, 3);
    activityThumbs.innerHTML = thumbs.map((d) =>
      `<img src="${normalizeImageSrc(d.image_path)}" alt="" width="32" height="32" loading="lazy">`
    ).join("");

    activityBar.style.display = recentVisible ? "none" : "flex";
    activityBar.classList.toggle("activity-bar--open", recentVisible);
    recentSection.style.display = recentVisible ? "block" : "none";

    if (!recentVisible) return;

    empty.style.display = "none";
    grid.innerHTML = allUploadItems.map((d) => `
      <div class="insp-item">
        <img src="${normalizeImageSrc(d.image_path)}" alt="Defect" loading="lazy">
        <div class="meta">
          <strong>${d.tower}</strong> &middot; Floor ${d.floor} &middot; Flat ${d.flat}<br>
          ${d.room}<br>
          ${d.description ? `<em>${d.description}</em><br>` : ""}
          <small>${new Date(d.created_at).toLocaleString()}</small>
        </div>
      </div>`).join("");

    wireGridLightbox(grid);

    toggleBtn.style.display = "inline";
    toggleBtn.textContent = "Hide";
  }

  activityBar.addEventListener("click", () => {
    recentVisible = true;
    renderUploads();
  });
  activityBar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activityBar.click(); }
  });

  toggleBtn.addEventListener("click", () => {
    recentVisible = false;
    renderUploads();
  });

  async function loadUploads() {
    try {
      const res = await fetch("/api/defects/my", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      allUploadItems = await res.json();
      renderUploads();
    } catch (err) { console.error("Failed to load uploads:", err); }
  }

  loadCollectionFromStorage();
  renderCollectionList();
  loadUploads();
});
