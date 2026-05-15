import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const outputRoot = path.join(__dirname, "generated", "codex-chat");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3037);
const publicBaseUrl = `http://${host}:${port}`;
const serviceVersion = "20260513-image-assets-v2";
const serviceModel = process.env.CODEX_CHAT_MODEL || "chatgpt";
const codexCommand = process.env.CODEX_COMMAND || resolveCodexCommand();
const codexTimeoutMs = parseTimeoutMs(process.env.CODEX_CHAT_TIMEOUT_MS, 60 * 60 * 1000);
const codexSandboxMode = normalizeSandboxMode(process.env.CODEX_CHAT_SANDBOX_MODE || "workspace-write");
const codexElevatedSandboxMode = normalizeSandboxMode(process.env.CODEX_CHAT_ELEVATED_SANDBOX_MODE || "danger-full-access");
const codexWorkspaceRoot = resolveLocalPath(process.env.CODEX_CHAT_WORKSPACE_ROOT || __dirname);
const workspaceFilterRoot = resolveLocalPath(process.env.CODEX_CHAT_WORKSPACE_FILTER_ROOT || "E:\\works\\project");
const codexConfigPath = process.env.CODEX_CONFIG_PATH || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "config.toml");
const retentionMaxAgeMs = parseTimeoutMs(process.env.CODEX_CHAT_RETENTION_MAX_AGE_MS, 60 * 60 * 1000);
const retentionMaxOutputDirs = Math.max(1, Number(process.env.CODEX_CHAT_RETENTION_MAX_OUTPUT_DIRS || 5));
const retentionMaxDataFiles = Math.max(1, Number(process.env.CODEX_CHAT_RETENTION_MAX_DATA_FILES || 20));
const cleanupIntervalMs = parseTimeoutMs(process.env.CODEX_CHAT_CLEANUP_INTERVAL_MS, 60 * 60 * 1000);
const cleanupCodexGeneratedImages = String(process.env.CODEX_CHAT_CLEANUP_CODEX_GENERATED_IMAGES || "true").toLowerCase() === "true";
const codexGeneratedImagesMaxAgeMs = parseTimeoutMs(process.env.CODEX_CHAT_CODEX_GENERATED_IMAGES_MAX_AGE_MS, 60 * 60 * 1000);
const cleanupArtifactsOnComplete = String(process.env.CODEX_CHAT_CLEANUP_ON_COMPLETE || "true").toLowerCase() !== "false";
const deleteRecoveredCodexImages = String(process.env.CODEX_CHAT_DELETE_RECOVERED_CODEX_IMAGES || "true").toLowerCase() !== "false";
const outputPostCompleteTtlMs = parseTimeoutMs(process.env.CODEX_CHAT_OUTPUT_POST_COMPLETE_TTL_MS, 2 * 60 * 1000);

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(publicDir, { recursive: true });
await fs.mkdir(outputRoot, { recursive: true });
scheduleRuntimeCleanup();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const url = new URL(req.url || "/", publicBaseUrl);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "chatgpt-service",
        version: serviceVersion,
        model: serviceModel,
        codexCommand,
        codexWorkspaceRoot,
        codexTimeoutMs,
        codexSandboxMode,
        codexElevatedSandboxMode,
        workspaceAccess: "lv1+wenyuan-only"
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      const accessPayload = Object.fromEntries(url.searchParams.entries());
      const workspaceAllowed = canOperateWorkspace({
        ...accessPayload,
        codexElevated: accessPayload.codexElevated === "true" || accessPayload.codexElevated === "1"
      });
      sendJson(res, 200, {
        ok: true,
        canOperateWorkspace: workspaceAllowed,
        defaultWorkspaceRoot: workspaceAllowed ? resolveWorkspaceRoot({}, { workspaceAllowed: true }) : "",
        workspaces: workspaceAllowed ? await listTrustedWorkspaces() : []
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [{
          id: serviceModel,
          object: "model",
          created: 0,
          owned_by: "local-chatgpt"
        }]
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const payload = await readJson(req);
      const result = await runCodexChat(payload);
      const created = Math.floor(Date.now() / 1000);
      sendJson(res, 200, {
        id: "chatcmpl-" + crypto.randomBytes(12).toString("hex"),
        object: "chat.completion",
        created,
        model: String(payload.model || serviceModel),
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.answer,
            assets: result.assets
          },
          finish_reason: "stop"
        }],
        assets: result.assets,
        usage: estimateUsage(payload, result.answer)
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      await streamCodexChat(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/outputs/")) {
      await serveOutput(req, res, url);
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/outputs/")) {
      const requestId = decodeURIComponent(url.pathname.replace(/^\/outputs\//, "").split("/")[0] || "");
      sendJson(res, 200, { ok: true, deleted: await deleteOutputRequest(requestId) });
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      await serveStatic(req, res, url);
      return;
    }
    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: errorMessage(error) });
  }
});

