#!/usr/bin/env bash
# Runs the HermieKit tests.
#
#   native/apple/scripts/test.sh                 swift test
#   native/apple/scripts/test.sh --filter Core   anything after the options goes to swift test
#   native/apple/scripts/test.sh --apps          also generate both projects and build both apps
#                                                unsigned (iOS Simulator and macOS)
#   native/apple/scripts/test.sh --keychain      also run KeychainStore against the real keychain:
#                                                the hosted HermieKeychainTests in the iOS app, on
#                                                a throwaway simulator created for the run and
#                                                deleted after it. HERMIE_SIM_DEVICE_TYPE and
#                                                HERMIE_SIM_RUNTIME override the device type
#                                                (default iPhone 17) and the runtime (default
#                                                the newest iOS runtime installed).
#
# The options can be combined, in any order, before the swift test arguments.
#
# The keychain tests are not run on macOS: the Mac's data protection keychain
# needs a signed build with the app's keychain group, which is the group a
# Hermie install on the same Mac keeps its live credentials in.

set -euo pipefail

apple_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$(cd "$apple_dir/.." && pwd)"

build_apps=false
keychain=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apps) build_apps=true ;;
    --keychain) keychain=true ;;
    *) break ;;
  esac
  shift
done

swift test --package-path "$apple_dir/HermieKit" "$@"

derived="$apple_dir/DerivedData"

if [[ "$build_apps" == true ]]; then
  "$apple_dir/scripts/generate.sh"
  xcodebuild build -quiet \
    -project "$native_dir/ios/Hermie.xcodeproj" -scheme Hermie \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO
  echo "Built Hermie for the iOS Simulator"
  xcodebuild build -quiet \
    -project "$native_dir/macos/Hermie.xcodeproj" -scheme Hermie \
    -destination 'generic/platform=macOS' \
    -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO
  echo "Built Hermie for macOS"
fi

if [[ "$keychain" == true ]]; then
  "$apple_dir/scripts/generate.sh" ios

  device_type="${HERMIE_SIM_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}"
  runtime="${HERMIE_SIM_RUNTIME:-$(xcrun simctl list runtimes iOS available | awk '/^iOS / { id = $NF } END { print id }')}"
  if [[ -z "$runtime" ]]; then
    echo "No iOS Simulator runtime is installed." >&2
    exit 1
  fi

  # A device of its own, so the run can never meet another simulator's
  # keychain, and nothing it writes outlives it.
  udid="$(xcrun simctl create "Hermie keychain tests $$" "$device_type" "$runtime")"
  cleanup() {
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  echo "Keychain tests on a throwaway simulator ($device_type, $runtime)"
  # Signed ad hoc, to run locally: the simulator honours the entitlements Xcode
  # embeds in the binary, so the test host has the app's keychain access group
  # without a team, a provisioning profile or a certificate, on a CI runner as
  # on a developer's Mac.
  xcodebuild test -quiet \
    -project "$native_dir/ios/Hermie.xcodeproj" -scheme HermieKeychainTests \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$derived" \
    CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
  echo "Keychain tests passed"
fi
