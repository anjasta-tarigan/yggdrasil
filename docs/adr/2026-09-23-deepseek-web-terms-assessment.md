# ADR: DeepSeek Web Provider Terms of Use & Account Risk Assessment

**Date:** 2026-09-23
**Status:** Approved for Experimental Prototype
**Decision Owner:** Project Lead
**Jurisdiction:** Self-hosted / Local development
**Account Type:** Operator-controlled personal testing account
**Source URLs:** https://chat.deepseek.com/, https://www.deepseek.com/terms
**Retrieval Date:** 2026-09-23

## Context & Assessment

Yggdrasil proposes an experimental integration with the DeepSeek consumer web interface using user-imported session tokens. Under DeepSeek's Terms of Use (retrieved September 2026), automated access without an official API key is restricted.

## Decision

1. **Experimental Scope Only:** The feature is approved solely for operator-mediated local experimentation in single-user environments.
2. **Explicit Consent Required:** The operator must explicitly provide their own session token and acknowledge the experimental nature and account risk.
3. **No Automation/Scraping:** The software strictly forbids automated browser credential harvesting, CAPTCHA bypass, and automated session refreshing.
4. **Kill Switch:** If DeepSeek enforces technical account restrictions, the feature remains disabled by default via `YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS=false`.

## Residual Risks & Approver

- **Residual Risk:** Upstream account rate-limiting, temporary suspension, or session revocation by DeepSeek.
- **Risk Owner:** Operator deploying the self-hosted instance.
- **Approver:** Operator Consent Recorded in Git History (Project Lead).
