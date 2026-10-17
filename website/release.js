/* Liney public release metadata: only GitHub's published assets are offered. */
(function () {
  "use strict";

  var repository = "Cytech-Team/Liney";
  var latestUrl = "https://github.com/" + repository + "/releases/latest";
  var apiUrl = "https://api.github.com/repos/" + repository + "/releases/latest";
  var release = null;
  var archSelect = document.getElementById("release-arch");
  var packages = ["AppImage", "deb", "rpm", "flatpak", "tar.gz"];
  var installTab = "AppImage";
  var installation = {
    AppImage: { title: "AppImage", description: "รันไฟล์ AppImage ที่ดาวน์โหลดมาโดยตรง ไม่ต้องติดตั้งเป็นแพ็กเกจของระบบ" },
    deb: { title: "DEB · Debian / Ubuntu", description: "คำสั่งนี้ใช้ตัวจัดการแพ็กเกจ apt เพื่อติดตั้งไฟล์ .deb ที่ดาวน์โหลดมา" },
    rpm: { title: "RPM · Fedora", description: "ตัวอย่างสำหรับ Fedora ที่มีคำสั่ง dnf" },
    flatpak: { title: "Flatpak bundle", description: "ต้องมี Flatpak ก่อน และติดตั้งไฟล์ bundle จาก GitHub Release โดยตรง ไม่ได้ติดตั้งจาก Flathub" }
  };

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach(function (node) { node.textContent = value; });
  }

  function getArch() {
    return archSelect ? archSelect.value : "x86_64";
  }

  function toSize(bytes) {
    return (bytes / 1048576).toFixed(1) + " MiB";
  }

  function findAsset(type, arch) {
    if (!release) return null;
    var suffix = "-linux-" + arch + "." + type;
    var prefix = "Liney-" + release.tag_name.replace(/^v/, "") + suffix;
    return release.assets.find(function (asset) {
      return asset.name === prefix &&
        asset.state === "uploaded" &&
        asset.size > 0 &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.startsWith("https://github.com/" + repository + "/releases/download/");
    }) || null;
  }

  function renderCards() {
    document.querySelectorAll("[data-package]").forEach(function (card) {
      var type = card.dataset.package;
      var link = card.querySelector("[data-asset-link]");
      var size = card.querySelector("[data-asset-size]");
      var asset = findAsset(type, getArch());
      if (!link || !size) return;
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
        link.textContent = release ? "ดู Releases ↗" : "ตรวจสอบบน GitHub ↗";
        link.removeAttribute("download");
        link.setAttribute("aria-label", type + " — เปิดหน้า GitHub Releases");
        card.classList.toggle("package-unavailable", Boolean(release));
        size.textContent = release ? "ไม่มีไฟล์ " + getArch() + " ใน Release นี้" : "ยังตรวจสอบไฟล์ไม่ได้";
      }
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
  }

  function installCommand(type) {
    var arch = getArch();
    var asset = findAsset(type, arch);
    if (release && !asset) return "# ไม่มีไฟล์ " + type + " สำหรับ " + arch + " ใน Release นี้\n# เลือกรูปแบบอื่น หรือเปิด GitHub Releases เพื่อตรวจสอบ";
    var filename = asset ? asset.name : "Liney-*-linux-" + arch + "." + type;
    switch (type) {
      case "AppImage": return "cd ~/Downloads\nchmod +x " + filename + "\n./" + filename;
      case "deb": return "cd ~/Downloads\nsudo apt install ./" + filename;
      case "rpm": return "cd ~/Downloads\nsudo dnf install ./" + filename;
      case "flatpak": return "cd ~/Downloads\nflatpak install --user ./" + filename;
      default: return "";
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
        !data.html_url.startsWith("https://github.com/" + repository + "/releases/tag/") ||
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
    setText("#release-sync-state", "ยืนยันไฟล์จาก GitHub Releases แล้ว");
    render();
  }

  function failGracefully() {
    setText("[data-release-version]", "ดูรุ่นล่าสุดบน GitHub");
    setText("#release-sync-state", "ไม่สามารถตรวจสอบข้อมูล Release อัตโนมัติ");
    setText("[data-release-date]", "ยังดาวน์โหลดและตรวจสอบไฟล์ได้จาก GitHub Releases โดยตรง");
    render();
  }

  if (typeof fetch === "function") {
    fetch(apiUrl, { headers: { "Accept": "application/vnd.github+json" } })
      .then(function (response) { if (!response.ok) throw new Error("GitHub " + response.status); return response.json(); })
      .then(applyRelease).catch(failGracefully);
  } else {
    failGracefully();
  }
})();
