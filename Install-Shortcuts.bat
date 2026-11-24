@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = '%~dp0'.TrimEnd('\'); " ^
  "$exe = Join-Path $root 'DahuaViewer.exe'; " ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "foreach ($p in @(([Environment]::GetFolderPath('Desktop') + '\Dahua Viewer.lnk'), ([Environment]::GetFolderPath('Programs') + '\Dahua Viewer.lnk'))) { " ^
  "  $l = $ws.CreateShortcut($p); $l.TargetPath = $exe; $l.WorkingDirectory = $root; $l.IconLocation = ($exe + ',0'); $l.Save(); " ^
  "} " ^
  "Write-Host 'Da tao shortcut Dahua Viewer tren Desktop va Start Menu!'"
pause