server.listen(port, host, () => {
  console.log(`ChatGPT service running at http://${host}:${port}`);
});

async function streamCodexChat(req, res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true"
  });
  const emit = (event) => {
    res.write(JSON.stringify({
      ts: Date.now(),
      ...event
    }) + "\n");
  };
  try {
    const payload = await readJson(req);
    const onProgressEvent = shouldStreamProgress(payload) ? emit : () => {};
    const result = await runCodexChat(payload, onProgressEvent);
    emit({
      type: "final",
      status: "done",
      title: "处理完成",
      content: result.answer,
      assets: result.assets
    });
  } catch (error) {
    emit({
      type: "error",
      status: "error",
      title: "调用失败",
      content: errorMessage(error)
    });
  } finally {
    res.end();
  }
}

function shouldStreamProgress(payload) {
  if (payload?.streamProgress === true || payload?.streamProgress === "true") {
    return true;
  }
  return canOperateWorkspace(payload) && hasRequestedWorkspace(payload);
}

async function runCodexChat(payload, onEvent = () => {}) {
  const requestStartedAt = Date.now();
  const requestId = "chat-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const wantsImage = isImageRequest(payload);
  const workspaceAllowed = canOperateWorkspace(payload) && hasRequestedWorkspace(payload);
  const workspaceRoot = resolveWorkspaceRoot(payload, { workspaceAllowed });
  const sandboxMode = resolveSandboxMode(payload, { workspaceAllowed, wantsImage });
  const imageNamePrefix = wantsImage ? `image-${Date.now()}-${crypto.randomBytes(4).toString("hex")}` : "";
  const outputDir = path.join(outputRoot, requestId);
  const attachmentDir = path.join(dataDir, `${requestId}-attachments`);
  const imageAttachments = await collectImageAttachments(payload, attachmentDir);
  if (wantsImage) {
    await fs.mkdir(outputDir, { recursive: true });
  }
  onEvent({
    type: "progress",
    status: "running",
    title: wantsImage ? "准备图片生成" : (workspaceAllowed ? "准备任务" : "准备回复"),
    content: wantsImage ? "正在准备图片生成..." : (workspaceAllowed ? "正在准备任务上下文..." : "正在理解你的问题...")
  });
  const promptFile = path.join(dataDir, `${requestId}-prompt.txt`);
  const lastMessageFile = path.join(dataDir, `${requestId}-last-message.txt`);
  await fs.writeFile(promptFile, buildPrompt(payload, { wantsImage, outputDir, requestId, imageNamePrefix, workspaceRoot, sandboxMode, imageAttachments, workspaceAllowed }), "utf8");
  const hasLocalImageAttachments = imageAttachments.some((attachment) => !attachment.remote);
  onEvent({
    type: "progress",
    status: "running",
    title: wantsImage ? "生成图片" : (workspaceAllowed ? "开始执行" : "组织回答"),
    content: wantsImage ? "正在生成图片..." : (workspaceAllowed ? "正在执行任务..." : "正在组织回答...")
  });
  const result = await runCodex(promptFile, lastMessageFile, {
    wantsImage,
    workspaceRoot,
    sandboxMode,
    attachmentDir: hasLocalImageAttachments ? attachmentDir : "",
    onEvent
  });
  const lastMessage = existsSync(lastMessageFile)
    ? (await fs.readFile(lastMessageFile, "utf8")).trim()
    : "";
  let assets = wantsImage ? await collectAssets(outputDir, requestId) : [];
  if (wantsImage && !assets.length) {
    assets = await collectAssetsFromOutputText(
      [lastMessage, result.stdout, result.stderr].filter(Boolean).join("\n"),
      { outputDir, requestId, workspaceRoot }
    );
  }
  if (wantsImage && !assets.length) {
    assets = await collectAssetsFromCodexGeneratedImages({
      outputDir,
      requestId,
      imageNamePrefix,
      sinceMs: requestStartedAt - 5000
    });
  }
  if (result.code !== 0) {
    throw new Error(trimText(result.stderr || result.stdout || "codex exec failed", 4000));
  }
  if (wantsImage && !assets.length) {
    throw new Error("Image generation did not produce a saved image file. Please retry; no image was uploaded to life.");
  }
  const answer = assets.length
    ? (assets.length > 1 ? `Generated ${assets.length} images.` : "Generated image.")
    : (lastMessage || result.stdout.trim() || "Codex completed without a final message.");
  if (assets.length) {
    scheduleOutputRequestCleanup(requestId);
  }
  if (workspaceAllowed) {
    const changedFiles = collectChangedFiles(workspaceRoot);
    if (changedFiles.length) {
      onEvent({
        type: "file_change",
        status: "done",
        title: `${changedFiles.length} 个文件已更改`,
        content: formatChangedFiles(changedFiles),
        files: changedFiles
      });
    }
  }
  if (cleanupArtifactsOnComplete) {
    cleanupRequestDataArtifacts({ promptFile, lastMessageFile, attachmentDir }).catch(() => {});
  }
  cleanupRuntimeArtifacts().catch(() => {});
  return { answer, assets };
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname.replace(/^\/assets\//, "/");
  const filePath = path.join(publicDir, decodeURIComponent(pathname));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  const file = await fs.readFile(filePath);
  res.end(file);
}

async function serveOutput(req, res, url) {
  const relative = decodeURIComponent(url.pathname.replace(/^\/outputs\//, ""));
  const filePath = path.join(outputRoot, relative);
  if (!filePath.startsWith(outputRoot) || !existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(filePath) });
  const file = await fs.readFile(filePath);
  res.end(file);
}

async function cleanupRequestDataArtifacts({ promptFile, lastMessageFile, attachmentDir } = {}) {
  for (const filePath of [promptFile, lastMessageFile]) {
    if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
  }
  if (attachmentDir) {
    await fs.rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function deleteOutputRequest(requestId) {
  const safeId = String(requestId || "").trim();
  if (!/^chat-\d+-[a-f0-9]+$/i.test(safeId)) return false;
  const dir = path.join(outputRoot, safeId);
  if (!path.resolve(dir).startsWith(path.resolve(outputRoot))) return false;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

function scheduleOutputRequestCleanup(requestId) {
  if (!outputPostCompleteTtlMs || outputPostCompleteTtlMs < 0) return;
  setTimeout(() => deleteOutputRequest(requestId).catch(() => {}), outputPostCompleteTtlMs).unref?.();
}

function buildPrompt(payload, options = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const normalized = messages
    .map((message) => {
      const role = String(message?.role || "user").trim() || "user";
      const content = normalizeContent(message?.content);
      return content ? `${role.toUpperCase()}:\n${content}` : "";
    })
    .filter(Boolean);
  const fallback = String(payload?.prompt || payload?.question || "").trim();
  const base = [
    "You are ChatGPT, a local chat and image generation assistant.",
    "Reply directly to the user. Preserve the user's language unless they ask otherwise.",
    "If the request is ordinary conversation or Q&A, answer in plain text or Markdown.",
    options.wantsImage
      ? "The user is asking for an image. You MUST use the available image generation capability/tool now, save the final image file into the exact output directory below, and return only a brief summary after the file exists. Do not provide a text-only description. Do not claim success unless an actual image file was written."
      : "Do not edit files, run commands, or change the workspace unless the user explicitly asks for coding work.",
    options.workspaceAllowed
      ? "Workspace access is enabled for this request."
      : "Limited access mode: you may only chat, generate images, and inspect attached images. Do not inspect, list, edit, run commands for, or operate any local project/workspace. If the user asks for workspace, file, shell, codebase, or local project operations, politely say: 当前权限仅支持聊天、生图和识别上传图片，暂不支持工作区操作。",
    "When reading Chinese documentation or source files, preserve UTF-8. If text appears garbled/mojibake, re-read it with an explicit encoding (UTF-8 first, then GBK/GB18030 if needed) before summarizing. Never return garbled text to the user.",
    options.imageAttachments?.length
      ? "The user attached screenshots/images. Inspect the local image files listed below directly with Codex's vision capability before deciding what code changes or explanation are needed. Do not rely only on OCR."
      : "",
    `Working project root: ${options.workspaceRoot || __dirname}`,
    options.imageAttachments?.length ? formatImageAttachmentPrompt(options.imageAttachments) : "",
    `Codex sandbox mode: ${options.sandboxMode || codexSandboxMode}`,
    options.wantsImage ? `Output directory: ${options.outputDir}` : "",
    options.wantsImage ? `Save images with unique filenames starting with ${options.imageNamePrefix}, for example ${options.imageNamePrefix}-01.png. Do not use generic names like image-0001.png. If image generation is unavailable or no file can be written, fail clearly instead of returning a successful text description.` : "",
    options.wantsImage ? "" : "",
    normalized.length ? normalized.join("\n\n") : `USER:\n${fallback}`,
    "",
    "ASSISTANT:"
  ];
  return base.filter((line, index) => line || index > 3).join("\n");
}
function normalizeContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image_url") return "[Image attachment supplied separately as a local file for Codex vision]";
      return "";
    }).filter(Boolean).join("\n").trim();
  }
  return content == null ? "" : String(content).trim();
}

async function collectImageAttachments(payload, attachmentDir) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const attachments = [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (part?.type !== "image_url") continue;
      const rawUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const data = parseDataImage(rawUrl);
      if (!data) {
        if (rawUrl) {
          attachments.push({
            name: `remote-image-${attachments.length + 1}`,
            path: rawUrl,
            remote: true
          });
        }
        continue;
      }
      await fs.mkdir(attachmentDir, { recursive: true });
      const index = attachments.filter((item) => !item.remote).length + 1;
      const fileName = `screenshot-${String(index).padStart(2, "0")}.${data.ext}`;
      const filePath = path.join(attachmentDir, fileName);
      await fs.writeFile(filePath, data.buffer);
      attachments.push({
        name: fileName,
        path: filePath,
        mime: data.mime,
        remote: false
      });
    }
  }
  return attachments;
}

