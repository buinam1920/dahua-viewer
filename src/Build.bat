@echo off
setlocal
set "SRC=%~dp0"
set "ROOT=%~dp0.."
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo Khong tim thay .NET Framework csc.exe tai %CSC%
  exit /b 1
)
"%CSC%" /nologo /platform:x64 /target:winexe /optimize+ ^
  /win32icon:"%SRC%dahua-viewer.ico" ^
  /out:"%ROOT%\DahuaViewer.exe" ^
  /r:"%ROOT%\Microsoft.Web.WebView2.Core.dll" ^
  /r:"%ROOT%\Microsoft.Web.WebView2.WinForms.dll" ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Web.Extensions.dll ^
  "%SRC%DahuaViewerApp.cs"
if errorlevel 1 (
  echo Build that bai!
  exit /b 1
)
echo Build thanh cong: %ROOT%\DahuaViewer.exe
