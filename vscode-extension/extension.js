// @ts-check
const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;

/** @type {vscode.OutputChannel} */
let outputChannel;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Txa MCP');

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'txamcp.showStatus';
    updateStatusBar('stopped');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('txamcp.startServer', () => startServer(context)),
        vscode.commands.registerCommand('txamcp.stopServer', stopServer),
        vscode.commands.registerCommand('txamcp.restartServer', () => restartServer(context)),
        vscode.commands.registerCommand('txamcp.showStatus', showStatus),
        vscode.commands.registerCommand('txamcp.login', loginToHub),
        vscode.commands.registerCommand('txamcp.logout', logoutFromHub),
        vscode.commands.registerCommand('txamcp.openDashboard', openDashboard)
    );

    // Update auth commands based on current login state
    updateAuthCommands();

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('txamcp')) {
                onConfigChanged(context);
                // Update auth commands when API key changes
                if (e.affectsConfiguration('txamcp.apiKey')) {
                    updateAuthCommands();
                }
            }
        })
    );

    // Register deep link handler for authentication callback
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri) {
                outputChannel.appendLine(`[Txa MCP] Intercepted deep link: ${uri.toString()}`);
                const params = new URLSearchParams(uri.query);
                const code = params.get('code') || params.get('key');
                if (code) {
                    const config = vscode.workspace.getConfiguration('txamcp');
                    const hubUrl = config.get('hubUrl', 'https://txahub.click');
                    const isCode = code.includes('-') && code.length === 36;
                    
                    if (isCode) {
                        outputChannel.appendLine(`[Txa MCP] Exchanging deep link code: ${code}`);
                        vscode.window.showInformationMessage('Txa MCP: Exchanging authorization code...');
                        
                        fetch(`${hubUrl}/api/auth/antigravity/exchange`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ code })
                        })
                        .then(res => res.json())
                        .then(data => {
                            if (data.success && data.api_key) {
                                config.update('apiKey', data.api_key, vscode.ConfigurationTarget.Global).then(() => {
                                    outputChannel.appendLine('[Txa MCP] ✔ Authentication successful!');
                                    vscode.window.showInformationMessage(
                                        '✅ Txa MCP: Successfully authenticated! Restarting server...',
                                        'View Status'
                                    ).then(action => {
                                        if (action === 'View Status') {
                                            vscode.commands.executeCommand('txamcp.showStatus');
                                        }
                                    });
                                    syncSettingsToGlobalConfig();
                                    updateAuthCommands();
                                    restartServer(context);
                                });
                            } else {
                                outputChannel.appendLine(`[Txa MCP] ✖ Exchange failed: ${data.message}`);
                                vscode.window.showErrorMessage(`Txa MCP: Authorization failed - ${data.message || 'Invalid code'}. Please try again.`);
                            }
                        })
                        .catch(err => {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            outputChannel.appendLine(`[Txa MCP] ✖ Connection error: ${errMsg}`);
                            vscode.window.showErrorMessage(`Txa MCP: Connection error - ${errMsg}. Check your network.`);
                        });
                    } else {
                        config.update('apiKey', code, vscode.ConfigurationTarget.Global).then(() => {
                            outputChannel.appendLine('[Txa MCP] ✔ API Key saved successfully!');
                            vscode.window.showInformationMessage(
                                '✅ Txa MCP: Successfully authenticated! Restarting server...',
                                'View Status'
                            ).then(action => {
                                if (action === 'View Status') {
                                    vscode.commands.executeCommand('txamcp.showStatus');
                                }
                            });
                            syncSettingsToGlobalConfig();
                            updateAuthCommands();
                            restartServer(context);
                        });
                    }
                }
            }
        })
    );

    // Deploy instructions.md to MCP schema folders
    deployInstructions(context);

    // Sync settings to global config
    syncSettingsToGlobalConfig();

    // Auto-start if enabled
    const config = vscode.workspace.getConfiguration('txamcp');
    if (config.get('autoStartServer', true)) {
        startServer(context);
    }

    // Listen for active editor changes to sync active project root in real-time
    const trackActiveState = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document && editor.document.uri.scheme === 'file') {
            saveActiveState(editor.document.fileName);
        } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            saveActiveState(vscode.workspace.workspaceFolders[0].uri.fsPath);
        }
    };
    
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(trackActiveState),
        vscode.workspace.onDidChangeWorkspaceFolders(trackActiveState)
    );
    
    // Initial tracking
    trackActiveState();

    outputChannel.appendLine('[Txa MCP] Extension activated successfully.');
}

