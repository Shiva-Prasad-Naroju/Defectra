document.addEventListener("DOMContentLoaded", () => {
  const video = document.getElementById("live-video");
  const startBtn = document.getElementById("start-stream-btn");
  const stopBtn = document.getElementById("stop-stream-btn");
  const placeholder = document.getElementById("video-placeholder");
  const statusDot = document.getElementById("stream-status-dot");
  const statusText = document.getElementById("stream-status-text");
  const livePanel = document.getElementById("live-panel");
  const ctaRow = document.getElementById("cta-row");

  /* QR elements */
  const qrConnectBtn = document.getElementById("qr-connect-btn");
  const qrModal = document.getElementById("qr-modal");
  const qrModalClose = document.getElementById("qr-modal-close");
  const qrCodeContainer = document.getElementById("qr-code-container");
  const qrSpinner = document.getElementById("qr-spinner");
  const qrStatusDot = document.getElementById("qr-status-dot");
  const qrStatusText = document.getElementById("qr-status-text");

  let stream = null;
  let peer = null;
  let activeConnection = null;

  /* ── Local camera ── */
  startBtn?.addEventListener("click", async () => {
    if (!video || !placeholder || !stopBtn) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });
      showLiveStream(stream, "Connected");
    } catch (err) {
      console.error("Error accessing camera: ", err);
      alert("Could not access camera. Please allow camera permissions.");
    }
  });

  stopBtn?.addEventListener("click", () => {
    stopLiveStream();
  });

  function showLiveStream(mediaStream, label) {
    if (!video || !placeholder || !stopBtn) return;
    video.srcObject = mediaStream;
    video.classList.remove("hidden");
    placeholder.classList.add("hidden");
    startBtn?.classList.add("hidden");
    qrConnectBtn?.classList.add("hidden");
    ctaRow?.querySelector(".dashboard-live-cta-divider")?.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    statusDot?.classList.add("online");
    livePanel?.classList.add("is-live");
    if (statusText) statusText.textContent = label || "Connected";
  }

  function stopLiveStream() {
    if (!video || !placeholder || !stopBtn) return;

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (activeConnection) {
      activeConnection.close();
      activeConnection = null;
    }
    if (peer) {
      peer.destroy();
      peer = null;
    }

    video.srcObject = null;
    video.classList.add("hidden");
    placeholder.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    startBtn?.classList.remove("hidden");
    qrConnectBtn?.classList.remove("hidden");
    ctaRow?.querySelector(".dashboard-live-cta-divider")?.classList.remove("hidden");
    statusDot?.classList.remove("online");
    livePanel?.classList.remove("is-live");
    if (statusText) statusText.textContent = "Not connected";
  }

  /* ── Helpers ── */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  /** Build the remote camera URL using the current origin (works when deployed) */
  function getRemoteUrl(peerId) {
    return `${window.location.origin}/dashboard/live/remote/?session=${encodeURIComponent(peerId)}`;
  }

  /** Generate QR code canvas */
  function generateQRCode(text, container) {
    const qr = qrcode(0, "M"); // eslint-disable-line no-undef
    qr.addData(text);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const cellSize = Math.max(4, Math.floor(200 / moduleCount));
    const margin = cellSize * 2;
    const innerSize = moduleCount * cellSize;
    const size = innerSize + margin * 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.className = "qr-modal__canvas";
    const ctx = canvas.getContext("2d");

    /* White background with margin */
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    /* Draw modules */
    ctx.fillStyle = "#0f172a";
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(margin + col * cellSize, margin + row * cellSize, cellSize, cellSize);
        }
      }
    }

    container.appendChild(canvas);
  }

  /* ── QR Code Connection ── */

  qrConnectBtn?.addEventListener("click", async () => {
    if (!qrModal) return;
    qrModal.classList.remove("hidden");
    qrSpinner?.classList.remove("hidden");
    if (qrStatusText) qrStatusText.textContent = "Waiting for device\u2026";
    qrStatusDot?.classList.remove("online");

    /* Remove any previous QR canvas */
    qrCodeContainer?.querySelector(".qr-modal__canvas")?.remove();

    try {
      await Promise.all([
        loadScript("https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"),
        loadScript("https://unpkg.com/qrcode-generator@1.4.4/qrcode.js")
      ]);

      if (peer) { peer.destroy(); peer = null; }

      peer = new Peer({
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.relay.metered.ca:80" },
            { urls: "turn:global.relay.metered.ca:80", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
            { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
            { urls: "turn:global.relay.metered.ca:443", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" },
            { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "e7e4e8c1a12b0a46a5df71a3", credential: "qCJ/l+UWpG5YRTOC" }
          ]
        }
      });

      peer.on("open", (id) => {
        const remoteUrl = getRemoteUrl(id);
        qrSpinner?.classList.add("hidden");
        generateQRCode(remoteUrl, qrCodeContainer);
      });

      peer.on("call", (call) => {
        call.answer();
        activeConnection = call;

        call.on("stream", (remoteStream) => {
          stream = remoteStream;
          if (qrStatusText) qrStatusText.textContent = "Device connected!";
          qrStatusDot?.classList.add("online");

          setTimeout(() => {
            qrModal.classList.add("hidden");
            showLiveStream(remoteStream, "Connected (remote device)");
          }, 600);
        });

        call.on("close", () => {
          stopLiveStream();
        });
      });

      peer.on("error", (err) => {
        console.error("PeerJS error:", err);
        qrSpinner?.classList.add("hidden");
        if (qrStatusText) qrStatusText.textContent = "Connection error. Close and try again.";
      });
    } catch (err) {
      console.error("Failed to initialize QR connection:", err);
      qrSpinner?.classList.add("hidden");
      if (qrStatusText) qrStatusText.textContent = "Failed to load. Check your connection.";
    }
  });

  qrModalClose?.addEventListener("click", () => {
    qrModal?.classList.add("hidden");
    if (!stream && peer) {
      peer.destroy();
      peer = null;
    }
  });

  qrModal?.addEventListener("click", (e) => {
    if (e.target === qrModal) qrModalClose?.click();
  });

  /* Close on Escape */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && qrModal && !qrModal.classList.contains("hidden")) {
      qrModalClose?.click();
    }
  });
});
