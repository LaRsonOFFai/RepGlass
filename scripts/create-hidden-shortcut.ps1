$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $ProjectRoot 'Start-RepGlass-hidden.vbs'
$PackagedApp = Join-Path $ProjectRoot 'app\release\win-unpacked\RepGlass.exe'
$Desktop = [Environment]::GetFolderPath('DesktopDirectory')
$ShortcutPath = Join-Path $Desktop 'RepGlass.lnk'
$LegacyShortcutPath = Join-Path $Desktop 'RepGlass Hidden.lnk'
$IconPath = Join-Path $ProjectRoot 'app\assets\logo.ico'

if (!(Test-Path $PackagedApp) -and !(Test-Path $Launcher)) {
    throw "Neither packaged application nor source launcher was found."
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
if (Test-Path $PackagedApp) {
    $Shortcut.TargetPath = $PackagedApp
    $Shortcut.Arguments = ''
    $Shortcut.WorkingDirectory = Split-Path -Parent $PackagedApp
    $Shortcut.WindowStyle = 1
} else {
    $Shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $Shortcut.Arguments = "`"$Launcher`""
    $Shortcut.WorkingDirectory = $ProjectRoot
    $Shortcut.WindowStyle = 7
}
$Shortcut.Description = 'Start RepGlass'

if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}

$Shortcut.Save()

if (Test-Path $LegacyShortcutPath) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
}

Write-Host "Created RepGlass shortcut: $ShortcutPath"
