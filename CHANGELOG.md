# Changelog

All notable changes to txamcp will be documented in this file.

## [3.5.1] - 2026-06-01

### Fixes
- **Kiro IDE**: Changed to use `txa` command with full path instead of `node` for better compatibility
- Added `getNpmGlobalBinPath()` function to automatically detect npm global bin location
- Kiro now uses `txa.cmd` (Windows) or `txa` (Unix) with full path from npm global bin
- Updated both user config and project config for Kiro IDE

## [3.5.0] - 2026-06-01

### New Features
- **Kiro IDE Support**: Added automatic detection and configuration for Kiro IDE
  - Added Kiro IDE to `getAppPaths()` for user config (`~/.kiro/settings/mcp.json`)
  - Added `getKiroProjectConfig()` to detect project config in current directory (`.kiro/settings/mcp.json`)
  - Updated `setup()` command to configure Kiro with correct format
  - Kiro uses `command: "txa"` instead of `command: "node"` for MCP server

### Improvements
- Enhanced `txa setup` to detect and configure Kiro IDE project configs automatically
- Improved integration summary display with better padding for longer IDE names

## [3.4.0] - 2026-05-21

### Security Fixes
- **CRITICAL**: Fixed path traversal vulnerability (CVE-level)
  - Added `isPathWithinProjectRoot()` function to enforce path containment
  - Added `isAbsolutePath()` function to reject all absolute paths
  - Updated `getAbsolutePath()` to reject ALL absolute paths for security
  - Updated `getAbsolutePathForWrite()` for write operations
  - Fixed `write_file()` to use secure path resolution
  - Fixed `create_directory()` to use secure path resolution
  - Fixed `read_dir()` to use secure path resolution
  - All file tools now enforce project root containment
  - Prevents unauthorized file access outside project directory

### Improvements
- Improved IDE integration - no longer requires `add_root` parameter by default
- Added better logging for root update debugging
- Enhanced error messages with clearer guidance
- Updated README with comprehensive configuration documentation
- Added IDE integration section explaining context parameters

### Documentation
- Added Configuration section to README.md
- Documented environment variables and their usage
- Added Project Root Detection explanation
- Added Advanced Configuration guide
- Added IDE Integration notes

## [3.3.4] - Previous Release
- Previous version with original feature set

---

**Note**: Version 3.5.0 adds Kiro IDE support. Version 3.4.0 includes critical security fixes. All users are strongly recommended to upgrade.
