package dev.killio.device

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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

@InvokeArg
class BarsArgs {
    var color: String = ""
    var dark: Boolean = true
}

@InvokeArg
class EventArgs {
    var title: String = ""
    var start: Long = 0
    var end: Long = 0
    var location: String? = null
    var notes: String? = null
}

@InvokeArg
class RangeArgs {
    var startMs: Long = 0
    var endMs: Long = 0
}

@InvokeArg
class QueryArgs {
    var query: String = ""
}

@InvokeArg
class BrightnessArgs {
    var level: Double = -1.0
    var restore: Boolean = false
}

@InvokeArg
class MediaArgs {
    var key: String = ""
}

/**
 * The phone's own hardware and system apps, for the agent tools Killio Vault had: alarm, timer, torch,
 * installed apps, contacts, calendar, screen brightness and the media keys. Every action answers with what really happened; none of them runs without the page
 * having asked the person first (the frontend confirms before calling).
 */
@TauriPlugin
class DevicePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Android draws an app under the status bar, the navigation bar and any notch. The page is a
     * website that knows nothing about those, so the space they take (and the keyboard's, while it is
     * up) is kept out of the page here: what the person can touch is what the page gets.
     */
    override fun load(webView: WebView) {
        super.load(webView)
        activity.runOnUiThread {
            val content = activity.findViewById<View>(android.R.id.content)
            val night = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            paintBars(if (night) Color.parseColor("#0d0d0c") else Color.parseColor("#f6f6f4"), night)
            ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
                val taken = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
                )
                view.setPadding(taken.left, taken.top, taken.right, taken.bottom)
                WindowInsetsCompat.CONSUMED
            }
            ViewCompat.requestApplyInsets(content)
        }
    }

    /** The colour behind the system bars, and whether their icons must be light (on a dark page) or dark. */
    private fun paintBars(color: Int, dark: Boolean) {
        activity.window.decorView.setBackgroundColor(color)
        activity.findViewById<View>(android.R.id.content).setBackgroundColor(color)
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    /** The page says its colour so the bars around it read as part of it. */
    @Command
    fun setBars(invoke: Invoke) {
        val args = invoke.parseArgs(BarsArgs::class.java)
        val color = try { Color.parseColor(args.color) } catch (error: Exception) { null }
        if (color == null) {
            invoke.reject("Not a colour.")
            return
        }
        activity.runOnUiThread {
            try {
                paintBars(color, args.dark)
                invoke.resolve(JSObject().put("painted", true))
            } catch (error: Exception) {
                invoke.reject(error.message ?: "The bars could not be painted.")
            }
        }
    }

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

    /**
     * Opens the calendar app with a new event filled in. The person saves it there: nothing is written
     * to the calendar from here, so no permission is needed.
     */
    @Command
    fun calendarCreate(invoke: Invoke) {
        val args = invoke.parseArgs(EventArgs::class.java)
        if (args.title.isBlank() || args.start <= 0 || args.end < args.start) {
            invoke.reject("The event needs a title, a start and an end that is not before the start.")
            return
        }
        val intent = Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, args.start)
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, args.end)
            .putExtra(CalendarContract.Events.TITLE, args.title.take(200))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        args.location?.takeIf { it.isNotBlank() }?.let { intent.putExtra(CalendarContract.Events.EVENT_LOCATION, it.take(200)) }
        args.notes?.takeIf { it.isNotBlank() }?.let { intent.putExtra(CalendarContract.Events.DESCRIPTION, it.take(2000)) }
        try {
            activity.startActivity(intent)
            invoke.resolve(JSObject().put("opened", true).put("note", "The calendar app opened with the event filled in. The person saves it there."))
        } catch (error: Exception) {
            invoke.reject("This phone has no calendar app that accepts new events.")
        }
    }

    /** The events between two moments (at most 62 days, 50 events), from the calendars on this phone. */
    @Command
    fun calendarList(invoke: Invoke) {
        val args = invoke.parseArgs(RangeArgs::class.java)
        if (!allowed(invoke, Manifest.permission.READ_CALENDAR, "the calendar")) return
        val from = if (args.startMs > 0) args.startMs else System.currentTimeMillis()
        val week = 7L * 24 * 60 * 60 * 1000
        val until = (if (args.endMs > from) args.endMs else from + week).coerceAtMost(from + 62L * 24 * 60 * 60 * 1000)
        try {
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().let {
                ContentUris.appendId(it, from)
                ContentUris.appendId(it, until)
                it.build()
            }
            val columns = arrayOf(
                CalendarContract.Instances.TITLE,
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
                CalendarContract.Instances.EVENT_LOCATION,
                CalendarContract.Instances.ALL_DAY,
            )
            val events = JSArray()
            activity.contentResolver.query(uri, columns, null, null, CalendarContract.Instances.BEGIN + " ASC")?.use { cursor ->
                while (cursor.moveToNext() && events.length() < 50) {
                    events.put(
                        JSObject()
                            .put("title", cursor.getString(0) ?: "")
                            .put("start", cursor.getLong(1))
                            .put("end", cursor.getLong(2))
                            .put("location", cursor.getString(3) ?: "")
                            .put("allDay", cursor.getInt(4) == 1)
                    )
                }
            }
            invoke.resolve(JSObject().put("events", events).put("from", from).put("until", until))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The calendar could not be read.")
        }
    }

    /** Contacts whose name contains the text, with their phone numbers (at most 10). */
    @Command
    fun contactsSearch(invoke: Invoke) {
        val args = invoke.parseArgs(QueryArgs::class.java)
        val wanted = args.query.trim()
        if (wanted.length < 2) {
            invoke.reject("Give at least two letters of the name.")
            return
        }
        if (!allowed(invoke, Manifest.permission.READ_CONTACTS, "the contacts")) return
        try {
            val columns = arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
            )
            val seen = HashSet<String>()
            val contacts = JSArray()
            activity.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                columns,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                arrayOf("%" + wanted.take(60) + "%"),
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC",
            )?.use { cursor ->
                while (cursor.moveToNext() && contacts.length() < 10) {
                    val name = cursor.getString(0) ?: continue
                    val number = cursor.getString(1) ?: continue
                    if (seen.add(name + "|" + number.filter { it.isDigit() || it == '+' })) {
                        contacts.put(JSObject().put("name", name).put("number", number))
                    }
                }
            }
            invoke.resolve(JSObject().put("contacts", contacts))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The contacts could not be read.")
        }
    }

    /** Brightness of this app's own screen (0..1), or back to the phone's setting. It does not change the system's. */
    @Command
    fun setBrightness(invoke: Invoke) {
        val args = invoke.parseArgs(BrightnessArgs::class.java)
        if (!args.restore && (args.level < 0.0 || args.level > 1.0)) {
            invoke.reject("The brightness must be between 0 and 1.")
            return
        }
        val value = if (args.restore) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else args.level.toFloat().coerceAtLeast(0.01f)
        activity.runOnUiThread {
            try {
                val attributes = activity.window.attributes
                attributes.screenBrightness = value
                activity.window.attributes = attributes
                invoke.resolve(
                    if (args.restore) JSObject().put("restored", true)
                    else JSObject().put("level", args.level).put("note", "Applies while Killio is on screen; the phone's own setting is unchanged.")
                )
            } catch (error: Exception) {
                invoke.reject(error.message ?: "The brightness could not be changed.")
            }
        }
    }

    /** Presses a media key for whatever is playing: pause, play, next or previous. */
    @Command
    fun mediaKey(invoke: Invoke) {
        val args = invoke.parseArgs(MediaArgs::class.java)
        val code = when (args.key) {
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            else -> {
                invoke.reject("Unknown media key.")
                return
            }
        }
        try {
            val audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
            audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
            invoke.resolve(JSObject().put("pressed", args.key).put("note", "The key was sent; whether something was playing is not known."))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The media key could not be sent.")
        }
    }

    /**
     * Whether the person already allowed reading this. If not, the phone asks now and this call ends with
     * a message saying so: the assistant (or the person) asks again once it is allowed.
     */
    private fun allowed(invoke: Invoke, permission: String, what: String): Boolean {
        if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) return true
        ActivityCompat.requestPermissions(activity, arrayOf(permission), 4100)
        invoke.reject("The phone is asking the person for permission to read " + what + ". Ask again once they have allowed it.")
        return false
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
