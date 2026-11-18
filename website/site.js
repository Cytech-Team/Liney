(function () {
  "use strict";

  var config = window.LINEY_SITE_CONFIG || {};


  function safeUrl(value) {
    if (!value) return "";

    try {
      var url = new URL(value, window.location.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      return url.href.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function inferRepositoryUrl() {
    var hostMatch = window.location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!hostMatch) return "";

    var pathParts = window.location.pathname.split("/").filter(Boolean);
    var repository = pathParts[0] || hostMatch[1] + ".github.io";
    return "https://github.com/" + hostMatch[1] + "/" + repository;
  }

  function disableLink(link, message) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("is-disabled");
    if (message) link.setAttribute("title", message);
    link.addEventListener("click", function (event) {
      event.preventDefault();
    });
  }


  var repositoryUrl = safeUrl(config.repositoryUrl) || inferRepositoryUrl();
  var releaseUrl = safeUrl(config.releaseUrl) || (repositoryUrl ? repositoryUrl + "/releases" : "");
  var contactEmail = typeof config.contactEmail === "string" ? config.contactEmail.trim() : "";
  var effectiveDate = typeof config.effectiveDate === "string" && config.effectiveDate
    ? config.effectiveDate
    : "2026-09-05";

  document.querySelectorAll("[data-repo-link]").forEach(function (link) {
    if (repositoryUrl) {
      link.href = repositoryUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
    } else {
      disableLink(link, "ตั้งค่า repositoryUrl ใน website/site-config.js ก่อน");
    }
  });

  document.querySelectorAll("[data-release-link]").forEach(function (link) {
    if (releaseUrl) {
      link.href = releaseUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
    } else {
      disableLink(link, "ตั้งค่า repositoryUrl ใน website/site-config.js ก่อน");
      var fallbackText = link.getAttribute("data-unconfigured-label");
      if (fallbackText) link.textContent = fallbackText;
    }
  });

  document.querySelectorAll("[data-contact-email]").forEach(function (element) {
    if (contactEmail) {
      element.textContent = contactEmail;
      if (element.tagName.toLowerCase() === "a") element.href = "mailto:" + contactEmail;
    }
  });

  document.querySelectorAll("[data-effective-date]").forEach(function (element) {
    element.textContent = effectiveDate;
  });

  document.querySelectorAll("[data-current-year]").forEach(function (element) {
    element.textContent = String(new Date().getFullYear());
  });

  function setupMobileNavigation() {
    var header = document.querySelector(".site-header");
    var shell = header && header.querySelector(".nav-shell");
    var nav = shell && shell.querySelector(".site-nav");
    if (!header || !shell || !nav || shell.querySelector(".nav-toggle")) return;

    document.documentElement.classList.add("js-nav");

    if (!nav.id) nav.id = "liney-site-nav";

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "nav-toggle";
    toggle.setAttribute("aria-controls", nav.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "เปิดเมนู");
    toggle.innerHTML = '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>';
    shell.insertBefore(toggle, nav);

    function setOpen(open) {
      header.classList.toggle("menu-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "ปิดเมนู" : "เปิดเมนู");
    }

    toggle.addEventListener("click", function () {
      setOpen(!header.classList.contains("menu-open"));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (!header.classList.contains("menu-open")) return;
      if (!header.contains(event.target)) setOpen(false);
    });

    var desktop = window.matchMedia("(min-width: 721px)");
    function closeForDesktop(event) {
      if (event.matches) setOpen(false);
    }
    if (desktop.addEventListener) desktop.addEventListener("change", closeForDesktop);
    else desktop.addListener(closeForDesktop);
  }

  function setupThemeControl() {
    var shell = document.querySelector('.nav-shell');
    if (!shell || shell.querySelector('.theme-picker')) return;
    var root = document.documentElement;
    var key = 'liney.site.theme';
    var valid = ['system', 'light', 'dark'];
    var mode = root.getAttribute('data-theme-preference') || 'system';
    var media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var picker = document.createElement('div');
    picker.className = 'theme-picker';
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'theme-trigger';
    trigger.setAttribute('aria-label', 'เลือกธีมเว็บไซต์');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    var icon = document.createElement('span');
    icon.className = 'theme-current-icon';
    icon.setAttribute('aria-hidden', 'true');
    var text = document.createElement('span');
    text.className = 'theme-current-label';
    trigger.appendChild(icon);
    trigger.appendChild(text);
    picker.appendChild(trigger);
    var menu = document.createElement('div');
    menu.className = 'theme-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'เลือกธีม');
    var labels = { system: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' };
    var symbols = { system: '◐', light: '☼', dark: '☾' };
    var buttons = {};
    valid.forEach(function (choice) {
      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'theme-option';
      option.setAttribute('data-theme-option', choice);
      option.textContent = symbols[choice] + '  ' + labels[choice];
      option.addEventListener('click', function () {
        applyTheme(choice, true);
        setOpen(false);
        trigger.focus();
      });
      menu.appendChild(option);
      buttons[choice] = option;
    });
    picker.appendChild(menu);
    shell.appendChild(picker);

    function applyTheme(next, persist) {
      mode = valid.indexOf(next) !== -1 ? next : 'system';
      var resolved = mode === 'system' ? (media && media.matches ? 'dark' : 'light') : mode;
      root.setAttribute('data-theme-preference', mode);
      root.setAttribute('data-theme', resolved);
      root.style.colorScheme = resolved;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#101815' : '#f6f7f2');
      if (persist) {
        try { window.localStorage.setItem(key, mode); } catch (_) { /* storage disabled */ }
      }
      icon.textContent = symbols[mode];
      text.textContent = labels[mode];
      valid.forEach(function (choice) {
        buttons[choice].setAttribute('aria-pressed', choice === mode ? 'true' : 'false');
      });
    }
    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      picker.classList.toggle('is-open', open);
    }
    trigger.addEventListener('click', function () { setOpen(menu.hidden); });
    document.addEventListener('click', function (event) {
      if (!picker.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        trigger.focus();
      }
    });
    if (media) {
      var onChange = function () {
        if (mode === 'system') applyTheme('system', false);
      };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }
    applyTheme(mode, false);
  }


  function setupMotionSystem() {
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var header = document.querySelector('.site-header');
    var progress = document.createElement('div');
    progress.className = 'motion-progress';
    progress.setAttribute('aria-hidden', 'true');
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(progress);
    }

    var revealTargets = document.querySelectorAll(
      '.section-heading, .home-teaser, .technology-preview-visual, .home-roadmap-strip, ' +
      '.subpage-hero-layout, .feature-status-grid article, .technology-detail-grid article, ' +
      '.roadmap-list article, .roadmap-note-grid article, .roadmap-feedback, ' +
      '.architecture-diagram, .final-cta-inner, .download-promo-layout, .showcase'
    );
    revealTargets.forEach(function (element, index) {
      element.setAttribute('data-reveal', '');
      if (element.matches('.home-teaser, .feature-status-grid article, .technology-detail-grid article, .roadmap-list article, .roadmap-note-grid article')) {
        var siblings = Array.prototype.indexOf.call(element.parentElement.children, element);
        element.style.setProperty('--reveal-delay', Math.min(siblings, 5) * 85 + 'ms');
      }
    });

    if (!reduceMotion && 'IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -45px 0px' });
      revealTargets.forEach(function (element) { observer.observe(element); });
    } else {
      revealTargets.forEach(function (element) { element.classList.add('is-visible'); });
    }

    var ticking = false;
    function updateScrollEffects() {
      var root = document.documentElement;
      var scrollable = root ? root.scrollHeight - window.innerHeight : 0;
      var ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
      if (progress.style) {
        progress.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio)) + ')';
      }
      if (header && header.classList) header.classList.toggle('is-scrolled', window.scrollY > 12);
      ticking = false;
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(updateScrollEffects);
        } else {
          updateScrollEffects();
        }
      }, { passive: true });
    }
    updateScrollEffects();

    var showcase = document.querySelector('.showcase');
    if (showcase && !reduceMotion && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches) {
      showcase.addEventListener('pointermove', function (event) {
        var rect = showcase.getBoundingClientRect();
        var x = (event.clientX - rect.left) / rect.width - .5;
        var y = (event.clientY - rect.top) / rect.height - .5;
        showcase.style.transform = 'perspective(1100px) rotateY(' + (x * 4).toFixed(2) + 'deg) rotateX(' + (-y * 3).toFixed(2) + 'deg)';
      });
      showcase.addEventListener('pointerleave', function () {
        showcase.style.transform = '';
      });
    }
  }

  setupThemeControl();
  setupMotionSystem();
  setupMobileNavigation();
})();
