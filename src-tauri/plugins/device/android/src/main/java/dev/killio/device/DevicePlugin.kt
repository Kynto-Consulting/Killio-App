package dev.killio.device

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.provider.AlarmClock
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class AlarmArgs {
    var hour: Int = 0
    var minute: Int = 0
    var label: String? = null
}

@InvokeArg
class TimerArgs {
    var seconds: Int = 0
    var label: String? = null
}

@InvokeArg
class TorchArgs {
    var on: Boolean = true
}

@InvokeArg
class OpenAppArgs {
    var packageName: String = ""
}

/**
 * The phone's own hardware and system apps, for the agent tools Killio Vault had: alarm, timer, torch and
 * installed apps. Every action answers with what really happened; none of them runs without the page
 * having asked the person first (the frontend confirms before calling).
 */
@TauriPlugin
class DevicePlugin(private val activity: Activity) : Plugin(activity) {

    /** Sets an alarm in the phone's clock app, without leaving Killio. */
    @Command
    fun setAlarm(invoke: Invoke) {
        val args = invoke.parseArgs(AlarmArgs::class.java)
        if (args.hour !in 0..23 || args.minute !in 0..59) {
            invoke.reject("The time is not valid.")
            return
        }
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, args.hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, args.minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        args.label?.takeIf { it.isNotBlank() }?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it.take(120)) }
        start(invoke, intent, "This phone has no clock app that accepts alarms.") {
            JSObject().put("set", true).put("hour", args.hour).put("minute", args.minute)
        }
    }

    /** Starts a countdown in the phone's clock app. */
    @Command
    fun setTimer(invoke: Invoke) {
        val args = invoke.parseArgs(TimerArgs::class.java)
        if (args.seconds !in 1..86400) {
            invoke.reject("The timer must be between 1 second and 24 hours.")
            return
        }
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, args.seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        args.label?.takeIf { it.isNotBlank() }?.let { intent.putExtra(AlarmClock.EXTRA_MESSAGE, it.take(120)) }
        start(invoke, intent, "This phone has no clock app that accepts timers.") {
            JSObject().put("started", true).put("seconds", args.seconds)
        }
    }

    /** Turns the torch on or off. */
    @Command
    fun flashlight(invoke: Invoke) {
        val args = invoke.parseArgs(TorchArgs::class.java)
        try {
            val cameras = activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val withFlash = cameras.cameraIdList.firstOrNull { id ->
                cameras.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            if (withFlash == null) {
                invoke.reject("This device has no torch.")
                return
            }
            cameras.setTorchMode(withFlash, args.on)
            invoke.resolve(JSObject().put("on", args.on))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The torch could not be changed.")
        }
    }

    /** The apps that have an icon on the home screen, as label and package. */
    @Command
    fun listApps(invoke: Invoke) {
        try {
            val manager = activity.packageManager
            val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val apps = JSArray()
            manager.queryIntentActivities(launcher, 0)
                .map { it.loadLabel(manager).toString() to it.activityInfo.packageName }
                .distinctBy { it.second }
                .sortedBy { it.first.lowercase() }
                .take(600)
                .forEach { (label, packageName) -> apps.put(JSObject().put("label", label).put("package", packageName)) }
            invoke.resolve(JSObject().put("apps", apps))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The apps could not be listed.")
        }
    }

    /** Opens an installed app by package. Only apps that have a launcher icon can be opened. */
    @Command
    fun openApp(invoke: Invoke) {
        val args = invoke.parseArgs(OpenAppArgs::class.java)
        val intent = activity.packageManager.getLaunchIntentForPackage(args.packageName)
        if (intent == null) {
            invoke.reject("That app is not installed.")
            return
        }
        start(invoke, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), "That app could not be opened.") {
            JSObject().put("opened", args.packageName)
        }
    }

    private fun start(invoke: Invoke, intent: Intent, unavailable: String, answer: () -> JSObject) {
        try {
            if (intent.resolveActivity(activity.packageManager) == null) {
                invoke.reject(unavailable)
                return
            }
            activity.startActivity(intent)
            invoke.resolve(answer())
        } catch (error: Exception) {
            invoke.reject(error.message ?: unavailable)
        }
    }
}
