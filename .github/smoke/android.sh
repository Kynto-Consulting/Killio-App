#!/usr/bin/env bash
# Runs inside an Android emulator session: installs the APK that was just built, opens the app, checks it
# is still alive after a while and takes a picture of the screen.
set -u
mkdir -p smoke
package="dev.killio.client"
apk="$(find src-tauri/gen/android/app/build/outputs/apk -name '*.apk' | head -1)"
echo "apk: $apk ($(du -h "$apk" | cut -f1))"

adb install -r "$apk" || { echo "INSTALL FAILED"; exit 1; }
adb logcat -c
adb shell monkey -p "$package" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 40

pid="$(adb shell pidof "$package" | tr -d '\r')"
adb exec-out screencap -p > smoke/android.png
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