function parseDataImage(value) {
  const text = String(value || "");
  const match = text.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const extByMime = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return {
    mime,
    ext: extByMime[mime] || "png",
    buffer: Buffer.from(match[2], "base64")
  };
}

function formatImageAttachmentPrompt(attachments) {
  const lines = ["Image attachments available to Codex:"];
  attachments.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${attachment.name || "image"}: ${attachment.path}`);
  });
  return lines.join("\n");
}

async function runCodex(promptFile, lastMessageFile, options = {}) {
  return new Promise((resolve) => {
    const workspaceRoot = resolveLocalPath(options.workspaceRoot || __dirname);
    const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C", workspaceRoot,
      "-s", normalizeSandboxMode(options.sandboxMode || codexSandboxMode)
    ];
    if (options.wantsImage) {
      args.push("--add-dir", outputRoot);
    }
    if (options.attachmentDir) {
      args.push("--add-dir", options.attachmentDir);
    }
    args.push("--output-last-message", lastMessageFile, "-");
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      const command = buildCommandSpawn(codexCommand, args);
      child = spawn(command.file, command.args, {
        cwd: workspaceRoot,
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          LANG: process.env.LANG || "C.UTF-8",
          LC_ALL: process.env.LC_ALL || "C.UTF-8",
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
          POWERSHELL_TELEMETRY_OPTOUT: process.env.POWERSHELL_TELEMETRY_OPTOUT || "1"
        }
      });
    } catch (error) {
      resolve({ code: 1, stdout, stderr: errorMessage(error) });
      return;
    }
    const timeout = codexTimeoutMs > 0
      ? setTimeout(() => {
        terminateProcessTree(child);
        finish(1, `codex exec timed out after ${Math.round(codexTimeoutMs / 1000)} seconds`);
      }, codexTimeoutMs)
      : null;
    const finish = (code, extraStderr = "") => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code !== 0 || extraStderr) {
        onEvent({
          type: "error",
          status: "error",
          title: "执行失败",
          content: extraStderr || `退出码：${code ?? 0}`
        });
      }
      resolve({ code, stdout, stderr: stderr + extraStderr });
    };
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      emitCodexOutput(onEvent, "stdout", text);
    });
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      stderr += text;
      emitCodexOutput(onEvent, "stderr", text);
    });
    child.on("error", error => finish(1, errorMessage(error)));
    child.on("close", code => finish(code));
    fs.readFile(promptFile, "utf8")
      .then(text => {
        child.stdin.write(text);
        child.stdin.end();
      })
      .catch(error => {
        child.stdin.write("Failed to read prompt: " + errorMessage(error));
        child.stdin.end();
      });
  });
}

function buildCommandSpawn(command, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const commandDir = path.dirname(command);
    const nodeExe = path.join(commandDir, "node.exe");
    const codexJs = path.join(commandDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(nodeExe) && existsSync(codexJs)) {
      return { file: nodeExe, args: [codexJs, ...args] };
    }
    const shell = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    return {
      file: shell,
      args: ["/d", "/s", "/c", quoteCmdArg(command) + " " + args.map(quoteCmdArg).join(" ")]
    };
  }
  return { file: command, args };
}

function quoteCmdArg(value) {
  const text = String(value || "");
  return `"${text.replace(/"/g, '\\"')}"`;
}

