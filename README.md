# Txa_MCP 🚀

Professional MCP Server & CLI for Local AI Context Management. Part of the [TXA Hub](https://txahub.click) ecosystem.

## Features
- **Project Context Awareness**: Give your AI (Trae, Cursor, Windsurf) deep knowledge of your local files.
- **Enterprise Ready**: Full integration with TXA Hub for tool synchronization.
- **Auto-Config**: One command to configure all your IDEs.
- **Windows Optimized**: Native PowerShell support and high-speed file searching.

## Installation
Install globally via npm:
```bash
npm install -g txamcp
```

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

## Support
Visit [txahub.click](https://txahub.click) or join our community for support.

---
© 2026 TXA Hub Team. Licensed under MIT.