#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import chalk from "chalk";
import boxen from "boxen";
import { exec, execSync } from "child_process";
import http from "http";
import https from "https";
import { URL } from "url";
import { createRequire } from "module";
import crypto from "crypto";
import updateNotifier from "update-notifier";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// Check for updates
updateNotifier({ pkg }).notify();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = {
  success: (msg) => console.log(chalk.green(`  ${chalk.bold('SUCCESS')} ${msg}`)),
  info: (msg) => console.log(chalk.blue(`  ${chalk.bold('INFO')}    ${msg}`)),
  warn: (msg) => console.log(chalk.yellow(`  ${chalk.bold('WARN')}    ${msg}`)),
  error: (msg) => console.log(chalk.red(`  ${chalk.bold('ERROR')}   ${msg}`)),
  step: (msg) => console.log(chalk.magenta(`  ${chalk.bold('STEP')}    ${msg}`))
};

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Validation Config
const API_KEY_PREFIX = "txamcp-";
const API_KEY_REGEX = /^txamcp-[a-f0-9]{56}$/;

function validateApiKeyFormat(apiKey) {
  if (!apiKey) {
    return {
      valid: false,
      message: "API Key cannot be empty.",
      example: "txamcp-710645672906e5762696614486536554556485542261626244226462"
    };
  }

  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    return {
      valid: false,
      message: `API Key must start with '${API_KEY_PREFIX}'.`,
      example: "txamcp-710645672906e5762696614486536554556485542261626244226462"
    };
  }

  if (!API_KEY_REGEX.test(apiKey)) {
    return {
      valid: false,
      message: "Invalid API Key format (must be 56 hex characters after prefix).",
      example: "txamcp-710645672906e5762696614486536554556485542261626244226462"
    };
  }

  return { valid: true };
}

/**
 * Decrypt data using AES-128-ECB with key 'txahub'
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
    // If decryption fails, it might be plaintext (fallback)
    return data;
  }
}

/**
 * Helper to safely parse JSON responses from TXAHUB.
 * If the response is an HTML error page (e.g. Cloudflare Error 522),
 * it returns a clean, user-friendly error instead of raw HTML.
 */
