param(
    [string]$LifeBaseUrl = "https://www.liaoxianjun.com",
    [string]$PublicLifeBaseUrl = "",
    [string]$WorkerToken = "change-me",
    [string]$ChatBaseUrl = "http://127.0.0.1:3037",
    [string]$CodexWorkspaceRoot = "E:\works\project\life",
    [string]$CodexSandboxMode = "workspace-write",
    [string]$CodexElevatedSandboxMode = "danger-full-access",
    [int]$LongTaskTimeoutMinutes = 60,
    [int]$WorkerChatTimeoutMinutes = 65,
    [int]$LifeRequestTimeoutSeconds = 60,
    [switch]$AllowLocalLifeBaseUrl,
    [switch]$SkipWorker
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Get-ProjectEnvValue {
    param([string]$Name)
    $envFile = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path -LiteralPath $envFile)) {
        return ""
    }
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
            continue
        }
        $key, $value = $trimmed.Split("=", 2)
        $cleanKey = $key.Trim().TrimStart([char]0xFEFF)
        if ($cleanKey -eq $Name) {
            return $value.Trim().Trim("'").Trim('"')
        }
    }
    return ""
}

function Test-LocalLifeBaseUrl {
    param([string]$Url)
    try {
        $hostName = ([Uri]$Url).Host.ToLowerInvariant()
        return $hostName -eq "127.0.0.1" -or $hostName -eq "localhost" -or $hostName -eq "::1"
    } catch {
        return $false
    }
}

if ((Test-LocalLifeBaseUrl $LifeBaseUrl) -and -not $AllowLocalLifeBaseUrl) {
    $configuredLifeBaseUrl = Get-ProjectEnvValue -Name "LIFE_BASE_URL"
    if ([string]::IsNullOrWhiteSpace($configuredLifeBaseUrl) -or (Test-LocalLifeBaseUrl $configuredLifeBaseUrl)) {
        $configuredLifeBaseUrl = "https://www.liaoxianjun.com"
    }
    Write-Host "LifeBaseUrl '$LifeBaseUrl' is local; using '$configuredLifeBaseUrl'. Use -AllowLocalLifeBaseUrl for local debugging."
    $LifeBaseUrl = $configuredLifeBaseUrl
}
$LifeBaseUrl = $LifeBaseUrl.TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($PublicLifeBaseUrl)) {
    $PublicLifeBaseUrl = $LifeBaseUrl
}
if ((Test-LocalLifeBaseUrl $PublicLifeBaseUrl) -and -not $AllowLocalLifeBaseUrl) {
    Write-Host "PublicLifeBaseUrl '$PublicLifeBaseUrl' is local; using '$LifeBaseUrl'."
    $PublicLifeBaseUrl = $LifeBaseUrl
}
$PublicLifeBaseUrl = $PublicLifeBaseUrl.TrimEnd("/")


function Import-LocalWorkerToken {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_CHAT_WORKER_TOKEN)) {
        return $env:CODEX_CHAT_WORKER_TOKEN
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_MEDIA_WORKER_TOKEN)) {
        return $env:CODEX_MEDIA_WORKER_TOKEN
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
                $token = $value.Trim()
            }
        }
    }
    return $token
}

if ([string]::IsNullOrWhiteSpace($WorkerToken) -or $WorkerToken -eq "change-me") {
    $localWorkerToken = Import-LocalWorkerToken
    if (-not [string]::IsNullOrWhiteSpace($localWorkerToken)) {
        $WorkerToken = $localWorkerToken
        Write-Host "Loaded Codex chat worker token from local environment."
    }
}

$NodePath = "node"
if (-not [string]::IsNullOrWhiteSpace($env:NVM_SYMLINK)) {
    $candidate = Join-Path $env:NVM_SYMLINK "node.exe"
    if (Test-Path $candidate) {
        $NodePath = $candidate
    }
}

