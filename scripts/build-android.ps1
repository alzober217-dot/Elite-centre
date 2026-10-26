$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command java.exe -ErrorAction SilentlyContinue)) {
  throw 'Java 21 is required. Install Android Studio or a compatible JDK 21 and configure JAVA_HOME.'
}

$javaVersionOutput = & java.exe -version 2>&1 | Out-String
if ($javaVersionOutput -notmatch 'version "21\.') {
  throw "Java 21 is required by this Android build. Detected: $($javaVersionOutput.Trim())"
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  throw 'Android SDK was not found. Install Android Studio, install Android SDK Platform 36 and Build Tools 36, then configure ANDROID_HOME.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'android'))) {
  throw 'The Android platform project is missing. Run npm run android:add once before building.'
}

npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "The web build failed with exit code $LASTEXITCODE." }

npx.cmd cap sync android
if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed with exit code $LASTEXITCODE." }

$gradleWrapper = Join-Path $projectRoot 'android\gradlew.bat'
if (-not (Test-Path -LiteralPath $gradleWrapper)) {
  throw 'Gradle wrapper is missing from the Android project.'
}

& $gradleWrapper -p (Join-Path $projectRoot 'android') assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Android APK build failed with exit code $LASTEXITCODE." }

$apkPath = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apkPath)) {
  throw 'Gradle completed without producing the expected APK.'
}

Write-Host "Installable debug APK: $apkPath"