async function safeParseJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    let errorMsg = `Server returned status ${response.status}`;
    try {
      const text = await response.text();
      if (text.trim().startsWith("<!DOCTYPE") || text.includes("<html")) {
        errorMsg = `Server error (${response.status}). The server returned an HTML error page (possibly Cloudflare or web server error).`;
      } else if (text.trim()) {
        errorMsg = `Server returned status ${response.status}: ${text.substring(0, 200)}`;
      }
    } catch (e) { }
    throw new Error(errorMsg);
  }
  try {
    return await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON response: ${message}`);
  }
}

async function getHubUrl() {
  if (process.env.HUB_URL) return process.env.HUB_URL;
  try {
    const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
    if (await fileExists(configPath)) {
      const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
      if (config.hubUrl) return config.hubUrl;
    }
  } catch (e) {}
  return "https://txahub.click";
}

async function getPublicIP() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', () => {
      // Fallback to local IP if public fails
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            return resolve(net.address);
          }
        }
      }
      resolve('unknown');
    });
  });
}

async function login(apiKey) {
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  if (await fileExists(configPath)) {
    console.log("");
    log.warn(`You are already logged in.`);
    let config;
    try {
      config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    } catch (e) {}

    const currentUsername = config?.user?.username;
    if (currentUsername && currentUsername !== "Unknown") {
      console.log(chalk.gray(`Currently active session: ${chalk.bold.white(currentUsername)}`));
      console.log(chalk.gray(`To switch accounts, please run '${chalk.cyan("txa logout")}' first.\n`));
      return;
    }

    if (config?.apiKey) {
      log.step("Session username missing. Synchronizing with server...");
      try {
        const hubUrl = await getHubUrl();
        const response = await fetch(`${hubUrl}/api/verify-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: config.apiKey, cli_token: config.cliToken }),
          signal: AbortSignal.timeout(5000)
        });
        const data = await safeParseJson(response);
        if (data.success) {
          config.user = data.user;
          config.lastSync = new Date().toISOString();
          await fs.writeFile(configPath, JSON.stringify(config, null, 2));
          log.success(`Session synchronized successfully!`);
          console.log(chalk.gray(`Currently active session: ${chalk.bold.white(data.user.username)}`));
          console.log(chalk.gray(`To switch accounts, please run '${chalk.cyan("txa logout")}' first.\n`));
          return;
        } else {
          log.error("Local session is invalid or expired.");
          console.log(chalk.gray(`Please run '${chalk.cyan("txa logout")}' first, then login again.\n`));
          return;
        }
      } catch (e) {
        const maskedKey = config.apiKey.substring(0, 12) + "...";
        console.log(chalk.gray(`Currently active session: ${chalk.bold.white("Unknown")} (License: ${maskedKey})`));
        console.log(chalk.gray(`To switch accounts, please run '${chalk.cyan("txa logout")}' first.\n`));
        return;
      }
    } else {
      console.log(chalk.gray(`Currently active session: ${chalk.bold.white("Unknown")}`));
      console.log(chalk.gray(`To switch accounts, please run '${chalk.cyan("txa logout")}' first.\n`));
      return;
    }
  }

  if (!apiKey) {
    console.log("");
    log.step(chalk.bold("Initializing automated login flow..."));
    const computerName = os.hostname();
    const ipAddress = await getPublicIP();

    try {
      const hubUrl = await getHubUrl();
      const res = await fetch(`${hubUrl}/api/auth/cli/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          computer_name: computerName,
          ip_address: ipAddress
        })
      });
      const data = await safeParseJson(res);
      if (!data.success) {
        log.error("Failed to initiate login request: " + (data.message || "Unknown error"));
        return;
      }

      const { request_id, auth_url } = data;
      const port = 6767;
      let poll;
      let statusInterval;

      async function killProcessOnPort(targetPort) {
        return new Promise((resolve) => {
          const cmd = os.platform() === 'win32'
            ? `netstat -ano | findstr :${targetPort}`
            : `lsof -t -i:${targetPort}`;

          exec(cmd, (err, stdout) => {
            if (err || !stdout) return resolve();
            
            const lines = stdout.split('\n').filter(Boolean);
            const pids = new Set();
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && !isNaN(pid) && parseInt(pid) !== process.pid && parseInt(pid) > 0) {
                pids.add(parseInt(pid));
              }
            }

            const killPromises = Array.from(pids).map(pid => {
              return new Promise((r) => {
                const killCmd = os.platform() === 'win32'
                  ? `taskkill /F /PID ${pid}`
                  : `kill -9 ${pid}`;
                exec(killCmd, () => r());
              });
            });

            Promise.all(killPromises).then(() => resolve());
          });
        });
      }

      const cleanup = async (status, key = null, token = null) => {
        if (statusInterval) clearInterval(statusInterval);
        if (poll) clearInterval(poll);
        process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear status line
        try {
          server.close();
        } catch (e) { }
        
        if (status === "success" && key) {
          console.log("");
          log.success(chalk.bold("✓ Authorization confirmed! Syncing credentials..."));
          const decryptedKey = decrypt(key);
          const decryptedToken = decrypt(token);
          await completeLogin(decryptedKey, decryptedToken);
        } else if (status === "success_already_written") {
          try {
            const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
            const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
            console.log("\n" + boxen(
              chalk.green.bold(` ✓ ACCESS GRANTED: ${config.user?.username?.toUpperCase() || "USER"} `) + "\n\n" +
              chalk.white(`${chalk.bold('User :')} ${config.user?.email || config.user?.username}\n`) +
              chalk.white(`${chalk.bold('Plan :')} ${chalk.cyan(config.user?.plan_name || "FREE")}\n`) +
              chalk.white(`${chalk.bold('Usage:')} ${chalk.bold(config.user?.request_count || 0)} / ${chalk.gray(config.user?.requests_total || "5,000")}`),
              { padding: 1, borderStyle: 'round', borderColor: 'green', backgroundColor: '#0f172a' }
            ));
            log.success("Session synchronized. CLI is ready for use.");
          } catch (e) {
            log.success("Authentication complete! Session synchronized.");
          }
        } else if (status === "expired") {
          console.log("");
          log.error("⏱ Login request expired after 5 minutes. Please try again.");
        } else if (status === "cancelled") {
          console.log("");
          log.warn("✗ Authorization was cancelled by user.");
        }
        process.exit(0);
      };

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname === "/callback") {
          const status = url.searchParams.get("status");
          const key = url.searchParams.get("api_key");
          const token = url.searchParams.get("token");

          if (status === "success" && key) {
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>✓ Authorization Successful - TXAMCP</title>
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
                    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
                    <script src="https://cdn.tailwindcss.com"></script>
                    <style>
                        body { font-family: 'Outfit', sans-serif; background-color: #020617; }
                        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
                        .animate-float { animation: float 6s ease-in-out infinite; }
                        @keyframes float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
                        .pulse-success { animation: pulse-success 2s ease-in-out infinite; }
                        @keyframes pulse-success { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                    </style>
                </head>
                <body class="flex items-center justify-center min-h-screen overflow-hidden">
                    <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-emerald-500/10 blur-[120px] rounded-full"></div>
                    
                    <div class="glass p-12 rounded-[2.5rem] shadow-2xl max-w-lg w-full text-center relative z-10 border-emerald-500/20">
                        <div class="w-24 h-24 bg-emerald-500/10 rounded-3xl flex items-center justify-center text-5xl text-emerald-400 mx-auto mb-8 animate-bounce shadow-lg shadow-emerald-500/20 border border-emerald-500/20">
                            <i class="bi bi-check-circle-fill"></i>
                        </div>
                        
                        <h1 class="text-4xl font-black text-white mb-4 tracking-tight">✓ SUCCESS!</h1>
                        <p class="text-slate-400 text-lg mb-6 leading-relaxed">
                            You have successfully authorized <span class="text-emerald-400 font-bold">TXA CLI</span>.
                        </p>
                        
                        <div class="p-4 bg-emerald-900/20 rounded-2xl border border-emerald-500/30 mb-6">
                            <p class="text-emerald-400 font-semibold mb-2">
                                <i class="bi bi-terminal mr-2"></i>Return to Your Terminal
                            </p>
                            <p class="text-slate-400 text-sm">
                                Your CLI is now authenticated and ready to use. Check your terminal for confirmation.
                            </p>
                        </div>
 
                        <div class="flex items-center justify-center gap-3 text-slate-500 mb-4">
                            <span class="w-2 h-2 bg-emerald-500 rounded-full pulse-success"></span>
                            <span class="text-xs uppercase tracking-widest font-bold">Connection Secured</span>
                        </div>
                        
                        <p class="text-slate-500 text-xs italic">
                            This window will close automatically in a few seconds
                        </p>
                    </div>
                    
                    <script>
                        setTimeout(() => { 
                            window.close(); 
                            // Fallback for browsers that block window.close()
                            if (!window.closed) {
                                document.querySelector('h1').innerText = "✓ DONE!";
                                document.querySelector('p.text-slate-400.text-lg').innerHTML = 
                                    "This browser tab can be safely closed now.<br><span class='text-sm text-slate-500'>Return to your terminal to continue.</span>";
                            }
                        }, 3000);
                    </script>
                </body>
                </html>`;
 
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            
            // Clear the waiting animation
            if (statusInterval) clearInterval(statusInterval);
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            console.log("");
            log.success(chalk.bold("✓ Authorization received from browser! Processing..."));
            
            await cleanup("success", key, token);
          } else {
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <title>Authorization Cancelled - TXAMCP</title>
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
                    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
                    <script src="https://cdn.tailwindcss.com"></script>
                    <style>
                        body { font-family: 'Outfit', sans-serif; background-color: #020617; }
                        .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
                    </style>
                </head>
                <body class="flex items-center justify-center min-h-screen overflow-hidden">
                    <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-red-500/5 blur-[120px] rounded-full"></div>
                    
                    <div class="glass p-12 rounded-[2.5rem] shadow-2xl max-w-lg w-full text-center relative z-10 border-red-500/20">
                        <div class="w-24 h-24 bg-red-500/10 rounded-3xl flex items-center justify-center text-5xl text-red-400 mx-auto mb-8 border border-red-500/20">
                            <i class="bi bi-x-circle-fill"></i>
                        </div>
                        
                        <h1 class="text-4xl font-black text-white mb-4 tracking-tight uppercase">Cancelled</h1>
                        <p class="text-slate-400 text-lg mb-8 leading-relaxed">
                            The authorization request was denied or timed out.
                        </p>
                        
                        <div class="p-4 bg-slate-900/50 rounded-2xl border border-slate-800 text-slate-500 text-sm italic">
                            Return to your terminal to try again.
                        </div>
                    </div>
                </body>
                </html>`;
 
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            
            // Clear the waiting animation
            if (statusInterval) clearInterval(statusInterval);
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            
            log.warn("Authorization request was cancelled.");
            await cleanup("cancelled");
          }
        }
      });
 
      server.on('error', async (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(chalk.yellow("\n  ⚠ Port 6767 is occupied. Attempting to free port..."));
          await killProcessOnPort(port);
          
          try {
            server.listen(port);
            console.log(chalk.green("  ✔ Port 6767 successfully freed and bound."));
          } catch (retryErr) {
            console.log(chalk.gray("  ℹ Could not free port 6767. Using background polling flow..."));
          }
        } else {
          log.error("Login Server Error: " + err.message);
        }
      });
 
      try {
        server.listen(port);
      } catch (e) {
        // Fallback to polling
      }
      const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
      exec(`${start} ${auth_url}`);

      console.log("\n" + boxen(
        chalk.white.bold("ACTION REQUIRED: Complete Login in Browser\n\n") +
        chalk.gray("A browser window should have opened automatically.\n") +
        chalk.gray("If not, please copy and paste this URL:\n\n") +
        chalk.cyan.underline(auth_url) + "\n\n" +
        chalk.magenta.italic("⏳ Waiting for authorization..."),
        { padding: 1, borderStyle: 'double', borderColor: 'magenta', title: ' OAuth 2.0 Auth ', titleAlignment: 'center' }
      ));

      let statusDots = 0;
      statusInterval = setInterval(() => {
        statusDots = (statusDots + 1) % 4;
        const dots = '.'.repeat(statusDots);
        process.stdout.write(`\r  ${chalk.cyan('⏳')} ${chalk.gray('Waiting for authorization' + dots.padEnd(3, ' '))}`);
      }, 500);

      // Handle Ctrl+C to notify server
      const handleAbort = async () => {
        if (statusInterval) clearInterval(statusInterval);
        process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear status line
        console.log('\n\n  ' + chalk.yellow('!') + ' Aborting login flow...');
        try {
          const hubUrl = await getHubUrl();
          await fetch(`${hubUrl}/api/auth/cli/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: request_id }),
            signal: AbortSignal.timeout(2000) // Don't hang on exit
          });
        } catch (e) { }
        process.exit(0);
      };
      process.on('SIGINT', handleAbort);

      // Polling fallback
      let pollCount = 0;
      poll = setInterval(async () => {
        pollCount++;
        
        // Every 10 polls (30 seconds), show a hint
        if (pollCount % 10 === 0) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log(`  ${chalk.cyan('💡')} ${chalk.gray('Tip: Make sure to click "Authorize" in your browser')}`);
        }
        
        try {
          const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
          if (await fileExists(configPath)) {
            const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
            if (config.apiKey && config.apiKey.startsWith("txamcp-")) {
              process.stdout.write('\r' + ' '.repeat(80) + '\r');
              console.log("");
              log.success(chalk.bold("Authorization confirmed via local gateway sync!"));
              await cleanup("success_already_written");
            }
          }
        } catch (e) { }

        try {
          const hubUrl = await getHubUrl();
          const pollRes = await fetch(`${hubUrl}/api/auth/cli/poll?request_id=${request_id}`);
          const pollData = await safeParseJson(pollRes);
          
          if (pollData.error === 'EXPIRED' || pollData.success === false) {
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            await cleanup("expired");
          }

          if (pollData.status === 'authorized') {
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            log.success(chalk.bold("Authorization confirmed via polling!"));
            await cleanup("success", pollData.api_key, pollData.token);
          } else if (pollData.status === 'cancelled') {
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            await cleanup("cancelled");
          }
        } catch (e) { }
      }, 3000);
      return;
    } catch (err) {
      log.error("Network error: " + err.message);
      return;
    }
  }

  // Local Validation for manual API Key
  const validation = validateApiKeyFormat(apiKey);
  if (!validation.valid) {
    log.error(validation.message);
    console.log(chalk.gray(`Example: ${validation.example}`));
    return;
  }

  await completeLogin(apiKey);
}

