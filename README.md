Personal AI Assistant, self hosted.

AI SDK v7
AI Elements
OpenAI-Compatible

## Quick Start & CLI Installation

### Linux & macOS
```bash
curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
```

### Windows
```powershell
irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
```

### Management Commands
```bash
yggdrasil status    # Check service health and port (default: 2302)
yggdrasil logs      # Tail system logs
yggdrasil update    # Atomic update with automatic WAL backup & rollback
yggdrasil restart   # Restart background daemon
yggdrasil uninstall # Remove service and application
```

## Built-in Tools

### `image_search`
Autonomous tool for retrieving real, externally hosted images from the web (products, landmarks, people, diagrams, artworks, UI references).
- **Multi-Provider Backend:** Automatic fallback across Exa -> SearXNG -> Firecrawl with quota cooldowns.
- **Contract:** `image_search(query, count?, safe_search?, preferred_domains?, aspect_ratio?, min_width?, min_height?)`
- **Security & Quality:** SSRF protection, loopback/private IP blocking, URL normalization, deduplication, and domain ranking.
- **Rich UI:** Dedicated responsive image gallery with error fallbacks, source attribution badges, and Radix Dialog lightbox zoom.
- **Configuration:** Set `EXA_API_KEY`, `FIRECRAWL_API_KEY`, or `SEARXNG_BASE_URL` in `.env.local` or configure in Settings → Tools.