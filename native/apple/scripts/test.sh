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
#                                                run and deleted after it. The lab's composer
#                                                tests and the onboarding tests run against
#                                                fake gateways started on this Mac for the run
#                                                (node and the workspace needed; without them
#                                                they skip). HERMIE_SIM_PAD_TYPE overrides the
#                                                iPad type (default iPad Pro 11-inch (M5)).
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

# Fake gateways on the host for the UI tests, which the simulator (or the Mac) reaches on
# 127.0.0.1: the lab's composer tests get one that streams slowly enough to be stopped
# (TEST_RUNNER_HERMIE_LAB_GATEWAY), and the onboarding tests an ungated, a token and a
# native-sign-in one (TEST_RUNNER_HERMIE_FAKE_GATEWAY_NONE, _TOKEN, _NATIVE), the browser sign-in test
# one with the staged identity provider (_STAGED), and the chat screen's
# test a token one with history whose replies stream slowly enough to watch and stop
# (TEST_RUNNER_HERMIE_CHAT_GATEWAY, token ui-test-token), and the lab's passkey tests one that
# verifies passkeys (TEST_RUNNER_HERMIE_PASSKEY_GATEWAY, --auth native --passkey). Each listens on a
# port of its own (--port 0, read back from its listening line), and a watchdog takes it down
# when this script's end of its stdin closes. Without node or the workspace the tests that need
# one skip themselves.
fake_gateway_pids=()
fake_gateway_logs=()
fake_gateway_fd=6
start_fake_gateway() {
  local variable="$1"
  shift

  if ! command -v node >/dev/null 2>&1 || [[ ! -f "$repo_dir/node_modules/tsx/package.json" ]]; then
    echo "No fake gateway for $variable (node or the workspace is missing); its UI tests will skip." >&2
    return
  fi

  local log
  log="$(mktemp -t hermie-ui-gateway)"
  fake_gateway_logs+=("$log")
  local watchdog="data:text/javascript,process.stdin.on('end',()=>process.exit(0)).on('error',()=>process.exit(0)).resume();//"
  local fifo
  fifo="$(mktemp -u -t hermie-ui-gateway-stdin)"
  mkfifo "$fifo"
  (cd "$repo_dir" && exec node --import tsx --import "$watchdog" \
    packages/fake-gateway/src/cli.ts --port 0 "$@" <"$fifo" >"$log" 2>&1) &
  fake_gateway_pids+=("$!")
  # The write end, held by this script for the gateway's whole life.
  fake_gateway_fd=$((fake_gateway_fd + 1))
  eval "exec ${fake_gateway_fd}>\"\$fifo\""
  rm -f "$fifo"

  local url=""
  for _ in $(seq 1 300); do
    url="$(sed -n 's/^fake gateway listening on \(http[^ ]*\).*/\1/p' "$log" | head -n 1)"
    [[ -n "$url" ]] && break
    sleep 0.1
  done

  if [[ -z "$url" ]]; then
    echo "The fake gateway for $variable did not start:" >&2
    cat "$log" >&2
    exit 1
  fi

  export "TEST_RUNNER_$variable=$url"
  echo "Fake gateway for $variable on $url"
}
stop_fake_gateways() {
  local fd
  for ((fd = 7; fd <= fake_gateway_fd; fd++)); do
    eval "exec ${fd}>&-" 2>/dev/null || true
  done
  fake_gateway_fd=6
  for pid in "${fake_gateway_pids[@]+"${fake_gateway_pids[@]}"}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  fake_gateway_pids=()
  for log in "${fake_gateway_logs[@]+"${fake_gateway_logs[@]}"}"; do
    rm -f "$log"
  done
  fake_gateway_logs=()
}

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
    stop_fake_gateways
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

  start_fake_gateway HERMIE_LAB_GATEWAY --stream-delay 120
  start_fake_gateway HERMIE_FAKE_GATEWAY_NONE --auth none
  start_fake_gateway HERMIE_FAKE_GATEWAY_TOKEN --auth token --token ui-test-token
  start_fake_gateway HERMIE_FAKE_GATEWAY_NATIVE --auth native
  start_fake_gateway HERMIE_FAKE_GATEWAY_STAGED --auth native --idp staged
  start_fake_gateway HERMIE_CHAT_GATEWAY --auth token --token ui-test-token --stream-delay 500 --history-rows 40
  start_fake_gateway HERMIE_PASSKEY_GATEWAY --auth native --passkey

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
  stop_fake_gateways
  echo "UI tests passed"
fi

if [[ "$ui_mac" == true ]]; then
  "$apple_dir/scripts/generate.sh" macos
  start_fake_gateway HERMIE_LAB_GATEWAY --stream-delay 120
  trap stop_fake_gateways EXIT
  echo "HermieLab UI tests on this Mac; they drive the pointer until they finish"
  xcodebuild test -quiet \
    -project "$native_dir/macos/Hermie.xcodeproj" -scheme HermieLab \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived"
  echo "HermieLab UI tests passed on the Mac"
fi