/**
 * Check if user is logged in and update auth commands accordingly
 */
function updateAuthCommands() {
    const config = vscode.workspace.getConfiguration('txamcp');
    const apiKey = /** @type {string} */ (config.get('apiKey', ''));
    const isLoggedIn = apiKey && apiKey.trim().startsWith('txamcp-') && apiKey.length === 63;

    // Update status bar to show login state
    if (isLoggedIn) {
        statusBarItem.text = '$(check) Txa MCP';
        statusBarItem.tooltip = 'Txa MCP: Connected to TXAHUB';
    } else {
        statusBarItem.text = '$(circle-outline) Txa MCP';
        statusBarItem.tooltip = 'Txa MCP: Not connected to TXAHUB';
    }
}

/**
 * Deploy instructions.md to IDE MCP schema folders
 * @param {vscode.ExtensionContext} context
 */
function deployInstructions(context) {
    const extensionPath = context.extensionPath;
    const instructionsSource = path.join(extensionPath, '..', 'instructions.md');
    
    // Fallback: check in extension itself
    const altSource = path.join(extensionPath, 'instructions.md');
    const source = fs.existsSync(instructionsSource) ? instructionsSource : 
                   fs.existsSync(altSource) ? altSource : null;

    if (!source) {
        outputChannel.appendLine('[Txa MCP] instructions.md not found, skipping deployment.');
        return;
    }

    const homeDir = os.homedir();
    const targets = [
        path.join(homeDir, '.gemini', 'antigravity-ide', 'mcp', 'Txa_MCP'),
        path.join(homeDir, '.gemini', 'antigravity', 'mcp', 'Txa_MCP'),
        path.join(homeDir, '.gemini', 'config', 'mcp', 'Txa_MCP'),
    ];

    const content = fs.readFileSync(source, 'utf-8');

    for (const targetDir of targets) {
        try {
            const parentDir = path.dirname(targetDir);
            if (!fs.existsSync(parentDir)) continue;

            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            const targetFile = path.join(targetDir, 'instructions.md');
            fs.writeFileSync(targetFile, content, 'utf-8');
            outputChannel.appendLine(`[Txa MCP] ✔ Deployed instructions.md → ${targetFile}`);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`[Txa MCP] ⚠ Could not deploy to ${targetDir}: ${errMsg}`);
        }
    }
}

/**
 * Sync VS Code settings to TXAMCP global config file (~/.txamcp/config.json)
 * This bridges the VS Code UI settings to the MCP server's config
 */
