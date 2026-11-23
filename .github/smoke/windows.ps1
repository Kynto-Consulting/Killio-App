# Starts the app that was just built, checks it is still alive after a while and takes a picture of the
# screen. Compiling is not proof that it runs: this is.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path smoke | Out-Null
$exe = Get-ChildItem -Path src-tauri/target/release/killio-app.exe
Write-Output "binary: $($exe.FullName)"

$process = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 25

$alive = -not $process.HasExited
if ($alive) { Write-Output "RUNNING after 25 s (pid $($process.Id))" }
else { Write-Output "EXITED with code $($process.ExitCode) before 25 s" }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save("smoke/windows.png", [System.Drawing.Imaging.ImageFormat]::Png)
} catch { Write-Output "no screenshot: $_" }

Get-ChildItem smoke
if ($alive) { Stop-Process -Id $process.Id -Force }
if (-not $alive) { exit 1 }
