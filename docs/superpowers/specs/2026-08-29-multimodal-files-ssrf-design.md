# Architectural Specification: Multimodal File Ingestion, Content Understanding & Secure URL Fetching (AI SDK v7)

**Date:** 2026-08-29  
**Status:** Approved  
**Authors:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification defines the architecture for:
1. **Universal Multimodal File Understanding**: An adaptive processing pipeline that ensures AI models can "read and see" all uploaded content. Images are routed as native multimodal vision parts to vision models, while source code, configuration files, documents, and data sheets are decoded on the server into structured syntax blocks (`[Attached File: name]`) so text and code models can analyze them reliably.
2. **Secure URL Fetching & SSRF Protection**: A defense-in-depth security layer conforming to Rule 04 (OWASP A10) that validates protocols, resolves DNS, blocks private/loopback/cloud metadata IP ranges, enforces response size limits, and secures AI SDK v7's `experimental_download` and `fetch_page` tools.

---

## 2. Universal File Ingestion & Model Understanding

### 2.1 File Ingestion Categories
- **Visual Media (`image/*`)**:
  - MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
  - Processed as native `type: "file"` parts in `UIMessage`.
  - Converted via `convertToModelMessages()` to base64 image parts for multimodal vision models (Claude 3.7 Sonnet, GPT-4o, Gemini 2.5, Ollama LLaVA/Qwen-VL).
- **Code & Text Documents**:
  - MIME types: `text/*`, `application/json`, `application/javascript`, `application/typescript`, `application/xml`, or matching file extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.json`, `.csv`, `.md`, `.txt`, `.yaml`, `.yml`, `.sql`, `.env`).
  - Decoded from data URLs into UTF-8 text on the server.
  - Injected as structured contextual code blocks in the user message payload:
    ```markdown
    [Attached File: src/server.ts (application/typescript)]
    ```typescript
    ...file content...
    ```
    ```
- **PDF Documents (`application/pdf`)**:
  - Sent as native document parts to providers supporting document input, with text extraction fallback for OpenAI-compatible endpoints.

### 2.2 Server-Side Adaptive Message Processor (`src/lib/ai/attachments.ts`)
- `processIncomingMessageAttachments(messages: UIMessage[]): Promise<UIMessage[]>`:
  - Scans user messages for `type: "file"` parts.
  - Extracts text/code files from data URLs (`data:text/...;base64,...`) into markdown blocks.
  - Retains image parts for vision decoding.
  - Updates character and token count estimates accurately in `estimateMessageTokens()`.

---

## 3. Secure URL Fetching & SSRF Defense (`src/lib/security/ssrf.ts`)

Conforms strictly to **Rule 04 (§1.10 SSRF Prevention)**.

### 3.1 DNS & IP Blacklisting
- Resolves hostnames to IP addresses using `node:dns/promises`.
- Rejects non-public IPs:
  - **Loopback**: `127.0.0.0/8`, `::1`, `localhost`
  - **Cloud Metadata**: `169.254.169.254`, `metadata.google.internal`
  - **Private IPv4**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - **Private IPv6**: `fc00::/7`, `fe80::/10`

### 3.2 Secure Fetch Handler (`secureFetch`)
- Enforces protocol allowlist (`http:`, `https:` only).
- Enforces a 10MB response size ceiling.
- Enforces 10-second timeout with `AbortSignal.timeout(10000)`.
- Inspects and re-validates destination IP on HTTP 3xx redirects to prevent intranet bypasses.

### 3.3 Integration Points
- `fetch_page` tool in `src/lib/ai/tools.ts`.
- AI SDK v7 `experimental_download` hook in `streamText`.

---

## 4. UI Enhancements

- **Prompt Input Screenshot Capture**: Wire `<PromptInputActionAddScreenshot>` in `<PromptInputTools>` to capture screen regions via `navigator.mediaDevices.getDisplayMedia`.
- **Staged File Previews**: Live preview thumbnails with file size and remove buttons in the prompt bar.

---

## 5. Testing & Quality Verification

1. **Unit Tests**:
   - `src/lib/security/__tests__/ssrf.test.ts`: Verify rejection of localhost, 127.0.0.1, 169.254.169.254, private IP ranges, and protocol validation.
   - `src/lib/ai/__tests__/attachments.test.ts`: Verify server-side decoding of code/text files from data URLs into syntax-highlighted blocks.
2. **Regression Gate**:
   - 100% pass across all 61+ existing test suites.
   - Zero TypeScript errors (`pnpm tsc --noEmit`).