async function completeLogin(apiKey, token = null) {
  // Ensure local validation even if called from browser flow (extra safety)
  const validation = validateApiKeyFormat(apiKey);
  if (!validation.valid) {
    log.error("Invalid key received: " + validation.message);
    return;
  }

  const configDir = path.resolve(os.homedir(), ".txamcp");
  const configPath = path.join(configDir, "config.json");

  log.step(chalk.bold("Verifying credentials with server..."));
  try {
    const hubUrl = await getHubUrl();
    const response = await fetch(`${hubUrl}/api/verify-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, cli_token: token })
    });
    const data = await safeParseJson(response);

    if (data.success) {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({
        apiKey, cliToken: token, user: data.user, lastSync: new Date().toISOString()
      }, null, 2));

      console.log("\n" + boxen(
        chalk.green.bold(` ACCESS GRANTED: ${data.user.username.toUpperCase()} `) + "\n\n" +
        chalk.white(`${chalk.bold('User :')} ${data.user.email || data.user.username}\n`) +
        chalk.white(`${chalk.bold('Plan :')} ${chalk.cyan(data.user.plan_name || "FREE")}\n`) +
        chalk.white(`${chalk.bold('Usage:')} ${chalk.bold(data.user.request_count || 0)} / ${chalk.gray(data.user.requests_total || "5,000")}`),
        { padding: 1, borderStyle: 'round', borderColor: 'green', backgroundColor: '#0f172a' }
      ));
      log.success("Session synchronized. CLI is ready for use.");
    } else {
      log.error(data.message || "Authentication failed.");
    }
  } catch (error) {
    log.error(`Connection error: ${error.message}`);
  }
}

async function logout() {
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  if (await fileExists(configPath)) {
    await fs.unlink(configPath).catch(() => { });
    console.log("");
    log.success("Logged out successfully. Local session cleared.");
  } else {
    log.warn("No active session found.");
  }
}

function getAppPaths() {
  const platform = os.platform();
  const home = os.homedir();
  const appData = process.env.APPDATA || "";
  return [
    { name: "Antigravity IDE", configPath: path.join(home, ".gemini", "antigravity-ide", "mcp_config.json") },
    { name: "Antigravity (old)", configPath: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
    { name: "Windsurf", configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
    { name: "Trae", configPath: platform === "win32" ? path.join(appData, "Trae", "User", "mcp.json") : path.join(home, ".config", "Trae", "User", "mcp.json") },
    { name: "Cursor", configPath: path.join(home, ".cursor", "mcp.json") },
    { name: "Claude Desktop", configPath: platform === "win32" ? path.join(appData, "Claude", "claude_desktop_config.json") : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") },
    { name: "Kiro IDE (User Config)", configPath: path.join(home, ".kiro", "settings", "mcp.json") }
  ].filter(ide => ide.configPath !== "");
}

// Detect Kiro IDE project config in current working directory
async function getKiroProjectConfig() {
  const cwd = process.cwd();
  const projectConfigPath = path.join(cwd, ".kiro", "settings", "mcp.json");
  
  if (await fileExists(projectConfigPath)) {
    return { name: "Kiro IDE (Project Config)", configPath: projectConfigPath };
  }
  return null;
}

async function setup() {
  log.step(chalk.bold("Configuring MCP interfaces for IDEs..."));
  const hubUrl = await getHubUrl();
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  let apiKey = "";
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, "utf-8"));
    apiKey = cfg.apiKey;
  } catch (e) { }

  const ides = getAppPaths();
  const serverPath = path.resolve(__dirname, "mcp-server.mjs");
  let integrations = [];

  // Check for Kiro project config in current directory
  const kiroProjectConfig = await getKiroProjectConfig();
  if (kiroProjectConfig) {
    ides.push(kiroProjectConfig);
  }

  for (const ide of ides) {
    const isKiro = ide.name.includes("Kiro");
    
    // For Kiro, check if config directory exists or create it
    // For other IDEs, check if parent directory exists
    const targetDir = isKiro ? path.dirname(ide.configPath) : path.dirname(ide.configPath);
    
    if (await fileExists(targetDir) || isKiro) {
      try {
        let settings = {};
        if (await fileExists(ide.configPath)) {
          const content = await fs.readFile(ide.configPath, "utf-8");
          try {
            settings = JSON.parse(content);
          } catch (parseError) {
            log.warn(`Existing config for ${ide.name} is invalid JSON. Overwriting...`);
          }
        }

        if (!settings.mcpServers) settings.mcpServers = {};
        delete settings.mcpServers["txamcp"]; // Remove legacy name if exists
        
        // Kiro uses txa command directly (like Antigravity uses antigravity cli)
        if (isKiro) {
          settings.mcpServers["txamcp"] = {
            "command": "txa",
            "args": ["mcp-server"],
            "env": {
              "API_KEY": apiKey,
              "HUB_URL": hubUrl
            },
            "disabled": false,
            "autoApprove": []
          };
        } else {
          settings.mcpServers["Txa_MCP"] = {
            "command": "node",
            "args": [serverPath],
            "env": {
              "API_KEY": apiKey,
              "HUB_URL": hubUrl,
              "TXAMCP_PROJECT_ROOT": "${workspaceFolder}",
              "TXAMCP_ACTIVE_FILE": "${file}",
              "TXAMCP_REQUIRE_ADD_ROOT": "1"
            }
          };
        }

        await fs.mkdir(path.dirname(ide.configPath), { recursive: true });
        await fs.writeFile(ide.configPath, JSON.stringify(settings, null, 2));

        log.success(`Integrated with ${chalk.bold.cyan(ide.name)}`);
        console.log(chalk.gray(`          Path: ${ide.configPath}`));

        integrations.push(ide);
      } catch (e) {
        log.error(`Failed to configure ${ide.name}: ${e.message}`);
      }
    }
  }

  if (integrations.length > 0) {
    const summary = integrations.map(i =>
      `  ${chalk.green('+')} ${chalk.bold(i.name.padEnd(25))} ${chalk.blue(i.configPath)}`
    ).join("\n");

    console.log("\n" + boxen(
      chalk.green.bold("  INTEGRATION COMPLETE!") + "\n\n" +
      summary + "\n\n" +
      chalk.white("  Please RESTART your IDEs to apply the new configuration."),
      {
        padding: 1,
        borderStyle: 'round',
        borderColor: 'green',
        title: ' Setup Success ',
        titleAlignment: 'left'
      }
    ));
  } else {
    log.warn("No compatible IDEs detected on this system.");
  }

  // Automatic extension installation from Open VSX
  console.log("");
  log.step(chalk.bold("Checking and installing VS Code Extension for detected IDEs..."));
  
  const extInstallers = [
    { name: "VS Code", bin: "code" },
    { name: "VSCodium", bin: "codium" },
    { name: "Cursor", bin: "cursor" },
    { name: "Windsurf", bin: "windsurf" },
    { name: "Trae", bin: "trae" }
  ];

  const execSyncOpt = { stdio: 'ignore', windowsHide: true };

  for (const item of extInstallers) {
    try {
      const checkCmd = os.platform() === 'win32' ? `where ${item.bin}` : `which ${item.bin}`;
      execSync(checkCmd, execSyncOpt);
      
      log.info(`Installing "Txa MCP" extension for ${chalk.bold.cyan(item.name)}...`);
      execSync(`${item.bin} --install-extension txahub.txamcp-vscode`, { stdio: 'inherit', windowsHide: true });
      log.success(`Successfully installed extension for ${item.name}!`);
    } catch (e) {
      // Quietly ignore if not found or fails
    }
  }
}

async function handleGetConfig() {
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  if (!(await fileExists(configPath))) return log.warn("Authentication required. Run 'txa login'.");

  log.step(chalk.bold("Fetching account metadata..."));
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  try {
    const hubUrl = await getHubUrl();
    const res = await fetch(`${hubUrl}/api/verify-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.apiKey, cli_token: config.cliToken })
    });
    const data = await safeParseJson(res);
    if (data.success) {
      const usage = data.user.request_count;
      const total = data.user.requests_total || 5000;
      const color = (usage / total > 0.8) ? chalk.red : (usage / total > 0.5) ? chalk.yellow : chalk.green;

      console.log("\n" + boxen(
        chalk.bold.cyan(" SESSION DETAILS ") + "\n\n" +
        `${chalk.bold("Identity :")} ${chalk.white(data.user.username)}\n` +
        `${chalk.bold("Tiers    :")} ${chalk.bold.magenta(data.user.plan_name)}\n` +
        `${chalk.bold("Activity :")} ${color(usage)} / ${chalk.gray(total)} requests\n` +
        `${chalk.bold("License  :")} ${chalk.gray(config.apiKey.substring(0, 12) + "...")}`,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan' }
      ));
    } else {
      log.error("Session expired. Please re-authenticate.");
    }
  } catch (e) { log.error(e.message); }
}

