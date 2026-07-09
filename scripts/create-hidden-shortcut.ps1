$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $ProjectRoot 'Start-RepGlass-hidden.vbs'
$Desktop = [Environment]::GetFolderPath('DesktopDirectory')
$ShortcutPath = Join-Path $Desktop 'RepGlass Hidden.lnk'
$IconPath = Join-Path $ProjectRoot 'src\ui\assets\logo.ico'

if (!(Test-Path $Launcher)) {
    throw "Hidden launcher not found: $Launcher"
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$Shortcut.Arguments = "`"$Launcher`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.Description = 'Start RepGlass hidden in the tray'
$Shortcut.WindowStyle = 7

if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}

$Shortcut.Save()

Write-Host "Created hidden startup shortcut: $ShortcutPath"
