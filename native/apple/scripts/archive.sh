#!/usr/bin/env bash
# Archives a native app and exports it for App Store Connect.
#
#   native/apple/scripts/archive.sh ios <outdir>              an .ipa
#   native/apple/scripts/archive.sh macos <outdir>            a .pkg
#   native/apple/scripts/archive.sh ios <outdir> --upload     the same, then validate and upload it
#
# Nothing here names an account. It all comes from the environment:
#
#   HERMIE_TEAM_ID              required. The Apple Developer team that signs.
#   HERMIE_ASC_KEY_ID           an App Store Connect API key id and its issuer id. --upload
#   HERMIE_ASC_ISSUER_ID        needs both; set one, set both.
#   HERMIE_ASC_KEY_PATH         optional. The key's .p8 file. Defaults to where altool looks:
#                               ~/.appstoreconnect/private_keys/AuthKey_<HERMIE_ASC_KEY_ID>.p8,
#                               and the file has to keep that AuthKey_<id>.p8 name.
#   HERMIE_ASC_SIGN_WITH_KEY=1  optional. Sign with the API key instead of the account
#                               signed in to Xcode, for a Mac with no Xcode account.
#
# Signing is automatic, with -allowProvisioningUpdates: profiles and certificates
# that are missing are created on the developer portal by whoever is authenticated.
# That is the account signed in to Xcode unless HERMIE_ASC_SIGN_WITH_KEY=1, because
# the export signs with a cloud-managed distribution certificate, and only an
# Account Holder or Admin may use those: a key with the App Manager role, which is
# enough to upload, archives fine and then fails the export with "Cloud signing
# permission error". Sign with a key only when it has the Admin role.
#
# The version is MARKETING_VERSION in native/apple/Config/Version.xcconfig; the
# build number is the git commit count, written by generate.sh. Archive from a
# committed tree, or the build number and the commit in the About line describe
# a tree that does not exist. docs/release.md has the rest.

set -euo pipefail

apple_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$(cd "$apple_dir/.." && pwd)"

usage() {
  echo "usage: native/apple/scripts/archive.sh ios|macos <outdir> [--upload]" >&2
  exit 2
}

fail() {
  echo "archive.sh: $*" >&2
  exit 1
}

platform="${1:-}"
out_arg="${2:-}"
upload=false
case "$platform" in
  ios | macos) ;;
  *) usage ;;
