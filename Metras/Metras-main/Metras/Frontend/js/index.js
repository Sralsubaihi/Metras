// index.js - Landing page (index.html).
// Public page, no Firebase: mobile menu drawer, scroll-reveal animations,
// navbar shadow on scroll and the tilt effect on the hero illustration.

document.addEventListener("DOMContentLoaded", () => {
  // Mobile navigation drawer.
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("backdrop");
  const menuButton = document.getElementById("btnMenu");
  const setDrawer = open => {
    drawer?.classList.toggle("open", open);
    drawer?.setAttribute("aria-hidden", String(!open));
    if (backdrop) backdrop.hidden = !open;
    menuButton?.setAttribute("aria-expanded", String(open));
  };
  menuButton?.addEventListener("click", () => setDrawer(true));
  document.getElementById("btnCloseDrawer")?.addEventListener("click", () => setDrawer(false));
  backdrop?.addEventListener("click", () => setDrawer(false));
  drawer?.querySelectorAll("a").forEach(link => link.addEventListener("click", () => setDrawer(false)));

  // Fade sections in (staggered) the first time they scroll into view.
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });
  document.querySelectorAll(".reveal").forEach((element, index) => {
    element.style.setProperty("--reveal-delay", `${Math.min(index % 4, 3) * 90}ms`);
    observer.observe(element);
  });

  // Add a shadow to the navbar once the page is scrolled.
  const topbar = document.querySelector(".home-nav");
  const updateNav = () => topbar?.classList.toggle("is-scrolled", window.scrollY > 24);
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  // 3D tilt of the hero illustration following the pointer
  // (desktop only, disabled when the user prefers reduced motion).
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const visual = document.querySelector(".risk-visual");
    document.querySelector(".home-hero")?.addEventListener("pointermove", event => {
      if (!visual || window.innerWidth < 900) return;
      const x = (event.clientX / window.innerWidth - 0.5) * 7;
      const y = (event.clientY / window.innerHeight - 0.5) * 7;
      visual.style.transform = `perspective(1100px) rotateY(${x}deg) rotateX(${-y}deg)`;
    });
    document.querySelector(".home-hero")?.addEventListener("pointerleave", () => {
      if (visual) visual.style.transform = "perspective(1100px) rotateY(0) rotateX(0)";
    });
  }
});
