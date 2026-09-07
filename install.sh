#!/usr/bin/env bash
# install.sh - POSIX Verified Bootstrap Installer for Yggdrasil
#
# Two modes:
#   1. Default (no --verified): resolves the latest GitHub release (or
#      $YGGDRASIL_VERSION), downloads the release-asset copy of this script
#      plus its .sha256 companion, verifies it, and execs the verified copy.
#      This self-verification trampoline guards against a tampered copy of
#      this script being served to the user (Codecov-style supply-chain attack).
#   2. --verified (set by phase 1 on the downloaded copy, or via
#      YGGDRASIL_CHANNEL=main for development installs tracking main):
#      checks prerequisites, clones the repo, builds it, and hands off to
#      the CLI installer.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
#        (or: ./install.sh [TARGET_DIR])
set -euo pipefail

GITHUB_OWNER_REPO="anjasta-tarigan/yggdrasil"
LATEST_API_URL="https://api.github.com/repos/${GITHUB_OWNER_REPO}/releases/latest"
ASSET_BASE_URL="https://github.com/${GITHUB_OWNER_REPO}/releases/download"
SCRIPT_NAME="install.sh"
CHECKSUM_NAME="install.sh.sha256"

abort() {
  echo "ERROR: $*" >&2
  exit 1
}

# --- Phase boundary: --verified marks a checksum-verified payload. ----------
IS_VERIFIED="false"
for arg in "$@"; do
  [ "$arg" = "--verified" ] && IS_VERIFIED="true"
done

if [ "$IS_VERIFIED" = "false" ] && [ "${YGGDRASIL_CHANNEL:-}" != "main" ]; then
  # --- Phase 1: verify this installer against the published release. -------
  # YGGDRASIL_VERSION pins a specific release tag; default is "latest".
  VERSION="${YGGDRASIL_VERSION:-}"
  if [ -z "$VERSION" ]; then
    echo "[Yggdrasil] Resolving latest release..."
    VERSION="$(curl -fsSL "${LATEST_API_URL}" \
      | grep '"tag_name":' \
      | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
    [ -n "$VERSION" ] || abort "Could not resolve the latest Yggdrasil release. Set YGGDRASIL_VERSION=<tag> to pin one."
  fi
  echo "[Yggdrasil] Using release ${VERSION}."

  TMP_DIR="$(mktemp -d)"
  # mktemp dir is 0700; checksum files are not secrets, but keep the dir tight.
  trap 'rm -rf "$TMP_DIR"' EXIT

  SCRIPT_PATH="${TMP_DIR}/${SCRIPT_NAME}"
  CHECKSUM_PATH="${TMP_DIR}/${CHECKSUM_NAME}"

  echo "[Yggdrasil] Downloading installer and checksum for ${VERSION}..."
  curl -fsSL "${ASSET_BASE_URL}/${VERSION}/${SCRIPT_NAME}" -o "$SCRIPT_PATH" \
    || abort "Failed to download ${SCRIPT_NAME} from release ${VERSION}."
  curl -fsSL "${ASSET_BASE_URL}/${VERSION}/${CHECKSUM_NAME}" -o "$CHECKSUM_PATH" \
    || abort "Failed to download ${CHECKSUM_NAME} from release ${VERSION}."

  # The .sha256 companion references the plain script name, so verify inside
  # the temp dir. sha256sum (Linux) with shasum fallback (macOS).
  if ! (cd "$TMP_DIR" && (sha256sum -c "$CHECKSUM_NAME" 2>/dev/null || shasum -a 256 -c "$CHECKSUM_NAME")); then
    abort "Checksum verification failed for Yggdrasil installer! Aborting."
  fi
  echo "[Yggdrasil] Checksum verified."

  # Pass every original argument plus the verified flag; --verified is consumed
  # here, never forwarded to the CLI installer.
  PASSTHRU_ARGS=()
  for arg in "$@"; do
    [ "$arg" = "--verified" ] || PASSTHRU_ARGS+=("$arg")
  done

  bash "$SCRIPT_PATH" --verified "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
  exit $?
fi

# --- Phase 2: verified installer (brief's direct flow). --------------------
DEFAULT_DIR="$HOME/.yggdrasil"
REPO_URL="https://github.com/${GITHUB_OWNER_REPO}.git"

# Drop --verified; collect the target dir (first positional) and pass the
# remaining arguments through to the CLI installer.
TARGET_DIR="$DEFAULT_DIR"
TARGET_DIR_SET="false"
PASSTHRU_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--verified" ]; then
    continue
  elif [ "$TARGET_DIR_SET" = "false" ] && [ "${arg:0:1}" != "-" ]; then
    TARGET_DIR="$arg"
    TARGET_DIR_SET="true"
  else
    PASSTHRU_ARGS+=("$arg")
  fi
done

echo "[Yggdrasil] Checking system prerequisites..."
command -v git >/dev/null 2>&1 || { echo "Git is required but not installed." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js (>=20.9.0) is required but not installed." >&2; exit 1; }

# Node >= 20.9.0: parse major/minor and compare numerically (sh, not awk).
NODE_VERSION="$(node --version)" # e.g. v20.9.0 -> v20.9.0
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="${NODE_VERSION#v}"
NODE_MINOR="${NODE_MINOR#*.}"
NODE_MINOR="${NODE_MINOR%%.*}"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 9 ]; }; then
  echo "Node.js (>=20.9.0) is required but not installed." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[Yggdrasil] pnpm not found. Attempting corepack enable pnpm..."
  corepack enable pnpm || { echo "Failed to enable pnpm via corepack. Please install pnpm." >&2; exit 1; }
fi

mkdir -p "$TARGET_DIR"
APP_DIR="$TARGET_DIR/app"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[Yggdrasil] Cloning repository to $APP_DIR..."
  git clone --branch main "$REPO_URL" "$APP_DIR"
else
  echo "[Yggdrasil] Existing repository detected at $APP_DIR."
fi

cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build

echo "[Yggdrasil] Running CLI installer..."
exec node bin/yggdrasil.mjs install --dir "$TARGET_DIR" "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
