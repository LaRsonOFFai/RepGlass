$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $ProjectRoot 'scripts\start-hidden.cmd'

Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', "`"$Launcher`"") -WindowStyle Hidden
