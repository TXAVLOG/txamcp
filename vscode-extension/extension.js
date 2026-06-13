// @ts-check
const vscode = require('vscode');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;

/** @type {vscode.OutputChannel} */
let outputChannel;

/** @type {vscode.StatusBarItem} */
let statusBarItem;

/** @type {vscode.ExtensionContext | null} */
let extensionContext = null;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    extensionContext = context;
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
        vscode.commands.registerCommand('txamcp.showStatus', () => showStatus(context)),
        vscode.commands.registerCommand('txamcp.login', () => loginToHub(context)),
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
        syncToGeminiMcpConfig();
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
    // 1. Try to query npm root -g dynamically to support custom npm prefixes, NVM, etc.
    try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim();
        if (npmRoot) {
            const dynamicPath = path.join(npmRoot, 'txamcp', 'mcp-server.mjs');
            if (fs.existsSync(dynamicPath)) return dynamicPath;
        }
    } catch (e) {
        // Ignore and fallback to hardcoded paths
    }

    // 2. Check global npm installation (hardcoded defaults)
    const globalPaths = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'txamcp', 'mcp-server.mjs'),
        // Linux/Mac global
        '/usr/local/lib/node_modules/txamcp/mcp-server.mjs',
        '/usr/lib/node_modules/txamcp/mcp-server.mjs',
    ];

    for (const p of globalPaths) {
        if (fs.existsSync(p)) return p;
    }

    // 3. Check workspace
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
        if (msg.includes('🔑 TXAMCP AUTH') || msg.includes('Startup Auth Failed') || msg.includes('KEY_EXPIRED') || msg.includes('KEY_REVOKED') || msg.includes('KEY_NOT_FOUND')) {
            let friendlyMessage = 'Txa MCP: Authentication failed. Please authenticate with Txa Hub.';
            
            if (msg.includes('KEY_EXPIRED') || msg.includes('expired') || msg.includes('hết hạn')) {
                friendlyMessage = 'Txa MCP: API Key has expired. Please authenticate with Txa Hub to renew your key.';
            } else if (msg.includes('KEY_REVOKED') || msg.includes('revoked') || msg.includes('thu hồi') || msg.includes('vô hiệu hóa')) {
                friendlyMessage = 'Txa MCP: API Key has been revoked or deactivated. Please check your dashboard.';
            } else if (msg.includes('KEY_NOT_FOUND') || msg.includes('không tồn tại')) {
                friendlyMessage = 'Txa MCP: API Key is invalid or does not exist. Please check your settings.';
            } else if (msg.includes('LIMIT_EXCEEDED') || msg.includes('vượt giới hạn') || msg.includes('giới hạn')) {
                friendlyMessage = '🚫 Txa MCP: Monthly request quota limit exceeded. Please upgrade your plan.';
            } else if (msg.includes('ACCOUNT_LOCKED') || msg.includes('bị khóa')) {
                friendlyMessage = '🔒 Txa MCP: Account has been locked. Please contact support.';
            } else if (msg.includes('missing') || msg.includes('Missing API Key')) {
                friendlyMessage = 'Txa MCP: API Key is missing. Please authenticate with Txa Hub.';
            }
            
            showAuthErrorPrompt(context, friendlyMessage);
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
 * Show current server status and configuration menu
 * @param {vscode.ExtensionContext} context
 */
/**
 * Show current server status and configuration menu
 * @param {vscode.ExtensionContext} [context]
 */
function showStatus(context) {
    const ctx = context || extensionContext;
    if (!ctx) {
        outputChannel.appendLine('[Txa MCP] Error: Extension context is not available for showStatus.');
        return;
    }
    const config = vscode.workspace.getConfiguration('txamcp');
    const isRunning = serverProcess !== null && !serverProcess.killed;
    const hasKey = !!config.get('apiKey');
    const gatewayEnabled = config.get('enableHttpGateway', false);
    const autoStart = config.get('autoStartServer', true);
    
    /** @type {vscode.QuickPickItem[]} */
    const items = [];

    if (hasKey) {
        // Line 1: Stop and Start (correspondingly auto-displayed) & Reset
        if (isRunning) {
            items.push({
                label: `🔴 Server: Running (Click to Stop / Restart)`,
                description: `Stop / Restart (Reset)`,
                detail: `Manage the active Txa MCP server process`
            });
        } else {
            items.push({
                label: `🟢 Server: Stopped (Click to Start)`,
                description: `Start`,
                detail: `Start the Txa MCP server process`
            });
        }

        // Line 2: Logout
        items.push({
            label: `🚪 Logout`,
            description: `Sign Out`,
            detail: `Clear your active API Key session and disconnect from Txa Hub`
        });

        // Line 3: Show Details
        items.push({
            label: `📝 Show Details / Dashboard`,
            description: `Open Hub Web Console`,
            detail: `Hub URL: ${config.get('hubUrl', 'https://txahub.click')}`
        });

        // Line 4: HTTP Gateway toggle
        items.push({
            label: `🔌 HTTP Gateway: ${gatewayEnabled ? 'Enabled' : 'Disabled'}`,
            description: `Click to Toggle`,
            detail: `Annotation: Enables the local HTTP REST API gateway on port ${config.get('httpPort', 3636)}`
        });

        // Line 5: Auto Start toggle
        items.push({
            label: `⚙️ Auto Start: ${autoStart ? 'Yes' : 'No'}`,
            description: `Click to Toggle`,
            detail: `Annotation: Automatically start the Txa MCP server when VS Code opens`
        });
    } else {
        // Line 1: Login / Authenticate
        items.push({
            label: `🔑 Login / Authenticate`,
            description: `Connect`,
            detail: `Authorize VS Code with Txa Hub via Web SSO`
        });

        // Line 2: Show Details
        items.push({
            label: `📝 Show Details / Dashboard`,
            description: `Open Hub Web Console`,
            detail: `Hub URL: ${config.get('hubUrl', 'https://txahub.click')}`
        });

        // Line 3: HTTP Gateway toggle
        items.push({
            label: `🔌 HTTP Gateway: ${gatewayEnabled ? 'Enabled' : 'Disabled'}`,
            description: `Click to Toggle`,
            detail: `Annotation: Enables the local HTTP REST API gateway on port ${config.get('httpPort', 3636)}`
        });

        // Line 4: Auto Start toggle
        items.push({
            label: `⚙️ Auto Start: ${autoStart ? 'Yes' : 'No'}`,
            description: `Click to Toggle`,
            detail: `Annotation: Automatically start the Txa MCP server when VS Code opens`
        });
    }

    vscode.window.showQuickPick(items, {
        title: 'Txa MCP Status',
        placeHolder: 'Select an option to manage settings or server state'
    }).then(selected => {
        if (!selected) return;

        const label = selected.label;

        if (label.includes('Server:')) {
            if (isRunning) {
                const statusItems = ['🛑 Stop Server', '🔄 Restart Server (Reset)'];
                vscode.window.showQuickPick(statusItems, {
                    title: 'Manage Server Process'
                }).then(action => {
                    if (action === '🛑 Stop Server') {
                        vscode.commands.executeCommand('txamcp.stopServer');
                    } else if (action === '🔄 Restart Server (Reset)') {
                        vscode.commands.executeCommand('txamcp.restartServer');
                    }
                });
            } else {
                vscode.commands.executeCommand('txamcp.startServer');
            }
        } 
        else if (label.includes('Logout')) {
            vscode.window.showWarningMessage(
                'Are you sure you want to log out and clear your session?',
                'Sign Out', 'Cancel'
            ).then(action => {
                if (action === 'Sign Out') {
                    vscode.commands.executeCommand('txamcp.logout');
                }
            });
        } 
        else if (label.includes('Login / Authenticate')) {
            vscode.commands.executeCommand('txamcp.login');
        }
        else if (label.includes('Show Details / Dashboard')) {
            vscode.commands.executeCommand('txamcp.openDashboard');
        } 
        else if (label.includes('HTTP Gateway')) {
            const newGateway = !gatewayEnabled;
            config.update('enableHttpGateway', newGateway, vscode.ConfigurationTarget.Global).then(() => {
                vscode.window.showInformationMessage(`HTTP Gateway is now ${newGateway ? 'Enabled' : 'Disabled'}.`);
                onConfigChanged(ctx);
            });
        } 
        else if (label.includes('Auto Start')) {
            const newAutoStart = !autoStart;
            config.update('autoStartServer', newAutoStart, vscode.ConfigurationTarget.Global).then(() => {
                vscode.window.showInformationMessage(`Auto Start is now ${newAutoStart ? 'Yes' : 'No'}.`);
                onConfigChanged(ctx);
            });
        }
    });
}

/**
 * Decrypt data using AES-128-ECB with key 'txahub'
 * @param {string} data
 * @param {string} [key]
 * @returns {string}
 */
function decrypt(data, key = 'txahub') {
    if (!data) return data;
    try {
        const keyBuf = Buffer.alloc(16, 0);
        keyBuf.write(key);
        const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
        let decrypted = decipher.update(data, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return data;
    }
}

/**
 * Get public IP address (with fallback)
 * @returns {Promise<string>}
 */
async function getPublicIP() {
    return new Promise((resolve) => {
        const https = require('https');
        https.get('https://api.ipify.org', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data.trim()));
        }).on('error', () => {
            const nets = os.networkInterfaces();
            if (nets) {
                for (const name of Object.keys(nets)) {
                    const netList = nets[name];
                    if (netList) {
                        for (const net of netList) {
                            if (net.family === 'IPv4' && !net.internal) {
                                return resolve(net.address);
                            }
                        }
                    }
                }
            }
            resolve('unknown');
        });
    });
}