esac
[[ -n "$out_arg" && "$out_arg" != --* ]] || usage
if [[ $# -gt 2 ]]; then
  [[ "$3" == "--upload" && $# -eq 3 ]] || usage
  upload=true
fi

# Every check that can fail does so before anything is built: an archive takes
# minutes, and a missing variable should not cost them.
[[ -n "${HERMIE_TEAM_ID:-}" ]] || fail "HERMIE_TEAM_ID is not set. Export the Apple Developer team id that signs the app."

key_id="${HERMIE_ASC_KEY_ID:-}"
issuer_id="${HERMIE_ASC_ISSUER_ID:-}"
if [[ -n "$key_id" && -z "$issuer_id" ]] || [[ -z "$key_id" && -n "$issuer_id" ]]; then
  fail "set HERMIE_ASC_KEY_ID and HERMIE_ASC_ISSUER_ID together, or neither."
fi
if [[ "$upload" == true && -z "$key_id" ]]; then
  fail "--upload needs an App Store Connect API key: set HERMIE_ASC_KEY_ID and HERMIE_ASC_ISSUER_ID."
fi

sign_with_key="${HERMIE_ASC_SIGN_WITH_KEY:-0}"
if [[ "$sign_with_key" == 1 && -z "$key_id" ]]; then
  fail "HERMIE_ASC_SIGN_WITH_KEY=1 needs HERMIE_ASC_KEY_ID and HERMIE_ASC_ISSUER_ID."
fi

auth_args=()
if [[ -n "$key_id" ]]; then
  key_path="${HERMIE_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${key_id}.p8}"
  [[ -f "$key_path" ]] || fail "no API key file at $key_path. Set HERMIE_ASC_KEY_PATH to the .p8 file."
  [[ "$(basename "$key_path")" == "AuthKey_${key_id}.p8" ]] ||
    fail "the key file must be named AuthKey_${key_id}.p8; altool finds it by that name."
  if [[ "$sign_with_key" == 1 ]]; then
    auth_args=(-authenticationKeyPath "$key_path" -authenticationKeyID "$key_id" -authenticationKeyIssuerID "$issuer_id")
  fi
fi

command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild is not installed. Install Xcode 26 or newer."

if [[ -n "$(git -C "$native_dir" status --porcelain 2>/dev/null)" ]]; then
  echo "archive.sh: warning: the working tree has uncommitted changes; the build number and commit name HEAD, not what is built." >&2
fi

mkdir -p "$out_arg"
out_dir="$(cd "$out_arg" && pwd)"
archive="$out_dir/Hermie-$platform.xcarchive"
export_dir="$out_dir/export-$platform"
options="$out_dir/ExportOptions-$platform.plist"

case "$platform" in
  ios)
    destination='generic/platform=iOS'
    product_ext=ipa
    altool_type=ios
    ;;
  macos)
    destination='generic/platform=macOS'
    product_ext=pkg
    altool_type=macos
    ;;
esac

"$apple_dir/scripts/generate.sh" "$platform"

echo "Archiving Hermie for $platform into $archive"
rm -rf "$archive" "$export_dir"
# The archive is signed for development, which on a Mac means this machine has
# to be on the team's device list: -allowProvisioningDeviceRegistration adds it
# on the first archive instead of failing. The export re-signs for distribution.
xcodebuild archive -quiet \
  -project "$native_dir/$platform/Hermie.xcodeproj" -scheme Hermie -configuration Release \
  -destination "$destination" -archivePath "$archive" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${auth_args[@]+"${auth_args[@]}"} \
  DEVELOPMENT_TEAM="$HERMIE_TEAM_ID"
[[ -d "$archive" ]] || fail "xcodebuild archive finished without writing $archive."

# The app embeds its extensions (the widgets and the share extension), which the
# archive signs along with it: the scheme builds them as the app's dependencies,
# and DEVELOPMENT_TEAM above applies to every target. They take MARKETING_VERSION
# and the build number from the same Config/Shared.xcconfig as the app, and App
# Store Connect rejects a build whose extension disagrees with its app, so check
# both here rather than after an upload.
case "$platform" in
  ios)
    app_bundle="$archive/Products/Applications/Hermie.app"
    plugins="$app_bundle/PlugIns"
    app_info="$app_bundle/Info.plist"
    ;;
  macos)
    app_bundle="$archive/Products/Applications/Hermie.app"
    plugins="$app_bundle/Contents/PlugIns"
    app_info="$app_bundle/Contents/Info.plist"
    ;;
esac
app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_info")"
app_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_info")"
for extension in HermieWidgetsExtension HermieShareExtension; do
  appex="$plugins/$extension.appex"
  [[ -d "$appex" ]] || fail "the archive has no $extension.appex in $plugins."
  if [[ "$platform" == macos ]]; then
    appex_info="$appex/Contents/Info.plist"
  else
    appex_info="$appex/Info.plist"
  fi
  appex_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$appex_info")"
  appex_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$appex_info")"
  [[ "$appex_version" == "$app_version" && "$appex_build" == "$app_build" ]] ||
    fail "$extension is $appex_version ($appex_build) but the app is $app_version ($app_build)."
  codesign --verify --strict "$appex" || fail "$extension.appex is not signed."
done

# manageAppVersionAndBuildNumber is false: left to itself the export renumbers
# the build, and the commit count is the build number on purpose.
cat >"$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$HERMIE_TEAM_ID</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST

echo "Exporting for App Store Connect into $export_dir"
xcodebuild -exportArchive -quiet \
  -archivePath "$archive" -exportOptionsPlist "$options" -exportPath "$export_dir" \
  -allowProvisioningUpdates ${auth_args[@]+"${auth_args[@]}"}

product="$export_dir/Hermie.$product_ext"
[[ -f "$product" ]] || fail "the export finished without writing $product."

info="$archive/Info.plist"
version="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$info")"
build="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$info")"
echo "Hermie $version ($build) for $platform: $product"

if [[ "$upload" == true ]]; then
  # altool reads the key from a directory by its AuthKey_<id>.p8 name.
  export API_PRIVATE_KEYS_DIR
  API_PRIVATE_KEYS_DIR="$(dirname "$key_path")"
  # Validation first: a failed validation costs seconds, a rejected upload
  # costs a build number.
  echo "Validating $product"
  xcrun altool --validate-app -f "$product" -t "$altool_type" --apiKey "$key_id" --apiIssuer "$issuer_id"
  echo "Uploading $product"
  xcrun altool --upload-app -f "$product" -t "$altool_type" --apiKey "$key_id" --apiIssuer "$issuer_id"
  echo "Uploaded Hermie $version ($build) for $platform. Processing takes a few minutes to half an hour."
fi
