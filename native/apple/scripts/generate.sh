#!/usr/bin/env bash
# Generates the Xcode projects from their XcodeGen specs.
#
#   native/apple/scripts/generate.sh            both projects
#   native/apple/scripts/generate.sh ios        native/ios/Hermie.xcodeproj only
#   native/apple/scripts/generate.sh macos      native/macos/Hermie.xcodeproj only
#
# Also writes native/apple/Config/Build.generated.xcconfig with the build
# number (the git commit count) and the short commit hash. Both outputs are
# ignored by git, so running this never dirties the tree. Run it again after
# pulling or committing, so the build number and the About line name the tree
# you are building.

set -euo pipefail

apple_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="$(cd "$apple_dir/.." && pwd)"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is not installed. Install it with: brew install xcodegen" >&2
  exit 1
fi

# Neither value may fail the build: a checkout without git (a tarball, a CI step
# that fetched without history) gets the same fallbacks the Expo app uses.
build_number="$(git -C "$native_dir" rev-list --count HEAD 2>/dev/null || true)"
commit="$(git -C "$native_dir" rev-parse --short HEAD 2>/dev/null || true)"
build_number="${build_number:-1}"
commit="${commit:-dev}"

generated="$apple_dir/Config/Build.generated.xcconfig"
contents="// Written by native/apple/scripts/generate.sh. Do not edit; do not commit.
CURRENT_PROJECT_VERSION = $build_number
HERMIE_COMMIT = $commit"

# Rewritten only when it changed, so an unchanged tree does not invalidate the
# build.
if [[ ! -f "$generated" ]] || [[ "$(cat "$generated")" != "$contents" ]]; then
  printf '%s\n' "$contents" >"$generated"
fi

platforms=("$@")
if [[ ${#platforms[@]} -eq 0 ]]; then
  platforms=(ios macos)
fi

for platform in "${platforms[@]}"; do
  case "$platform" in
    ios | macos) ;;
    *)
      echo "Unknown platform '$platform'; expected ios or macos." >&2
      exit 1
      ;;
  esac
  xcodegen generate --quiet --spec "$native_dir/$platform/project.yml" --project "$native_dir/$platform"
  echo "Generated native/$platform/Hermie.xcodeproj (build $build_number, commit $commit)"
done
