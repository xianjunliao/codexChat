const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chatForm");
const inputEl = document.getElementById("promptInput");
const sendEl = document.getElementById("sendButton");
const clearEl = document.getElementById("clearButton");
const statusEl = document.getElementById("status");
const appEl = document.querySelector(".app");

const messages = [];
let health = {};

checkHealth();
render();

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendMessage();
});

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

clearEl.addEventListener("click", () => {
  messages.length = 0;
  appEl.classList.remove("coding-mode");
  render();
  inputEl.focus();
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    health = data;
    statusEl.textContent = `服务已连接 · ${data.model || "chatgpt"} · Codex ${data.codexSandboxMode || "workspace-write"}`;
  } catch (error) {
    statusEl.textContent = `服务不可用：${error.message || "连接失败"}`;
  }
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content || sendEl.disabled) return;
  const coding = isCodingPrompt(content);
  appEl.classList.toggle("coding-mode", coding);
  messages.push({ role: "user", content });
  inputEl.value = "";
  autosize();
  render();
  setSending(true, coding);
  const pending = {
    role: "assistant",
    content: pendingText(content, coding),
    pending: true,
    coding,
    events: coding ? [] : null,
    assets: []
  };
  messages.push(pending);
  render();
  try {
    if (coding) {
      await sendStreamingMessage(pending);
    } else {
      await sendClassicMessage(pending);
    }
  } catch (error) {
    pending.pending = false;
    pending.error = true;
    pending.content = `调用失败：${error.message || "未知错误"}`;
  } finally {
    setSending(false, coding);
    render();
    inputEl.focus();
  }
}

async function sendClassicMessage(pending) {
  const response = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(false))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const choiceMessage = data.choices?.[0]?.message || {};
  pending.pending = false;
  pending.assets = Array.isArray(choiceMessage.assets)
    ? choiceMessage.assets
    : (Array.isArray(data.assets) ? data.assets : []);
  pending.content = choiceMessage.content || "";
  if (pending.assets.length) {
    pending.content = pending.assets.length > 1 ? `已生成 ${pending.assets.length} 张图片。` : "已生成图片。";
  }
  if (!pending.content.trim()) {
    pending.content = "ChatGPT 已完成处理，但没有返回文本。";
  }
}

async function sendStreamingMessage(pending) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(true))
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      applyStreamEvent(pending, JSON.parse(line));
    }
  }
  if (buffer.trim()) {
    applyStreamEvent(pending, JSON.parse(buffer));
  }
  pending.pending = false;
  if (!pending.content.trim()) {
    pending.content = "Codex 已完成处理，但没有返回文本。";
  }
}

function applyStreamEvent(message, event) {
  if (event.type === "final") {
    message.pending = false;
    message.content = event.content || "";
    message.assets = Array.isArray(event.assets) ? event.assets : [];
  } else if (event.type === "error") {
    message.pending = false;
    message.error = true;
    message.content = event.content || "Codex 调用失败";
  } else {
    message.events.push(event);
    message.content = event.title || "Codex 正在处理";
  }
  render();
}

function buildPayload(coding) {
  const payload = {
    model: "chatgpt",
    messages: messages
      .filter((message) => !message.pending && !message.error)
      .map((message) => ({ role: message.role, content: message.content }))
  };
  if (coding) {
    payload.streamProgress = true;
    payload.codexElevated = true;
    payload.accessLevel = "lv1";
    payload.signMan = "文远";
    payload.workspaceAccess = "life-ai-local";
    payload.workspaceRoot = health.codexWorkspaceRoot || "";
  }
  return payload;
}

function setSending(sending, coding = false) {
  sendEl.disabled = sending;
  clearEl.disabled = sending;
  sendEl.textContent = sending ? (coding ? "运行中" : "等待") : "发送";
}

function render() {
  if (!messages.length) {
    messagesEl.innerHTML = `<div class="empty">发送一句话开始聊天；需要改代码时直接描述需求，界面会切换到 Codex 编程模式。</div>`;
    return;
  }
  messagesEl.replaceChildren(...messages.map((message) => {
    const item = document.createElement("article");
    item.className = `message ${message.role}${message.error ? " error" : ""}${message.coding ? " coding" : ""}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = message.role === "user" ? "你" : (message.coding ? "Codex" : "ChatGPT");
    const body = document.createElement("span");
    body.className = "message-body";
    body.textContent = message.content;
    item.append(meta, body);
    if (message.coding && Array.isArray(message.events)) {
      item.appendChild(renderCodexEvents(message.events));
    }
    const assets = Array.isArray(message.assets) ? message.assets : [];
    if (assets.length) {
      item.appendChild(renderAssets(assets));
    }
    return item;
  }));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderCodexEvents(events) {
  const list = document.createElement("div");
  list.className = "codex-events";
  const recent = events.slice(-60);
  recent.forEach((event) => {
    const row = document.createElement("div");
    row.className = `codex-event ${event.type || "event"} ${event.status || "running"}`;
    const title = document.createElement("div");
    title.className = "codex-event-title";
    title.textContent = eventTitle(event);
    const content = document.createElement("pre");
    content.textContent = event.content || "";
    row.append(title, content);
    list.appendChild(row);
  });
  return list;
}

function renderAssets(assets) {
  const grid = document.createElement("div");
  grid.className = "asset-grid";
  assets.forEach((asset) => {
    const link = document.createElement("a");
    link.className = "asset-link";
    link.href = asset.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = asset.fileName || "生成图片";
    const caption = document.createElement("span");
    caption.className = "asset-meta";
    caption.textContent = imageMeta(asset);
    link.append(image, caption);
    grid.appendChild(link);
  });
  return grid;
}

function eventTitle(event) {
  const labels = {
    codex_step: "步骤",
    tool_call: "命令",
    tool_result: "结果",
    codex_output: event.source || "输出",
    file_change: "文件",
    error: "错误"
  };
  const label = labels[event.type] || "事件";
  return `${label} · ${event.title || event.status || "running"}`;
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(160, Math.max(46, inputEl.scrollHeight))}px`;
}

function pendingText(text, coding) {
  if (coding) return "Codex 正在接手编程任务...";
  return isImagePrompt(text) ? "正在创建图片..." : "正在生成回复...";
}

function imageMeta(asset) {
  const size = formatBytes(asset.size || 0);
  const width = Number(asset.width || 0);
  const height = Number(asset.height || 0);
  const dimensions = width > 0 && height > 0 ? `${width} x ${height}` : "尺寸未知";
  return `${dimensions} · ${size}`;
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isImagePrompt(text) {
  const value = String(text || "");
  const hasImageWord = /(图片|图像|插画|照片|头像|海报|壁纸|竖屏|横屏|image|picture|photo|illustration|wallpaper)/i.test(value);
  const hasCreateWord = /(生成|绘制|画|做|来一张|给我一张|create|generate|draw|make)/i.test(value);
  return hasImageWord && hasCreateWord;
}

function isCodingPrompt(text) {
  const value = String(text || "");
  if (isImagePrompt(value)) return false;
  return /(代码|编程|项目|工作区|仓库|文件|接口|服务端|前端|组件|样式|修复|报错|bug|测试|运行|实现|添加|修改|重构|codex|code|repo|file|server|frontend|backend|component|css|test|fix|bug|implement|refactor)/i.test(value);
}