function syncSettingsToGlobalConfig() {
    const config = vscode.workspace.getConfiguration('txamcp');
    const apiKey = (/** @type {string} */ (config.get('apiKey', ''))).trim();
    const hubUrl = config.get('hubUrl', 'https://txahub.click');

    if (!apiKey) return; // Don't overwrite if no key set in VS Code

    // Check if the setting is a one-time OAuth authorization code instead of a real API key
    const isCode = apiKey.includes('-') && apiKey.length === 36;
    if (isCode) {
        outputChannel.appendLine(`[Txa MCP] Detected OAuth authorization code. Exchanging with Txa Hub...`);
        fetch(`${hubUrl}/api/auth/antigravity/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: apiKey })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.api_key) {
                outputChannel.appendLine(`[Txa MCP] ✔ Successfully exchanged authorization code for API Key.`);
                config.update('apiKey', data.api_key, vscode.ConfigurationTarget.Global).then(() => {
                    vscode.window.showInformationMessage('Txa MCP: Successfully authenticated and synced API Key!');
                });
            } else {
                outputChannel.appendLine(`[Txa MCP] ✖ Authorization code exchange failed: ${data.message || 'Unknown error'}`);
                vscode.window.showErrorMessage(`Txa MCP: Authorization code exchange failed: ${data.message || 'Invalid code'}`);
            }
        })
        .catch(err => {
            const errMsg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`[Txa MCP] ✖ Connection error during exchange: ${errMsg}`);
        });
        return; // Wait for exchange to trigger and update config
    }

    const configDir = path.join(os.homedir(), '.txamcp');
    const configPath = path.join(configDir, 'config.json');

    try {
        /**
         * @type {{ apiKey?: any; hubUrl?: any; updatedBy?: any; updatedAt?: any; }}
         */
        let existingConfig = {};
        if (fs.existsSync(configPath)) {
            existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        }

        // Only update if VS Code has explicit values
        existingConfig.apiKey = apiKey;
        if (hubUrl !== 'https://txahub.click') {
            existingConfig.hubUrl = hubUrl;
        }
        existingConfig.updatedBy = 'vscode-extension';
        existingConfig.updatedAt = new Date().toISOString();

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');
        outputChannel.appendLine('[Txa MCP] ✔ Synced API Key to global config.');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Txa MCP] ⚠ Could not sync settings: ${errMsg}`);
    }
}

/**
 * Build environment variables from VS Code settings
 * @returns {Record<string, string | undefined>}
 */
function buildEnvFromSettings() {
    const config = vscode.workspace.getConfiguration('txamcp');

    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env };

    const apiKey = /** @type {string} */ (config.get('apiKey', ''));
    if (apiKey) env.API_KEY = apiKey;

    const hubUrl = /** @type {string} */ (config.get('hubUrl', ''));
    if (hubUrl) env.HUB_URL = hubUrl;

    env.ENABLE_HTTP_GATEWAY = config.get('enableHttpGateway', false) ? 'true' : 'false';
    env.MCP_PORT = String(config.get('httpPort', 3636));
    env.TXAMCP_REQUIRE_ADD_ROOT = config.get('requireAddRoot', false) ? '1' : '0';

    const projectRoot = config.get('projectRoot', '');
    if (projectRoot) env.TXAMCP_PROJECT_ROOT = projectRoot;

    // If workspace is open, pass it as project root
    if (!projectRoot && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        env.TXAMCP_PROJECT_ROOT = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    return env;
}

/**
 * Find the MCP server script
 * @returns {string | null}
 */
function findServerScript() {
    // 1. Check global npm installation
    const globalPaths = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'txamcp', 'mcp-server.mjs'),
        // Linux/Mac global
        '/usr/local/lib/node_modules/txamcp/mcp-server.mjs',
        '/usr/lib/node_modules/txamcp/mcp-server.mjs',
    ];

    for (const p of globalPaths) {
        if (fs.existsSync(p)) return p;
    }

    // 2. Check workspace
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            const localPath = path.join(folder.uri.fsPath, 'node_modules', 'txamcp', 'mcp-server.mjs');
            if (fs.existsSync(localPath)) return localPath;
        }
    }

    return null;
}

/**
 * Start the MCP server process
 * @param {vscode.ExtensionContext} context
 */
