# Starts the app that was just built, checks it is still alive after a while and takes a picture of the
# screen. Compiling is not proof that it runs: this is.
# Two runs: a first launch (the server picker), then one already connected to killio.dev, which shows that
# the window loads and draws a real server's page and not only the app's own screen.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path smoke | Out-Null
$exe = Get-ChildItem -Path src-tauri/target/release/killio-app.exe
$configDir = Join-Path $env:APPDATA 'dev.killio.client'
Write-Output "binary: $($exe.FullName)"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Shoot($path) {
  try {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } catch { Write-Output "no screenshot: $_" }
}

function Run($name, $seconds) {
  $process = Start-Process -FilePath $exe.FullName -PassThru
  Start-Sleep -Seconds $seconds
  $alive = -not $process.HasExited
  if ($alive) { Write-Output "[$name] RUNNING after $seconds s (pid $($process.Id))" }
  else { Write-Output "[$name] EXITED with code $($process.ExitCode) before $seconds s" }
  Shoot "smoke/$name.png"
  if ($alive) { Stop-Process -Id $process.Id -Force; Start-Sleep -Seconds 3 }
  return $alive
}

if (Test-Path $configDir) { Remove-Item -Recurse -Force $configDir }
if (-not (Run 'windows' 25)) { exit 1 }

# Second launch: as a person who already chose killio.dev. The app goes straight to it.
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
'{ "tenants": [{ "name": "Killio", "url": "https://www.killio.dev/" }], "current": "https://www.killio.dev/", "accounts": [] }' |
  Set-Content -Encoding utf8 -Path (Join-Path $configDir 'config.json')
$second = Run 'windows-server' 40
Get-ChildItem smoke
if (-not $second) { exit 1 }
