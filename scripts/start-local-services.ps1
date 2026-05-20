param(
    [string]$ProjectRoot = "",
    [string]$LifeBaseUrl = "http://127.0.0.1:8080",
    [string]$PublicLifeBaseUrl = "",
    [string]$WorkerToken = "",
    [string]$HostName = "127.0.0.1",
    [int]$Port = 3037,
    [string]$CodexWorkspaceRoot = "E:\works\project\life",
    [string]$CodexSandboxMode = "workspace-write",
    [string]$CodexElevatedSandboxMode = "danger-full-access",
    [int]$LongTaskTimeoutMinutes = 60,
    [int]$WorkerChatTimeoutMinutes = 65,
    [int]$LifeRequestTimeoutSeconds = 60,
    [switch]$KeepExistingWorker,
    [switch]$NoFollowLogs
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
    $ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
}

$logDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "local-services.log"
$envFile = Join-Path $ProjectRoot ".env"

function Write-ServiceLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString("s"), $Message
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Read-DotEnvValue {
    param([string]$Value)
    $clean = $Value.Trim()
    if (($clean.StartsWith('"') -and $clean.EndsWith('"')) -or ($clean.StartsWith("'") -and $clean.EndsWith("'"))) {
        return $clean.Substring(1, $clean.Length - 2)
    }
    return $clean
}

function Load-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-ServiceLog "No .env file found at $Path"
        return
    }
    Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
            return
        }
        $name, $value = $line.Split("=", 2)
        $cleanName = $name.Trim().TrimStart([char]0xFEFF)
        if ($cleanName) {
            [Environment]::SetEnvironmentVariable($cleanName, (Read-DotEnvValue $value), "Process")
        }
    }
    Write-ServiceLog "Loaded environment from $Path"
}

function Import-WorkerToken {
    if (-not [string]::IsNullOrWhiteSpace($WorkerToken)) {
        $env:CODEX_CHAT_WORKER_TOKEN = $WorkerToken
        return "argument"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_CHAT_WORKER_TOKEN)) {
        return "CODEX_CHAT_WORKER_TOKEN"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_MEDIA_WORKER_TOKEN)) {
        $env:CODEX_CHAT_WORKER_TOKEN = $env:CODEX_MEDIA_WORKER_TOKEN
        return "CODEX_MEDIA_WORKER_TOKEN"
    }

    $siblingEnv = Join-Path (Split-Path -Parent $ProjectRoot) "codexImages\.env"
    if (-not (Test-Path -LiteralPath $siblingEnv)) {
        return ""
    }

    $token = ""
    Get-Content -LiteralPath $siblingEnv -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $name, $value = $line.Split("=", 2)
            $cleanName = $name.Trim().TrimStart([char]0xFEFF)
            if (($cleanName -eq "CODEX_CHAT_WORKER_TOKEN" -or $cleanName -eq "CODEX_MEDIA_WORKER_TOKEN") -and [string]::IsNullOrWhiteSpace($token)) {
                $token = Read-DotEnvValue $value
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $env:CODEX_CHAT_WORKER_TOKEN = $token
        return "codexImages\.env"
    }
    return ""
}

function Test-HttpOk {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Test-PortListening {
    param([int]$PortToTest)
    try {
        return [bool](Get-NetTCPConnection -LocalPort $PortToTest -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Stop-ProcessById {
    param(
        [int]$ProcessId,
        [string]$Reason,
        [string[]]$AllowedNames = @()
    )
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
        return $true
    }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if (-not $process) {
            return $true
        }
        if ($AllowedNames.Count -gt 0 -and ($AllowedNames -notcontains $process.ProcessName)) {
            Write-ServiceLog "Skipping PID $ProcessId ($($process.ProcessName)); expected: $($AllowedNames -join ', ')"
            return $false
        }
        Write-ServiceLog "Stopping PID $ProcessId ($($process.ProcessName)) for $Reason"
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        return $true
    } catch {
        Write-ServiceLog ("Failed to stop PID ${ProcessId}: " + $_.Exception.Message)
        return $false
    }
}

function Stop-PidFileProcess {
    param(
        [string]$PidFileName,
        [string]$Reason,
        [string[]]$AllowedNames = @()
    )
    $pidFile = Join-Path $logDir $PidFileName
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return $true
    }
    $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $canRemove = $true
    if ($raw -match "^\d+$") {
        $canRemove = Stop-ProcessById -ProcessId ([int]$raw) -Reason $Reason -AllowedNames $AllowedNames
    }
    if ($canRemove) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-ServiceLog "Keeping $PidFileName because PID $raw could not be stopped."
    }
    return $canRemove
}

