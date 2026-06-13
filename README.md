# Txa_MCP 🚀

Professional MCP Server & CLI for Local AI Context Management. Part of the [TXA Hub](https://txahub.click) ecosystem.

## Features
- **Project Context Awareness**: Give your AI (Trae, Cursor, Windsurf) deep knowledge of your local files.
- **Enterprise Ready**: Full integration with TXA Hub for tool synchronization.
- **Auto-Config**: One command to configure all your IDEs.
- **Windows Optimized**: Native PowerShell support and high-speed file searching.

## Installation

### Option 1: Install via npm (Recommended)
Install globally via npm:
```bash
npm install -g txamcp
```

### Option 2: Install VS Code Extension
For VS Code, Cursor, Windsurf, and other VS Code-based IDEs, install the official extension:
- **Open VSX**: [https://open-vsx.org/extension/txahub/txamcp-vscode](https://open-vsx.org/extension/txahub/txamcp-vscode)

The extension provides:
- 🎨 Full GUI status monitoring
- 🔐 One-click browser SSO login
- 🔄 Automatic API key synchronization
- 📁 Real-time project root auto-detection

## Quick Start
0. **Account**: Create an account at [txahub.click](https://txahub.click) to get your API Key.
1. **Login**: Authenticate your computer with TXA Hub.
   ```bash
   # Automated browser login
   txa login

   # Or manual API Key login
   txa login --api-key YOUR_API_KEY
   ```
2. **Setup**: Automatically configure your IDEs (Trae, Cursor, etc.).
   ```bash
   txa setup
   ```
3. **Enjoy**: Open your IDE and start using the enhanced AI tools!

## Commands
- `txa login`: Start the automated browser login flow.
- `txa setup`: Configure MCP for all supported IDEs.
- `txa get config`: Display current session & usage stats.
- `txa version`: Show current version info.
- `txa logout`: Terminate local session.

## Configuration

### Project Root Detection
TXAMCP automatically detects your project root by searching for common project markers (`.git`, `package.json`, `pubspec.yaml`, etc.). This works seamlessly with most IDEs without additional configuration.

### Advanced Configuration
For advanced use cases, you can set environment variables:

```bash
# Force explicit project root requirement (not recommended for most users)
export TXAMCP_REQUIRE_ADD_ROOT=1

# Set custom project root
export TXAMCP_PROJECT_ROOT=/path/to/your/project

# Set active file path (IDEs may send this automatically)
export TXAMCP_ACTIVE_FILE=/path/to/current/file
```

**Note**: By default, TXAMCP works automatically with IDEs. Only use `TXAMCP_REQUIRE_ADD_ROOT=1` if you need strict control over project root detection.

### IDE Integration
Most IDEs (Cursor, Windsurf, Trae) automatically send context information like `activeFilePath` or `currentFilePath`. TXAMCP uses this context to dynamically update the project root when needed.

## Support
Visit [txahub.click](https://txahub.click) or join our community for support.

---
© 2026 TXA Hub Team. Licensed under MIT.