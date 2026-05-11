$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $ProjectRoot "logs"
$PidFiles = @(
    "codex-chat-worker.pid",
    "codex-chat-worker-launcher.pid",
    "codex-chat-server.pid"
)

foreach ($name in $PidFiles) {
    $pidFile = Join-Path $LogDir $name
    if (-not (Test-Path $pidFile)) {
        continue
    }
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw -match "^\d+$") {
        try {
            $process = Get-Process -Id ([int]$raw) -ErrorAction Stop
            Stop-Process -Id $process.Id -Force
            Write-Host "Stopped pid=$($process.Id) from $name"
        } catch {
            Write-Host "Process from $name is not running."
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
