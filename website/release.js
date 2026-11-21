/* Liney public release metadata: only assets attached to the published GitHub Release are offered. */
(function () {
  "use strict";

  var repository = "Cytech-Team/Liney";
  var latestUrl = "https://github.com/" + repository + "/releases/latest";
  var apiUrl = "https://api.github.com/repos/" + repository + "/releases/latest";
  var release = null;
  var archSelect = document.getElementById("release-arch");
  var installTab = "AppImage";
  var packageTypes = {
    AppImage: { extension: ".appimage" },
    deb: { extension: ".deb" },
    rpm: { extension: ".rpm" },
    flatpak: { extension: ".flatpak" },
    "tar.gz": { extension: ".tar.gz" }
  };
  var installation = {
    AppImage: { title: "AppImage", description: "ดาวน์โหลดไฟล์ AppImage แล้วให้สิทธิ์ Execute จากนั้นเปิดแอปได้โดยตรง ไม่ต้องติดตั้งแพ็กเกจลงระบบ" },
    deb: { title: "DEB · Debian / Ubuntu", description: "ใช้ apt ติดตั้งไฟล์ .deb ในโฟลเดอร์ Downloads; apt จะจัดการ dependency ให้ด้วย" },
    rpm: { title: "RPM · Fedora", description: "ตัวอย่างคำสั่งสำหรับ Fedora และดิสโทรที่ใช้ dnf โดยติดตั้งจากไฟล์ .rpm ที่ดาวน์โหลดมา" },
    flatpak: { title: "Flatpak bundle", description: "ต้องติดตั้ง Flatpak ไว้ก่อน คำสั่งนี้ติดตั้ง bundle ที่ดาวน์โหลดจาก GitHub Release โดยตรง ไม่ใช่การติดตั้งจาก Flathub" }
  };
  var supportedArchitectures = ["x86_64", "aarch64"];

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach(function (node) {
      node.textContent = value;
    });
  }

  function getArch() {
    return archSelect ? archSelect.value : "x86_64";
  }

  function architectureAliases(arch) {
    return arch === "x86_64" ? ["x86_64", "amd64"] : ["aarch64", "arm64"];
  }

  function hasArchitecture(name, arch) {
    var stem = name.replace(/\.(?:appimage|deb|rpm|flatpak|tar\.gz)$/i, "");
    var match = stem.match(/(?:^|[-_])(x86_64|amd64|aarch64|arm64)(?:$|[-_])/i);
    return Boolean(match && architectureAliases(arch).indexOf(match[1].toLowerCase()) !== -1);
  }

  function toSize(bytes) {
    return (bytes / 1048576).toFixed(1) + " MiB";
  }

  function findAsset(type, arch) {
    if (!release || !packageTypes[type]) return null;
    var version = String(release.tag_name || "").replace(/^v/, "").toLowerCase();
    var extension = packageTypes[type].extension;
    return release.assets.find(function (asset) {
      var name = String(asset.name || "");
      var lowerName = name.toLowerCase();
      return lowerName.indexOf("-" + version + "-") !== -1 &&
        lowerName.endsWith(extension) &&
        hasArchitecture(name, arch) &&
        asset.state === "uploaded" &&
        asset.size > 0 &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.indexOf("https://github.com/" + repository + "/releases/download/") === 0;
    }) || null;
  }

  function hasAnyAsset(type, arch) {
    return Boolean(findAsset(type, arch));
  }

  function hasAnyReleaseAsset(type) {
    return supportedArchitectures.some(function (arch) {
      return hasAnyAsset(type, arch);
    });
  }

  function renderArchitectureOptions() {
    if (!archSelect) return;
    var available = [];

    Array.prototype.forEach.call(archSelect.options, function (option) {
      if (!option.dataset.originalLabel) option.dataset.originalLabel = option.textContent;
      var exists = !release || supportedArchitectures.indexOf(option.value) === -1 || supportedArchitectures.some(function (arch) {
        return arch === option.value && Object.keys(packageTypes).some(function (type) {
          return hasAnyAsset(type, arch);
        });
      });
      option.disabled = Boolean(release && !exists);
      option.textContent = option.dataset.originalLabel + (release && !exists ? " · ยังไม่มีไฟล์ในรุ่นนี้" : "");
      if (release && exists && supportedArchitectures.indexOf(option.value) !== -1) available.push(option.value);
    });

    if (release && archSelect.selectedOptions.length && archSelect.selectedOptions[0].disabled && available.length) {
      archSelect.value = available[0];
    }

    var hint = document.getElementById("release-arch-hint");
    if (hint) {
      if (!release) {
        hint.textContent = "ตรวจสอบสถาปัตยกรรมด้วยคำสั่ง uname -m";
      } else if (available.length === 1) {
        hint.textContent = "Release " + release.tag_name + " มีไฟล์สำหรับ " + available[0] + " เท่านั้น";
      } else if (available.length > 1) {
        hint.textContent = "เลือกสถาปัตยกรรมที่ตรงกับผล uname -m และตรวจไฟล์ที่พร้อมดาวน์โหลดด้านล่าง";
      } else {
        hint.textContent = "ยังไม่พบไฟล์ติดตั้งที่รองรับใน Release นี้";
      }
    }
  }

  function renderCards() {
    document.querySelectorAll("[data-package]").forEach(function (card) {
      var type = card.dataset.package;
      var link = card.querySelector("[data-asset-link]");
      var size = card.querySelector("[data-asset-size]");
      var asset = findAsset(type, getArch());
      if (!link || !size) return;

      if (type === "tar.gz") {
        card.style.display = release && hasAnyReleaseAsset(type) ? "" : "none";
      }

      if (asset) {
        link.href = asset.browser_download_url;
        link.textContent = "ดาวน์โหลด ↓";
        link.setAttribute("download", asset.name);
        link.setAttribute("aria-label", "ดาวน์โหลด " + asset.name + " จาก GitHub");
        link.classList.remove("is-disabled");
        size.textContent = toSize(asset.size) + " · " + getArch();
        card.classList.remove("package-unavailable");
      } else {
        link.href = release ? release.html_url : latestUrl;
        link.textContent = release ? "ดูไฟล์ทั้งหมด ↗" : "ตรวจสอบบน GitHub ↗";
        link.removeAttribute("download");
        link.setAttribute("aria-label", type + " — เปิดหน้า GitHub Releases");
        card.classList.toggle("package-unavailable", Boolean(release));
        size.textContent = release ? "ไม่มีไฟล์ " + getArch() + " ใน Release นี้" : "กำลังรอข้อมูลจาก GitHub";
      }
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
  }

  function installCommand(type) {
    var asset = findAsset(type, getArch());
    if (release && !asset) {
      return "# Release " + release.tag_name + " ไม่มีไฟล์ " + type + " สำหรับ " + getArch() +
        "\n# เลือกแพ็กเกจที่มีปุ่มดาวน์โหลด หรือเปิด GitHub Releases เพื่อตรวจสอบ";
    }
    if (!asset) {
      return "# ยังดึงข้อมูลชื่อไฟล์จาก GitHub ไม่สำเร็จ" +
        "\n# เปิด GitHub Releases ดาวน์โหลดไฟล์ก่อน แล้วกลับมาเลือกแพ็กเกจอีกครั้ง";
    }

    var filename = asset.name;
    switch (type) {
      case "AppImage":
        return "cd ~/Downloads\nchmod +x -- " + filename + "\n./" + filename;
      case "deb":
        return "cd ~/Downloads\nsudo apt install ./" + filename;
      case "rpm":
        return "cd ~/Downloads\nsudo dnf install ./" + filename;
      case "flatpak":
        return "cd ~/Downloads\nflatpak install --user ./" + filename + "\nflatpak run com.cyoriasmp.liney";
      default:
        return "# ไม่มีคำสั่งติดตั้งสำหรับแพ็กเกจนี้";
    }
  }

  function renderInstall() {
    var code = document.getElementById("install-command");
    if (!code) return;
    code.textContent = installCommand(installTab);
    var detail = installation[installTab];
    document.getElementById("install-terminal-label").textContent = detail.title;
    document.getElementById("install-description").textContent = detail.description;
    document.querySelectorAll("[data-install-tab]").forEach(function (button) {
      var selected = button.dataset.installTab === installTab;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function render() {
    renderArchitectureOptions();
    renderCards();
    renderInstall();
  }

  if (archSelect) archSelect.addEventListener("change", render);
  document.querySelectorAll("[data-install-tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      installTab = button.dataset.installTab;
      renderInstall();
    });
  });

  var copy = document.getElementById("copy-install-command");
  if (copy) copy.addEventListener("click", function () {
    var command = document.getElementById("install-command").textContent;
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      copy.textContent = "เลือกข้อความแล้วคัดลอก";
      return;
    }
    navigator.clipboard.writeText(command).then(function () {
      copy.textContent = "คัดลอกแล้ว ✓";
    }).catch(function () {
      copy.textContent = "เลือกข้อความแล้วคัดลอก";
    });
  });

  function applyRelease(data) {
    if (!data || !/^v\d+\.\d+\.\d+/.test(data.tag_name || "") ||
        data.draft || data.prerelease ||
        typeof data.html_url !== "string" ||
        data.html_url.indexOf("https://github.com/" + repository + "/releases/tag/") !== 0 ||
        !Array.isArray(data.assets)) throw new Error("Release data invalid");

    release = data;
    setText("[data-release-version]", data.tag_name);
    var date = new Date(data.published_at);
    if (!Number.isNaN(date.getTime())) {
      setText("[data-release-date]", "เผยแพร่ " + new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(date));
    }
    document.querySelectorAll("[data-release-link]").forEach(function (link) {
      link.href = data.html_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    setText("#release-sync-state", "ตรวจสอบรายชื่อไฟล์จาก GitHub Release แล้ว");
    render();
  }

  function failGracefully() {
    setText("[data-release-version]", "ดูรุ่นล่าสุดบน GitHub");
    setText("#release-sync-state", "ไม่สามารถตรวจสอบข้อมูล Release อัตโนมัติ");
    setText("[data-release-date]", "เปิด GitHub Releases เพื่อดูเวอร์ชันและไฟล์ที่เผยแพร่จริง");
    render();
  }

  if (typeof fetch === "function") {
    fetch(apiUrl, { headers: { "Accept": "application/vnd.github+json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("GitHub " + response.status);
        return response.json();
      })
      .then(applyRelease)
      .catch(failGracefully);
  } else {
    failGracefully();
  }
})();