function Stop-PortListeners {
    param([int]$PortToStop)
    $connections = @(Get-NetTCPConnection -LocalPort $PortToStop -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
        if ($connection.OwningProcess -and $connection.OwningProcess -ne $PID) {
            Stop-ProcessById -ProcessId ([int]$connection.OwningProcess) -Reason "port $PortToStop listener"
        }
    }
}

function Stop-ChatWorker {
    $launcherStopped = Stop-PidFileProcess -PidFileName "codex-chat-worker-launcher.pid" -Reason "local worker restart" -AllowedNames @("node")
    $workerStopped = Stop-PidFileProcess -PidFileName "codex-chat-worker.pid" -Reason "local worker restart" -AllowedNames @("node")
    return ($launcherStopped -and $workerStopped)
}

function Prepare-ChatServicePort {
    param([string]$ChatBaseUrl)
    if (Test-HttpOk "$ChatBaseUrl/api/health") {
        Write-ServiceLog "Chat service is already healthy at $ChatBaseUrl."
        return
    }
    Write-ServiceLog "Chat service is not healthy at $ChatBaseUrl; cleaning old pid/port state."
    Stop-PidFileProcess -PidFileName "codex-chat-server.pid" -Reason "local service restart" -AllowedNames @("node")
    if (Test-PortListening -PortToTest $Port) {
        Stop-PortListeners -PortToStop $Port
    }
}