async function collectAssets(dir, requestId) {
  if (!existsSync(dir)) return [];
  const files = await fs.readdir(dir, { withFileTypes: true });
  const assets = [];
  for (const file of files) {
    if (!file.isFile() || !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) continue;
    const filePath = path.join(dir, file.name);
    const stat = await fs.stat(filePath).catch(() => null);
    const dimensions = await readImageDimensions(filePath);
    const dataUrl = await imageDataUrl(filePath, contentType(file.name));
    assets.push({
      fileName: file.name,
      type: contentType(file.name),
      size: stat?.size || 0,
      width: dimensions.width,
      height: dimensions.height,
      dataUrl,
      url: `/outputs/${encodeURIComponent(requestId)}/${encodeURIComponent(file.name)}`
    });
  }
  return assets.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

async function imageDataUrl(filePath, type) {
  try {
    const buffer = await fs.readFile(filePath);
    return `data:${type || "image/png"};base64,${buffer.toString("base64")}`;
  } catch {
    return "";
  }
}

async function collectAssetsFromOutputText(text, options = {}) {
  const imagePaths = extractImagePaths(text);
  if (!imagePaths.length) return [];
  const copied = [];
  await fs.mkdir(options.outputDir, { recursive: true });
  for (const imagePath of imagePaths) {
    const sourcePath = resolveReferencedImagePath(imagePath, options.workspaceRoot);
    if (!sourcePath || copied.includes(sourcePath) || !existsSync(sourcePath)) continue;
    const fileName = uniqueAssetFileName(options.outputDir, path.basename(sourcePath));
    const targetPath = path.join(options.outputDir, fileName);
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath).catch(() => null);
    }
    copied.push(sourcePath);
  }
  return collectAssets(options.outputDir, options.requestId);
}

