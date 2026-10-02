#!/usr/bin/env bash
# Runs the HermieKit tests.
#
#   native/apple/scripts/test.sh                 swift test
#   native/apple/scripts/test.sh --filter Core   anything after the options goes to swift test
#   native/apple/scripts/test.sh --apps          also generate both projects and build both apps
#                                                unsigned (iOS Simulator and macOS)

set -euo pipefail

apple_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$(cd "$apple_dir/.." && pwd)"

build_apps=false
if [[ "${1:-}" == "--apps" ]]; then
  build_apps=true
  shift
fi

swift test --package-path "$apple_dir/HermieKit" "$@"

if [[ "$build_apps" == true ]]; then
  "$apple_dir/scripts/generate.sh"
  derived="$apple_dir/DerivedData"
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
