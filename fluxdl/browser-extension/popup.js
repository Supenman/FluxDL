const API = "http://127.0.0.1:35917";

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const hint = document.getElementById("hint");
const autoCapture = document.getElementById("auto-capture");
const recheck = document.getElementById("recheck");

function setStatus(state) {
  statusDot.className = "dot " + state;
  if (state === "online") {
    statusText.textContent = "已连接 FluxDL 桌面端";
    hint.textContent =
      "在网页链接上右键，选择“用 FluxDL 下载此链接”，即可把任务发送到桌面端。";
    hint.classList.remove("warn");
  } else if (state === "offline") {
    statusText.textContent = "未连接 · 请先启动 FluxDL";
    hint.textContent = "启动 FluxDL 桌面端后点击下方“重新检测”，即可开始捕获链接。";
    hint.classList.add("warn");
  } else {
    statusText.textContent = "正在检测桌面端…";
  }
}

async function checkHealth() {
  setStatus("pending");
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await response.json();
    setStatus(response.ok && data.ok ? "online" : "offline");
  } catch {
    setStatus("offline");
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.sync.get({ autoCapture: true });
  autoCapture.checked = Boolean(stored.autoCapture);
}

autoCapture.addEventListener("change", () => {
  chrome.storage.sync.set({ autoCapture: autoCapture.checked });
});

recheck.addEventListener("click", () => {
  void checkHealth();
});

void loadPrefs();
void checkHealth();
