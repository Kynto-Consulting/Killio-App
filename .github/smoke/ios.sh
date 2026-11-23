#!/usr/bin/env bash
# Installs the simulator build on an iPhone simulator, opens it, checks it is still alive after a
# while and keeps a picture of the screen.
set -u
mkdir -p smoke
bundle="dev.killio.client"
app="$(find src-tauri/gen/apple/build -maxdepth 2 -name '*.app' | head -1)"
[ -n "$app" ] || { echo "no .app found"; exit 1; }
echo "app: $app ($(du -sh "$app" | cut -f1))"

device="$(xcrun simctl list devices available | grep -E '^\s+iPhone' | head -1 | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}')"
[ -n "$device" ] || { echo "no iPhone simulator available"; exit 1; }
echo "simulator: $(xcrun simctl list devices available | grep "$device")"

xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b > /dev/null
xcrun simctl install "$device" "$app" || { echo "INSTALL FAILED"; exit 1; }
xcrun simctl launch "$device" "$bundle" || { echo "LAUNCH FAILED"; exit 1; }
sleep 45
xcrun simctl io "$device" screenshot smoke/ios.png

running="$(xcrun simctl spawn "$device" launchctl list | grep "$bundle" || true)"
xcrun simctl spawn "$device" log show --last 2m --predicate 'process == "Killio"' --style compact > smoke/ios.log 2>&1 || true
ls -la smoke
echo "--- crashes, if any:"
ls ~/Library/Logs/DiagnosticReports 2> /dev/null | grep -i killio | head -5
xcrun simctl shutdown "$device" || true

if [ -n "$running" ]; then
  echo "RUNNING after 45 s: $running"
  exit 0
fi
echo "NOT RUNNING after 45 s"
exit 1
