const API = "http://127.0.0.1:35917";

const DEFAULT_SETTINGS = {
  autoCapture: true,
  groups: {
    archive: true,
    installer: true,
    media: true,
    doc: true,
    image: false,
  },
  minSizeMB: 1,
};

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const hint = document.getElementById("hint");
const autoCapture = document.getElementById("auto-capture");
const minSize = document.getElementById("min-size");
const groupInputs = Array.from(document.querySelectorAll("#groups input"));
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
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const groups = { ...DEFAULT_SETTINGS.groups, ...(stored.groups || {}) };
  autoCapture.checked = Boolean(stored.autoCapture);
  minSize.value = String(Number(stored.minSizeMB) || 0);
  for (const input of groupInputs) {
    input.checked = Boolean(groups[input.value]);
  }
}

function savePrefs() {
  const groups = {};
  for (const input of groupInputs) {
    groups[input.value] = input.checked;
  }
  chrome.storage.sync.set({
    autoCapture: autoCapture.checked,
    groups,
    minSizeMB: Math.max(0, Number(minSize.value) || 0),
  });
}

autoCapture.addEventListener("change", savePrefs);

for (const input of groupInputs) {
  input.addEventListener("change", savePrefs);
}

minSize.addEventListener("change", () => {
  if (!minSize.value || Number(minSize.value) < 0) minSize.value = "0";
  savePrefs();
});

recheck.addEventListener("click", () => {
  void checkHealth();
});

void loadPrefs();
void checkHealth();