/**
 * Login to TXAHUB via browser SSO or terminal fallback
 * @param {vscode.ExtensionContext} context
 */
async function loginToHub(context) {
    const config = vscode.workspace.getConfiguration('txamcp');
    const currentKey = /** @type {string} */ (config.get('apiKey', ''));
    const trimmedKey = currentKey.trim();

    // Check if already logged in with an API key
    if (trimmedKey && trimmedKey.startsWith('txamcp-') && trimmedKey.length === 63) {
        const action = await vscode.window.showWarningMessage(
            'You have an active API Key configured. Do you want to sign in again to switch accounts or refresh your session?',
            'Re-authenticate', 'Sign Out', 'Cancel'
        );
        if (action === 'Sign Out') {
            await logoutFromHub();
            return;
        } else if (action === 'Re-authenticate') {
            outputChannel.appendLine('[Txa MCP] Re-authenticating session...');
        } else {
            return;
        }
    }
    
    const hubUrl = config.get('hubUrl', 'https://txahub.click');
    
    outputChannel.appendLine('[Txa MCP] Initiating SSO auth request via Hub API...');
    
    const computerName = `${vscode.env.appName} (${os.hostname()})`;
    let ipAddress = 'unknown';
    try {
        ipAddress = await getPublicIP();
    } catch (e) {}

    let requestId = '';
    let authUrl = '';
    
    try {
        const res = await fetch(`${hubUrl}/api/auth/cli/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                computer_name: computerName,
                ip_address: ipAddress
            })
        });
        const data = await res.json();
        if (!data.success) {
            vscode.window.showErrorMessage(`Txa MCP: Failed to initiate login request: ${data.message || 'Unknown error'}`);
            return;
        }
        requestId = data.request_id;
        authUrl = data.auth_url;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Txa MCP: Network error: ${errMsg}`);
        return;
    }

    // Open browser for authentication
    vscode.env.openExternal(vscode.Uri.parse(authUrl));
    outputChannel.appendLine(`[Txa MCP] Opened authentication URL: ${authUrl}`);
    outputChannel.appendLine(`[Txa MCP] Waiting for authorization... (Request ID: ${requestId})`);

    let isAuthorized = false;
    /** @type {NodeJS.Timeout | null | undefined} */
    let pollInterval = undefined;
    /** @type {http.Server | null | undefined} */
    let localServer = undefined;

    const cleanup = () => {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        if (localServer) {
            try {
                localServer.close();
            } catch (e) {}
            localServer = null;
        }
    };

    // 1. Start a temporary HTTP server on port 3636 to receive local callback
    const port = 3636;
    localServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://localhost:${port}`);
        if (url.pathname === '/callback') {
            const status = url.searchParams.get('status');
            const key = url.searchParams.get('api_key');
            
            if (status === 'success' && key) {
                const decryptedKey = decrypt(decodeURIComponent(key));
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>✓ Authentication Successful - TXAMCP</title>
                        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
                        <script src="https://cdn.tailwindcss.com"></script>
                        <style>
                            body { font-family: 'Outfit', sans-serif; background-color: #020617; }
                            .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
                        </style>
                    </head>
                    <body class="flex items-center justify-center min-h-screen">
                        <div class="glass p-12 rounded-[2.5rem] shadow-2xl max-w-lg w-full text-center border-emerald-500/20">
                            <h1 class="text-4xl font-black text-white mb-4">✓ SUCCESS!</h1>
                            <p class="text-slate-400 text-lg mb-6">You have successfully authorized Txa MCP Extension.</p>
                            <p class="text-slate-500 text-sm">You can close this window now.</p>
                        </div>
                        <script>setTimeout(() => window.close(), 3000);</script>
                    </body>
                    </html>
                `);
                
                if (!isAuthorized) {
                    isAuthorized = true;
                    cleanup();
                    onAuthSuccess(decryptedKey);
                }
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <!DOCTYPE html>
                    <html>
                    <body style="background-color:#020617;color:#fff;text-align:center;padding-top:100px;font-family:sans-serif;">
                        <h1>Cancelled</h1>
                        <p>Authorization was cancelled.</p>
                    </body>
                    </html>
                `);
                cleanup();
            }
        }
    });

    localServer.on('error', (err) => {
        outputChannel.appendLine(`[Txa MCP] Local HTTP callback server error: ${err.message}. Falling back entirely to polling.`);
        localServer = null;
    });

    try {
        localServer.listen(port);
    } catch (e) {
        localServer = null;
    }

    /**
     * @param {string} apiKeyVal
     */
    const onAuthSuccess = (apiKeyVal) => {
        outputChannel.appendLine('[Txa MCP] ✔ Authentication successful!');
        config.update('apiKey', apiKeyVal, vscode.ConfigurationTarget.Global).then(() => {
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
    };

    // 2. Start polling the API endpoint in parallel (fallback / primary for custom IDE environments)
    pollInterval = setInterval(async () => {
        if (isAuthorized) return;
        try {
            const pollRes = await fetch(`${hubUrl}/api/auth/cli/poll?request_id=${requestId}`);
            const pollData = await pollRes.json();
            
            if (pollData) {
                if (pollData.error === 'EXPIRED' || pollData.success === false) {
                    cleanup();
                    vscode.window.showErrorMessage('Txa MCP: Authorization request expired. Please try again.');
                } else if (pollData.status === 'authorized') {
                    if (!isAuthorized) {
                        isAuthorized = true;
                        cleanup();
                        const decryptedKey = decrypt(pollData.api_key);
                        onAuthSuccess(decryptedKey);
                    }
                } else if (pollData.status === 'cancelled') {
                    cleanup();
                    vscode.window.showWarningMessage('Txa MCP: Authorization request cancelled.');
                }
            }
        } catch (e) {
            // Quietly ignore polling network errors (network blips)
        }
    }, 2000);

    // Show a progress indicator that can be cancelled
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Txa MCP: Authenticating...',
        cancellable: true
    }, async (progress, token) => {
        if (token) {
            token.onCancellationRequested(() => {
                outputChannel.appendLine('[Txa MCP] User cancelled auth waiting.');
                cleanup();
                fetch(`${hubUrl}/api/auth/cli/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ request_id: requestId })
                }).catch(() => {});
            });
        }

        progress.report({ message: 'Please complete the login in your browser.' });

        return new Promise((resolve) => {
            const checkTimer = setInterval(() => {
                if (isAuthorized || !pollInterval) {
                    clearInterval(checkTimer);
                    resolve(null);
                }
            }, 500);
        });
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
 * @param {string} [message]
 */
function showAuthErrorPrompt(context, message) {
    if (isAuthPromptVisible) return;
    isAuthPromptVisible = true;

    vscode.window.showErrorMessage(
        message || 'Txa MCP: Authentication failed or API Key has expired. Please authenticate with Txa Hub.',
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
/**
 * Automatically register/sync the Txa MCP server configuration to the Gemini IDE config folder.
 */
function syncToGeminiMcpConfig() {
    const serverScript = findServerScript();
    if (!serverScript) {
        outputChannel.appendLine('[Txa MCP] ⚠ Cannot sync to Gemini: MCP server script not found.');
        return;
    }

    const config = vscode.workspace.getConfiguration('txamcp');
    const apiKey = (/** @type {string} */ (config.get('apiKey', ''))).trim();
    const hubUrl = config.get('hubUrl', 'https://txahub.click');
    const requireAddRoot = config.get('requireAddRoot', false) ? '1' : '0';

    const homeDir = os.homedir();
    const configPaths = [
        path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
        path.join(homeDir, '.gemini', 'antigravity-ide', 'config', 'mcp_config.json'),
        path.join(homeDir, '.gemini', 'antigravity', 'config', 'mcp_config.json')
    ];

    for (const configPath of configPaths) {
        try {
            const parentDir = path.dirname(configPath);
            if (!fs.existsSync(parentDir)) {
                // If .gemini folder itself exists, but config directory doesn't, we can create it
                const geminiBase = path.join(homeDir, '.gemini');
                if (!fs.existsSync(geminiBase)) continue;
                fs.mkdirSync(parentDir, { recursive: true });
            }

            /** @type {any} */
            let mcpConfig = { mcpServers: {} };
            if (fs.existsSync(configPath)) {
                try {
                    mcpConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                } catch (e) {
                    outputChannel.appendLine(`[Txa MCP] ⚠ Error parsing ${configPath}, rewriting...`);
                }
            }

            if (!mcpConfig.mcpServers) {
                mcpConfig.mcpServers = {};
            }

            mcpConfig.mcpServers["Txa_MCP"] = {
                command: "node",
                args: [serverScript],
                env: {
                    API_KEY: apiKey,
                    HUB_URL: hubUrl,
                    TXAMCP_PROJECT_ROOT: "${workspaceFolder}",
                    TXAMCP_ACTIVE_FILE: "${file}",
                    TXAMCP_REQUIRE_ADD_ROOT: requireAddRoot
                }
            };

            fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
            outputChannel.appendLine(`[Txa MCP] ✔ Registered/Updated server configuration in Gemini: ${configPath}`);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`[Txa MCP] ⚠ Could not write configuration to ${configPath}: ${errMsg}`);
        }
    }
}

module.exports = { activate, deactivate };
