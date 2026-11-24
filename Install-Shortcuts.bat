@echo off
setlocal
set "RECORDER_VIEWER_ROOT=%~dp0"
powershell -NoProfile -Command ^
  "$root = $env:RECORDER_VIEWER_ROOT; " ^
  "$exe = Join-Path $root 'RecorderViewer.exe'; if (-not (Test-Path -LiteralPath $exe)) { throw 'Khong tim thay RecorderViewer.exe' }; " ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "foreach ($p in @(([Environment]::GetFolderPath('Desktop') + '\Recorder Viewer.lnk'), ([Environment]::GetFolderPath('Programs') + '\Recorder Viewer.lnk'))) { " ^
  "  $l = $ws.CreateShortcut($p); $l.TargetPath = $exe; $l.WorkingDirectory = $root; $l.IconLocation = ($exe + ',0'); $l.Save(); " ^
  "} " ^
  "Write-Host 'Da tao shortcut Recorder Viewer tren Desktop va Start Menu!'"
pause
