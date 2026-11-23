#!/usr/bin/env bash
# Starts the app that was just built, checks it is still alive after a while and takes a picture of the
# screen. Compiling is not proof that it runs: this is. Linux and macOS (Windows has its own script).
#   desktop.sh <linux|linux-frameless|macos>
# Two runs: a first launch (the server picker), then one already connected to killio.dev, which shows that
# the window loads and draws a real server's page and not only the app's own screen.
set -u
system="$1"
mkdir -p smoke

case "$system" in
  linux*)
    binary="$(find src-tauri/target -path '*release/killio-app' -type f | head -1)"
    config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/dev.killio.client"
    ;;
  macos)
    app="$(find src-tauri/target -name 'Killio.app' -maxdepth 6 | head -1)"
    binary="$app/Contents/MacOS/$(ls "$app/Contents/MacOS" | head -1)"
    config_dir="$HOME/Library/Application Support/dev.killio.client"
    ;;
esac
echo "binary: $binary"
[ -x "$binary" ] || { echo "the built app was not found"; exit 1; }

shoot() {
  case "$system" in
    linux*)
      # A black picture can mean "nothing drawn" or "no window": list the windows to tell them apart.
      echo "--- windows on the display:"
      xwininfo -root -tree 2>/dev/null | grep -E '^\s+0x' | head -8
      import -window root "$1" 2>/dev/null || echo "no screenshot"
      echo "--- distinct colours in the picture: $(identify -format '%k' "$1" 2>/dev/null)"
      ;;
    macos) screencapture -x "$1" 2>/dev/null || echo "no screenshot" ;;
  esac
}

# run <name> <seconds>: start, wait, check it is alive, picture, stop.
run() {
  local name="$1" seconds="$2" log="smoke/$1.log"
  "$binary" > "$log" 2>&1 &
  local pid=$!
  sleep "$seconds"
  local alive=1
  if kill -0 "$pid" 2>/dev/null; then echo "[$name] RUNNING after $seconds s (pid $pid)"; alive=0
  else wait "$pid"; echo "[$name] EXITED with code $? before $seconds s"; fi
  shoot "smoke/$name.png"
  echo "--- [$name] app output:"; head -15 "$log"
  kill "$pid" 2>/dev/null; sleep 3
  return $alive
}

rm -rf "$config_dir"
run "$system" 25 || exit 1

# Second launch: as a person who already chose killio.dev. The app goes straight to it.
mkdir -p "$config_dir"
cat > "$config_dir/config.json" <<'JSON'
{ "tenants": [{ "name": "Killio", "url": "https://www.killio.dev/" }], "current": "https://www.killio.dev/", "accounts": [] }
JSON
run "$system-server" 40
status=$?
ls -la smoke
exit $status
