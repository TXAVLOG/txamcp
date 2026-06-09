# Changelog

All notable changes to txamcp will be documented in this file.

## [3.5.3] - 2026-06-09

### Security Enhancement - External File Access Control

#### New Feature: `allow_external_access` Parameter
- **Problem**: MCP server blocked all file access outside project root for security
- **Solution**: Added optional `allow_external_access` boolean parameter to file operation tools
- **Behavior**: 
  - Default (`false`): Blocks access outside project root with clear error message
  - When AI sets to `true`: Informs user that explicit approval is required
  - Error message now guides AI: "To access files outside the project, the AI must set 'allow_external_access': true and you must explicitly approve it."

#### Updated Tools (11 tools total):
1. ✅ **read_file** - Read files with external access option
2. ✅ **write_file** - Write files with external access option  
3. ✅ **replace_in_file** - Modify files with external access option
4. ✅ **delete_file** - Delete files with external access option
5. ✅ **create_directory** - Create dirs with external access option
6. ✅ **edit_code** - Edit code with external access option
7. ✅ **quick_search_replace** - Search/replace with external access option
8. ✅ **read_dir** - List directory with external access option
9. ✅ **code_metrics** - Analyze code with external access option
10. ✅ **get_file_info** - Get file info with external access option

#### Path Resolution Functions Updated:
- `getAbsolutePath(receivedPath, allowExternalAccess = false)`
- `getAbsolutePathForWrite(receivedPath, allowExternalAccess = false)`
- Both functions now accept optional `allowExternalAccess` parameter
- Enhanced error messages with actionable guidance for AI

#### User Experience Flow:
```
Before:
AI tries to edit c:\Users\TXA3100\Desktop\soclo-profile\pages\about.html
❌ Error: "Security Error: Path traversal is not allowed"
→ Dead end, AI doesn't know what to do

After:
AI tries WITHOUT flag:
❌ Error: "Security Error: Path ... resolves outside the project root (...). 
          To access files outside the project, the AI must set 'allow_external_access': true 
          and you must explicitly approve it."
→ AI learns it needs to set the flag

AI tries WITH flag (allow_external_access: true):
→ IDE/Client shows approval dialog to user
→ User approves or denies
→ Operation proceeds or is safely rejected
```

#### Benefits:
- 🔒 Maintains security by default
- 🤖 AI can request external access when needed
- 👤 User has explicit control over cross-project operations
- 📖 Clear error messages guide both AI and user
- ✅ No breaking changes - parameter is optional

## [3.5.2] - 2026-06-09

### UX Improvements - CLI & Extension Authentication Flow

#### CLI (`txa login`)
- ✨ **Dynamic Status Animation**: Added animated "Waiting for authorization..." message with dots
- 📢 **Better Feedback Messages**: Clear success/error/timeout messages with emojis
- 💡 **Helpful Hints**: Shows tips every 30 seconds during waiting
- 🎨 **Enhanced Callback Page**: Improved HTML callback page with better visual feedback
- ⏱️ **Clear Timeout Handling**: Explicit "expired" message instead of silent failure
- 🔄 **Status Line Management**: Properly clears animation before showing result messages

#### VSCode Extension
- 🔐 **Login State Check**: Prevents login when already authenticated, shows switch account flow
- 📊 **Progress Notifications**: Shows "Waiting for authorization..." with VSCode progress indicator
- ✅ **Success Feedback**: Clear success message with option to view status after authentication
- 🎯 **Better UI**: Improved settings description with structured markdown and clearer action buttons
- 🔔 **Detailed Notifications**: All auth events now show user-friendly notifications

#### Both
- 🚫 **No More Silent Failures**: Every state change has explicit user feedback
- 📝 **Consistent Messaging**: Unified terminology across CLI and extension
- 🎭 **State Awareness**: Both CLI and extension now properly track authentication state

### Technical Changes
- Added `loginToHub()` async wrapper for progress tracking
- Added `statusInterval` management for CLI animation
- Enhanced `cleanup()` function with clear status messages for all scenarios
- Improved deep link handler with immediate feedback notifications

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
