param(
    [string]$Output = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$src = @(Get-ChildItem -LiteralPath $bridgeRoot -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($src.Count -lt 10) {
    throw "expected bridge source files, found $($src.Count)"
}

if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = Join-Path $bridgeRoot 'bin\ZkTecoBridge.exe'
}
elseif (-not [System.IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path $bridgeRoot $Output
}
$Output = [System.IO.Path]::GetFullPath($Output)
$binDirectory = Split-Path -Parent $Output
New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
    throw ".NET Framework compiler not found: $csc"
}

$tempOutput = Join-Path $binDirectory ('ZkTecoBridge.' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    & $csc /nologo /target:exe /platform:x86 /optimize+ /warnaserror+ /r:System.Web.Extensions.dll /r:System.Security.dll /r:System.Net.Http.dll /r:System.ServiceProcess.dll /out:$tempOutput $src
    if ($LASTEXITCODE -ne 0) {
        throw 'bridge build failed'
    }
    Move-Item -LiteralPath $tempOutput -Destination $Output -Force
}
finally {
    if (Test-Path -LiteralPath $tempOutput) {
        Remove-Item -LiteralPath $tempOutput -Force
    }
}

if ($SelfTest) {
    & $Output --self-test
    if ($LASTEXITCODE -ne 0) {
        throw "bridge self-test failed with exit code $LASTEXITCODE"
    }
}
Write-Output "BUILD PASS $Output"
