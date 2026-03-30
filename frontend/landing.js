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

  // Step card scroll-reveal
  const revealCards = document.querySelectorAll(".step-card--reveal");
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
