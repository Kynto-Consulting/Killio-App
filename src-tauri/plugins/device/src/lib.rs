//! The phone's own hardware and system apps, for the agent tools Killio Vault had on Android: alarm,
//! timer, torch, and the list of installed apps. The work is done in Kotlin (`android/`); this side only
//! hands a request over and brings the answer back. On every other system `run` says it is not available.

use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// Handle to the Kotlin side. Managed as app state by `init`.
pub struct Device<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Device<R> {
    /// Runs one action of the Kotlin plugin (the name of its `@Command` function) and returns its answer.
    pub fn run(&self, action: &str, payload: Value) -> Result<Value, String> {
        #[cfg(target_os = "android")]
        {
            self.handle.run_mobile_plugin::<Value>(action, payload).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (action, payload);
            Err("Only available on Android.".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("killio-device")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("dev.killio.device", "DevicePlugin")?;
                app.manage(Device { handle });
            }
            #[cfg(not(target_os = "android"))]
            app.manage(Device::<R> { _runtime: std::marker::PhantomData });
            Ok(())
        })
        .build()
}