async function collectAssetsFromCodexGeneratedImages(options = {}) {
  const roots = codexGeneratedImageRoots();
  const candidates = [];
  for (const root of roots) {
    candidates.push(...await listRecentImageFiles(root, options.sinceMs || 0));
  }
  const unique = new Map();
  for (const filePath of candidates) {
    unique.set(path.resolve(filePath).toLowerCase(), filePath);
  }
  const recent = Array.from(unique.values()).sort((a, b) => {
    const left = statMtimeMs(a);
    const right = statMtimeMs(b);
    return right - left;
  }).slice(0, 4);
  if (!recent.length) return [];
  await fs.mkdir(options.outputDir, { recursive: true });
  let index = 1;
  for (const sourcePath of recent.reverse()) {
    const ext = path.extname(sourcePath) || ".png";
    const fileName = `${options.imageNamePrefix || "image"}-${String(index).padStart(2, "0")}${ext}`;
    const targetPath = path.join(options.outputDir, fileName);
    await fs.copyFile(sourcePath, targetPath).catch(() => null);
    if (deleteRecoveredCodexImages) {
      await fs.rm(sourcePath, { force: true }).catch(() => {});
    }
    index += 1;
  }
  return collectAssets(options.outputDir, options.requestId);
}

function codexGeneratedImageRoots() {
  const roots = [];
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
  if (home) roots.push(path.join(home, "generated_images"));
  return roots.filter(Boolean);
}

async function listRecentImageFiles(root, sinceMs) {
  if (!root || !existsSync(root)) return [];
  const results = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (statMtimeMs(itemPath) >= sinceMs - 60 * 1000) stack.push(itemPath);
        continue;
      }
      if (!entry.isFile() || !/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
      if (statMtimeMs(itemPath) >= sinceMs) results.push(itemPath);
    }
  }
  return results;
}

function statMtimeMs(filePath) {
  try {
    return existsSync(filePath) ? Number(statSync(filePath).mtimeMs || 0) : 0;
  } catch {
    return 0;
  }
}

function scheduleRuntimeCleanup() {
  cleanupRuntimeArtifacts().catch(() => {});
  if (cleanupIntervalMs > 0) {
    setInterval(() => cleanupRuntimeArtifacts().catch(() => {}), cleanupIntervalMs).unref?.();
  }
}

async function cleanupRuntimeArtifacts() {
  const cutoff = Date.now() - retentionMaxAgeMs;
  await cleanupOldDataFiles(cutoff);
  await cleanupOldOutputDirs(cutoff);
  if (cleanupCodexGeneratedImages) {
    await cleanupOldCodexGeneratedImages(Date.now() - codexGeneratedImagesMaxAgeMs);
  }
}

async function cleanupOldDataFiles(cutoff) {
  const files = await listFiles(dataDir);
  const candidates = files
    .filter((file) => /chat-\d+-[a-f0-9]+-(prompt|last-message)\.txt$/i.test(path.basename(file)))
    .sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  await removeOldPaths(candidates, cutoff, retentionMaxDataFiles);
  const attachmentDirs = (await listDirectories(dataDir))
    .filter((dir) => /^chat-\d+-[a-f0-9]+-attachments$/i.test(path.basename(dir)));
  await removeOldPaths(attachmentDirs, cutoff, retentionMaxOutputDirs);
}

