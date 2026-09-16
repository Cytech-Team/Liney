(function () {
  "use strict";

  var config = window.LINEY_SITE_CONFIG || {};


  function ensureWebAppNav() {
    document.querySelectorAll(".site-nav").forEach(function (nav) {
      if (nav.querySelector("[data-web-app-link]")) return;
      var link = document.createElement("a");
      link.href = "app.html";
      link.textContent = "Web App";
      link.setAttribute("data-web-app-link", "");
      if (/\/(app|web)(\.html)?$/i.test(window.location.pathname)) link.setAttribute("aria-current", "page");
      var cta = nav.querySelector(".nav-cta");
      nav.insertBefore(link, cta || null);
    });
  }

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

  ensureWebAppNav();

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

  setupMobileNavigation();
})();
