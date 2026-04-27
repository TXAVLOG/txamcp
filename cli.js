#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import chalk from "chalk";
import boxen from "boxen";
import { exec } from "child_process";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import { URL } from "url";

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
  if (!apiKey) {
    console.log("");
    log.step(chalk.bold("Initializing automated login flow..."));
    const computerName = os.hostname();
    const ipAddress = await getPublicIP();
    
    try {
      const res = await fetch("https://txahub.click/api/auth/cli/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            computer_name: computerName,
            ip_address: ipAddress
        })
      });
      const data = await res.json();
      if (!data.success) {
        log.error("Failed to initiate login request: " + (data.message || "Unknown error"));
        return;
      }

      const { request_id, auth_url } = data;
      const port = 2311;
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname === "/callback") {
            const status = url.searchParams.get("status");
            const key = url.searchParams.get("api_key");
            const token = url.searchParams.get("token");
            
            if (status === "success" && key) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">' +
                        '<h1 style="color: #10b981; font-size: 40px; margin-bottom: 10px;">SUCCESS!</h1>' +
                        '<p style="color: #94a3b8; font-size: 18px;">You have successfully authorized TXA CLI.</p>' +
                        '<p style="color: #64748b;">You can safely close this tab and return to your terminal.</p></div>');
                console.log("");
                log.success(chalk.bold("Authorization received from browser!"));
                server.close();
                await completeLogin(key, token);
                process.exit(0);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; min-height: 100vh;">' +
                        '<h1 style="color: #ef4444; font-size: 40px; margin-bottom: 10px;">CANCELLED</h1>' +
                        '<p style="color: #94a3b8; font-size: 18px;">Authorization request was denied.</p></div>');
                log.warn("Authorization request was cancelled.");
                server.close();
                process.exit(0);
            }
        }
      });

      server.listen(port);
      const start = (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
      exec(`${start} ${auth_url}`);
      
      console.log("\n" + boxen(
          chalk.white.bold("ACTION REQUIRED: Complete Login in Browser\n\n") +
          chalk.gray("A browser window should have opened automatically.\n") +
          chalk.gray("If not, please copy and paste this URL:\n\n") +
          chalk.cyan.underline(auth_url) + "\n\n" +
          chalk.magenta.italic("Waiting for secure connection..."),
          { padding: 1, borderStyle: 'double', borderColor: 'magenta', title: ' OAuth 2.0 Auth ', titleAlignment: 'center' }
      ));

      // Handle Ctrl+C to notify server
      const abortController = new AbortController();
      const handleAbort = async () => {
          console.log('\n\n  ' + chalk.yellow('!') + ' Aborting login flow...');
          try {
              await fetch("https://txahub.click/api/auth/cli/cancel", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ request_id: request_id }),
                  signal: AbortSignal.timeout(2000) // Don't hang on exit
              });
          } catch (e) {}
          process.exit(0);
      };
      process.on('SIGINT', handleAbort);

      // Polling fallback
      const poll = setInterval(async () => {
          try {
              const pollRes = await fetch(`https://txahub.click/api/auth/cli/poll?request_id=${request_id}`);
              const pollData = await pollRes.json();
              if (pollData.status === 'authorized') {
                  clearInterval(poll);
                  process.off('SIGINT', handleAbort);
                  server.close();
                  await completeLogin(pollData.api_key, pollData.token);
                  process.exit(0);
              } else if (pollData.status === 'cancelled') {
                  clearInterval(poll);
                  process.off('SIGINT', handleAbort);
                  server.close();
                  log.warn("Login was cancelled on the website.");
                  process.exit(0);
              }
          } catch (e) {}
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
    const response = await fetch("https://txahub.click/api/verify-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, cli_token: token })
    });
    const data = await response.json();

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
    await fs.unlink(configPath).catch(() => {});
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
    { name: "Antigravity", configPath: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
    { name: "Windsurf", configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
    { name: "Trae", configPath: platform === "win32" ? path.join(appData, "Trae", "User", "mcp.json") : path.join(home, ".config", "Trae", "User", "mcp.json") },
    { name: "Cursor", configPath: platform === "win32" ? path.join(appData, "Cursor", "User", "globalStorage", "cursor.mcp", "mcp.json") : path.join(home, ".config", "Cursor", "User", "globalStorage", "cursor.mcp", "mcp.json") },
    { name: "Claude Desktop", configPath: platform === "win32" ? path.join(appData, "Claude", "claude_desktop_config.json") : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") }
  ].filter(ide => ide.configPath !== "");
}

async function setup() {
  log.step(chalk.bold("Configuring MCP interfaces for IDEs..."));
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  let apiKey = "";
  try {
    const cfg = JSON.parse(await fs.readFile(configPath, "utf-8"));
    apiKey = cfg.apiKey;
  } catch(e) {}

  const ides = getAppPaths();
  const serverPath = path.resolve(__dirname, "mcp-server.mjs");
  let integrations = [];

  for (const ide of ides) {
    if (await fileExists(path.dirname(ide.configPath))) {
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
        delete settings.mcpServers["txamcp"]; // Gỡ bỏ tên cũ nếu tồn tại
        settings.mcpServers["Txa_MCP"] = { 
            "command": "node", 
            "args": [serverPath], 
            "env": { 
                "API_KEY": apiKey,
                "HUB_URL": "https://txahub.click"
            } 
        };
        
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
          `  ${chalk.green('+')} ${chalk.bold(i.name.padEnd(15))} ${chalk.blue(i.configPath)}`
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
}

async function handleGetConfig() {
  const configPath = path.resolve(os.homedir(), ".txamcp", "config.json");
  if (!(await fileExists(configPath))) return log.warn("Authentication required. Run 'txa login'.");
  
  log.step(chalk.bold("Fetching account metadata..."));
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  try {
    const res = await fetch("https://txahub.click/api/verify-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.apiKey, cli_token: config.cliToken })
    });
    const data = await res.json();
    if (data.success) {
      const usage = data.user.request_count;
      const total = data.user.requests_total || 5000;
      const color = (usage/total > 0.8) ? chalk.red : (usage/total > 0.5) ? chalk.yellow : chalk.green;
      
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
  } catch(e) { log.error("Server connection timeout."); }
}

const args = process.argv.slice(2);
if (args[0] === "setup") setup().catch(err => log.error(err.message));
else if (args[0] === "login") {
  const keyIdx = args.indexOf("--api-key");
  login(keyIdx !== -1 ? args[keyIdx+1] : null).catch(err => log.error(err.message));
}
else if (args[0] === "get" && args[1] === "config") handleGetConfig().catch(err => log.error(err.message));
else if (args[0] === "logout") logout().catch(err => log.error(err.message));
else {
    const banner = chalk.bold.cyan(`
  ████████╗██╗  ██╗ █████╗ 
  ╚══██╔══╝╚██╗██╔╝██╔══██╗
     ██║    ╚███╔╝ ███████║
     ██║    ██╔██╗ ██╔══██║
     ██║   ██╔╝ ██╗██║  ██║
     ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝
    `) + chalk.bold.white("MCP CLI v3.0");

    console.log(boxen(banner, { padding: 0, borderStyle: 'none', textAlignment: 'center' }));
    console.log(chalk.gray.italic("    Advanced AI Context Management Hub\n"));
    
    console.log(chalk.bold("  COMMANDS:"));
    console.log(`    ${chalk.cyan("txa login")}        ${chalk.gray("Start automated browser login")}`);
    console.log(`    ${chalk.cyan("txa setup")}        ${chalk.gray("Configure MCP for all supported IDEs")}`);
    console.log(`    ${chalk.cyan("txa get config")}   ${chalk.gray("Display current session & usage stats")}`);
    console.log(`    ${chalk.cyan("txa logout")}       ${chalk.gray("Terminate local session\n")}`);
    
    console.log(chalk.bold("  EXAMPLES:"));
    console.log(chalk.green("    $ txa login --api-key txamcp-7106..."));
    console.log("");
}