async function cleanupOldOutputDirs(cutoff) {
  const dirs = (await listDirectories(outputRoot))
    .filter((dir) => /^chat-\d+-[a-f0-9]+$/i.test(path.basename(dir)))
    .sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
  await removeOldPaths(dirs, cutoff, retentionMaxOutputDirs);
}

async function cleanupOldCodexGeneratedImages(cutoff) {
  for (const root of codexGeneratedImageRoots()) {
    const dirs = (await listDirectories(root))
      .sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
    await removeOldPaths(dirs, cutoff, retentionMaxOutputDirs);
  }
}

async function removeOldPaths(paths, cutoff, keepNewest) {
  for (let index = 0; index < paths.length; index += 1) {
    const itemPath = paths[index];
    if (index < keepNewest && statMtimeMs(itemPath) >= cutoff) continue;
    await fs.rm(itemPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function listFiles(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function listDirectories(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function extractImagePaths(text) {
  const value = String(text || "");
  const matches = value.match(/(?:[a-zA-Z]:\\|\/|\.{1,2}[\\/])[^`"'<>|\r\n]+?\.(?:png|jpe?g|webp|gif)/gi) || [];
  return [...new Set(matches.map((item) => item.trim()))];
}

function resolveReferencedImagePath(imagePath, workspaceRoot = __dirname) {
  const value = String(imagePath || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return path.normalize(value);
  const candidates = [
    path.resolve(workspaceRoot, value),
    path.resolve(__dirname, value)
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function uniqueAssetFileName(dir, fileName) {
  const safeName = String(fileName || "image.png").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_");
  const ext = path.extname(safeName) || ".png";
  const base = path.basename(safeName, ext) || "image";
  let candidate = `${base}${ext}`;
  let index = 1;
  while (existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

async function readImageDimensions(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20)
      };
    }
    if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {
            width: buffer.readUInt16BE(offset + 7),
            height: buffer.readUInt16BE(offset + 5)
          };
        }
        offset += 2 + length;
      }
    }
    if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      const chunk = buffer.toString("ascii", 12, 16);
      if (chunk === "VP8X") {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3)
        };
      }
      if (chunk === "VP8 " && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff
        };
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

function isImageRequest(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const lastUser = messages.slice().reverse().find((message) => String(message?.role || "") === "user");
  const text = normalizeContent(lastUser?.content || payload?.prompt || payload?.question || "");
  const hasImageWord = /(图片|图像|插画|照片|头像|海报|壁纸|竖屏|横屏|风景图|场景图|配图|效果图|示意图|图|image|picture|photo|illustration|wallpaper)/i.test(text);
  const hasCreateWord = /(生成|画|绘制|做|出|来一张|给我一张|create|generate|draw|make)/i.test(text);
  return hasImageWord && hasCreateWord;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true"
  });
  res.end(status === 204 ? "" : JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
    ,
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "application/octet-stream";
}

function estimateUsage(payload, answer) {
  const prompt = JSON.stringify(payload?.messages || payload || {});
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(answer);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function trimText(text, max) {
  const value = String(text || "");
  return value.length <= max ? value : value.slice(0, max) + "\n...";
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

function emitCodexOutput(onEvent, source, text) {
  const clean = String(text || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
  if (!clean) return;
  if (source === "stderr") return;
  const chunks = clean.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => shouldEmitCodexOutputLine(line))
    .slice(-4);
  for (const line of chunks) {
    onEvent({
      type: "progress",
      status: "running",
      title: "进展",
      content: trimText(line, 1200)
    });
  }
}

function shouldEmitCodexOutputLine(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^(tokens used|codex|[-`'\s./\\\w:,]+|[\d,]+)$/i.test(value)) return false;
  if (/^[-`'\s]*[^一-龥]{1,100}[-`'\s]*$/i.test(value)) return false;
  if (isCodeLikeOutput(value)) return false;
  return /[\u4e00-\u9fa5]/.test(value);
}

function isCodeLikeOutput(value) {
  const text = String(value || "").trim();
  if (/^```/.test(text)) return true;
  if (/^\d{1,6}:\s*\S/.test(text)) return true;
  if (/^<\/?[a-z][\w:-]*(\s|>|\/>)/i.test(text)) return true;
  if (/<[a-z][\w:-]*(\s[^>]*)?>.*<\/[a-z][\w:-]*>/i.test(text)) return true;
  if (/[{};]\s*$/.test(text) && /(const|let|var|function|return|if|else|class|=>|=)/.test(text)) return true;
  return false;
}

function collectChangedFiles(workspaceRoot) {
  try {
    const statusResult = spawnSync("git", ["status", "--short"], {
      cwd: workspaceRoot,
      windowsHide: true,
      encoding: "utf8"
    });
    if (statusResult.status !== 0) return [];
    const statusEntries = String(statusResult.stdout || "")
      .split(/\r?\n/)
      .map(parseGitStatusLine)
      .filter(Boolean)
      .slice(0, 80);
    const stats = collectGitNumstat(workspaceRoot);
    return statusEntries.map((entry) => ({
      ...entry,
      ...(stats.get(entry.path) || {})
    }));
  } catch {
    return [];
  }
}

function parseGitStatusLine(line) {
  const value = String(line || "");
  if (!value.trim()) return null;
  const status = value.slice(0, 2).trim() || "M";
  let filePath = value.slice(3).trim();
  if (filePath.includes(" -> ")) filePath = filePath.split(" -> ").pop().trim();
  return filePath ? { status, path: filePath } : null;
}

function collectGitNumstat(workspaceRoot) {
  const stats = new Map();
  for (const args of [["diff", "--numstat"], ["diff", "--cached", "--numstat"]]) {
    try {
      const result = spawnSync("git", args, {
        cwd: workspaceRoot,
        windowsHide: true,
        encoding: "utf8"
      });
      if (result.status !== 0) continue;
      String(result.stdout || "").split(/\r?\n/).forEach((line) => {
        const parts = line.split(/\t+/);
        if (parts.length < 3) return;
        const added = Number(parts[0]);
        const deleted = Number(parts[1]);
        let filePath = parts.slice(2).join("\t").trim();
        if (filePath.includes(" => ")) filePath = filePath.replace(/.* => /, "").replace(/[{}]/g, "");
        const current = stats.get(filePath) || { added: 0, deleted: 0 };
        stats.set(filePath, {
          added: current.added + (Number.isFinite(added) ? added : 0),
          deleted: current.deleted + (Number.isFinite(deleted) ? deleted : 0)
        });
      });
    } catch {}
  }
  return stats;
}

function formatChangedFiles(files) {
  return files.map((file) => {
    const added = Number(file.added || 0);
    const deleted = Number(file.deleted || 0);
    const stats = added || deleted ? ` +${added} -${deleted}` : "";
    return `${file.path}${stats}`;
  }).join("\n");
}

function resolveCodexCommand() {
  const candidates = [
    process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, "codex.cmd") : "",
    "E:\\nvm4w\\nodejs\\codex.cmd",
    "C:\\Program Files\\nodejs\\codex.cmd",
    "codex"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "codex" || existsSync(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

async function listTrustedWorkspaces() {
  const trusted = await readTrustedProjectRoots();
  const defaultRoot = resolveLocalPath(codexWorkspaceRoot);
  const combined = trusted.some((item) => samePath(item.path, defaultRoot))
    ? trusted
    : [{ key: workspaceKey(defaultRoot), name: workspaceName(defaultRoot), path: defaultRoot, source: "default" }, ...trusted];
  const expanded = [];
  for (const item of combined) {
    if (samePath(item.path, workspaceFilterRoot)) {
      expanded.push(...await listGitChildren(item.path));
    } else {
      expanded.push(item);
    }
  }
  const unique = new Map();
  for (const item of expanded) {
    if (!isAllowedWorkspaceListItem(item.path)) continue;
    const key = workspaceKey(item.path);
    if (!unique.has(key)) {
      unique.set(key, { ...item, key });
    }
  }
  return Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function listGitChildren(rootPath) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name))
      .filter((childPath) => existsSync(path.join(childPath, ".git")))
      .map((childPath) => ({
        key: workspaceKey(childPath),
        name: workspaceName(childPath),
        path: resolveLocalPath(childPath),
        source: "codex-config-child"
      }));
  } catch {
    return [];
  }
}

function isAllowedWorkspaceListItem(candidate) {
  const candidateKey = normalizedPathKey(candidate);
  const rootKey = normalizedPathKey(workspaceFilterRoot);
  return candidateKey !== rootKey
    && candidateKey.startsWith(rootKey + path.sep)
    && existsSync(path.join(candidate, ".git"));
}

async function readTrustedProjectRoots() {
  if (!codexConfigPath || !existsSync(codexConfigPath)) return [];
  const text = await fs.readFile(codexConfigPath, "utf8");
  const lines = text.split(/\r?\n/);
  const workspaces = [];
  let currentPath = "";
  for (const line of lines) {
    const section = line.match(/^\s*\[projects\.'([^']+)'\]\s*$/);
    if (section) {
      currentPath = section[1];
      continue;
    }
    if (!currentPath) continue;
    const trust = line.match(/^\s*trust_level\s*=\s*"([^"]+)"/);
    if (!trust) continue;
    if (trust[1] === "trusted") {
      const resolved = resolveLocalPath(currentPath);
      workspaces.push({
        key: workspaceKey(resolved),
        name: workspaceName(resolved),
        path: resolved,
        source: "codex-config"
      });
    }
    currentPath = "";
  }
  return workspaces;
}

function resolveWorkspaceRoot(payload, options = {}) {
  if (!options.workspaceAllowed) {
    return __dirname;
  }
  const requested = String(payload?.workspaceRoot || payload?.workspacePath || payload?.codexWorkspaceRoot || "").trim();
  const target = resolveLocalPath(requested || codexWorkspaceRoot);
  if (!isTrustedWorkspacePath(target)) {
    throw new Error(`Workspace is not trusted by Codex config: ${target}`);
  }
  return target;
}

function resolveSandboxMode(payload, options = {}) {
  if (options.workspaceAllowed) {
    return codexElevatedSandboxMode;
  }
  if (options.wantsImage) {
    return "workspace-write";
  }
  return "read-only";
}

function canOperateWorkspace(payload) {
  return payload?.codexElevated === true
    && normalizeAccessLevel(payload) === "lv1"
    && isWenyuan(payload);
}

function hasRequestedWorkspace(payload) {
  return Boolean(String(payload?.workspaceRoot || payload?.workspacePath || payload?.codexWorkspaceRoot || "").trim());
}

function normalizeAccessLevel(payload) {
  const candidates = [
    payload?.accessLevel,
    payload?.ownerLevel,
    payload?.signLevel,
    payload?.level,
    payload?.auth?.accessLevel,
    payload?.accessAuth?.accessLevel
  ];
  for (const candidate of candidates) {
    const level = String(candidate || "").trim().toLowerCase();
    if (level) return level === "admin" ? "lv1" : level;
  }
  return "";
}

function isWenyuan(payload) {
  const values = [
    payload?.signMan,
    payload?.ownerName,
    payload?.name,
    payload?.auth?.name,
    payload?.accessAuth?.name,
    payload?.workspaceAccess
  ];
  return values.some((value) => {
    const text = String(value || "").trim();
    return text === "文远" || text === "鏂囪繙" || text === "life-ai-local";
  });
}

function isTrustedWorkspacePath(target) {
  const targetKey = normalizedPathKey(target);
  const roots = syncTrustedWorkspacePaths();
  return roots.some((root) => {
    const rootKey = normalizedPathKey(root);
    return targetKey === rootKey || targetKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep);
  });
}

function syncTrustedWorkspacePaths() {
  const roots = [resolveLocalPath(codexWorkspaceRoot)];
  if (!codexConfigPath || !existsSync(codexConfigPath)) return roots;
  try {
    const text = readFileSync(codexConfigPath, "utf8");
    const lines = text.split(/\r?\n/);
    let currentPath = "";
    for (const line of lines) {
      const section = line.match(/^\s*\[projects\.'([^']+)'\]\s*$/);
      if (section) {
        currentPath = section[1];
        continue;
      }
      if (!currentPath) continue;
      const trust = line.match(/^\s*trust_level\s*=\s*"([^"]+)"/);
      if (!trust) continue;
      if (trust[1] === "trusted") roots.push(resolveLocalPath(currentPath));
      currentPath = "";
    }
  } catch {
  }
  return roots;
}

function workspaceName(root) {
  const parsed = path.parse(root);
  return path.basename(root) || parsed.root || root;
}

function workspaceKey(root) {
  return normalizedPathKey(root).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function samePath(a, b) {
  return normalizedPathKey(a) === normalizedPathKey(b);
}

function normalizedPathKey(value) {
  return resolveLocalPath(value).replace(/[\\/]+$/g, "").toLowerCase();
}

function resolveLocalPath(value) {
  return path.resolve(cleanEmbeddedWindowsAbsolutePath(value));
}

function cleanEmbeddedWindowsAbsolutePath(value) {
  const text = String(value || "").trim();
  const matches = Array.from(text.matchAll(/[A-Za-z]:[\\/]/g));
  if (matches.length <= 1) return text;
  const lastDrive = matches[matches.length - 1];
  return text.slice(lastDrive.index);
}

function parseTimeoutMs(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSandboxMode(value) {
  const mode = String(value || "").trim();
  return ["read-only", "workspace-write", "danger-full-access"].includes(mode) ? mode : "workspace-write";
}

function errorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

