document.getElementById("status").textContent = "พร้อมเชื่อม liney.namnarak.in.th/app";
document.getElementById("open-app").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://liney.namnarak.in.th/app" });
});
