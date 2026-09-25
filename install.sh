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

# Refuse plain HTTP and any redirect that downgrades away from HTTPS, so a
# network attacker cannot swap the installer or its checksum in transit.
CURL_SECURE=(-fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --retry 3)

abort() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || abort "curl is required but not installed. Please install curl."

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
    CURL_AUTH_HDR=()
    if [ -n "${GITHUB_TOKEN:-}" ]; then
      CURL_AUTH_HDR=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    elif [ -n "${GH_TOKEN:-}" ]; then
      CURL_AUTH_HDR=(-H "Authorization: Bearer ${GH_TOKEN}")
    fi
    VERSION="$(curl "${CURL_SECURE[@]}" "${CURL_AUTH_HDR[@]+"${CURL_AUTH_HDR[@]}"}" "${LATEST_API_URL}" 2>/dev/null \
      | grep '"tag_name":' \
      | head -n 1 \
      | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
  fi

  [ -n "$VERSION" ] || abort "Could not resolve the latest Yggdrasil release. Set YGGDRASIL_CHANNEL=main to install from the main branch, or set YGGDRASIL_VERSION=<tag> to pin one."
  echo "[Yggdrasil] Using release ${VERSION}."

  TMP_DIR="$(mktemp -d)"
  # mktemp dir is 0700; checksum files are not secrets, but keep the dir tight.
  trap 'rm -rf "$TMP_DIR"' EXIT

  SCRIPT_PATH="${TMP_DIR}/${SCRIPT_NAME}"
  CHECKSUM_PATH="${TMP_DIR}/${CHECKSUM_NAME}"

  echo "[Yggdrasil] Downloading installer and checksum for ${VERSION}..."
  curl "${CURL_SECURE[@]}" "${ASSET_BASE_URL}/${VERSION}/${SCRIPT_NAME}" -o "$SCRIPT_PATH" \
    || abort "Failed to download ${SCRIPT_NAME} from release ${VERSION}."
  curl "${CURL_SECURE[@]}" "${ASSET_BASE_URL}/${VERSION}/${CHECKSUM_NAME}" -o "$CHECKSUM_PATH" \
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

  export YGGDRASIL_VERSION="${VERSION}"
  bash "$SCRIPT_PATH" --verified "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
  exit $?
fi

# --- Phase 2: verified installer (direct flow). ----------------------------
DEFAULT_DIR="${HOME}/.yggdrasil"
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
command -v git >/dev/null 2>&1 || abort "Git is required but not installed. Please install Git: https://git-scm.com/"
command -v node >/dev/null 2>&1 || abort "Node.js (>=22.13.0) is required but not installed. Please install Node.js: https://nodejs.org/"

# Node >= 22.13.0 (pnpm 11.x loads the node:sqlite builtin): parse major/minor
# and compare numerically (sh, not awk).
NODE_VERSION="$(node --version 2>/dev/null || echo "v0.0.0")"
NODE_NUM="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_NUM%%.*}"
NODE_REST="${NODE_NUM#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ -z "$NODE_MAJOR" ] || [ -z "$NODE_MINOR" ] || [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  abort "Node.js (>=22.13.0) is required, but found ${NODE_VERSION}. Please update Node.js: https://nodejs.org/"
fi
echo "[Yggdrasil] Node.js ${NODE_VERSION} detected."

# Check for pnpm, adding common user paths to PATH first if present
for pnpm_dir in "${HOME}/.local/share/pnpm" "${HOME}/.local/bin" "${HOME}/.pnpm"; do
  if [ -d "$pnpm_dir" ] && [[ ":$PATH:" != *":$pnpm_dir:"* ]]; then
    export PATH="${pnpm_dir}:${PATH}"
  fi
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[Yggdrasil] pnpm not found in PATH. Attempting automatic setup..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm 2>/dev/null || true
  fi
  if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    echo "[Yggdrasil] Installing pnpm globally via npm..."
    npm install -g pnpm 2>/dev/null || npm install --prefix "${HOME}/.local" -g pnpm 2>/dev/null || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    abort "pnpm is required. Please install pnpm (e.g. 'npm install -g pnpm' or 'curl -fsSL https://get.pnpm.io/install.sh | sh -')."
  fi
fi
echo "[Yggdrasil] pnpm $(pnpm --version 2>/dev/null || echo '') ready."

mkdir -p "$TARGET_DIR"
APP_DIR="$TARGET_DIR/app"

# A release install pins the code to the verified release tag; the main channel
# tracks main. `yggdrasil update` moves any install onto main afterwards.
if [ -n "${YGGDRASIL_VERSION:-}" ]; then
  CHECKOUT_REF="${YGGDRASIL_VERSION}"
else
  CHECKOUT_REF="main"
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[Yggdrasil] Cloning ${CHECKOUT_REF} to $APP_DIR..."
  git clone --depth 1 --branch "$CHECKOUT_REF" "$REPO_URL" "$APP_DIR"
elif [ "$CHECKOUT_REF" = "main" ]; then
  echo "[Yggdrasil] Existing repository detected at $APP_DIR. Fetching updates..."
  git -C "$APP_DIR" fetch --depth 1 origin main:refs/remotes/origin/main
  git -C "$APP_DIR" checkout -B main origin/main
else
  echo "[Yggdrasil] Existing repository detected at $APP_DIR. Fetching release ${CHECKOUT_REF}..."
  # `+` force-updates a local tag that a previous run left at another commit.
  git -C "$APP_DIR" fetch --depth 1 origin "+refs/tags/${CHECKOUT_REF}:refs/tags/${CHECKOUT_REF}"
  git -C "$APP_DIR" checkout "$CHECKOUT_REF"
fi

cd "$APP_DIR"

# Allocate sufficient V8 heap ceiling to prevent OOM kills on 1-2GB RAM systems
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
export NODE_ENV="production"

echo "[Yggdrasil] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "[Yggdrasil] Building production Next.js application..."
pnpm build

echo "[Yggdrasil] Running CLI installer..."
exec node bin/yggdrasil.mjs install --dir "$TARGET_DIR" "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
