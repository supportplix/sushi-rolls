param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'remove')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'bin\ZkTecoBridge.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $exe = Join-Path $PSScriptRoot 'ZkTecoBridge.exe'
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Bridge executable not found: $exe"
}

$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'SUSHI ROLLS ZKTeco LX15.lnk'
if ($Action -eq 'remove') {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    Write-Output 'LOGON_AGENT_REMOVE_OK'
    return
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.Arguments = '--agent'
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.WindowStyle = 7
$shortcut.Description = 'SUSHI ROLLS ZKTeco LX15 attendance background agent'
$shortcut.Save()
Write-Output 'LOGON_AGENT_INSTALL_OK'