function Follow-Logs {
    $logSpecs = @(
        @{ Label = "local"; Path = Join-Path $logDir "local-services.log" },
        @{ Label = "server:out"; Path = Join-Path $logDir "server.out.log" },
        @{ Label = "server:err"; Path = Join-Path $logDir "server.err.log" },
        @{ Label = "worker:out"; Path = Join-Path $logDir "worker.out.log" },
        @{ Label = "worker:err"; Path = Join-Path $logDir "worker.err.log" },
        @{ Label = "worker"; Path = Join-Path $logDir "codex-chat-worker.log" }
    )

    foreach ($spec in $logSpecs) {
        if (-not (Test-Path -LiteralPath $spec.Path)) {
            New-Item -ItemType File -Force -Path $spec.Path | Out-Null
        }
    }

    Write-ServiceLog "Following logs. Press Ctrl+C to stop viewing logs; services will keep running."
    $jobs = @()
    foreach ($spec in $logSpecs) {
        $jobs += Start-Job -ScriptBlock {
            param([string]$Label, [string]$Path)
            Get-Content -LiteralPath $Path -Tail 0 -Wait | ForEach-Object {
                if ($null -ne $_) {
                    "[{0}] {1}" -f $Label, $_
                }
            }
        } -ArgumentList $spec.Label, $spec.Path
    }

    try {
        while ($true) {
            foreach ($job in $jobs) {
                Receive-Job -Job $job -ErrorAction SilentlyContinue | ForEach-Object {
                    Write-Host $_
                }
            }
            Start-Sleep -Milliseconds 500
        }
    } finally {
        foreach ($job in $jobs) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-ServiceLog "Starting local Codex chat services. ProjectRoot=$ProjectRoot"
Set-Location -LiteralPath $ProjectRoot
Load-DotEnv -Path $envFile

if ([string]::IsNullOrWhiteSpace($LifeBaseUrl)) {
    $LifeBaseUrl = "http://127.0.0.1:8080"
}
$LifeBaseUrl = $LifeBaseUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($PublicLifeBaseUrl)) {
    $PublicLifeBaseUrl = $LifeBaseUrl
}
$PublicLifeBaseUrl = $PublicLifeBaseUrl.TrimEnd("/")
$ChatBaseUrl = "http://$HostName`:$Port"
$resolvedWorkspaceRoot = (Resolve-Path -LiteralPath $CodexWorkspaceRoot).Path

$tokenSource = Import-WorkerToken
if ([string]::IsNullOrWhiteSpace($tokenSource)) {
    Write-ServiceLog "Worker token was not found. Remote life will reject the worker; local life must allow the same token."
} else {
    Write-ServiceLog "Loaded worker token from $tokenSource."
}

$env:LIFE_BASE_URL = $LifeBaseUrl
$env:CODEX_CHAT_PUBLIC_LIFE_BASE_URL = $PublicLifeBaseUrl
$env:CHATGPT_BASE_URL = $ChatBaseUrl
$env:HOST = $HostName
$env:PORT = "$Port"
$env:CODEX_CHAT_UPLOAD_TO_LIFE = if ($env:CODEX_CHAT_UPLOAD_TO_LIFE) { $env:CODEX_CHAT_UPLOAD_TO_LIFE } else { "true" }
$env:CODEX_CHAT_WORKSPACE_ROOT = $resolvedWorkspaceRoot
$env:CODEX_CHAT_SANDBOX_MODE = $CodexSandboxMode
$env:CODEX_CHAT_ELEVATED_SANDBOX_MODE = $CodexElevatedSandboxMode
$env:CODEX_CHAT_TIMEOUT_MS = [string]($LongTaskTimeoutMinutes * 60 * 1000)
$env:CODEX_CHAT_REQUEST_TIMEOUT_MS = [string]($WorkerChatTimeoutMinutes * 60 * 1000)
$env:CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS = [string]($LifeRequestTimeoutSeconds * 1000)

Write-ServiceLog "Local life URL set to $LifeBaseUrl"
if (Test-HttpOk $LifeBaseUrl) {
    Write-ServiceLog "Local life is reachable."
} else {
    Write-ServiceLog "Local life is not reachable yet; worker will keep retrying."
}

if (-not $KeepExistingWorker) {
    if (-not (Stop-ChatWorker)) {
        throw "Existing Codex chat worker could not be stopped. Re-run from an elevated PowerShell, or pass -KeepExistingWorker if it is already using the intended local life URL."
    }
}
Prepare-ChatServicePort -ChatBaseUrl $ChatBaseUrl

$startScript = Join-Path $ProjectRoot "scripts\start-codex-chat.ps1"
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Missing start script: $startScript"
}

$startArgs = @{
    LifeBaseUrl = $LifeBaseUrl
    PublicLifeBaseUrl = $PublicLifeBaseUrl
    WorkerToken = $env:CODEX_CHAT_WORKER_TOKEN
    ChatBaseUrl = $ChatBaseUrl
    CodexWorkspaceRoot = $resolvedWorkspaceRoot
    CodexSandboxMode = $CodexSandboxMode
    CodexElevatedSandboxMode = $CodexElevatedSandboxMode
    LongTaskTimeoutMinutes = $LongTaskTimeoutMinutes
    WorkerChatTimeoutMinutes = $WorkerChatTimeoutMinutes
    LifeRequestTimeoutSeconds = $LifeRequestTimeoutSeconds
}
if ($KeepExistingWorker) {
    $startArgs.SkipWorker = $true
}
& $startScript @startArgs

Write-ServiceLog "Local Codex chat services start command finished. Chat=$ChatBaseUrl LifeBaseUrl=$LifeBaseUrl"
if (-not $NoFollowLogs) {
    Follow-Logs
}
