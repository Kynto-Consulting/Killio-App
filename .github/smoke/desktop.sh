#!/usr/bin/env bash
# Starts the app that was just built, checks it is still alive after a while and takes a picture of the
# screen. Compiling is not proof that it runs: this is. Linux and macOS (Windows has its own script).
#   desktop.sh <linux|macos>
set -u
system="$1"
mkdir -p smoke
log="smoke/$system.log"

case "$system" in
  linux*)
    binary="$(find src-tauri/target -path '*release/killio-app' -type f | head -1)"
    ;;
  macos)
    app="$(find src-tauri/target -name 'Killio.app' -maxdepth 6 | head -1)"
    binary="$app/Contents/MacOS/$(ls "$app/Contents/MacOS" | head -1)"
    ;;
esac
echo "binary: $binary"
[ -x "$binary" ] || { echo "the built app was not found"; exit 1; }

# The app keeps its settings in the user's folder; a fresh runner means the first-run screen (server picker).
"$binary" > "$log" 2>&1 &
pid=$!
sleep 25

if kill -0 "$pid" 2>/dev/null; then
  echo "RUNNING after 25 s (pid $pid)"
  alive=0
else
  wait "$pid"; echo "EXITED with code $? before 25 s"
  alive=1
fi

case "$system" in
  linux*)
    # A black picture can mean "nothing drawn" or "no window": list the windows to tell them apart.
    echo "--- windows on the display:"
    xwininfo -root -tree 2>/dev/null | grep -E '^\s+0x' | head -20
    import -window root "smoke/$system.png" 2>> "$log" || echo "no screenshot"
    echo "--- distinct colours in the picture: $(identify -format '%k' "smoke/$system.png" 2>/dev/null)"
    ;;
  macos) screencapture -x "smoke/$system.png" 2>> "$log" || echo "no screenshot" ;;
esac
ls -la smoke
echo "--- app output:"
head -40 "$log"
kill "$pid" 2>/dev/null
exit $alive
