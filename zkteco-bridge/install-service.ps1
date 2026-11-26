param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'start', 'stop', 'remove')]
    [string]$Action,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$serviceName = 'SushiRolls.ZkTeco'
$exe = Join-Path $PSScriptRoot 'bin\ZkTecoBridge.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $exe = Join-Path $PSScriptRoot 'ZkTecoBridge.exe'
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Bridge executable not found: $exe"
}

function Invoke-Sc([string[]]$Arguments, [int[]]$SuccessExitCodes = @()) {
    $output = & "$env:WINDIR\System32\sc.exe" @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and $SuccessExitCodes -notcontains $exitCode) {
        $detail = ($output | ForEach-Object { $_.ToString() }) -join ' '
        if ([string]::IsNullOrWhiteSpace($detail)) {
            throw "sc.exe failed with exit code $exitCode"
        }
        throw "sc.exe failed with exit code $exitCode`: $detail"
    }
}

# sc.exe is sensitive to how PowerShell passes arguments containing quotes and
# spaces. Build the full command line and let cmd.exe parse it exactly as typed.
function Invoke-ScLine([string]$Line) {
    & cmd.exe /c $Line
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe failed with exit code $LASTEXITCODE ($Line)"
    }
}

function Get-ServiceState {
    $output = & "$env:WINDIR\System32\sc.exe" query $serviceName 2>$null
    if ($LASTEXITCODE -ne 0) { return 'absent' }
    if ($output -match 'STATE\s*:\s*4\s+RUNNING') { return 'running' }
    if ($output -match 'STATE\s*:\s*[2356]\s+') { return 'pending' }
    return 'stopped'
}

function Wait-ServiceState([string]$Target, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((Get-ServiceState) -eq $Target) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return ((Get-ServiceState) -eq $Target)
}

function Start-BridgeService {
    $state = Get-ServiceState
    if ($state -eq 'running') { return }
    if ($state -eq 'absent') { throw 'Service is not installed.' }
    & "$env:WINDIR\System32\sc.exe" start $serviceName | Out-Null
    # 1056 means "already running"; the state check below is the source of truth.
    if (-not (Wait-ServiceState 'running' 30)) {
        throw 'Service did not reach the RUNNING state.'
    }
}

function Stop-BridgeService {
    $state = Get-ServiceState
    if ($state -eq 'absent' -or $state -eq 'stopped') { return }
    & "$env:WINDIR\System32\sc.exe" stop $serviceName | Out-Null
    if (-not (Wait-ServiceState 'stopped' 30)) {
        throw 'Service did not reach the STOPPED state.'
    }
}

switch ($Action) {
    'install' {
        $binPath = '\"' + $exe + '\" --service'
        if ((Get-ServiceState) -eq 'absent') {
            Invoke-ScLine ('sc.exe create ' + $serviceName + ' binPath= "' + $binPath + '" start= auto DisplayName= SUSHI ROLLS ZKTeco LX15 Attendance')
        }
        else {
            # A running service keeps the old executable mapped. Stop it first so
            # an app update takes effect, then rewrite the path and restart.
            Stop-BridgeService
            Invoke-ScLine ('sc.exe config ' + $serviceName + ' binPath= "' + $binPath + '" start= auto')
        }
        # Restart the bridge automatically if it ever crashes.
        Invoke-ScLine ('sc.exe failure ' + $serviceName + ' reset= 86400 actions= restart/5000/restart/10000/restart/30000')
        Start-BridgeService
    }
    'start' { Start-BridgeService }
    'stop' { Stop-BridgeService }
    'remove' {
        Stop-BridgeService
        if ((Get-ServiceState) -ne 'absent') {
            Invoke-Sc @('delete', $serviceName)
        }
    }
}