async function startServer(context) {
    if (serverProcess) {
        outputChannel.appendLine('[Txa MCP] Server is already running.');
        vscode.window.showInformationMessage('Txa MCP server is already running.');
        return;
    }

    const serverScript = findServerScript();
    if (!serverScript) {
        const action = await vscode.window.showErrorMessage(
            'Txa MCP server not found. Please install it first.',
            'Install via npm'
        );
        if (action === 'Install via npm') {
            const terminal = vscode.window.createTerminal('Txa MCP Install');
            terminal.show();
            terminal.sendText('npm install -g txamcp');
        }
        return;
    }

    const env = buildEnvFromSettings();

    outputChannel.appendLine(`[Txa MCP] Starting server: ${serverScript}`);
    updateStatusBar('starting');

    serverProcess = spawn('node', [serverScript], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });

    serverProcess.stderr?.on('data', (data) => {
        const msg = data.toString().trim();
        outputChannel.appendLine(msg);
        if (msg.includes('🔑 TXAMCP AUTH') || msg.includes('Startup Auth Failed')) {
            showAuthErrorPrompt(context);
        }
    });

    serverProcess.stdout?.on('data', (data) => {
        outputChannel.appendLine(`[stdout] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
        outputChannel.appendLine(`[Txa MCP] ✖ Server error: ${err.message}`);
        updateStatusBar('error');
        serverProcess = null;
    });

    serverProcess.on('exit', (code) => {
        outputChannel.appendLine(`[Txa MCP] Server exited with code ${code}`);
        updateStatusBar('stopped');
        serverProcess = null;
    });

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1500));

    if (serverProcess && !serverProcess.killed) {
        updateStatusBar('running');
        outputChannel.appendLine('[Txa MCP] ✔ Server started successfully.');
        
        // Check for updates asynchronously on server startup
        checkForUpdates(serverScript);
    }
}

/**
 * Stop the MCP server
 */
function stopServer() {
    if (!serverProcess) {
        vscode.window.showInformationMessage('Txa MCP server is not running.');
        return;
    }

    serverProcess.kill('SIGTERM');
    serverProcess = null;
    updateStatusBar('stopped');
    outputChannel.appendLine('[Txa MCP] Server stopped.');
    vscode.window.showInformationMessage('Txa MCP server stopped.');
}

/**
 * Restart the server
 * @param {vscode.ExtensionContext} context
 */
async function restartServer(context) {
    stopServer();
    await new Promise(resolve => setTimeout(resolve, 500));
    await startServer(context);
}

/**
 * Show current server status
 */
function showStatus() {
    const config = vscode.workspace.getConfiguration('txamcp');
    const isRunning = serverProcess !== null && !serverProcess.killed;
    
    const items = [
        `Status: ${isRunning ? '🟢 Running' : '🔴 Stopped'}`,
        `API Key: ${config.get('apiKey') ? '✔ Configured' : '❌ Not set'}`,
        `Hub URL: ${config.get('hubUrl', 'https://txahub.click')}`,
        `HTTP Gateway: ${config.get('enableHttpGateway', false) ? 'Enabled' : 'Disabled'}`,
        `Auto Start: ${config.get('autoStartServer', true) ? 'Yes' : 'No'}`,
    ];

    vscode.window.showQuickPick(items, {
        title: 'Txa MCP Status',
        placeHolder: 'Server status and configuration overview'
    });
}

/**
 * Login to TXAHUB via browser SSO or terminal fallback
 */
async function loginToHub() {
    const config = vscode.workspace.getConfiguration('txamcp');
    const currentKey = /** @type {string} */ (config.get('apiKey', ''));
    const trimmedKey = currentKey.trim();

    // Check if already logged in with a valid API key
    if (trimmedKey && trimmedKey.startsWith('txamcp-') && trimmedKey.length === 63) {
        const action = await vscode.window.showWarningMessage(
            'You are already logged in. Sign out first to switch accounts.',
            'View Status', 'Sign Out', 'Cancel'
        );
        if (action === 'View Status') {
            vscode.commands.executeCommand('txamcp.showStatus');
        } else if (action === 'Sign Out') {
            await logoutFromHub();
        }
        return;
    }
    
    const hubUrl = config.get('hubUrl', 'https://txahub.click');
    const state = Math.random().toString(36).substring(2, 15);
    
    // Open external browser for standard authorization.
    // The web app can redirect back to vscode://txahub.txamcp-vscode/auth?key=... or antigravity://txahub.txamcp-vscode/auth?key=...
    vscode.env.openExternal(vscode.Uri.parse(`${hubUrl}/auth/antigravity?client=antigravity&state=${state}`));
    
    outputChannel.appendLine('[Txa MCP] Opening Web Authentication SSO...');
    outputChannel.appendLine('[Txa MCP] Waiting for authorization callback...');
    
    const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: 'Txa MCP: Waiting for authorization...',
        cancellable: false
    };
    
    vscode.window.withProgress(progressOptions, async (progress) => {
        progress.report({ message: 'Complete the login in your browser. This window will auto-close upon success.' });
        
        // Wait up to 5 minutes for authorization
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                outputChannel.appendLine('[Txa MCP] Authorization timeout. You can manually paste the API key in settings.');
                resolve(null);
            }, 300000); // 5 minutes
            
            // The deep link handler will update config and restart server
            const disposable = vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('txamcp.apiKey')) {
                    const newKey = /** @type {string} */ (vscode.workspace.getConfiguration('txamcp').get('apiKey', ''));
                    if (newKey && newKey.startsWith('txamcp-')) {
                        clearTimeout(timeout);
                        disposable.dispose();
                        resolve(null);
                    }
                }
            });
        });
    });
    
    vscode.window.showInformationMessage(
        'Browser opened for authentication. Having issues? Try CLI fallback.',
        'CLI Login Fallback', 'Manual Key Entry'
    ).then(action => {
        if (action === 'CLI Login Fallback') {
            const terminal = vscode.window.createTerminal('Txa MCP Login');
            terminal.show();
            terminal.sendText('txa login');
        } else if (action === 'Manual Key Entry') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'txamcp.apiKey');
        }
    });
}

/**
 * Open TXAHUB dashboard in browser
 */
function openDashboard() {
    const config = vscode.workspace.getConfiguration('txamcp');
    const hubUrl = config.get('hubUrl', 'https://txahub.click');
    vscode.env.openExternal(vscode.Uri.parse(`${hubUrl}/dashboard`));
}

/**
 * Handle configuration changes
 * @param {vscode.ExtensionContext} context
 */
function onConfigChanged(context) {
    syncSettingsToGlobalConfig();
    outputChannel.appendLine('[Txa MCP] Configuration changed. Restart server for changes to take effect.');
    
    vscode.window.showInformationMessage(
        'Txa MCP settings changed. Restart server?',
        'Restart', 'Later'
    ).then(action => {
        if (action === 'Restart') {
            restartServer(context);
        }
    });
}

/**
 * Update status bar item
 * @param {'running' | 'stopped' | 'starting' | 'error'} status
 */
function updateStatusBar(status) {
    switch (status) {
        case 'running':
            statusBarItem.text = '$(check) Txa MCP';
            statusBarItem.tooltip = 'Txa MCP server is running';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'stopped':
            statusBarItem.text = '$(circle-slash) Txa MCP';
            statusBarItem.tooltip = 'Txa MCP server is stopped. Click to view status.';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'starting':
            statusBarItem.text = '$(sync~spin) Txa MCP';
            statusBarItem.tooltip = 'Txa MCP server is starting...';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'error':
            statusBarItem.text = '$(error) Txa MCP';
            statusBarItem.tooltip = 'Txa MCP server encountered an error';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
    }
}

function deactivate() {
    if (serverProcess) {
        serverProcess.kill('SIGTERM');
        serverProcess = null;
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
}

/** @type {boolean} */
let isAuthPromptVisible = false;

/**
 * Show a VS Code prompt informing the user about an auth failure
 * @param {vscode.ExtensionContext} context
 */
function showAuthErrorPrompt(context) {
    if (isAuthPromptVisible) return;
    isAuthPromptVisible = true;

    vscode.window.showErrorMessage(
        'Txa MCP: Authentication failed or API Key has expired. Please authenticate with Txa Hub.',
        'Authenticate Web SSO',
        'Configure Settings',
        'Dismiss'
    ).then(action => {
        isAuthPromptVisible = false;
        if (action === 'Authenticate Web SSO') {
            vscode.commands.executeCommand('txamcp.login');
        } else if (action === 'Configure Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'txamcp');
        }
    });
}

/**
 * Logout from Txa Hub (Clear VS Code settings, global config, and stop server)
 */
async function logoutFromHub() {
    const config = vscode.workspace.getConfiguration('txamcp');
    
    // Wipe API key setting in VS Code
    await config.update('apiKey', '', vscode.ConfigurationTarget.Global);
    
    // Wipe API key in global config file (~/.txamcp/config.json)
    const configDir = path.join(os.homedir(), '.txamcp');
    const configPath = path.join(configDir, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            const globalConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            delete globalConfig.apiKey;
            globalConfig.updatedBy = 'vscode-extension';
            globalConfig.updatedAt = new Date().toISOString();
            fs.writeFileSync(configPath, JSON.stringify(globalConfig, null, 2), 'utf-8');
        }
        outputChannel.appendLine('[Txa MCP] ✔ Logged out successfully. Local session cleared.');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Txa MCP] ⚠ Error during logout file cleanup: ${errMsg}`);
    }

    // Stop the MCP server
    stopServer();

    // Update auth commands to reflect logged out state
    updateAuthCommands();

    vscode.window.showInformationMessage('Txa MCP: Logged out successfully. Session cleared.');
}

