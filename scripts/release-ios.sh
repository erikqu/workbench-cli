#!/usr/bin/env bash
# Run on a Mac with Xcode, XcodeGen, fastlane, and an Apple distribution identity.
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  cat <<'EOF'
Usage: scripts/release-ios.sh [--upload]

Archive and export a signed iPhone build. --upload sends the IPA to TestFlight.
Required: APPLE_TEAM_ID, APPLE_BUNDLE_ID, APPLE_PROFILE_UUID, APPLE_KEYCHAIN_PATH.
For upload: APP_STORE_CONNECT_API_KEY_PATH (fastlane API-key JSON).
Optional: WORKBENCH_RELAY_URL, WORKBENCH_BUILD_NUMBER, RELEASE_TAG.
The certificate and provisioning profile must already be installed.
EOF
  exit 0
fi
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --upload ) ]] || { echo "Use --help for usage" >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo "Signed iPhone builds require macOS and Xcode" >&2; exit 1; }
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}"
: "${APPLE_BUNDLE_ID:?Set APPLE_BUNDLE_ID}"
: "${APPLE_PROFILE_UUID:?Set APPLE_PROFILE_UUID}"
: "${APPLE_KEYCHAIN_PATH:?Set APPLE_KEYCHAIN_PATH}"
workbench_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workbench_remote="$workbench_root/apps/remote"
workbench_output="$workbench_root/release/ios"
workbench_build="${WORKBENCH_BUILD_NUMBER:-1}"
[[ "$workbench_build" =~ ^[0-9]+$ ]] || { echo "Build number must be an integer" >&2; exit 2; }
node "$workbench_root/scripts/version.mjs" --check
mkdir -p "$workbench_output"
(
  cd "$workbench_remote"
  xcodegen generate --spec apple/project.yml
)
xcodebuild \
  -project "$workbench_remote/apple/WorkbenchRemote.xcodeproj" \
  -scheme WorkbenchRemote -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$workbench_output/Workbench.xcarchive" \
  -derivedDataPath "$workbench_output/build" \
  -skipPackagePluginValidation \
  "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" \
  "PRODUCT_BUNDLE_IDENTIFIER=$APPLE_BUNDLE_ID" \
  "CODE_SIGN_STYLE=Manual" "CODE_SIGN_IDENTITY=Apple Distribution" \
  "PROVISIONING_PROFILE_SPECIFIER=$APPLE_PROFILE_UUID" \
  "OTHER_CODE_SIGN_FLAGS=--keychain $APPLE_KEYCHAIN_PATH" \
  "CURRENT_PROJECT_VERSION=$workbench_build" \
  "WORKBENCH_RELAY_URL=${WORKBENCH_RELAY_URL:-}" \
  "WORKBENCH_AUTH_MODE=apple" archive
WORKBENCH_EXPORT_OPTIONS="$workbench_output/ExportOptions.plist" python3 - <<'PY'
import os, plistlib
with open(os.environ["WORKBENCH_EXPORT_OPTIONS"], "wb") as f:
    plistlib.dump({
        "method": "app-store-connect",
        "destination": "export",
        "signingStyle": "manual",
        "teamID": os.environ["APPLE_TEAM_ID"],
        "provisioningProfiles": {os.environ["APPLE_BUNDLE_ID"]: os.environ["APPLE_PROFILE_UUID"]},
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }, f)
PY
xcodebuild -exportArchive \
  -archivePath "$workbench_output/Workbench.xcarchive" \
  -exportPath "$workbench_output/export" \
  -exportOptionsPlist "$workbench_output/ExportOptions.plist"
workbench_ipa="$workbench_output/export/WorkbenchRemote.ipa"
[[ -f "$workbench_ipa" ]] || { echo "Export did not produce WorkbenchRemote.ipa" >&2; exit 1; }
if [[ "${1:-}" == --upload ]]; then
  : "${APP_STORE_CONNECT_API_KEY_PATH:?Set APP_STORE_CONNECT_API_KEY_PATH}"
  fastlane pilot upload --ipa "$workbench_ipa" \
    --app_identifier "$APPLE_BUNDLE_ID" \
    --api_key_path "$APP_STORE_CONNECT_API_KEY_PATH" \
    --skip_waiting_for_build_processing true
  echo "Uploaded to App Store Connect. Processing and external beta approval still need verification."
else
  printf 'Signed iPhone archive exported to %s\n' "$workbench_ipa"
fi
