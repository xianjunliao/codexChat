# Codex Chat Service

本项目把本机已登录的 Codex CLI 封装成一个本地聊天与图片生成服务，并提供一个 worker 与 `life` 站点的 Codex 会话队列对接。

## 功能

- 提供 OpenAI 风格的非流式聊天接口：`POST /v1/chat/completions`
- 通过 `codex exec` 调用本机 Codex/ChatGPT 能力
- 支持从 Codex 配置读取可信工作区，并通过 `GET /api/workspaces` 暴露给 `life`
- 支持长任务超时配置，适合代码修改、检查等耗时任务
- 支持收集本地生成的图片资源，并由 worker 上传到 `life`
- `data/`、`generated/`、`logs/` 都是运行时生成内容，已在 `.gitignore` 中忽略

## 环境要求

- Node.js 18 或更高版本
- 本机可用的 `codex` 命令
- 如需对接 `life`，需要在 `life` 侧配置 Codex chat worker 接口和相同的 worker token

## 快速启动

复制 `.env.example` 并按本机环境调整：

```powershell
Copy-Item .env.example .env
```

直接启动本地服务：

```powershell
npm start
```

默认监听：

```text
http://127.0.0.1:3037
```

本地检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3037/api/health
```

## 常用脚本

```powershell
npm start
npm run worker
npm run worker:once
```

Windows 下可以用脚本同时启动服务和 worker：

```powershell
.\scripts\start-codex-chat.ps1 `
  -LifeBaseUrl "https://www.liaoxianjun.com" `
  -PublicLifeBaseUrl "https://www.liaoxianjun.com" `
  -WorkerToken "change-me" `
  -CodexWorkspaceRoot "E:\works\project\life"
```

停止本地服务和 worker：

```powershell
.\scripts\stop-codex-chat.ps1
```

安装 Windows 开机/登录自启动任务：

```powershell
.\scripts\install-windows-startup-task.ps1 `
  -LifeBaseUrl "https://www.liaoxianjun.com" `
  -PublicLifeBaseUrl "https://www.liaoxianjun.com" `
  -WorkerToken "change-me"
```

卸载自启动任务：

```powershell
.\scripts\uninstall-windows-startup-task.ps1
```

## HTTP 接口

- `GET /api/health`：服务健康状态和当前配置摘要
- `GET /api/workspaces`：返回 Codex 配置中的可信工作区
- `GET /v1/models`：返回本服务暴露的模型列表
- `POST /v1/chat/completions`：OpenAI 风格的非流式聊天接口

`POST /v1/chat/completions` 会把 `messages` 合成为提示词，然后调用：

```powershell
codex exec --skip-git-repo-check -C <workspace> -s <sandbox> --output-last-message <file> -
```

最后把 Codex 输出的最后一条消息作为 assistant 内容返回。

## 主要环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3037` | 服务监听端口 |
| `CODEX_COMMAND` | 自动查找或 `codex` | Codex CLI 命令 |
| `CODEX_CHAT_MODEL` | `chatgpt` | `/v1/models` 和默认模型名 |
| `CODEX_CHAT_WORKSPACE_ROOT` | 项目目录 | 默认 Codex 工作区 |
| `CODEX_CHAT_WORKSPACE_FILTER_ROOT` | `E:\works\project` | 工作区列表过滤根目录 |
| `CODEX_CHAT_SANDBOX_MODE` | `workspace-write` | 普通请求的 Codex sandbox |
| `CODEX_CHAT_ELEVATED_SANDBOX_MODE` | `danger-full-access` | 提权请求的 Codex sandbox |
| `CODEX_CHAT_TIMEOUT_MS` | `3600000` | 服务侧 Codex 子进程超时 |
| `CODEX_CHAT_REQUEST_TIMEOUT_MS` | `3900000` | worker 等待本地聊天服务的超时 |
| `CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS` | `60000` | worker 请求 `life` 的短请求超时 |
| `CODEX_CHAT_REQUEST_RETRIES` | `2` | worker 请求失败后的重试次数 |
| `LIFE_BASE_URL` | `http://127.0.0.1:8080` | worker 访问的 `life` 地址 |
| `CODEX_CHAT_PUBLIC_LIFE_BASE_URL` | 同 `LIFE_BASE_URL` | 图片上传后对外展示的 `life` 地址 |
| `CHATGPT_BASE_URL` | `http://127.0.0.1:3037` | worker 访问本服务的地址 |
| `CODEX_CHAT_WORKER_TOKEN` | 空 | worker 与 `life` 之间的鉴权 token |
| `CODEX_CHAT_UPLOAD_TO_LIFE` | `true` | 是否把生成资源上传到 `life` |
| `CODEX_CHAT_UPLOAD_THEME` | `CodexChat` | 上传到 `life` 时使用的 themeName |

长任务超时配置可参考 [LONG_TASK_TIMEOUTS.md](LONG_TASK_TIMEOUTS.md)。

## 对接 life

推荐使用 `life` 的队列模式：

1. 在 `life` 侧创建或更新 Codex chat 队列表。
2. 在 `life` 和本项目 worker 中配置同一个 `CODEX_CHAT_WORKER_TOKEN`。
3. 启动本地服务和 worker。
4. `life` 创建 Codex 会话任务后，worker 拉取任务，调用本地服务，并把结果回写给 `life`。

worker 会定期把本机可信工作区列表同步到 `life`，并在聊天结果包含生成资源时把资源上传到：

```text
/upload/to?themeName=CodexChat
```

上传成功后，聊天结果中的资源地址会被替换为 `life` 的下载地址。
