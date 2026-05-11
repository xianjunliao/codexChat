import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const lifeBaseUrl = (process.env.LIFE_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const publicLifeBaseUrl = (process.env.CODEX_CHAT_PUBLIC_LIFE_BASE_URL || lifeBaseUrl).replace(/\/$/, "");
const chatBaseUrl = (process.env.CHATGPT_BASE_URL || "http://127.0.0.1:3037").replace(/\/$/, "");
const workerToken = process.env.CODEX_CHAT_WORKER_TOKEN || "";
const pollMs = Number(process.env.CODEX_CHAT_POLL_MS || 5000);
const workspaceSyncMs = Number(process.env.CODEX_CHAT_WORKSPACE_SYNC_MS || 60 * 1000);
const lifeRequestTimeoutMs = parseTimeoutMs(process.env.CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS, 60 * 1000);
const chatRequestTimeoutMs = parseTimeoutMs(process.env.CODEX_CHAT_REQUEST_TIMEOUT_MS, 65 * 60 * 1000);
const requestRetries = Number(process.env.CODEX_CHAT_REQUEST_RETRIES || 2);
const once = process.argv.includes("--once");
const uploadToLife = String(process.env.CODEX_CHAT_UPLOAD_TO_LIFE || "true").toLowerCase() !== "false";
const uploadThemeName = process.env.CODEX_CHAT_UPLOAD_THEME || "CodexChat";
const logFile = path.join(projectRoot, "logs", "codex-chat-worker.log");
const lockFile = path.join(projectRoot, "logs", "codex-chat-worker.pid");
const completionOutboxDir = path.join(projectRoot, "data", "codex-chat-completions");
let lastWorkspaceSyncAt = 0;

await fs.mkdir(path.join(projectRoot, "logs"), { recursive: true });
await fs.mkdir(completionOutboxDir, { recursive: true });
await acquireWorkerLock();
log(`Codex chat worker started. life=${lifeBaseUrl} chat=${chatBaseUrl} chatTimeoutMs=${chatRequestTimeoutMs} lifeTimeoutMs=${lifeRequestTimeoutMs}`);

do {
  try {
    await flushCompletionOutbox();
    await syncWorkspaceCatalog();
    const job = await takePendingJob();
    if (job) {
      await processJob(job);
    } else if (once) {
      log("No pending job.");
    }
  } catch (error) {
    log(`Worker error: ${errorMessage(error)}`);
  }
  if (!once) await sleep(pollMs);
} while (!once);

async function takePendingJob() {
  const data = await getJson(`${lifeBaseUrl}/api/codex-chat/worker/jobs?status=pending&limit=1`);
  const job = data.jobs?.[0];
  if (!job) return null;
  await postJson(`${lifeBaseUrl}/api/codex-chat/worker/jobs/${encodeURIComponent(job.requestId)}/running`, {});
  return job;
}

async function syncWorkspaceCatalog() {
  const now = Date.now();
  if (now - lastWorkspaceSyncAt < workspaceSyncMs) return;
  lastWorkspaceSyncAt = now;
  const params = new URLSearchParams({
    accessLevel: "lv1",
    signMan: "文远",
    codexElevated: "true"
  });
  const data = await getJson(`${chatBaseUrl}/api/workspaces?${params.toString()}`, { workerToken: false, timeoutMs: 5000 });
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
  if (!workspaces.length) return;
  await postJson(`${lifeBaseUrl}/api/codex-chat/worker/workspaces`, {
    defaultWorkspaceRoot: data.defaultWorkspaceRoot || "",
    workspaces,
    source: "codex-chat-worker",
    syncedAt: now
  });
}

async function processJob(job) {
  const requestId = job.requestId;
  const startedAt = Date.now();
  try {
    const requestPayload = parseJson(job.requestJson);
    const chatResponse = await postJson(`${chatBaseUrl}/v1/chat/completions`, {
      ...requestPayload,
      model: requestPayload.model || "chatgpt"
    }, { workerToken: false });
    const message = chatResponse.choices?.[0]?.message || {};
    let assets = Array.isArray(message.assets) ? message.assets : (Array.isArray(chatResponse.assets) ? chatResponse.assets : []);
    if (uploadToLife && assets.length) {
      assets = await uploadAssetsToLife(assets);
      chatResponse.assets = assets;
      if (chatResponse.choices?.[0]?.message) {
        chatResponse.choices[0].message.assets = assets;
      }
    }
    await deliverCompletion(requestId, "complete", {
      assistantText: message.content || "",
      responseJson: chatResponse,
      assets,
      statusCode: 200,
      latencyMs: Date.now() - startedAt
    });
    log(`Completed ${requestId}`);
  } catch (error) {
    await deliverCompletion(requestId, "error", {
      error: trimText(errorMessage(error), 4000),
      statusCode: 500
    }).catch(() => {});
    throw error;
  }
}

async function deliverCompletion(requestId, kind, payload) {
  const safeKind = kind === "error" ? "error" : "complete";
  const record = {
    requestId,
    kind: safeKind,
    payload,
    createdAt: Date.now(),
    attempts: 0,
    lastError: ""
  };
  try {
    await postCompletionRecord(record);
    await removeCompletionRecord(requestId).catch(() => {});
  } catch (error) {
    record.attempts = 1;
    record.lastError = trimText(errorMessage(error), 1000);
    await saveCompletionRecord(record);
    log(`Completion delivery deferred ${requestId}: ${record.lastError}`);
  }
}

async function flushCompletionOutbox() {
  const records = await readCompletionRecords();
  for (const record of records) {
    try {
      await postCompletionRecord(record);
      await removeCompletionRecord(record.requestId);
      log(`Flushed ${record.kind || "complete"} ${record.requestId}`);
    } catch (error) {
      record.attempts = Number(record.attempts || 0) + 1;
      record.lastError = trimText(errorMessage(error), 1000);
      record.updatedAt = Date.now();
      await saveCompletionRecord(record);
      log(`Completion flush deferred ${record.requestId}: ${record.lastError}`);
      break;
    }
  }
}

async function postCompletionRecord(record) {
  const requestId = String(record?.requestId || "").trim();
  if (!requestId) throw new Error("completion requestId missing");
  const kind = record.kind === "error" ? "error" : "complete";
  const payload = kind === "complete" ? await prepareCompletionPayload(record.payload || {}) : (record.payload || {});
  return await postJson(`${lifeBaseUrl}/api/codex-chat/worker/jobs/${encodeURIComponent(requestId)}/${kind}`, payload);
}

async function prepareCompletionPayload(payload) {
  if (!uploadToLife) return payload;
  const responseJson = payload.responseJson || {};
  const response = typeof responseJson === "string" ? parseJson(responseJson) : responseJson;
  let assets = Array.isArray(payload.assets)
    ? payload.assets
    : (Array.isArray(response?.assets) ? response.assets : (Array.isArray(response?.choices?.[0]?.message?.assets) ? response.choices[0].message.assets : []));
  if (!assets.length || assets.every((asset) => asset?.uploaded === true || asset?.downloadId)) return payload;
  assets = await uploadAssetsToLife(assets);
  if (response && typeof response === "object") {
    response.assets = assets;
    if (response.choices?.[0]?.message) {
      response.choices[0].message.assets = assets;
    }
  }
  return {
    ...payload,
    assets,
    responseJson: response && Object.keys(response).length ? response : payload.responseJson
  };
}

async function readCompletionRecords() {
  let entries = [];
  try {
    entries = await fs.readdir(completionOutboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(completionOutboxDir, entry.name);
    try {
      const record = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (record?.requestId) records.push(record);
    } catch {
    }
  }
  return records.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

async function saveCompletionRecord(record) {
  await fs.mkdir(completionOutboxDir, { recursive: true });
  const filePath = completionRecordPath(record.requestId);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
}

async function removeCompletionRecord(requestId) {
  const filePath = completionRecordPath(requestId);
  if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
}

function completionRecordPath(requestId) {
  const safeName = String(requestId || "").replace(/[^a-z0-9_.-]+/gi, "_") || "unknown";
  return path.join(completionOutboxDir, `${safeName}.json`);
}

async function uploadAssetsToLife(assets) {
  const uploaded = [];
  for (const asset of assets) {
    try {
      const assetUrl = absoluteAssetUrl(asset.url || "");
      const response = await fetch(assetUrl);
      if (!response.ok) throw new Error(`asset download failed: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName = asset.fileName || path.basename(new URL(assetUrl).pathname) || "codex-chat.png";
      const formData = new FormData();
      formData.append("file", new Blob([buffer], { type: asset.type || contentType(fileName) }), fileName);
      const uploadResponse = await fetch(`${lifeBaseUrl}/upload/to?themeName=${encodeURIComponent(uploadThemeName)}`, {
        method: "POST",
        headers: workerToken ? { "X-Codex-Chat-Token": workerToken } : {},
        body: formData
      });
      const data = await uploadResponse.json().catch(() => ({}));
      if (!uploadResponse.ok || Number(data.status) !== 200) {
        throw new Error(data.message || `upload failed: ${uploadResponse.status}`);
      }
      const downloadId = data.data?.downloadId || "";
      uploaded.push({
        ...asset,
        uploaded: true,
        downloadId,
        fileSize: data.data?.fileSize || asset.fileSize || "",
        themeName: data.data?.themeName || uploadThemeName,
        url: downloadId ? `${publicLifeBaseUrl}/download/to?id=${encodeURIComponent(downloadId)}` : asset.url,
        playUrl: ""
      });
    } catch (error) {
      uploaded.push({
        ...asset,
        uploaded: false,
        uploadError: errorMessage(error)
      });
    }
  }
  return uploaded;
}

function absoluteAssetUrl(url) {
  const value = String(url || "");
  if (/^https?:\/\//i.test(value)) return value;
  return `${chatBaseUrl}${value.startsWith("/") ? "" : "/"}${value}`;
}

async function getJson(url, options = {}) {
  const response = await requestJsonWithRetry(url, {
    method: "GET",
    headers: options.workerToken === false || !workerToken ? {} : { "X-Codex-Chat-Token": workerToken },
    timeoutMs: parseTimeoutMs(options.timeoutMs, lifeRequestTimeoutMs)
  });
  const data = response.data;
  if (response.status < 200 || response.status >= 300 || data.success === false || data.ok === false) {
    const message = data.error || data.message || "request failed";
    throw new Error(`GET ${url} failed: ${response.status} ${message}`);
  }
  return data;
}

async function postJson(url, payload, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.workerToken !== false && workerToken) headers["X-Codex-Chat-Token"] = workerToken;
  const response = await requestJsonWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload || {}),
    timeoutMs: options.workerToken === false ? chatRequestTimeoutMs : lifeRequestTimeoutMs
  });
  const data = response.data;
  if (response.status < 200 || response.status >= 300 || data.success === false || data.ok === false) {
    const message = data.error || data.message || "request failed";
    throw new Error(`POST ${url} failed: ${response.status} ${message}`);
  }
  return data;
}

async function requestJsonWithRetry(url, options) {
  const attempts = Math.max(1, requestRetries + 1);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientRequestError(error)) break;
      await sleep(Math.min(1000 * attempt, 3000));
    }
  }
  throw lastError;
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const body = options.body || "";
    const headers = { ...(options.headers || {}) };
    if (body && !headers["Content-Length"]) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const timeoutMs = parseTimeoutMs(options.timeoutMs, lifeRequestTimeoutMs);
    const request = (isHttps ? https : http).request({
      method: options.method || "GET",
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs > 0 ? timeoutMs : 0
    }, (response) => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        resolve({ status: response.statusCode || 0, data, text });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function isTransientRequestError(error) {
  const message = errorMessage(error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|timeout|other side closed|Headers Timeout/i.test(message);
}

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function contentType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeoutMs(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimText(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : value.slice(0, max) + "\n...";
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fsSync.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // Console logging still works if the file is temporarily unavailable.
  }
}

function errorMessage(error) {
  const message = error?.message || String(error || "unknown error");
  const cause = error?.cause;
  if (cause?.message && cause.message !== message) {
    return `${message}: ${cause.message}`;
  }
  if (cause?.code) {
    return `${message}: ${cause.code}`;
  }
  return message;
}

async function acquireWorkerLock() {
  if (fsSync.existsSync(lockFile)) {
    const pid = Number(fsSync.readFileSync(lockFile, "utf8").trim());
    if (pid && isProcessAlive(pid)) {
      console.log(`Codex chat worker is already running. pid=${pid}`);
      process.exit(0);
    }
  }
  fsSync.writeFileSync(lockFile, String(process.pid), "utf8");
  const cleanup = () => {
    try {
      if (fsSync.existsSync(lockFile) && fsSync.readFileSync(lockFile, "utf8").trim() === String(process.pid)) {
        fsSync.unlinkSync(lockFile);
      }
    } catch {
      // Best effort only.
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
