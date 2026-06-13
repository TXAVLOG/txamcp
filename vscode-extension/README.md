# Txa MCP — VS Code Extension

[![Open VSX](https://img.shields.io/badge/Open%20VSX-Install-blue?logo=Eclipse%20IDE&logoColor=white)](https://open-vsx.org/extension/txahub/txamcp-vscode)

Professional MCP server integration for AI-powered IDEs.

## Features

- 🔧 **Settings UI** — Configure API key, Hub URL, HTTP gateway and more through VS Code Settings panel
- 🚀 **Auto-start** — MCP server starts automatically when IDE opens
- 📊 **Status Bar** — Real-time server status indicator
- 🧠 **Instructions Auto-Deploy** — Automatically deploys AI guidance to IDE MCP folders
- ⚙️ **Settings Sync** — VS Code settings auto-sync to TXAMCP global config

## Commands

| Command | Description |
|---------|-------------|
| `Txa MCP: Start Server` | Start the MCP server |
| `Txa MCP: Stop Server` | Stop the MCP server |
| `Txa MCP: Restart Server` | Restart the MCP server |
| `Txa MCP: Show Status` | View server status and configuration |
| `Txa MCP: Login to TXAHUB` | Open terminal for `txa login` |
| `Txa MCP: Open TXAHUB Dashboard` | Open dashboard in browser |

## Settings

All settings are available under `Settings > Extensions > Txa MCP`:

| Setting | Description | Default |
|---------|-------------|---------|
| `txamcp.apiKey` | API Key for TXAHUB authentication | _(empty)_ |
| `txamcp.hubUrl` | TXAHUB server URL | `https://txahub.click` |
| `txamcp.autoStartServer` | Auto-start server on IDE launch | `true` |
| `txamcp.enableHttpGateway` | Enable HTTP REST API gateway | `false` |
| `txamcp.httpPort` | HTTP gateway port | `3636` |
| `txamcp.projectRoot` | Override project root path | _(auto-detect)_ |
| `txamcp.requireAddRoot` | Require explicit project root for search tools | `false` |
| `txamcp.logLevel` | Server log verbosity | `info` |

## Installation

### From Open VSX (Recommended)
Install directly from Open VSX Registry:
- **Link**: [https://open-vsx.org/extension/txahub/txamcp-vscode](https://open-vsx.org/extension/txahub/txamcp-vscode)
- **Compatible with**: VS Code, Cursor, Windsurf, Trae, and other VS Code-based IDEs

### From VS Code Marketplace
Search for "Txa MCP — AI Context Management" in the VS Code Extensions marketplace.

### From VSIX (Local)
```bash
cd vscode-extension
npm install
npm run package
# Install the generated .vsix file in your IDE
```

### Prerequisites
- `txamcp` must be installed globally: `npm install -g txamcp`
- Node.js 18+
