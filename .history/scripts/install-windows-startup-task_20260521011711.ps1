param(
    [string]$TaskName = "CodexChatService",
    [string]$LifeBaseUrl = "https://www.liaoxianjun.com",
    [string]$PublicLifeBaseUrl = "https://www.liaoxianjun.com",
    [string]$WorkerToken = "life-2a13f1c17d3940a95874e73f7f0446b70f3de8f6d12ff398"
)

$ErrorActionPreference = "Stop"

$StartScript = Join-Path $PSScriptRoot "start-codex-chat.ps1"
if (-not (Test-Path $StartScript)) {
    throw "Missing start script: $StartScript"
}

if ([string]::IsNullOrWhiteSpace($PublicLifeBaseUrl)) {
    $PublicLifeBaseUrl = $LifeBaseUrl
}

$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$StartScript`"",
    "-LifeBaseUrl", "`"$LifeBaseUrl`"",
    "-PublicLifeBaseUrl", "`"$PublicLifeBaseUrl`"",
    "-WorkerToken", "`"$WorkerToken`""
) -join " "

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($startupTrigger, $logonTrigger) `
    -Settings $settings `
    -Description "Start local ChatGPT/Codex chat service and MySQL relay worker for life." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started task: $TaskName"
Write-Host "Life URL: $LifeBaseUrl"
