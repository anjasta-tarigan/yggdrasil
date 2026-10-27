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

# Resolves a release tag (e.g. v0.3.7) to its underlying commit SHA.
# The project publishes *annotated* tags (git tag -a), so the tag ref points at a
# tag object rather than a commit, and `git clone --branch <annotated-tag>` fails on
# a shallow clone with "refs/tags/X is not a commit". We ask the GitHub API for the
# commit the tag resolves to (`/commits/<tag>` dereferences annotated tags
# automatically and returns the real commit SHA in one call), then clone by that
# SHA, which always succeeds.
resolve_tag_commit() {
  local tag="$1"
  local sha
  sha="$(curl -fsSL --proto '=https' --connect-timeout 15 --retry 3 \
    -H "User-Agent: yggdrasil-installer" \
    "https://api.github.com/repos/${GITHUB_OWNER_REPO}/commits/${tag}" 2>/dev/null \
    | grep -m1 '"sha"' | head -n1 | sed -E 's/^[^"]*"sha": *"([0-9a-f]+)".*/\1/')" || true
  [ -n "$sha" ] && printf '%s\n' "$sha" && return 0
  return 1
}

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
    VERSION=""
    for attempt in 1 2 3; do
      VERSION="$(curl "${CURL_SECURE[@]}" -H "User-Agent: yggdrasil-installer" "${CURL_AUTH_HDR[@]+"${CURL_AUTH_HDR[@]}"}" "${LATEST_API_URL}" 2>/dev/null \
        | grep '"tag_name":' \
        | head -n 1 \
        | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
      [ -n "$VERSION" ] && break
      sleep 1
    done
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

  # Phase 2 reads YGGDRASIL_VERSION from the environment, so a user pin is
  # inherited by the verified child as-is. Never export the *resolved* tag here:
  # an unpinned install must check out main, not the frozen release tag.
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
command -v node >/dev/null 2>&1 || abort "Node.js (>=24.0.0) is required but not installed. Please install Node.js: https://nodejs.org/"

# Node >= 24.0.0: parse major/minor
# and compare numerically (sh, not awk).
NODE_VERSION="$(node --version 2>/dev/null || echo "v0.0.0")"
NODE_NUM="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_NUM%%.*}"
NODE_REST="${NODE_NUM#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 24 ]; then
  abort "Node.js (>=24.0.0) is required, but found ${NODE_VERSION}. Please update Node.js: https://nodejs.org/"
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

# Resolve the tag to its underlying commit SHA (the project publishes *annotated*
# tags, whose ref points at a tag object, not a commit). Used only to VERIFY the
# checkout. We do NOT clone by SHA: a shallow `git clone --branch <sha>` cannot
# fetch an arbitrary commit that is not a branch tip, failing with "Remote branch
# <sha> not found in upstream origin". Instead we clone the default branch and then
# fetch + checkout the TAG by name (git dereferences annotated tags on checkout).
EXPECTED_SHA="$CHECKOUT_REF"
if [ "$CHECKOUT_REF" != "main" ]; then
  RESOLVED_SHA="$(resolve_tag_commit "$CHECKOUT_REF")"
  [ -n "$RESOLVED_SHA" ] || abort "Could not resolve commit for tag ${CHECKOUT_REF}. The release may have been removed."
  EXPECTED_SHA="$RESOLVED_SHA"
fi

# A prior (failed) install can leave a partial or detached .git behind (e.g. an
# annotated-tag clone that aborted with "refs/tags/X is not a commit" and left a
# detached HEAD). Re-running against that contaminated repo silently reuses the
# broken state. Detect a corrupt local repo and start from scratch.
if [ -d "$APP_DIR/.git" ]; then
  if ! git -C "$APP_DIR" rev-parse HEAD >/dev/null 2>&1; then
    echo "[Yggdrasil] Removing corrupt existing repository at $APP_DIR..."
    rm -rf "$APP_DIR"
  fi
fi

# Clone the default branch first (no -b, since annotated tags can't be cloned
# directly), then fetch the specific tag/branch and check it out by name.
if [ ! -d "$APP_DIR/.git" ]; then
  echo "[Yggdrasil] Cloning ${CHECKOUT_REF} to $APP_DIR..."
  git clone --depth 1 "$REPO_URL" "$APP_DIR"     || abort "git clone failed for ${CHECKOUT_REF}."
fi
if [ "$CHECKOUT_REF" = "main" ]; then
  echo "[Yggdrasil] Checking out main..."
  git -C "$APP_DIR" fetch --depth 1 origin main:refs/remotes/origin/main
  git -C "$APP_DIR" checkout -B main origin/main     || abort "git checkout failed for main."
else
  echo "[Yggdrasil] Fetching release ${CHECKOUT_REF}..."
  git -C "$APP_DIR" fetch --depth 1 origin "refs/tags/${CHECKOUT_REF}"     || abort "git fetch failed for tag ${CHECKOUT_REF}."
  git -C "$APP_DIR" checkout "tags/${CHECKOUT_REF}"     || abort "git checkout failed for ${CHECKOUT_REF}."
fi

# Verify we actually landed on the intended commit. A mismatch means the clone or
# checkout silently diverged (the exact failure mode that left prior installs on a
# detached HEAD with the wrong code); never proceed silently in that case.
if [ "$EXPECTED_SHA" != "main" ]; then
  ACTUAL_HEAD="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ "$ACTUAL_HEAD" != "$EXPECTED_SHA" ]; then
    abort "git checkout landed on ${ACTUAL_HEAD}, expected ${EXPECTED_SHA}."
  fi