function Repair-PathEnvironment {
    $pathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
    if ([string]::IsNullOrWhiteSpace($pathValue)) {
        $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
    }
    if ([string]::IsNullOrWhiteSpace($pathValue)) {
        return
    }
    [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
    [Environment]::SetEnvironmentVariable("Path", $null, "Process")
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

Repair-PathEnvironment

$env:LIFE_BASE_URL = $LifeBaseUrl.TrimEnd("/")
$env:CODEX_CHAT_PUBLIC_LIFE_BASE_URL = $PublicLifeBaseUrl.TrimEnd("/")
$env:CHATGPT_BASE_URL = $ChatBaseUrl.TrimEnd("/")
$env:CODEX_CHAT_WORKER_TOKEN = $WorkerToken
$env:CODEX_CHAT_UPLOAD_TO_LIFE = "true"
$env:CODEX_CHAT_WORKSPACE_ROOT = (Resolve-Path $CodexWorkspaceRoot).Path
$env:CODEX_CHAT_SANDBOX_MODE = $CodexSandboxMode
$env:CODEX_CHAT_ELEVATED_SANDBOX_MODE = $CodexElevatedSandboxMode
$env:CODEX_CHAT_TIMEOUT_MS = [string]($LongTaskTimeoutMinutes * 60 * 1000)
$env:CODEX_CHAT_REQUEST_TIMEOUT_MS = [string]($WorkerChatTimeoutMinutes * 60 * 1000)
$env:CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS = [string]($LifeRequestTimeoutSeconds * 1000)

function Test-PidAlive {
    param([string]$PidFile)
    if (-not (Test-Path $PidFile)) {
        return $false
    }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if (-not ($raw -match "^\d+$")) {
        return $false
    }
    try {
        $process = Get-Process -Id ([int]$raw) -ErrorAction Stop
        return $null -ne $process
    } catch {
        return $false
    }
}

function Get-ChatServiceHealth {
    try {
        $response = Invoke-WebRequest -Uri "$($env:CHATGPT_BASE_URL)/api/health" -UseBasicParsing -TimeoutSec 2
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
            return $null
        }
        return $response.Content | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Stop-PidFileProcess {
    param([string]$PidFile)
    if (-not (Test-Path $PidFile)) {
        return
    }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if ($raw -match "^\d+$") {
        try {
            Stop-Process -Id ([int]$raw) -Force -ErrorAction Stop
        } catch {
        }
    }
    if (Test-Path $PidFile) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ChatServicePort {
    try {
        $chatUri = [Uri]$env:CHATGPT_BASE_URL
        $portValue = $chatUri.Port
        if ($portValue -le 0) {
            return
        }
        $connections = Get-NetTCPConnection -LocalPort $portValue -State Listen -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            if ($connection.OwningProcess -and $connection.OwningProcess -ne $PID) {
                try {
                    Stop-Process -Id $connection.OwningProcess -Force -ErrorAction Stop
                } catch {
                }
            }
        }
    } catch {
    }
}

function Start-NodeProcess {
    param(
        [string]$Name,
        [string[]]$Arguments,
        [string]$PidFile,
        [string]$OutFile,
        [string]$ErrFile
    )
    if (Test-PidAlive $PidFile) {
        Write-Host "$Name already running. pid=$(Get-Content $PidFile -Raw)"
        return
    }
    if (Test-Path $PidFile) {
        Remove-Item $PidFile -Force
    }
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $OutFile `
        -RedirectStandardError $ErrFile `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII
    Write-Host "$Name started. pid=$($process.Id)"
}

$ServerPid = Join-Path $LogDir "codex-chat-server.pid"
$WorkerPid = Join-Path $LogDir "codex-chat-worker-launcher.pid"
$WorkerLockPid = Join-Path $LogDir "codex-chat-worker.pid"
$WorkerConfigFile = Join-Path $LogDir "codex-chat-worker.config.json"

function Get-WorkerConfigJson {
    ([ordered]@{
        lifeBaseUrl = $env:LIFE_BASE_URL
        publicLifeBaseUrl = $env:CODEX_CHAT_PUBLIC_LIFE_BASE_URL
        chatBaseUrl = $env:CHATGPT_BASE_URL
        chatRequestTimeoutMs = $env:CODEX_CHAT_REQUEST_TIMEOUT_MS
        lifeRequestTimeoutMs = $env:CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS
        uploadToLife = $env:CODEX_CHAT_UPLOAD_TO_LIFE
    } | ConvertTo-Json -Compress)
}

function Test-WorkerConfigMatches {
    param(
        [string]$ConfigFile,
        [string]$ExpectedConfig
    )
    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        return $false
    }
    try {
        return ((Get-Content -LiteralPath $ConfigFile -Raw).Trim() -eq $ExpectedConfig.Trim())
    } catch {
        return $false
    }
}

$ExpectedServiceVersion = "20260521-env-command-and-change-baseline-v2"
$ExpectedCodexTimeoutMs = [int64]$env:CODEX_CHAT_TIMEOUT_MS
$Health = Get-ChatServiceHealth
if ($null -ne $Health -and $Health.version -eq $ExpectedServiceVersion -and $Health.codexWorkspaceRoot -eq $env:CODEX_CHAT_WORKSPACE_ROOT -and [int64]$Health.codexTimeoutMs -eq $ExpectedCodexTimeoutMs -and $Health.codexSandboxMode -eq $env:CODEX_CHAT_SANDBOX_MODE -and $Health.codexElevatedSandboxMode -eq $env:CODEX_CHAT_ELEVATED_SANDBOX_MODE) {
    Write-Host "ChatGPT service already healthy at $($env:CHATGPT_BASE_URL)."
} else {
    if ($null -ne $Health) {
        Write-Host "ChatGPT service config changed; restarting service."
        Stop-PidFileProcess -PidFile $ServerPid
        Stop-ChatServicePort
        Start-Sleep -Seconds 1
    }
    Start-NodeProcess `
        -Name "ChatGPT service" `
        -Arguments @("server.js") `
        -PidFile $ServerPid `
        -OutFile (Join-Path $LogDir "server.out.log") `
        -ErrFile (Join-Path $LogDir "server.err.log")
    Start-Sleep -Seconds 2
}

if ($SkipWorker) {
    Write-Host "ChatGPT worker skipped."
} else {
    $ExpectedWorkerConfig = Get-WorkerConfigJson
    if ((Test-Path $WorkerLockPid) -and -not (Test-PidAlive $WorkerLockPid)) {
        Remove-Item $WorkerLockPid -Force -ErrorAction SilentlyContinue
    }
    if ((Test-PidAlive $WorkerLockPid) -and -not (Test-WorkerConfigMatches -ConfigFile $WorkerConfigFile -ExpectedConfig $ExpectedWorkerConfig)) {
        Write-Host "ChatGPT worker config changed; restarting worker."
        Stop-PidFileProcess -PidFile $WorkerLockPid
        Stop-PidFileProcess -PidFile $WorkerPid
    } elseif (Test-PidAlive $WorkerLockPid) {
        $runningWorkerPid = (Get-Content $WorkerLockPid -Raw).Trim()
        Set-Content -Path $WorkerPid -Value $runningWorkerPid -Encoding ASCII
        Write-Host "ChatGPT worker already running. pid=$runningWorkerPid"
        Set-Content -Path $WorkerConfigFile -Value $ExpectedWorkerConfig -Encoding UTF8
    } elseif ((Test-PidAlive $WorkerPid) -and -not (Test-WorkerConfigMatches -ConfigFile $WorkerConfigFile -ExpectedConfig $ExpectedWorkerConfig)) {
        Write-Host "ChatGPT worker launcher config changed; restarting worker."
        Stop-PidFileProcess -PidFile $WorkerPid
    }
    if (-not (Test-PidAlive $WorkerLockPid)) {
        Start-NodeProcess `
            -Name "ChatGPT worker" `
            -Arguments @("scripts/codex-chat-worker.js") `
            -PidFile $WorkerPid `
            -OutFile (Join-Path $LogDir "worker.out.log") `
            -ErrFile (Join-Path $LogDir "worker.err.log")
        Start-Sleep -Milliseconds 500
        if (Test-PidAlive $WorkerLockPid) {
            $runningWorkerPid = (Get-Content $WorkerLockPid -Raw).Trim()
            Set-Content -Path $WorkerPid -Value $runningWorkerPid -Encoding ASCII
        }
    }
    Set-Content -Path $WorkerConfigFile -Value $ExpectedWorkerConfig -Encoding UTF8
}

Write-Host "Life URL: $($env:LIFE_BASE_URL)"
Write-Host "Public Life URL: $($env:CODEX_CHAT_PUBLIC_LIFE_BASE_URL)"
Write-Host "Codex workspace root: $($env:CODEX_CHAT_WORKSPACE_ROOT)"
Write-Host "Codex sandbox: $($env:CODEX_CHAT_SANDBOX_MODE)"
Write-Host "Codex elevated sandbox: $($env:CODEX_CHAT_ELEVATED_SANDBOX_MODE)"
Write-Host "Codex timeout: $($env:CODEX_CHAT_TIMEOUT_MS) ms"
Write-Host "Worker chat timeout: $($env:CODEX_CHAT_REQUEST_TIMEOUT_MS) ms"
Write-Host "Life request timeout: $($env:CODEX_CHAT_LIFE_REQUEST_TIMEOUT_MS) ms"
Write-Host "Logs: $LogDir"
