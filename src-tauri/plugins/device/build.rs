fn main() {
    // No commands of its own: the app's commands (which check who is calling) are the only way in.
    // This crate exists to carry the Kotlin code in `android/` into the Android build.
    tauri_plugin::Builder::new(&[]).android_path("android").build();
}
