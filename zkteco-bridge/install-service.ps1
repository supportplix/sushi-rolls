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

function Write-ServiceResult($Result) {
    if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
        $json = ConvertTo-Json -InputObject $Result -Compress
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($ReportPath, $json, $encoding)
    }
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'SERVICE_ADMIN_REQUIRED'
    }

    switch ($Action) {
        'install' {
            $binPath = '"' + $exe + '" --service'
            $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'"
            if ($null -eq $service) {
                New-Service -Name $serviceName -BinaryPathName $binPath -DisplayName 'SUSHI ROLLS ZKTeco LX15 Attendance' -StartupType Automatic | Out-Null
            }
            else {
                $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
                    DisplayName = 'SUSHI ROLLS ZKTeco LX15 Attendance'
                    PathName = $binPath
                    StartMode = 'Automatic'
                }
                if ($result.ReturnValue -ne 0) {
                    throw "Win32_Service.Change failed with code $($result.ReturnValue)"
                }
            }
        }
        'start' {
            & "$env:WINDIR\System32\sc.exe" query $serviceName 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw 'SERVICE_NOT_INSTALLED'
            }
            $service = Get-Service -Name $serviceName -ErrorAction Stop
            if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
                Invoke-Sc -Arguments @('start', $serviceName) -SuccessExitCodes @(1056)
            }
        }
        'stop' { Invoke-Sc @('stop', $serviceName) }
        'remove' {
            & "$env:WINDIR\System32\sc.exe" stop $serviceName 2>$null | Out-Null
            Invoke-Sc @('delete', $serviceName)
        }
    }
    Write-ServiceResult @{ ok = $true }
    Write-Output "SERVICE_$($Action.ToUpper())_OK"
}
catch {
    Write-ServiceResult @{ ok = $false; error = $_.Exception.Message }
    throw
}
