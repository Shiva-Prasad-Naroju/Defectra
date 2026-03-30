document.addEventListener("DOMContentLoaded", () => {
  const stageUpload = document.getElementById("stage-upload");
  const stageReady = document.getElementById("stage-ready");
  const stageResults = document.getElementById("stage-results");
  const uploadZone = document.getElementById("upload-zone");
  const imageInput = document.getElementById("image-input");
  const cameraInput = document.getElementById("camera-input");
  const cameraBtn = document.getElementById("camera-btn");
  const readyPreview = document.getElementById("ready-preview");
  const processingOverlay = document.getElementById("processing-overlay");
  const processingStatus = document.getElementById("processing-status");
  const resultOriginal = document.getElementById("result-original");
  const resultHeadline = document.getElementById("result-headline");
  const resultSummary = document.getElementById("result-summary");
  const runAnalysisBtn = document.getElementById("run-analysis-btn");
  const cancelReadyBtn = document.getElementById("cancel-ready-btn");
  const analyseMoreBtn = document.getElementById("analyse-more-btn");

  const PROCESSING_MESSAGES = [
    "Scanning for defects…",
    "Mapping surfaces…",
    "Building insight…",
    "Preparing summary…",
  ];

  const DEMO_HEADLINE = "Structural risk detected along the upper joint.";
  const DEMO_SUMMARY =
    "Crack-like patterns appear along the upper joint with additional surface variation in the left field. Review highlighted regions on your photo before scheduling repairs. Full segmentation will connect when your model is live.";

  let currentDataUrl = "";
  let processingTimer = null;
  let messageInterval = null;

  const showUpload = () => {
    currentDataUrl = "";
    if (imageInput) imageInput.value = "";
    if (cameraInput) cameraInput.value = "";
    if (processingTimer) {
      clearTimeout(processingTimer);
      processingTimer = null;
    }
    if (messageInterval) {
      clearInterval(messageInterval);
      messageInterval = null;
    }
    processingOverlay?.classList.add("hidden");
    processingOverlay?.setAttribute("hidden", "");
    stageUpload?.classList.remove("hidden");
    stageUpload?.removeAttribute("hidden");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
  };

  const showReady = (dataUrl) => {
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
    stageResults?.classList.add("hidden");
    stageResults?.setAttribute("hidden", "");
  };

  const showResults = () => {
    if (messageInterval) {
      clearInterval(messageInterval);
      messageInterval = null;
    }
    if (processingTimer) {
      clearTimeout(processingTimer);
      processingTimer = null;
    }
    processingOverlay?.classList.add("hidden");
    processingOverlay?.setAttribute("hidden", "");
    if (resultOriginal && currentDataUrl) {
      resultOriginal.src = currentDataUrl;
      resultOriginal.alt = "Uploaded construction image";
    }
    if (resultHeadline) resultHeadline.textContent = DEMO_HEADLINE;
    if (resultSummary) resultSummary.textContent = DEMO_SUMMARY;
    stageUpload?.classList.add("hidden");
    stageUpload?.setAttribute("hidden", "");
    stageReady?.classList.add("hidden");
    stageReady?.setAttribute("hidden", "");
    stageResults?.classList.remove("hidden");
    stageResults?.removeAttribute("hidden");
  };

  const runProcessingThenResults = () => {
    if (!currentDataUrl) return;
    processingOverlay?.classList.remove("hidden");
    processingOverlay?.removeAttribute("hidden");

    let i = 0;
    if (processingStatus) processingStatus.textContent = PROCESSING_MESSAGES[0];
    if (messageInterval) clearInterval(messageInterval);
    messageInterval = window.setInterval(() => {
      i = (i + 1) % PROCESSING_MESSAGES.length;
      if (processingStatus) processingStatus.textContent = PROCESSING_MESSAGES[i];
    }, 850);

    if (processingTimer) clearTimeout(processingTimer);
    processingTimer = window.setTimeout(() => {
      if (messageInterval) {
        clearInterval(messageInterval);
        messageInterval = null;
      }
      showResults();
    }, 3400);
  };

  uploadZone?.addEventListener("click", (e) => {
    if (e.target === cameraBtn || cameraBtn?.contains(e.target)) return;
    imageInput?.click();
  });

  uploadZone?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      imageInput?.click();
    }
  });

  cameraBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    cameraInput?.click();
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
      if (typeof url === "string") showReady(url);
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

  cameraInput?.addEventListener("change", (e) => {
    const [file] = e.target.files || [];
    loadFile(file);
  });

  runAnalysisBtn?.addEventListener("click", () => {
    if (!currentDataUrl) return;
    runProcessingThenResults();
  });

  cancelReadyBtn?.addEventListener("click", () => {
    showUpload();
  });

  analyseMoreBtn?.addEventListener("click", () => {
    showUpload();
  });
});