fi

cd "$APP_DIR"
export NODE_ENV="production"

# Seed a baseline .env from .env.example immediately after clone. `next build`
# (and the runtime) evaluate src/env.ts, which throws when NODE_ENV=production
# but APP_SECRET is absent. The real secret is generated by `seed-env` below
# (after pnpm install, when the CLI's tsx runtime is available); this copy just
# guarantees .env exists with the standard template before any build step.
if [ ! -f "$TARGET_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$TARGET_DIR/.env" 2>/dev/null || true
fi
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || true
fi

# --- Adaptive resource allocation -------------------------------------------
# Detect available RAM and allocate ~50% as V8 heap ceiling (min 512 MB,
# max 4 GB).  This prevents fixed-heap OOM kills on low-RAM systems while
# avoiding wasteful over-allocation on high-RAM systems.
get_available_ram() {
  if [ -f /proc/meminfo ]; then
    awk '/MemAvailable/ { print int($2 / 1024) }' /proc/meminfo
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.memsize 2>/dev/null | awk '{ print int($1 / 1024 / 1024) }' || echo "0"
  else
    echo "1024"
  fi
}

RAM_MB="$(get_available_ram)"

if [ "$RAM_MB" -lt 512 ]; then
  HEAP_SIZE="512"
  echo "[Yggdrasil] Low system RAM detected (<512 MB). Install may be slow or fail."
elif [ "$RAM_MB" -lt 1024 ]; then
  HEAP_SIZE=$((RAM_MB / 2))
  echo "[Yggdrasil] Low system RAM (<1 GB); using ${HEAP_SIZE} MB heap."
elif [ "$RAM_MB" -lt 4096 ]; then
  HEAP_SIZE=$((RAM_MB / 2))
else
  HEAP_SIZE="2048"
fi

export NODE_OPTIONS="--max-old-space-size=${HEAP_SIZE}"

# Disable Turbopack parallel workers when RAM is scarce.
if [ "$RAM_MB" -lt 2048 ]; then
  export TURBOPACK_WORKERS="1"
  echo "[Yggdrasil] Low RAM; disabling Next.js parallel workers (TURBOPACK_WORKERS=1)."
fi

# --- Build with retry + timeout safeguards ---------------------------------
BUILD_TIMEOUT="${YGGDRASIL_BUILD_TIMEOUT:-1800}"
BUILD_LOG="${TARGET_DIR}/build.log"

build_app() {
  local attempt=1
  local max_attempts=3
  while [ $attempt -le $max_attempts ]; do
    echo "[Yggdrasil] Building Next.js app (attempt $attempt/$max_attempts, ${BUILD_TIMEOUT}s timeout)..."
    if timeout "$BUILD_TIMEOUT" pnpm build 2>&1 | tee "$BUILD_LOG"; then
      echo "[Yggdrasil] Build succeeded."
      return 0
    fi
    local exit_code=${PIPESTATUS[0]}

    if [ $exit_code -eq 124 ]; then
      echo "[Yggdrasil] Build timed out after ${BUILD_TIMEOUT}s."
      abort "Build exceeded ${BUILD_TIMEOUT}s timeout. Set YGGDRASIL_BUILD_TIMEOUT=3600 (or higher) and re-run."
    elif [ $exit_code -eq 143 ]; then
      HEAP_SIZE=$((HEAP_SIZE / 2))
      if [ $HEAP_SIZE -lt 256 ]; then
        echo "[Yggdrasil] Build terminated (OOM/timeout) and heap floor reached."
        abort "Build repeatedly killed (OOM/timeout). See log at ${BUILD_LOG}. Re-run with YGGDRASIL_BUILD_TIMEOUT=3600 or on a machine with more RAM."
      fi
      export NODE_OPTIONS="--max-old-space-size=${HEAP_SIZE}"
      echo "[Yggdrasil] Build terminated; retrying with ${HEAP_SIZE} MB heap..."
    else
      echo "[Yggdrasil] Build failed (exit ${exit_code}). See log at ${BUILD_LOG}."
      abort "Build failed with exit code ${exit_code}. See ${BUILD_LOG} for details."
    fi
    attempt=$((attempt + 1))
  done
  abort "Build failed after ${max_attempts} attempts. See ${BUILD_LOG} for details."
}

echo "[Yggdrasil] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Generate a valid APP_SECRET (and link app/.env) BEFORE the build. `writeEnvFile`
# keeps any existing 64-hex secret, otherwise generates one, so re-installs are
# idempotent. Without this, `pnpm build` aborts on the missing-secret ZodError and
# the later `yggdrasil install` secret step never runs.
echo "[Yggdrasil] Generating environment secret (APP_SECRET)..."
node bin/yggdrasil.mjs seed-env --dir "$TARGET_DIR" "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
[ $? -eq 0 ] || abort "yggdrasil seed-env failed to generate APP_SECRET."

echo "[Yggdrasil] Clearing Next.js build cache..."
rm -rf "$APP_DIR/.next" "$APP_DIR/.turbo"

echo "[Yggdrasil] Building production Next.js application..."
build_app

echo "[Yggdrasil] Running CLI installer..."
exec node bin/yggdrasil.mjs install --dir "$TARGET_DIR" "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"
