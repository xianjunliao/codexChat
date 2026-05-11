const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chatForm");
const inputEl = document.getElementById("promptInput");
const sendEl = document.getElementById("sendButton");
const clearEl = document.getElementById("clearButton");
const statusEl = document.getElementById("status");

const messages = [];

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
  render();
  inputEl.focus();
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    statusEl.textContent = `服务已连接 · ${data.model || "chatgpt"}`;
  } catch (error) {
    statusEl.textContent = `服务不可用：${error.message || "连接失败"}`;
  }
}

async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content || sendEl.disabled) return;
  messages.push({ role: "user", content });
  inputEl.value = "";
  autosize();
  render();
  setSending(true);
  const pending = {
    role: "assistant",
    content: isImagePrompt(content) ? "正在创建图片..." : "正在生成回复...",
    pending: true,
    assets: []
  };
  messages.push(pending);
  render();
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt",
        messages: messages
          .filter((message) => !message.pending && !message.error)
          .map((message) => ({ role: message.role, content: message.content }))
      })
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
  } catch (error) {
    pending.pending = false;
    pending.error = true;
    pending.content = `调用失败：${error.message || "未知错误"}`;
  } finally {
    setSending(false);
    render();
    inputEl.focus();
  }
}

function setSending(sending) {
  sendEl.disabled = sending;
  clearEl.disabled = sending;
  sendEl.textContent = sending ? "等待" : "发送";
}

function render() {
  if (!messages.length) {
    messagesEl.innerHTML = `<div class="empty">发送一句话开始聊天，也可以描述你想生成的图片。</div>`;
    return;
  }
  messagesEl.replaceChildren(...messages.map((message) => {
    const item = document.createElement("article");
    item.className = `message ${message.role}${message.error ? " error" : ""}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = message.role === "user" ? "你" : "ChatGPT";
    const body = document.createElement("span");
    body.textContent = message.content;
    item.append(meta, body);
    const assets = Array.isArray(message.assets) ? message.assets : [];
    if (assets.length) {
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
      item.appendChild(grid);
    }
    return item;
  }));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(160, Math.max(46, inputEl.scrollHeight))}px`;
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
  const hasCreateWord = /(生成|画|绘制|做|出|来一张|给我一张|create|generate|draw|make)/i.test(value);
  return hasImageWord && hasCreateWord;
}
