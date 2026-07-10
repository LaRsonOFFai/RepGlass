param(
    [switch]$NoStart,
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = Join-Path $ProjectRoot 'app'
$ShortcutScript = Join-Path $PSScriptRoot 'create-hidden-shortcut.ps1'
$PackagedApp = Join-Path $AppRoot 'release\win-unpacked\RepGlass.exe'

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Title"
    & $Action
}

function Invoke-Npm {
    param(
        [string]$Title,
        [string[]]$Arguments,
    [string]$WorkingDirectory = $AppRoot
    )

    Invoke-Step $Title {
        Push-Location $WorkingDirectory
        try {
            & npm @Arguments
            if ($LASTEXITCODE -ne 0) {
                throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }
}

if (!(Test-Path (Join-Path $AppRoot 'package.json'))) {
    throw "Modern app folder not found: $AppRoot"
}

Invoke-Step 'Checking required tools' {
    & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js is not available. Install Node.js 24.x first.' }

    & npm --version
    if ($LASTEXITCODE -ne 0) { throw 'npm is not available. Install npm 11.x first.' }
}

if (!$SkipInstall) {
    Invoke-Npm 'Installing RepGlass dependencies' @('install') $AppRoot
}

if (!$SkipBuild) {
    Invoke-Npm 'Verifying RepGlass' @('run', 'verify') $AppRoot
    Invoke-Npm 'Building Windows installer and portable application' @('run', 'dist') $AppRoot
}

Invoke-Step 'Creating RepGlass desktop shortcut' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ShortcutScript
    if ($LASTEXITCODE -ne 0) {
        throw "Shortcut creation failed with exit code $LASTEXITCODE"
    }
}

if (!$NoStart) {
    Invoke-Step 'Starting RepGlass' {
        if (Test-Path $PackagedApp) {
            Start-Process -FilePath $PackagedApp `
                -WorkingDirectory (Split-Path -Parent $PackagedApp)
        } else {
            $HiddenLauncher = Join-Path $ProjectRoot 'Start-RepGlass-hidden.vbs'
            if (!(Test-Path $HiddenLauncher)) {
                throw "RepGlass launcher not found: $HiddenLauncher"
            }
            Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
                -ArgumentList "`"$HiddenLauncher`"" `
                -WorkingDirectory $ProjectRoot `
                -WindowStyle Hidden
        }
    }
}

Write-Host ""
Write-Host 'RepGlass setup is complete.'
Write-Host 'Use the "RepGlass" desktop shortcut. Installers are in app\release.'
