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
})();
