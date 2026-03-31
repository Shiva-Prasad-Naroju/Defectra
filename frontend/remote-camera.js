document.addEventListener("DOMContentLoaded", () => {
  const stateConnecting = document.getElementById("state-connecting");
  const statePermission = document.getElementById("state-permission");
  const stateStreaming = document.getElementById("state-streaming");
  const stateError = document.getElementById("state-error");
  const errorMessage = document.getElementById("error-message");
  const video = document.getElementById("remote-video");
  const startCameraBtn = document.getElementById("start-camera-btn");
  const stopCameraBtn = document.getElementById("stop-camera-btn");
  const retryBtn = document.getElementById("retry-btn");

  let peer = null;
  let stream = null;
  let activeCall = null;

  const params = new URLSearchParams(window.location.search);
  const hostPeerId = params.get("session");

  if (!hostPeerId) {
    showState("error", "No session ID found. Please scan the QR code again from the Live Inspection page.");
    return;
  }

  function showState(state, errMsg) {
    stateConnecting.classList.add("hidden");
    statePermission.classList.add("hidden");
    stateStreaming.classList.add("hidden");
    stateError.classList.add("hidden");

    switch (state) {
      case "connecting":
        stateConnecting.classList.remove("hidden");
        break;
      case "permission":
        statePermission.classList.remove("hidden");
        break;
      case "streaming":
        stateStreaming.classList.remove("hidden");
        break;
      case "error":
        if (errMsg) errorMessage.textContent = errMsg;
        stateError.classList.remove("hidden");
        break;
    }
  }

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

  async function connectToHost() {
    showState("connecting");

    try {
      await loadScript("https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js");
    } catch (_) {
      showState("error", "Failed to load the connection library. Check your internet connection and try again.");
      return;
    }

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

    peer.on("open", () => {
      showState("permission");
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      if (err.type === "peer-unavailable") {
        showState("error", "The inspection session was not found. It may have expired. Please scan a new QR code.");
      } else if (err.type === "network") {
        showState("error", "Network error. Please check your internet connection and try again.");
      } else {
        showState("error", `Connection error: ${err.message}`);
      }
    });

    peer.on("disconnected", () => {
      if (stateStreaming && !stateStreaming.classList.contains("hidden")) {
        stopStreaming();
        showState("error", "Connection to the session was lost.");
      }
    });
  }

  async function startStreaming() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });

      video.srcObject = stream;
      showState("streaming");

      activeCall = peer.call(hostPeerId, stream);

      activeCall.on("close", () => {
        stopStreaming();
        showState("error", "The inspection session was ended by the host.");
      });

      activeCall.on("error", (err) => {
        console.error("Call error:", err);
        stopStreaming();
        showState("error", "Streaming error. Please try again.");
      });
    } catch (err) {
      console.error("Camera access error:", err);
      if (err.name === "NotAllowedError") {
        showState("error", "Camera permission was denied. Please allow camera access in your browser settings and try again.");
      } else if (err.name === "NotFoundError") {
        showState("error", "No camera found on this device.");
      } else {
        showState("error", "Could not access camera. Please check your device permissions.");
      }
    }
  }

  function stopStreaming() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (activeCall) {
      activeCall.close();
      activeCall = null;
    }
    if (video) video.srcObject = null;
  }

  startCameraBtn?.addEventListener("click", startStreaming);

  stopCameraBtn?.addEventListener("click", () => {
    stopStreaming();
    if (peer && !peer.disconnected) {
      showState("permission");
    } else {
      showState("error", "Session disconnected. Scan the QR code again to reconnect.");
    }
  });

  retryBtn?.addEventListener("click", () => {
    if (peer) peer.destroy();
    connectToHost();
  });

  connectToHost();
});
