# Security Policy

Yggdrasil runs on your machine and holds your conversations, embeddings, and
API keys. Security reports about any part of that trust boundary are welcome
and taken seriously.

## Supported versions

Security fixes are applied to the current release line and communicated
through GitHub releases. Always update to the newest release before
reporting — `yggdrasil check-update` shows whether one exists without
downloading anything.

| Version | Status |
| :--- | :--- |
| Latest release (currently 0.6.x) | Supported |
| Older releases | Not supported; each update command rolls back safely, so upgrading is low risk |

The pre-release `development` branch changes frequently. Issues found there
are still in scope, but fixes land on the release line first.

## How to report

**Please do not open a public issue for something you believe is a
vulnerability.** Use GitHub's private vulnerability reporting instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, how you found it, and how to reproduce it.

If your GitHub account cannot use private reporting, email the address in the
repository owner's GitHub profile and mention "Yggdrasil security" in the
subject. For anything urgent that risks real user data, prefer the private
form and wait for an acknowledgment before any public discussion.

Please include only what is needed to reproduce the report. Never send real
API keys, your `APP_SECRET` or `.env` contents, or your `yggdrasil.db` — reproduce
against a scratch install instead.

## What happens next

1. **Acknowledgment** within about seven days of the report.
2. **Triage and a proposed fix**, with an estimated release if the issue is
   accepted.
3. **Coordinated disclosure.** The fix ships in a release first; a GitHub
   security advisory follows. Credit is given in the advisory and release
   notes unless you prefer to stay anonymous.

## Scope

In scope:

- The bootstrap installers (`install.sh`, `install.ps1`) and their
  self-verification against published SHA-256 checksums.
- The application's network surface: API routes, CSRF and rate limiting,
  SSRF defenses in outbound fetchers, and the DeepSeek web-session adapter.
- Credential handling: `APP_SECRET`, HKDF key derivation, AES-256-GCM at-rest
  encryption, and the `providers.secrets.env` / models storage under
  `~/.yggdrasil`.
- The service lifecycle CLI (`yggdrasil` commands), including file
  permissions on the `.env` files it writes.

Out of scope, unless chained to an in-scope issue:

- Attacks that require you to already be the compromised operator or to
  modify an installed checkout.
- Vulnerabilities in dependencies that are fixed in their upstream releases
  and reachable only through normal dependency updates. Report those
  upstream first, then notify us if a pinned version needs replacing.
- Anything about third-party model providers or their endpoints that does
  not involve Yggdrasil's own handling of them.

## Design invariants, for context

Reports often overlap invariants this project intends to hold. The current
ones, which the installer and CI cover: verified installer distribution with
CI-generated checksums, HTTPS-only downloads, AES-256-GCM credential
encryption, SSRF rejection of loopback/RFC 1918/metadata addresses, strict
Origin and Referer checks plus sliding-window rate limits on mutating routes,
and shell and file tools that stay disabled until the operator enables them.

## Safe harbor

Research done in good faith against your own installation — not other
people's machines and not the project's own infrastructure — and reported
through the private flow above will not be pursued as a violation of the
license.
