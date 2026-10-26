$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$apkPath = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'

if (-not (Get-Command adb.exe -ErrorAction SilentlyContinue)) {
  throw 'Android Debug Bridge was not found. Install Android SDK Platform-Tools or use the generated APK file on your phone.'
}

if (-not (Test-Path -LiteralPath $apkPath)) {
  throw 'The APK was not found. Run scripts\build-android.ps1 first.'
}

$devices = & adb.exe devices
if ($LASTEXITCODE -ne 0) { throw 'Could not query Android devices.' }
if (($devices | Select-String -Pattern '\tdevice$' | Measure-Object).Count -lt 1) {
  throw 'No authorized Android device found. Enable Developer options and USB debugging, connect the phone, and accept its authorization prompt.'
}

& adb.exe install -r $apkPath
if ($LASTEXITCODE -ne 0) { throw 'Could not install the APK on the connected Android device.' }

Write-Host 'Elite Center was installed successfully on the connected Android device.'
