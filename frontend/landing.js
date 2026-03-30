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

  const setNavOpen = (open) => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navLinks.classList.toggle("is-open", open);
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
    if (e.key === "Escape") setNavOpen(false);
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

});
