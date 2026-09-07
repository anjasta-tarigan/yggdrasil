# install.ps1 - Windows PowerShell Bootstrap Installer for Yggdrasil
#
# Two modes:
#   1. Default: resolves the latest GitHub release (or $env:YGGDRASIL_VERSION),
#      downloads the release-asset copy of this script plus its .sha256
#      companion, verifies it with Get-FileHash, and runs the verified copy.
#      This self-verification trampoline guards against a tampered copy of
#      this script being served to the user (Codecov-style supply-chain attack).
#   2. -Verified (set by phase 1 on the downloaded copy, or via
#      $env:YGGDRASIL_CHANNEL = "main" for development installs tracking main):
#      checks prerequisites, clones the repo, builds it, and hands off to
#      the CLI installer.
#
# Usage: irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
#        (or: .\install.ps1 [-TargetDir <dir>])

param (
    [string]$TargetDir = "$env:USERPROFILE\.yggdrasil",
    [switch]$Verified
)

$ErrorActionPreference = "Stop"

$GithubOwnerRepo = "anjasta-tarigan/yggdrasil"
$LatestApiUrl = "https://api.github.com/repos/$GithubOwnerRepo/releases/latest"
$AssetBaseUrl = "https://github.com/$GithubOwnerRepo/releases/download"

if (-not $Verified -and $env:YGGDRASIL_CHANNEL -ne "main") {
    # --- Phase 1: verify this installer against the published release. ------
    # YGGDRASIL_VERSION pins a specific release tag; default is "latest".
    $version = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else {
        Write-Host "[Yggdrasil] Resolving latest release..."
        try {
            (Invoke-RestMethod -Uri $LatestApiUrl).tag_name
        } catch {
            Write-Error "Could not resolve the latest Yggdrasil release. Set YGGDRASIL_VERSION=<tag> to pin one."
            exit 1
        }
    }
    if (-not $version) {
        Write-Error "Could not resolve the latest Yggdrasil release. Set YGGDRASIL_VERSION=<tag> to pin one."
        exit 1
    }
    Write-Host "[Yggdrasil] Using release $version."

    $scriptPath = Join-Path $env:TEMP "yggdrasil-install.ps1"
    $hashPath = Join-Path $env:TEMP "yggdrasil-install.ps1.sha256"

    Write-Host "[Yggdrasil] Downloading installer and checksum for $version..."
    try {
        Invoke-WebRequest -Uri "$AssetBaseUrl/$version/install.ps1" -OutFile $scriptPath
        Invoke-WebRequest -Uri "$AssetBaseUrl/$version/install.ps1.sha256" -OutFile $hashPath
    } catch {
        Write-Error "Failed to download install.ps1 from release $version."
        exit 1
    }

    # The .sha256 companion is "<hex digest>  install.ps1" (sha256sum format).
    $expectedHash = (Get-Content $hashPath).Trim().Split(" ")[0]
    $actualHash = (Get-FileHash -Path $scriptPath -Algorithm SHA256).Hash.ToLower()
    if ($expectedHash.ToLower() -ne $actualHash) {
        Write-Error "ERROR: Checksum verification failed for Yggdrasil installer! Aborting."
        exit 1
    }
    Write-Host "[Yggdrasil] Checksum verified."

    # -Verified is consumed here, never forwarded to the CLI installer.
    & $scriptPath -TargetDir $TargetDir -Verified
    exit $LASTEXITCODE
}

# --- Phase 2: verified installer (direct flow). -----------------------------
Write-Host "[Yggdrasil] Checking system prerequisites..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required but not installed."
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (>=20.9.0) is required but not installed."
    exit 1
}

# Node >= 20.9.0: parse major.minor and compare numerically.
$nodeVersion = (node --version).TrimStart("v") # e.g. 20.9.0
$nodeParts = $nodeVersion.Split(".")
if ([int]$nodeParts[0] -lt 20 -or ([int]$nodeParts[0] -eq 20 -and [int]$nodeParts[1] -lt 9)) {
    Write-Error "Node.js (>=20.9.0) is required but not installed."
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[Yggdrasil] pnpm not found. Attempting corepack enable pnpm..."
    try {
        corepack enable pnpm
    } catch {
        Write-Error "Failed to enable pnpm via corepack. Please install pnpm."
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$appDir = Join-Path $TargetDir "app"

if (-not (Test-Path (Join-Path $appDir ".git"))) {
    Write-Host "[Yggdrasil] Cloning repository to $appDir..."
    git clone --branch main "https://github.com/$GithubOwnerRepo.git" $appDir
} else {
    Write-Host "[Yggdrasil] Existing repository detected at $appDir."
}

Set-Location $appDir
pnpm install --frozen-lockfile
pnpm build

Write-Host "[Yggdrasil] Running CLI installer..."
node bin\yggdrasil.mjs install --dir $TargetDir
