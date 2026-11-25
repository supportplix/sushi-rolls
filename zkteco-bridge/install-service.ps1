param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'start', 'stop', 'remove')]
    [string]$Action
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

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

function Invoke-Sc([string[]]$Arguments) {
    & "$env:WINDIR\System32\sc.exe" @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe failed with exit code $LASTEXITCODE"
    }
}

switch ($Action) {
    'install' {
        $binPath = '"' + $exe + '" --service'
        $existing = & "$env:WINDIR\System32\sc.exe" query $serviceName 2>$null
        if ($LASTEXITCODE -eq 0) {
            Invoke-Sc @('config', $serviceName, "binPath=$binPath", 'start=', 'auto')
        }
        else {
            Invoke-Sc @('create', $serviceName, "binPath=$binPath", 'start=', 'auto', 'DisplayName=', 'SUSHI ROLLS ZKTeco LX15 Attendance')
        }
    }
    'start' { Invoke-Sc @('start', $serviceName) }
    'stop' { Invoke-Sc @('stop', $serviceName) }
    'remove' {
        & "$env:WINDIR\System32\sc.exe" stop $serviceName 2>$null | Out-Null
        Invoke-Sc @('delete', $serviceName)
    }
}

Write-Output "SERVICE_$($Action.ToUpper())_OK"
