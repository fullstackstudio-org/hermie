package nl.fullstackstudio.hermie.devlaunch

import android.content.pm.ApplicationInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The Android half of the development launch arguments.
 *
 * On Apple platforms `src/dev/launch-intent.ts` reads
 * `ProcessInfo.processInfo.arguments`, which is what `xcrun simctl launch` sets.
 * Android has no equivalent — `adb shell am start` cannot set a process argument
 * vector — so the same grammar arrives as **Intent extras** instead and this
 * module flattens them back into the `argv` shape the parser already takes:
 *
 * ```sh
 * adb shell am start -n dev.hermie.app/.MainActivity \
 *   --es hermieGateway http://10.0.2.2:9119 --es hermieToken demo \
 *   --es hermieTheme light --es hermieOpen chat:researcher
 * ```
 *
 * becomes `["--hermieGateway", "http://10.0.2.2:9119", "--hermieToken", "demo", …]`,
 * which `parseDevLaunchArguments` reads exactly as it reads a simulator's. A key
 * that already starts with `--` is passed through unchanged, so the iOS spelling
 * works here too if a shell makes that easier. Nothing is validated here on
 * purpose: the grammar, its defaults and its rejection of a typo all live in the
 * TypeScript, which is the side with tests.
 *
 * **The gate, and how it differs from iOS.** iOS removes the constant at compile
 * time with `#if DEBUG`, so a Release binary does not define it. A library's
 * `BuildConfig.DEBUG` is not a trustworthy stand-in for that, so this reads the
 * application's own `FLAG_DEBUGGABLE` instead — set by the debug manifest merge
 * and by nothing else, so a release APK returns an empty list. That is a
 * **runtime** gate rather than a compile-time one, and the difference is worth
 * stating plainly: on Android the eleven lines below are present in a release
 * APK, they just never see an extra. The gate that removes the caller is still
 * `__DEV__` in `launch-intent.ts`, which folds `DEV_LAUNCH_INTENT` to `null` and
 * takes `seedDevGateway`'s body with it.
 *
 * The third iOS gate — "nothing is registered with the system" — does NOT hold
 * here, and pretending otherwise would be the wrong note to leave. `MainActivity`
 * is `exported`, because a launcher activity has to be, so any app on the device
 * can start it with extras. `FLAG_DEBUGGABLE` is what makes that harmless in
 * anything shipped.
 *
 * **`singleTask` bites.** `MainActivity` is `launchMode="singleTask"`, so a second
 * `am start` against a live process arrives at `onNewIntent` and `getIntent()`
 * still answers the intent the activity was created with. Force-stop between
 * launches — `adb shell am force-stop dev.hermie.app` — or the app will
 * show you the previous screenshot's arguments.
 */
class HermieDevLaunchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HermieDevLaunch")

    // A property rather than a constant, because the activity does not exist yet
    // when modules are created. It is read once, at JavaScript module load.
    Property("devLaunchArguments") { launchArguments() }
  }

  private fun launchArguments(): List<String> {
    val activity = appContext.currentActivity ?: return emptyList()

    if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
      return emptyList()
    }

    val extras = activity.intent?.extras ?: return emptyList()
    val argv = mutableListOf<String>()

    for (key in extras.keySet()) {
      // Only string extras: `--es`. A non-string answers null here rather than
      // throwing, which is the right shape for a channel where an unrecognised
      // value is meant to be ignored.
      val value = extras.getString(key) ?: continue

      argv += if (key.startsWith("--")) key else "--$key"
      argv += value
    }

    return argv
  }
}