const args = process.argv.slice(2);
if (args[0] === "mcp-server") {
  // Directly run the MCP server
  const serverPath = path.resolve(__dirname, "mcp-server.mjs");
  const serverUrl = os.platform() === 'win32' 
    ? `file:///${serverPath.replace(/\\/g, '/')}`
    : `file://${serverPath}`;
  await import(serverUrl);
}
else if (args[0] === "setup") setup().catch(err => log.error(err.message));
else if (args[0] === "login") {
  const keyIdx = args.indexOf("--api-key");
  login(keyIdx !== -1 ? args[keyIdx + 1] : null).catch(err => log.error(err.message));
}
else if (args[0] === "get" && args[1] === "config") handleGetConfig().catch(err => log.error(err.message));
else if (args[0] === "logout") logout().catch(err => log.error(err.message));
else if (args[0] === "version" || args[0] === "-v" || args[0] === "--v" || args[0] === "--version") {
  console.log("\n" + boxen(
    chalk.bold.cyan(" TXAMCP CLI ENGINE ") + "\n\n" +
    chalk.white(`${chalk.bold('Version :')} ${chalk.bold.green(pkg.version)}\n`) +
    chalk.white(`${chalk.bold('License :')} ${chalk.yellow('MIT')}\n`) +
    chalk.white(`${chalk.bold('Channel :')} ${chalk.blue('stable')}`),
    { padding: 1, borderStyle: 'double', borderColor: 'cyan', title: ' System Info ', titleAlignment: 'center' }
  ));
}
else {
  const unknownCmd = args[0];
  const banner = chalk.bold.cyan(`
  ████████╗██╗  ██╗ █████╗ 
  ╚══██╔══╝╚██╗██╔╝██╔══██╗
     ██║    ╚███╔╝ ███████║
     ██║    ██╔██╗ ██╔══██║
     ██║   ██╔╝ ██╗██║  ██║
     ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝
    `) + chalk.bold.white(`MCP CLI v${pkg.version}`);

  if (unknownCmd && !["help", "--help", "-h"].includes(unknownCmd)) {
    console.log("");
    log.error(`Unknown command: ${chalk.bold.red(unknownCmd)}`);
  }

  console.log(boxen(banner, { padding: 0, borderStyle: 'none', textAlignment: 'center' }));
  console.log(chalk.gray.italic("    Advanced AI Context Management Hub\n"));

  console.log(chalk.bold("  COMMANDS:"));
  console.log(`    ${chalk.cyan("txa login")}        ${chalk.gray("Start automated browser login")}`);
  console.log(`    ${chalk.cyan("txa setup")}        ${chalk.gray("Configure MCP for all supported IDEs")}`);
  console.log(`    ${chalk.cyan("txa get config")}   ${chalk.gray("Display current session & usage stats")}`);
  console.log(`    ${chalk.cyan("txa version")}      ${chalk.gray("Show current version info")}`);
  console.log(`    ${chalk.cyan("txa logout")}       ${chalk.gray("Terminate local session\n")}`);

  console.log(chalk.bold("  EXAMPLES:"));
  console.log(chalk.green("    $ txa login --api-key txamcp-7106..."));
  console.log("");
}
