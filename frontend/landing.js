import { mountLandingAssistant } from "./assistant-widget.js";

document.addEventListener("DOMContentLoaded", () => {
  const scrollToFeatures = () => {
    const el = document.getElementById("features");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };
  document.querySelectorAll(".landing-cta").forEach((btn) => {
    btn.addEventListener("click", scrollToFeatures);
  });

  const mqNavMobile = window.matchMedia("(max-width: 760px)");
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("primary-nav");

  const featuresDropdown = navLinks?.querySelector(".nav-dropdown");
  const featuresTrigger = featuresDropdown?.querySelector(".nav-dropdown__trigger");

  const setFeaturesDropdownOpen = (open) => {
    if (!featuresDropdown || !featuresTrigger) return;
    featuresDropdown.classList.toggle("is-open", open);
    featuresTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const setNavOpen = (open) => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navLinks.classList.toggle("is-open", open);
    if (!open) setFeaturesDropdownOpen(false);
  };

  navToggle?.addEventListener("click", () => {
    const next = navToggle.getAttribute("aria-expanded") !== "true";
    setNavOpen(next);
  });

  navLinks?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => {
      if (mqNavMobile.matches) setNavOpen(false);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setFeaturesDropdownOpen(false);
      setNavOpen(false);
    }
  });

  featuresTrigger?.addEventListener("click", (e) => {
    if (!mqNavMobile.matches) return;
    e.preventDefault();
    const next = !featuresDropdown?.classList.contains("is-open");
    setFeaturesDropdownOpen(next);
  });

  featuresDropdown?.querySelectorAll(".nav-dropdown__menu a").forEach((a) => {
    a.addEventListener("click", () => {
      if (mqNavMobile.matches) setFeaturesDropdownOpen(false);
    });
  });

  document.addEventListener("click", (e) => {
    if (!mqNavMobile.matches || !navLinks?.classList.contains("is-open")) return;
    const nav = document.getElementById("navbar");
    if (nav && !nav.contains(e.target)) setNavOpen(false);
  });

  mqNavMobile.addEventListener("change", () => {
    if (!mqNavMobile.matches) setNavOpen(false);
  });

  // Hero scroll indicator
  const scrollHint = document.getElementById("hero-scroll-hint");
  if (scrollHint) {
    scrollHint.addEventListener("click", () => {
      const next = document.getElementById("features");
      if (next) next.scrollIntoView({ behavior: "smooth" });
    });

    const toggleScrollHint = () => {
      scrollHint.classList.toggle("is-hidden", window.scrollY > 80);
    };

    window.addEventListener(
      "scroll",
      () => {
        toggleScrollHint();
      },
      { passive: true }
    );

    // Ensure correct state on load/refresh/back navigation.
    toggleScrollHint();
  }

  // Unified workflow decision engine
  const workflowEngine = document.getElementById("workflow-engine");
  if (workflowEngine) {
    const scene = workflowEngine.querySelector(".workflow-engine__scene");
    const hotspots = workflowEngine.querySelectorAll(".workflow-engine__hotspot");
    const timeEl = document.getElementById("workflow-engine-time");

    let activeMode = "image";
    let previewMode = null;
    let cycleTimer = null;
    let scanResetTimer = null;
    let startTimer = null;

    const applyMode = (mode, withTransition = true) => {
      if (!scene) return;
      scene.classList.remove("mode-idle", "mode-image", "mode-live");
      if (withTransition) {
        scene.classList.add("is-transitioning");
        clearTimeout(scanResetTimer);
        scanResetTimer = window.setTimeout(() => {
          scene.classList.remove("is-transitioning");
        }, 700);
      }
      scene.classList.add("mode-" + mode);

      // Reset scan-fill animation when entering image mode
      if (mode === "image") {
        const fill = scene.querySelector(".wf-narrative__scan-fill");
        if (fill) {
          fill.style.animation = "none";
          fill.offsetHeight;
          fill.style.animation = "";
        }
        // Re-trigger badge sequence
        scene.querySelectorAll(".wf-narrative__badge").forEach((b) => {
          b.style.animation = "none";
          b.offsetHeight;
          b.style.animation = "";
        });
      }
    };

    const setActiveMode = (mode, withTransition = true) => {
      activeMode = mode;
      if (!previewMode) applyMode(mode, withTransition);
    };

    const updateTime = () => {
      if (!timeEl) return;
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
    };

    const startCycle = () => {
      clearInterval(cycleTimer);
      cycleTimer = window.setInterval(() => {
        setActiveMode(activeMode === "image" ? "live" : "image", true);
      }, 7000);
    };

    applyMode("idle", false);
    updateTime();
    const timeTimer = window.setInterval(updateTime, 1000);

    // Measure SVG path lengths for precise draw-on animation
    scene.querySelectorAll(".wf-narrative__crack, .wf-narrative__crack--live").forEach((path) => {
      if (path.getTotalLength) {
        const len = Math.ceil(path.getTotalLength());
        path.style.setProperty("--seg-len", len);
      }
    });

    startTimer = window.setTimeout(() => {
      setActiveMode("image", false);
      startCycle();
    }, 1000);

    hotspots.forEach((spot) => {
      const workflow = spot.getAttribute("data-workflow");
      if (!workflow) return;

      const href = workflow === "image" ? "/dashboard/image-analysis/" : "/dashboard/live/";

      spot.addEventListener("mouseenter", () => {
        previewMode = workflow;
        applyMode(workflow, false);
      });

      spot.addEventListener("mouseleave", () => {
        previewMode = null;
        applyMode(activeMode, false);
      });

      spot.addEventListener("focus", () => {
        previewMode = workflow;
        applyMode(workflow, false);
      });

      spot.addEventListener("blur", () => {
        previewMode = null;
        applyMode(activeMode, false);
      });

      spot.addEventListener("click", () => {
        window.location.href = href;
      });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(cycleTimer);
        cycleTimer = null;
      } else if (!cycleTimer) {
        startCycle();
      }
    });

    window.addEventListener("pagehide", () => {
      clearInterval(cycleTimer);
      cycleTimer = null;
      clearInterval(timeTimer);
      clearTimeout(scanResetTimer);
      clearTimeout(startTimer);
    });
  }

  const setupReveal = (selector, threshold = 0.15) => {
    const items = document.querySelectorAll(selector);
    if (!items.length) return;
    if (!("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold, rootMargin: "0px 0px -8% 0px" }
    );

    items.forEach((item) => observer.observe(item));
  };

  // Section reveal animations
  setupReveal(".m-stepper__step--reveal", 0.15);
  setupReveal(".benefit-card--reveal", 0.12);
  setupReveal(".reveal-on-scroll", 0.1);

  // ── FAQ Accordion ──
  const faqItems = document.querySelectorAll(".faq-item");

  const closeFaq = (item) => {
    const answer = item.querySelector(".faq-answer");
    if (!answer) return Promise.resolve();

    return new Promise((resolve) => {
      item.classList.remove("is-open");
      answer.style.height = answer.scrollHeight + "px";
      // Force reflow so the browser registers the starting height
      answer.offsetHeight;
      answer.style.height = "0";
      answer.style.opacity = "0";

      const onEnd = () => {
        answer.removeEventListener("transitionend", onEnd);
        item.removeAttribute("open");
        resolve();
      };
      answer.addEventListener("transitionend", onEnd);
    });
  };

  const openFaq = (item) => {
    const answer = item.querySelector(".faq-answer");
    if (!answer) return;

    item.setAttribute("open", "");
    item.classList.add("is-open");

    const targetHeight = answer.scrollHeight;
    answer.style.height = "0";
    answer.style.opacity = "0";
    // Force reflow
    answer.offsetHeight;
    answer.style.height = targetHeight + "px";
    answer.style.opacity = "1";

    const onEnd = () => {
      answer.removeEventListener("transitionend", onEnd);
      answer.style.height = "auto";
    };
    answer.addEventListener("transitionend", onEnd);
  };

  // Normalize initial accordion state — all items start collapsed.
  faqItems.forEach((item) => {
    item.removeAttribute("open");
    item.classList.remove("is-open");
    const answer = item.querySelector(".faq-answer");
    if (answer) {
      answer.style.height = "0";
      answer.style.opacity = "0";
    }
  });

  faqItems.forEach((item) => {
    const summary = item.querySelector("summary");
    if (!summary) return;

    summary.addEventListener("click", (e) => {
      e.preventDefault();

      const isOpen = item.classList.contains("is-open");

      // Close all other open items
      const closePromises = [];
      faqItems.forEach((other) => {
        if (other !== item && other.classList.contains("is-open")) {
          closePromises.push(closeFaq(other));
        }
      });

      if (isOpen) {
        // Close the clicked item
        closeFaq(item);
      } else {
        // Open the clicked item
        openFaq(item);
      }
    });
  });

  mountLandingAssistant();
});
