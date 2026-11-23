#!/usr/bin/env bash
# Runs inside an Android emulator session: installs the APK that was just built, opens the app, checks it
# is still alive after a while and takes a picture of the screen; then picks killio.dev in the server
# picker, to see the app load and draw a real server's page on a phone.
set -u
mkdir -p smoke
package="dev.killio.client"
apk="$(find "${APK_DIR:-src-tauri/gen/android/app/build/outputs/apk}" -name '*.apk' | head -1)"
[ -n "$apk" ] || { echo "no APK found"; exit 1; }
echo "apk: $apk ($(du -h "$apk" | cut -f1))"

adb install -r "$apk" || { echo "INSTALL FAILED"; exit 1; }
adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 40

pid="$(adb shell pidof "$package" | tr -d '\r')"
adb exec-out screencap -p > smoke/android.png

if [ -n "$pid" ]; then
  # The "Killio" row of the picker sits a little above the middle of the screen.
  size="$(adb shell wm size | tr -d '\r' | grep -oE '[0-9]+x[0-9]+' | tail -1)"
  width="${size%x*}"; height="${size#*x}"
  # A slow emulator shows its own "isn't responding" dialogs over the app: close them and bring the app back.
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null 2>&1
  adb shell input keyevent KEYCODE_ESCAPE
  adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
  sleep 8
  adb exec-out screencap -p > smoke/android-before-tap.png
  echo "screen: ${width}x${height}; tapping the Killio row"
  adb shell input tap "$((width / 2))" "$((height * 43 / 100))"
  sleep 60
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null 2>&1
  adb exec-out screencap -p > smoke/android-server.png
  echo "--- after choosing the server, still running: $(adb shell pidof "$package" | tr -d '\r')"
fi

adb logcat -d > smoke/android.log 2>&1
ls -la smoke
echo "--- crashes in the log, if any:"
grep -E "FATAL EXCEPTION|AndroidRuntime: |Fatal signal" smoke/android.log | head -20

if [ -n "$pid" ]; then
  echo "RUNNING after 40 s (pid $pid)"
  echo "--- what is on screen:"
  adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -3
  exit 0
fi
echo "NOT RUNNING after 40 s"
exit 1
