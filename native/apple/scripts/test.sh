#!/usr/bin/env bash
# Runs the HermieKit tests.
#
#   native/apple/scripts/test.sh                 swift test
#   native/apple/scripts/test.sh --filter Core   anything after the options goes to swift test
#   native/apple/scripts/test.sh --apps          also generate both projects and build both apps
#                                                unsigned (iOS Simulator and macOS)
#   native/apple/scripts/test.sh --integration   also run the black-box tests against the fake gateway
#                                                (Tests/HermieIntegrationTests, macOS only). They need
#                                                node and the workspace installed (npm ci at the
#                                                repository root); without either they are skipped
#                                                with a message, except in CI, where that is an
#                                                error. On by default when CI is set.
#   native/apple/scripts/test.sh --no-integration
#                                                leave them out, in CI too.
#   native/apple/scripts/test.sh --keychain      also run KeychainStore against the real keychain:
#                                                the hosted HermieKeychainTests in the iOS app, on
#                                                a throwaway simulator created for the run and
#                                                deleted after it. HERMIE_SIM_DEVICE_TYPE and
#                                                HERMIE_SIM_RUNTIME override the device type
#                                                (default iPhone 17) and the runtime (default
#                                                the newest iOS runtime installed).
#   native/apple/scripts/test.sh --ui            also run the iOS UI test schemes in ui_schemes
#                                                (the app shell's HermieShellUITests and the
#                                                transcript lab's HermieLab) on a throwaway
#                                                iPhone and a throwaway iPad, created for the
#                                                run and deleted after it. HERMIE_SIM_PAD_TYPE
#                                                overrides the iPad type (default iPad Pro
#                                                11-inch (M5)).
#   native/apple/scripts/test.sh --ui-mac        also run the transcript lab's UI tests (HermieLab)
#                                                on this Mac. They drive the real pointer and
#                                                keyboard while they run, and the test runner
#                                                needs the Accessibility permission.
#
# The options can be combined, in any order, before the swift test arguments.
#
# The keychain tests are not run on macOS: the Mac's data protection keychain
# needs a signed build with the app's keychain group, which is the group a
# Hermie install on the same Mac keeps its live credentials in.

set -euo pipefail

apple_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$(cd "$apple_dir/.." && pwd)"
repo_dir="$(cd "$native_dir/.." && pwd)"

build_apps=false
keychain=false
integration=false
if [[ -n "${CI:-}" ]]; then
  integration=true
fi
ui=false
ui_mac=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apps) build_apps=true ;;
    --keychain) keychain=true ;;
    --integration) integration=true ;;
    --no-integration) integration=false ;;
    --ui) ui=true ;;
    --ui-mac) ui_mac=true ;;
    *) break ;;
  esac
  shift
done

if [[ "$integration" == true ]]; then
  missing=""
  if ! command -v node >/dev/null 2>&1; then
    missing="node is not on PATH"
  elif [[ ! -f "$repo_dir/node_modules/tsx/package.json" ]]; then
    missing="the workspace is not installed (run npm ci in $repo_dir)"
  fi

  if [[ -n "$missing" ]]; then
    if [[ -n "${CI:-}" ]]; then
      echo "The fake-gateway integration tests cannot run: $missing." >&2
      exit 1
    fi

    echo "Skipping the fake-gateway integration tests: $missing." >&2
    integration=false
  fi
fi

if [[ "$integration" == true ]]; then
  # The tests tag every fake gateway they start with this run's id (in the
  # node command line), so the check below finds this run's children and
  # nobody else's.
  export HERMIE_INTEGRATION=1
  export HERMIE_INTEGRATION_RUN="run-$$-$RANDOM"
else
  export HERMIE_INTEGRATION=0
fi

status=0
swift test --package-path "$apple_dir/HermieKit" "$@" || status=$?

if [[ "$integration" == true ]]; then
  # Every fake gateway must be gone. Each one exits when its stdin closes, so
  # one left over from a crashed run goes within moments; give it five seconds.
  tag="hermie-integration-$HERMIE_INTEGRATION_RUN"
  deadline=$((SECONDS + 5))
  while pgrep -f "$tag" >/dev/null 2>&1 && ((SECONDS < deadline)); do
    sleep 0.1
  done

  if pgrep -f "$tag" >/dev/null 2>&1; then
    echo "Fake gateways outlived the test run:" >&2
    pgrep -fl "$tag" >&2 || true
    exit 1
  fi
fi

if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi

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

if [[ "$ui" == true ]]; then
  "$apple_dir/scripts/generate.sh" ios

  # One entry per UI test scheme in native/ios/project.yml; add yours here.
  ui_schemes=(HermieShellUITests HermieLab)

  phone_type="${HERMIE_SIM_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17}"
  pad_type="${HERMIE_SIM_PAD_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB}"
  ui_runtime="${HERMIE_SIM_RUNTIME:-$(xcrun simctl list runtimes iOS available | awk '/^iOS / { id = $NF } END { print id }')}"
  if [[ -z "$ui_runtime" ]]; then
    echo "No iOS Simulator runtime is installed." >&2
    exit 1
  fi

  # Devices of their own, deleted on the way out whatever happens.
  ui_devices=()
  ui_cleanup() {
    for device in "${ui_devices[@]}"; do
      xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
      xcrun simctl delete "$device" >/dev/null 2>&1 || true
    done
    # The keychain run's device, when both ran: this trap replaces that one.
    if declare -F cleanup >/dev/null; then
      cleanup
    fi
  }
  trap ui_cleanup EXIT

  ui_devices+=("$(xcrun simctl create "Hermie UI tests iPhone $$" "$phone_type" "$ui_runtime")")
  ui_devices+=("$(xcrun simctl create "Hermie UI tests iPad $$" "$pad_type" "$ui_runtime")")

  for device in "${ui_devices[@]}"; do
    for scheme in "${ui_schemes[@]}"; do
      echo "$scheme on a throwaway simulator ($device, $ui_runtime)"
      # Signed ad hoc, as the keychain tests are: no team, profile or certificate.
      xcodebuild test -quiet \
        -project "$native_dir/ios/Hermie.xcodeproj" -scheme "$scheme" \
        -destination "platform=iOS Simulator,id=$device" \
        -derivedDataPath "$derived" \
        CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
    done
  done
  echo "UI tests passed"
fi

if [[ "$ui_mac" == true ]]; then
  "$apple_dir/scripts/generate.sh" macos
  echo "HermieLab UI tests on this Mac; they drive the pointer until they finish"
  xcodebuild test -quiet \
    -project "$native_dir/macos/Hermie.xcodeproj" -scheme HermieLab \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived"
  echo "HermieLab UI tests passed on the Mac"
fi
