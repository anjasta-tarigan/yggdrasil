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