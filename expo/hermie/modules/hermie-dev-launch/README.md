# hermie-dev-launch

The Android half of the development launch arguments. Android only, and Debug
only.

`src/dev/launch-intent.ts` opens the app straight onto one screen from the command
line. On Apple platforms it reads `ProcessInfo.processInfo.arguments`, which is
what `xcrun simctl launch` sets, through `hermie-mac`. `adb shell am start` has no
argument vector to set, so the same grammar arrives as **Intent extras** and this
module flattens them into the `argv` shape the parser already takes:

```sh
adb shell am start -n dev.hermie.app/.MainActivity \
  --es hermieGateway http://10.0.2.2:9119 --es hermieOpen chat:researcher
```

becomes `["--hermieGateway", "http://10.0.2.2:9119", "--hermieOpen", "chat:researcher"]`.
Nothing is validated here: the grammar, its defaults and its rejection of a typo
all live in the TypeScript, which is the side with tests.

`requireOptionalNativeModule` finds `HermieMac` on Apple and `HermieDevLaunch`
here, so exactly one of the two answers in any binary and the JavaScript needs no
platform branch.

## Two things to know before using it

- **Force-stop between launches.** `MainActivity` is `launchMode="singleTask"`, so
  a second `am start` against a live process arrives at `onNewIntent` while
  `getIntent()` still answers the intent the activity was created with. Without
  `adb shell am force-stop dev.hermie.app` the app shows you the
  previous launch's arguments.
- **The gate is `FLAG_DEBUGGABLE`, at runtime.** iOS removes its constant at
  compile time with `#if DEBUG`; a library's `BuildConfig.DEBUG` is not a
  trustworthy stand-in for that, so this reads the application's debuggable flag
  instead. A release APK therefore contains these lines and never sees an extra.
  `MainActivity` is also `exported`, because a launcher activity has to be — so
  unlike on iOS, the channel _is_ reachable from another app on the device, and
  the debuggable flag is the whole of what makes that harmless in a shipped
  build. CONTRIBUTING.md states the same thing beside the iOS gates.
