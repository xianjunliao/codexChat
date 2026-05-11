# Long Task Timeouts

Some Codex jobs can legitimately take a long time, especially codebase-wide checks or implementation work.

The default local service timeouts are:

- `CODEX_CHAT_TIMEOUT_MS=3600000`: 60 minutes for the `codex exec` child process.
- `CODEX_CHAT_REQUEST_TIMEOUT_MS=3900000`: 65 minutes for the worker waiting on the local chat service.
- `CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS=60000`: 60 seconds for short worker calls back to `life`.

Set `CODEX_CHAT_TIMEOUT_MS=0` to disable the service-side Codex kill timer entirely.

When using the startup script, pass minutes directly:

```powershell
.\scripts\start-codex-chat.ps1 -LongTaskTimeoutMinutes 120 -WorkerChatTimeoutMinutes 125
```

Restart both the local chat service and worker after changing timeout values so existing processes pick up the new environment.