/**
 * Get the currently installed version of the global MCP server
 * @param {string} serverScript
 * @returns {string | null}
 */
function getInstalledServerVersion(serverScript) {
    try {
        const pkgPath = path.join(path.dirname(serverScript), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const serverPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return serverPkg.version;
        }
    } catch (e) {}
    return null;
}

/**
 * Check npm registry asynchronously for new txamcp updates
 * @param {string} serverScript
 */
async function checkForUpdates(serverScript) {
    const installedVer = getInstalledServerVersion(serverScript);
    if (!installedVer) return;

    try {
        outputChannel.appendLine('[Txa MCP] Checking for updates on npm...');
        const res = await fetch('https://registry.npmjs.org/txamcp/latest');
        const data = await res.json();
        const latestVer = data.version;

        if (latestVer && latestVer !== installedVer) {
            outputChannel.appendLine(`[Txa MCP] 💡 Update available! Installed: v${installedVer}, Latest: v${latestVer}`);
            vscode.window.showInformationMessage(
                `A new update for Txa MCP (v${latestVer}) is available! Currently installed: v${installedVer}.`,
                'Update Now',
                'Later'
            ).then(action => {
                if (action === 'Update Now') {
                    const terminal = vscode.window.createTerminal('Txa MCP Update');
                    terminal.show();
                    terminal.sendText('npm install -g txamcp');
                }
            });
        } else {
            outputChannel.appendLine(`[Txa MCP] ✔ Txa MCP is up to date (v${installedVer}).`);
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Txa MCP] ⚠ Failed to check for updates: ${errMsg}`);
    }
}

/**
 * Find the project root directory by traversing upwards
 * @param {string} startDir 
 * @param {number} steps 
 * @returns {string}
 */
function findProjectRoot(startDir, steps = 0) {
    if (steps > 10) return startDir;
    const markers = [".git", "package.json", "pubspec.yaml", "composer.json", "go.mod", "requirements.txt"];
    try {
        const stat = fs.statSync(startDir);
        const dir = stat.isDirectory() ? startDir : path.dirname(startDir);
        for (const marker of markers) {
            if (fs.existsSync(path.join(dir, marker))) return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return dir;
        return findProjectRoot(parent, steps + 1);
    } catch (e) {
        return startDir;
    }
}

/**
 * Persist the active editor file and project root to the global runtime-state
 * @param {string} filePath 
 */
function saveActiveState(filePath) {
    const dir = path.join(os.homedir(), '.txamcp');
    const statePath = path.join(dir, 'runtime-state.json');
    try {
        const projectRoot = findProjectRoot(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(statePath, JSON.stringify({
            currentProjectRoot: projectRoot,
            activeFilePath: filePath,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf-8');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Txa MCP] Error saving runtime state: ${errMsg}`);
    }
}

module.exports = { activate, deactivate };
