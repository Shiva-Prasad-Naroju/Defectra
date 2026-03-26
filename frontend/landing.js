document.addEventListener("DOMContentLoaded", () => {
  const goDashboard = () => {
    window.location.href = "/dashboard/image-analysis/";
  };
  document.querySelectorAll(".landing-cta").forEach((btn) => {
    btn.addEventListener("click", goDashboard);
  });

  const mqNavMobile = window.matchMedia("(max-width: 760px)");
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("primary-nav");
  const productsTrigger = document.getElementById("nav-products-trigger");
  const productsDropdown = productsTrigger?.closest(".nav-dropdown");

  const setNavOpen = (open) => {
    if (!navToggle || !navLinks) return;
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navLinks.classList.toggle("is-open", open);
  };

  const setProductsOpen = (open) => {
    if (!productsTrigger || !productsDropdown) return;
    productsTrigger.setAttribute("aria-expanded", open ? "true" : "false");
    productsDropdown.classList.toggle("is-open", open);
  };

  navToggle?.addEventListener("click", () => {
    const next = navToggle.getAttribute("aria-expanded") !== "true";
    setNavOpen(next);
    if (!next) setProductsOpen(false);
  });

  productsTrigger?.addEventListener("click", (e) => {
    if (!mqNavMobile.matches) return;
    e.preventDefault();
    const open = !productsDropdown.classList.contains("is-open");
    setProductsOpen(open);
  });

  navLinks?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => {
      if (mqNavMobile.matches) {
        setNavOpen(false);
        setProductsOpen(false);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setNavOpen(false);
      setProductsOpen(false);
    }
  });

  document.addEventListener("click", (e) => {
    if (!mqNavMobile.matches || !navLinks?.classList.contains("is-open")) return;
    const nav = document.getElementById("navbar");
    if (nav && !nav.contains(e.target)) {
      setNavOpen(false);
      setProductsOpen(false);
    }
  });

  mqNavMobile.addEventListener("change", () => {
    if (!mqNavMobile.matches) {
      setNavOpen(false);
      setProductsOpen(false);
    }
  });

  // Hero scroll indicator
  const scrollHint = document.getElementById("hero-scroll-hint");
  if (scrollHint) {
    scrollHint.addEventListener("click", () => {
      const next = document.getElementById("how-it-works");
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

  // ── Auto-rotating Feature Showcase ──
  const showcaseCards = document.querySelectorAll(".showcase__card");
  if (showcaseCards.length) {
    const DURATION = 3500; // ms per card
    let current = 0;
    let timer = null;
    let paused = false;

    // Set CSS accent variables
    showcaseCards.forEach((card) => {
      card.style.setProperty("--accent", card.dataset.accent);
      card.style.setProperty("--showcase-dur", DURATION + "ms");
    });

    const activate = (index) => {
      showcaseCards.forEach((c) => c.classList.remove("is-live"));
      showcaseCards[index].classList.add("is-live");
      current = index;
    };

    const next = () => {
      activate((current + 1) % showcaseCards.length);
    };

    const startLoop = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => { if (!paused) next(); }, DURATION);
    };

    // Pause on hover, resume on leave
    const showcase = document.getElementById("feature-showcase");
    if (showcase) {
      showcase.addEventListener("mouseenter", () => { paused = true; });
      showcase.addEventListener("mouseleave", () => { paused = false; });
    }

    // Click a card to jump to it and restart timer
    showcaseCards.forEach((card, i) => {
      card.addEventListener("click", () => {
        activate(i);
        startLoop();
      });
    });

    // Start on scroll into view
    if ("IntersectionObserver" in window) {
      const obs = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          activate(0);
          startLoop();
          obs.disconnect();
        }
      }, { threshold: 0.3 });
      obs.observe(showcase || showcaseCards[0]);
    } else {
      activate(0);
      startLoop();
    }
  }

  // ── Active nav link tracking ──
  const navAnchors = document.querySelectorAll(".nav-links > li > a[href^='#']");
  const sections = [];
  navAnchors.forEach((a) => {
    const id = a.getAttribute("href").slice(1);
    const el = document.getElementById(id);
    if (el) sections.push({ el, link: a });
  });

  if (sections.length) {
    const updateActiveNav = () => {
      const scrollY = window.scrollY + 120;
      let current = sections[0];
      for (const s of sections) {
        if (s.el.offsetTop <= scrollY) current = s;
      }
      navAnchors.forEach((a) => a.classList.remove("is-active"));
      if (current) current.link.classList.add("is-active");
    };
    window.addEventListener("scroll", updateActiveNav, { passive: true });
    updateActiveNav();
  }

  // Stepper scroll-reveal
  const revealCards = document.querySelectorAll(".m-stepper__step--reveal");
  if (revealCards.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            observer.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealCards.forEach((card) => observer.observe(card));
  } else {
    revealCards.forEach((card) => card.classList.add("is-visible"));
  }
});
