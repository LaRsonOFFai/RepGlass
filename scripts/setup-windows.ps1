param(
    [switch]$NoStart,
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebRoot = Join-Path $ProjectRoot 'pickleglass_web'
$HiddenLauncher = Join-Path $ProjectRoot 'Start-RepGlass-hidden.vbs'
$ShortcutScript = Join-Path $PSScriptRoot 'create-hidden-shortcut.ps1'

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
        [string]$WorkingDirectory = $ProjectRoot
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

if (!(Test-Path $WebRoot)) {
    throw "Web project folder not found: $WebRoot"
}

Invoke-Step 'Checking required tools' {
    & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node.js is not available. Install Node.js 24.x first.' }

    & npm --version
    if ($LASTEXITCODE -ne 0) { throw 'npm is not available. Install npm 11.x first.' }
}

if (!$SkipInstall) {
    Invoke-Npm 'Installing root dependencies' @('install') $ProjectRoot
    Invoke-Npm 'Installing web dependencies' @('install') $WebRoot
}

if (!$SkipBuild) {
    Invoke-Npm 'Building renderer and web assets' @('run', 'build:all') $ProjectRoot
}

Invoke-Step 'Creating hidden startup desktop shortcut' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ShortcutScript
    if ($LASTEXITCODE -ne 0) {
        throw "Shortcut creation failed with exit code $LASTEXITCODE"
    }
}

if (!$NoStart) {
    Invoke-Step 'Starting RepGlass hidden' {
        if (!(Test-Path $HiddenLauncher)) {
            throw "Hidden launcher not found: $HiddenLauncher"
        }

        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
            -ArgumentList "`"$HiddenLauncher`"" `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden
    }
}

Write-Host ""
Write-Host 'RepGlass setup is complete.'
Write-Host 'Use the "RepGlass Hidden" desktop shortcut or run: npm run start:hidden'
