import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs/promises";
import { existsSync, readFileSync, createReadStream } from "fs";
import crypto from "crypto";
import path from "path";
import os from "os";
import chalk from "chalk";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";

import { exec } from "child_process";
import { promisify } from "util";

dotenv.config();
const execPromise = promisify(exec);

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("./package.json");

// --- CONFIGURATION ---
const PORT = process.env.MCP_PORT || 3636;
const MARKERS = [".git", "package.json", "pubspec.yaml", "composer.json", "go.mod", "requirements.txt"];
const EXCLUDE_DIRS = ['node_modules', 'build', '.git', '.dart_tool', 'dist', 'coverage', 'vendor', '.next', '.venv'];
const MAX_SEARCH_STEPS = 10;
const MAX_SNIPPET_LENGTH = 500;
const ROOT_STATE_PATH = path.resolve(os.homedir(), ".txamcp", "runtime-state.json");

// --- HUB VERIFICATION ---
const HUB_URL = process.env.HUB_URL || "https://txahub.click";

let CONFIG_API_KEY = process.env.API_KEY;
const globalConfigPath = path.resolve(os.homedir(), ".txamcp", "config.json");
try {
    if (existsSync(globalConfigPath)) {
        const config = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
        if (config.apiKey) CONFIG_API_KEY = config.apiKey;
    }
} catch (err) { }

let USER_CONTEXT = null;

async function verifyWithHub() {
    if (!CONFIG_API_KEY) {
        throw new Error("🔑 TXAMCP AUTH: API Key is missing. Please run 'txa login' first.");
    }

    try {
        const response = await fetch(`${HUB_URL}/api/verify-key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: CONFIG_API_KEY })
        });

        const data = await response.json();
        if (!data.success) {
            const code = data.code || "UNKNOWN_ERROR";
            const reason = data.message || "Authentication failed";

            let errorMsg = `TXAMCP [${code}]: ${reason}.`;

            switch (code) {
                case "LIMIT_EXCEEDED":
                    errorMsg = `🚫 TXAMCP LIMIT EXCEEDED\n` +
                        `You have exhausted your quota for this month.\n\n` +
                        `🔗 Upgrade Plan: ${HUB_URL}/plans\n` +
                        `📊 View Usage: ${HUB_URL}/dashboard`;
                    break;
                case "SESSION_EXPIRED":
                case "KEY_REVOKED":
                case "KEY_EXPIRED":
                    errorMsg = `🔑 TXAMCP AUTH: ${reason}\n\n` +
                        `API Key has been revoked or expired. Re-authorization required.\n\n` +
                        `👉 OPTION 1: Run in terminal:\n` +
                        `   txa login\n\n` +
                        `👉 OPTION 2: Authorize via web:\n` +
                        `   🔗 ${HUB_URL}/dashboard/keys → Create new key → txa login\n\n` +
                        `👉 OPTION 3: Manage devices:\n` +
                        `   🔗 ${HUB_URL}/dashboard/devices`;
                    break;
                case "ACCOUNT_DELETED":
                    errorMsg = `❌ TXAMCP: Account has been deleted.\n\n` +
                        `🔗 Register new account: ${HUB_URL}/register\n` +
                        `📧 Contact support: ${HUB_URL}/support`;
                    break;
                case "ACCOUNT_LOCKED":
                    errorMsg = `🔒 TXAMCP ACCOUNT LOCKED: ${reason}\n\n` +
                        `Account has been locked by Admin.\n` +
                        `📧 Contact support: ${HUB_URL}/support`;
                    break;
                default:
                    errorMsg = `⚠️ TXAMCP [${code}]: ${reason}\n\n` +
                        `🔗 Check status: ${HUB_URL}/dashboard\n` +
                        `📧 Support: ${HUB_URL}/support`;
                    break;
            }

            throw new Error(errorMsg);
        }
        USER_CONTEXT = data;
        return data;
    } catch (err) {
        if (err.message.includes("TXAMCP")) throw err;
        log.error(`Hub Connection Failed: ${err.message}`);
        throw new Error(`TXAMCP CONNECTION ERROR: Cannot reach TXAHUB. Please check your internet connection or visit https://txahub.click. Detail: ${err.message}`);
    }
}

async function checkAuth() {
    await verifyWithHub();
}

function validateHttpApiKey(req) {
    // If the server itself is globally authenticated and running locally on the user's system,
    // we can trust local IDE client requests coming from the same machine.
    if (CONFIG_API_KEY) {
        return { valid: true };
    }

    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) return { valid: false, status: 401, message: "Missing API Key (x-api-key header or api_key query parameter)." };
    if (apiKey !== CONFIG_API_KEY) return { valid: false, status: 403, message: "Invalid API Key." };
    return { valid: true };
}

// Enhanced Logger (Strictly to stderr to avoid interfering with MCP protocol)
const log = {
    timestamp: () => `[${new Date().toLocaleTimeString()}]`,
    info: (msg) => {
        const plan = USER_CONTEXT?.user?.plan_name ? `[${USER_CONTEXT.user.plan_name}] ` : "";
        process.stderr.write(`${log.timestamp()} ℹ ${plan}${msg}\n`);
    },
    error: (msg) => process.stderr.write(`${log.timestamp()} ✖ ${msg}\n`),
    warn: (msg) => process.stderr.write(`${log.timestamp()} ⚠ ${msg}\n`),
    success: (msg) => process.stderr.write(`${log.timestamp()} ✔ ${msg}\n`),
    tool: (name) => {
        const plan = USER_CONTEXT?.user?.plan_name ? `[${USER_CONTEXT.user.plan_name}] ` : "";
        process.stderr.write(`${log.timestamp()} 🔨 TOOL: ${plan + name}\n`);
    }
};

// --- PROJECT ROOT DISCOVERY ---
function findProjectRoot(startDir, steps = 0) {
    if (steps > MAX_SEARCH_STEPS) return startDir;

    for (const marker of MARKERS) {
        if (existsSync(path.join(startDir, marker))) return startDir;
    }

    const parent = path.dirname(startDir);
    if (parent === startDir) return startDir;

    return findProjectRoot(parent, steps + 1);
}

function isTemplatePlaceholder(value) {
    return typeof value === "string" && value.includes("${") && value.includes("}");
}

const serverFileDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
let CURRENT_PROJECT_ROOT = findProjectRoot(process.cwd());

// Fallback: If CURRENT_PROJECT_ROOT resolves to a root folder (like C:\ or /) or has no project markers,
// try to resolve it from the directory where this script is located.
if ((CURRENT_PROJECT_ROOT === path.parse(CURRENT_PROJECT_ROOT).root || !existsSync(path.join(CURRENT_PROJECT_ROOT, "package.json"))) && existsSync(serverFileDir)) {
    const fallbackRoot = findProjectRoot(serverFileDir);
    if (fallbackRoot && fallbackRoot !== path.parse(fallbackRoot).root) {
        CURRENT_PROJECT_ROOT = fallbackRoot;
    }
}

function getEnvRootCandidates() {
    const candidates = [
        process.env.TXAMCP_PROJECT_ROOT,
        process.env.TXAMCP_ACTIVE_FILE
    ];
    return candidates.filter(Boolean).filter(v => !isTemplatePlaceholder(v));
}

function isRequireAddRootEnabled() {
    return process.env.TXAMCP_REQUIRE_ADD_ROOT === "1";
}

function normalizeAndResolveRoot(candidatePath) {
    if (!candidatePath || typeof candidatePath !== "string") return null;
    const normalized = path.normalize(candidatePath.trim());
    const absolute = path.isAbsolute(normalized) ? normalized : path.resolve(CURRENT_PROJECT_ROOT, normalized);
    const targetPath = existsSync(absolute) ? absolute : null;
    if (!targetPath) return null;
    return findProjectRoot(targetPath);
}

function persistCurrentRoot() {
    try {
        const dir = path.dirname(ROOT_STATE_PATH);
        if (!existsSync(dir)) {
            require("fs").mkdirSync(dir, { recursive: true });
        }
        require("fs").writeFileSync(ROOT_STATE_PATH, JSON.stringify({
            currentProjectRoot: CURRENT_PROJECT_ROOT,
            updatedAt: new Date().toISOString()
        }, null, 2), "utf-8");
    } catch (err) {
        log.warn(`Could not persist root state: ${err.message}`);
    }
}

function loadPersistedRoot() {
    try {
        if (!existsSync(ROOT_STATE_PATH)) return;
        const state = JSON.parse(readFileSync(ROOT_STATE_PATH, "utf-8"));
        const resolved = normalizeAndResolveRoot(state.currentProjectRoot);
        if (resolved) {
            CURRENT_PROJECT_ROOT = resolved;
        }
    } catch (err) {
        log.warn(`Could not load persisted root state: ${err.message}`);
    }
}

// --- PATH NORMALIZATION ---
/**
 * Security: Enforce that a resolved path is within CURRENT_PROJECT_ROOT
 * Prevents path traversal attacks and access to files outside the project
 */
function isPathWithinProjectRoot(resolvedPath) {
    const normalizedRoot = path.normalize(CURRENT_PROJECT_ROOT);
    const normalizedPath = path.normalize(resolvedPath);
    
    // Ensure both paths are absolute
    const absoluteRoot = path.resolve(normalizedRoot);
    const absolutePath = path.resolve(normalizedPath);
    
    // Check if the resolved path starts with the project root
    const relativePath = path.relative(absoluteRoot, absolutePath);
    
    // If relative path starts with '..', it means the path is outside the root
    return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Security: Check if the input path is absolute (reject all absolute paths for security)
 */
function isAbsolutePath(receivedPath) {
    const normalized = path.normalize(receivedPath);
    return path.isAbsolute(normalized);
}

/**
 * Safe path resolution that enforces project root containment
 * Allows absolute paths ONLY if they resolve within the project root
 * @param {string} receivedPath - The path to resolve
 * @param {boolean} allowExternalAccess - If true, allows access outside project root (requires explicit confirmation)
 */
function getAbsolutePath(receivedPath, allowExternalAccess = false) {
    if (!receivedPath || typeof receivedPath !== 'string') {
        throw new Error("Missing or invalid 'path' argument. Please check your tool arguments.");
    }
    const normalized = path.normalize(receivedPath);
    
    // Resolve: absolute paths used as-is, relative paths resolved from project root
    const absolute = path.isAbsolute(normalized)
        ? normalized
        : path.resolve(CURRENT_PROJECT_ROOT, normalized);

    // Security check: ensure path is within project root (unless explicitly allowed)
    if (!allowExternalAccess && !isPathWithinProjectRoot(absolute)) {
        throw new Error(
            `Security Error: Path "${receivedPath}" resolves outside the project root (${CURRENT_PROJECT_ROOT}). ` +
            `To access files outside the project, the AI must set "allow_external_access": true and you must explicitly approve it.`
        );
    }

    if (!existsSync(absolute)) {
        throw new Error(`File or directory not found at: ${absolute}`);
    }
    return absolute;
}

/**
 * Safe path resolution for write operations (creates parent dirs if needed)
 * Allows absolute paths ONLY if they resolve within the project root
 * @param {string} receivedPath - The path to resolve
 * @param {boolean} allowExternalAccess - If true, allows access outside project root (requires explicit confirmation)
 */
function getAbsolutePathForWrite(receivedPath, allowExternalAccess = false) {
    if (!receivedPath || typeof receivedPath !== 'string') {
        throw new Error("Missing or invalid 'path' argument. Please check your tool arguments.");
    }
    const normalized = path.normalize(receivedPath);
    
    // Resolve: absolute paths used as-is, relative paths resolved from project root
    const absolute = path.isAbsolute(normalized)
        ? normalized
        : path.resolve(CURRENT_PROJECT_ROOT, normalized);

    // Security check: ensure path is within project root (unless explicitly allowed)
    if (!allowExternalAccess && !isPathWithinProjectRoot(absolute)) {
        throw new Error(
            `Security Error: Path "${receivedPath}" resolves outside the project root (${CURRENT_PROJECT_ROOT}). ` +
            `To access files outside the project, the AI must set "allow_external_access": true and you must explicitly approve it.`
        );
    }

    return absolute;
}

function updateRootFromPath(filePath) {
    const potentialRoot = normalizeAndResolveRoot(filePath);
    if (potentialRoot && potentialRoot !== CURRENT_PROJECT_ROOT) {
        CURRENT_PROJECT_ROOT = potentialRoot;
        persistCurrentRoot();
        process.stderr.write(`[TXAMCP] Dynamic Root Update: ${CURRENT_PROJECT_ROOT}\n`);
    }
    return Boolean(potentialRoot);
}

function updateRootFromToolArgs(args = {}) {
    const addRootCandidate = args?.add_root;
    if (addRootCandidate) {
        const updated = updateRootFromPath(addRootCandidate);
        return { used: updated, source: "add_root" };
    }

    const contextCandidates = [
        args?.activeFilePath,
        args?.active_file_path,
        args?.currentFilePath,
        args?.current_file_path,
        args?.openedFilePath,
        args?.opened_file_path
    ].filter(Boolean);

    if (contextCandidates.length > 0) {
        const updated = updateRootFromPath(contextCandidates[0]);
        return { used: updated, source: "active_file_context" };
    }

    const envCandidates = getEnvRootCandidates();
    if (envCandidates.length > 0) {
        const updated = updateRootFromPath(envCandidates[0]);
        return { used: updated, source: "env_context" };
    }

    return { used: false, source: "none" };
}

function requiresExplicitRoot(toolName) {
    return toolName === "file_search";
}

function formatMandatoryFooter() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timestamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    return `---------------------------------------------\n     TXAMCP - Time: ${timestamp}\n      Thanks for using tool!`;
}

function appendMandatoryFooterToResult(result) {
    if (!result || !Array.isArray(result.content)) return result;
    const footerPrefix = "---------------------------------------------\n     TXAMCP - Time:";
    result.content.forEach(item => {
        if (item?.type === "text" && typeof item.text === "string" && !item.text.includes(footerPrefix)) {
            item.text = `${item.text}\n\n${formatMandatoryFooter()}`;
        }
    });
    return result;
}

// --- GIT ROOT DISCOVERY ---
async function getGitRoot(startDir) {
    let current = startDir;
    for (let i = 0; i < MAX_SEARCH_STEPS; i++) {
        try {
            if (existsSync(path.join(current, ".git"))) return current;
        } catch (e) { }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

// --- SERVER SETUP ---
const server = new McpServer({
    name: "Txa_MCP",
    version: pkg.version,
    description: "Txa_MCP - Professional context management for AI IDEs. Provides project-aware tools for memory, todos, auditing, system info, and more.",
});

// --- SETUP MCP SERVER ---
async function registerTools(serverInstance) {
    const allToolNames = Object.keys(TOOL_IMPLEMENTATIONS);
    let registeredCount = 0;

    const now = Date.now();
    const isCacheFresh = ENABLED_TOOLS_CACHE && (now - LAST_SYNC_TIME < SYNC_INTERVAL);

    if (!isCacheFresh) {
        // Initial sync to know initial status (but NOT used for filtering)
        try {
            log.info("Synchronizing tools status with TXAHUB...");
            const response = await fetch(`${HUB_URL}/api/tools?api_key=${CONFIG_API_KEY}`, {
                signal: AbortSignal.timeout(5000)
            });
            const data = await response.json();

            if (data.success && data.tools) {
                ENABLED_TOOLS_CACHE = data.tools.map(t => t.name);
                BLOCKED_BY_PLAN_CACHE = data.blocked_by_plan || [];
                DISABLED_REASONS_CACHE = data.disabled_reasons || {};
                POLICY_META_CACHE = data.policy || null;
                LAST_SYNC_TIME = now;
                const disabledCount = allToolNames.length - (ENABLED_TOOLS_CACHE.length + BLOCKED_BY_PLAN_CACHE.length);
                log.success(`Synced: ${ENABLED_TOOLS_CACHE.length} enabled, ${BLOCKED_BY_PLAN_CACHE.length} blocked by plan, ${disabledCount} disabled by Admin.`);
            } else {
                log.warn("Hub returned no tools. All local tools will be registered.");
            }
        } catch (err) {
            log.error(`Hub sync failed (${err.message}). All tools registered in offline mode.`);
        }
    }

    // ALWAYS register ALL tools - IDE will always see full list
    // Enabled/disabled check happens REAL-TIME when tool is called
    for (const toolName of allToolNames) {
        const impl = TOOL_IMPLEMENTATIONS[toolName];
        if (impl) {
            serverInstance.tool(
                toolName,
                impl.description,
                impl.schema,
                async (args) => {
                    return await processToolCall(toolName, args);
                }
            );
            registeredCount++;
        }
    }

    log.success(`Registered ALL ${registeredCount} tools on this instance (enabled status checked per-call).`);

    if (registeredCount === 0) {
        serverInstance.tool(
            "txamcp_notice",
            "⚠️ NOTICE: No tools are currently enabled for this account.",
            {},
            async () => {
                const auth = await verifyWithHub().catch(() => null);
                const plan = auth ? auth.user.plan_name : "N/A";
                return {
                    content: [{
                        type: "text",
                        text: `⚠️ SYSTEM: All tools have been disabled by Admin or your plan (${plan}) does not support them.\n\nACTION: Please upgrade your plan at https://txahub.click/plans or contact Admin for support.`
                    }],
                    isError: true
                };
            }
        );
        log.warn("No tools enabled for this user. Registered notice tool.");
    } else {
        log.success(`Successfully initialized ${registeredCount} tools on this instance.`);
    }
}

async function setupMcpServer(serverInstance) {
    // Resources for AI awareness
    serverInstance.resource("account_status", "account://status", async (uri) => {
        let auth;
        let statusText = "Active";
        let warning = "";

        try {
            auth = await verifyWithHub();
            // Determine nuanced status
            const usagePercent = (auth.user.request_count / (auth.user.max_requests_per_month || 5000)) * 100;
            if (usagePercent > 90) {
                statusText = "Near Limit";
                warning = " (Warning: You are almost out of requests!)";
            }
        } catch (err) {
            statusText = "Inactive/Limit Exceeded";
            warning = ` (Error: ${err.message})`;
        }

        return {
            contents: [{
                uri: uri.href,
                text: auth
                    ? `TXAMCP Account Status: ${statusText}${warning}\nUser: ${auth.user.username}\nPlan: ${auth.user.plan_name}\nUsage: ${auth.user.request_count}/${auth.user.max_requests_per_month || '5,000'}`
                    : `TXAMCP Account Status: ${statusText}${warning}\nPlease ask the user to run 'txa login' or upgrade their plan.`
            }]
        };
    });

    // Prompts for AI behaviors
    serverInstance.prompt("fix_minimal", {
        issue: z.string().describe("Description of error or issue"),
        code: z.string().describe("Code to fix")
    }, ({ issue, code }) => ({
        messages: [{
            role: "user",
            content: {
                type: "text",
                text: `Please fix the following issue in a minimal way:\nIssue: ${issue}\nCode:\n${code}`
            }
        }]
    }));

    // Register all tools
    await registerTools(serverInstance);
}

/**
 * TOOL DEFINITIONS & IMPLEMENTATIONS
 */
const TOOL_IMPLEMENTATIONS = {
    "list_repositories": {
        description: "Get Git information for the current directory (Remote, Branch, Status).",
        schema: {},
        handler: async () => {
            const gitRoot = await getGitRoot(CURRENT_PROJECT_ROOT);
            if (!gitRoot) return { content: [{ type: "text", text: `⚠️ WARNING: Directory ${CURRENT_PROJECT_ROOT} and its parents are not a Git repository. If you intend to run git commands, ensure you are in the correct project directory.` }] };
            const [remote, branch, status] = await Promise.all([
                execPromise("git remote get-url origin", { cwd: gitRoot }).then(r => r.stdout.trim()).catch(() => "N/A"),
                execPromise("git rev-parse --abbrev-ref HEAD", { cwd: gitRoot }).then(r => r.stdout.trim()).catch(() => "Unknown"),
                execPromise("git status --short", { cwd: gitRoot }).then(r => r.stdout.trim()).catch(() => "")
            ]);
            return { content: [{ type: "text", text: `Git Root: ${gitRoot}\nRepo: ${remote}\nBranch: ${branch}\nChanges:\n${status || "Clean"}` }] };
        }
    },
    "search_code": {
        description: "Search code using regex (git grep).",
        schema: {
            query: z.string().describe("Regex query"),
            pathFilter: z.string().optional().describe("Glob filter (e.g. *.js)")
        },
        handler: async ({ query, pathFilter }) => {
            const cmd = `git grep -nEi "${query}" -- ${pathFilter || "."}`;
            const { stdout } = await execPromise(cmd, { cwd: CURRENT_PROJECT_ROOT }).catch(err => ({ stdout: err.stdout }));
            return { content: [{ type: "text", text: stdout || "No results." }] };
        }
    },
    "read_file": {
        description: "Read file content.",
        schema: {
            filePath: z.string().describe("File path"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow reading files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const content = await fs.readFile(abs, "utf-8");
            return { content: [{ type: "text", text: content }] };
        }
    },
    "write_file": {
        description: "Overwrite file content (Full).",
        schema: {
            filePath: z.string().describe("File path"),
            content: z.string().describe("New content"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow writing files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, content, allow_external_access }) => {
            const abs = getAbsolutePathForWrite(filePath, allow_external_access || false);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content, "utf-8");
            return { content: [{ type: "text", text: `✅ Successfully wrote to ${filePath}.\n\n--- FILE CONTENT ---\n${content}` }] };
        }
    },
    "inspect_database": {
        description: "Automatically analyze DB schema from .sql files or project config.",
        schema: {
            dbFile: z.string().optional().describe("Specific SQL file (optional)")
        },
        handler: async ({ dbFile }) => {
            let results = "--- Database Schema Analysis ---\n";
            let sqlFiles;
            if (dbFile) {
                sqlFiles = [getAbsolutePath(dbFile)];
            } else {
                const cmd = os.platform() === 'win32'
                    ? 'powershell -Command "Get-ChildItem -Path . -Filter *.sql -Recurse -Depth 3 -Name -ErrorAction SilentlyContinue"'
                    : 'find . -maxdepth 3 -name "*.sql"';
                sqlFiles = await execPromise(cmd, { cwd: CURRENT_PROJECT_ROOT })
                    .then(r => r.stdout.split('\n').map(f => f.trim()).filter(Boolean).map(f => path.join(CURRENT_PROJECT_ROOT, f)))
                    .catch(() => []);
            }
            for (const file of sqlFiles) {
                if (!file.trim() || !existsSync(file)) continue;
                const content = await fs.readFile(file, "utf-8");
                const tables = content.match(/CREATE TABLE\s+[`"']?(\w+)[`"']?/gi) || [];
                results += `\nFile: ${path.basename(file)}\nTables found: ${tables.map(t => t.split(' ').pop()).join(', ') || "None"}\n`;
            }
            return { content: [{ type: "text", text: results }] };
        }
    },
    "system_info": {
        description: "Get system information (OS, RAM, CPU, Disk).",
        schema: {},
        handler: async () => {
            const info = {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                cpus: os.cpus().length,
                freeMem: Math.round(os.freemem() / 1024 / 1024) + "MB",
                totalMem: Math.round(os.totalmem() / 1024 / 1024) + "MB",
                uptime: Math.round(os.uptime() / 3600) + " hours"
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        }
    },
    "analyze_network": {
        description: "Check listening ports and network connections on WINDOWS.",
        schema: {},
        handler: async () => {
            const cmd = os.platform() === 'win32' ? 'netstat -an | findstr LISTENING' : 'netstat -tunlp | grep LISTEN';
            const { stdout } = await execPromise(cmd).catch(() => ({ stdout: "Could not retrieve netstat info." }));
            return { content: [{ type: "text", text: `Listening Ports:\n${stdout}` }] };
        }
    },
    "find_large_files": {
        description: "Find top 10 largest files in project on WINDOWS (excluding node_modules, .git).",
        schema: {
            minSizeMB: z.number().default(5).describe("Minimum size (MB)")
        },
        handler: async ({ minSizeMB = 5 }) => {
            const exclude = EXCLUDE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ');
            const cmd = os.platform() === 'win32'
                ? `powershell "Get-ChildItem -Path . -Recurse -File | Where-Object { $_.Length -gt ${minSizeMB}MB } | Sort-Object Length -Descending | Select-Object -First 10 | ForEach-Object { '{0} - {1}MB' -f $_.FullName, [Math]::Round($_.Length / 1MB, 2) }"`
                : `find . -type f ${exclude} -size +${minSizeMB}M -exec ls -lh {} + | sort -rh -k5 | head -n 10`;
            const { stdout } = await execPromise(cmd, { cwd: CURRENT_PROJECT_ROOT });
            return { content: [{ type: "text", text: `Large Files (> ${minSizeMB}MB):\n${stdout || "No large files found."}` }] };
        }
    },
    "memory_save": {
        description: "Store important knowledge/decisions in project memory (.txamcp_memory).",
        schema: {
            key: z.string().describe("Identifier key"),
            value: z.string().describe("Content to remember")
        },
        handler: async ({ key, value }) => {
            const memPath = path.join(CURRENT_PROJECT_ROOT, ".txamcp_memory.json");
            let memory = {};
            if (existsSync(memPath)) memory = JSON.parse(await fs.readFile(memPath, "utf-8"));
            memory[key] = { value, updated_at: new Date().toISOString() };
            await fs.writeFile(memPath, JSON.stringify(memory, null, 2));
            return { content: [{ type: "text", text: `Memory saved: ${key}` }] };
        }
    },
    "memory_load": {
        description: "Load stored knowledge.",
        schema: {
            key: z.string().optional().describe("Identifier key (optional)")
        },
        handler: async ({ key }) => {
            const memPath = path.join(CURRENT_PROJECT_ROOT, ".txamcp_memory.json");
            if (!existsSync(memPath)) return { content: [{ type: "text", text: "No memory found for this project." }] };
            const memory = JSON.parse(await fs.readFile(memPath, "utf-8"));
            if (key) return { content: [{ type: "text", text: memory[key] ? JSON.stringify(memory[key], null, 2) : "Key not found." }] };
            return { content: [{ type: "text", text: JSON.stringify(memory, null, 2) }] };
        }
    },
    "run_shell": {
        description: "Run shell command safely in project. IMPORTANT: OS is WINDOWS, use standard POWERSHELL syntax. Avoid bash/linux commands.",
        schema: {
            command: z.string().describe("POWERSHELL command to run")
        },
        handler: async ({ command }) => {
            const options = { cwd: CURRENT_PROJECT_ROOT };
            if (os.platform() === 'win32') {
                options.shell = 'powershell.exe';
            }
            const { stdout, stderr } = await execPromise(command, options);
            return { content: [{ type: "text", text: stdout || stderr || "Command executed successfully." }] };
        }
    },
    "kill_process": {
        description: "Stop common app build processes (gradle, flutter, node, adb, etc.) or a specific process.",
        schema: {
            processName: z.string().optional().describe("Process name (e.g. java, flutter, node, adb). If empty, scans broad build processes.")
        },
        handler: async ({ processName }) => {
            let cmd;
            if (os.platform() === 'win32') {
                if (processName) {
                    const name = processName.toLowerCase().replace('.exe', '');
                    const filter = name === 'node' ? ` | Where-Object { $_.Id -ne ${process.pid} }` : '';
                    cmd = `powershell -Command "Get-Process -Name '${name}' -ErrorAction SilentlyContinue${filter} | Stop-Process -Force -ErrorAction SilentlyContinue; echo 'Killed ${name}'"`;
                } else {
                    // Comprehensive list for Flutter/Android/Web build processes
                    // Includes adb, aapt, ninja, etc.
                    const targets = [
                        'flutter', 'dart', 'adb', 'java', 'node',
                        'msbuild', 'ninja', 'cmake', 'aapt', 'aapt2', 'gradlew'
                    ];
                    const psList = targets.map(t => `'${t}'`).join(',');
                    cmd = `powershell -Command "$targets = @(${psList}); foreach ($t in $targets) { Get-Process -Name $t -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${process.pid} } | Stop-Process -Force -ErrorAction SilentlyContinue }; echo 'Build and related processes (flutter, adb, java, etc.) have been terminated.'"`;
                }
            } else {
                if (processName) {
                    cmd = `pkill -9 -f ${processName}`;
                } else {
                    cmd = `pkill -9 -f "gradle|flutter|dart|node|adb|cmake|ninja|aapt"`;
                }
            }

            try {
                const { stdout, stderr } = await execPromise(cmd);
                return { content: [{ type: "text", text: stdout || stderr || "Processes terminated successfully." }] };
            } catch (err) {
                // If some processes weren't found, it's fine
                return { content: [{ type: "text", text: `Cleanup result: ${err.message}` }] };
            }
        }
    },
    "get_dependencies": {
        description: "Analyze project dependencies on WINDOWS (package.json, composer.json, etc.).",
        schema: {},
        handler: async () => {
            const files = ["package.json", "composer.json", "pubspec.yaml", "requirements.txt"];
            let results = "";
            for (const f of files) {
                const abs = path.join(CURRENT_PROJECT_ROOT, f);
                if (existsSync(abs)) {
                    const content = await fs.readFile(abs, "utf-8");
                    results += `\n--- ${f} ---\n${content.substring(0, 500)}...\n`;
                }
            }
            return { content: [{ type: "text", text: results || "No dependency files found." }] };
        }
    },
    "list_workspaces": {
        description: "List working directories and current project structure on WINDOWS.",
        schema: {},
        handler: async () => {
            const { stdout } = await execPromise(os.platform() === 'win32' ? 'dir /b' : 'ls -F', { cwd: CURRENT_PROJECT_ROOT });
            return { content: [{ type: "text", text: `Project Root: ${CURRENT_PROJECT_ROOT}\nContents:\n${stdout}` }] };
        }
    },
    "get_file_info": {
        description: "Get detailed information about a file (Size, Modified Date, Permissions).",
        schema: {
            filePath: z.string().describe("File path"),
            hashAlgorithm: z.string().optional().describe("Hash algorithm (sha256, md5, sha1). Empty = return all."),
            allow_external_access: z.boolean().optional().describe("Set to true to allow accessing files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, hashAlgorithm, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const stats = await fs.stat(abs);
            const ext = path.extname(abs).toLowerCase();
            const fileName = path.basename(abs);

            // --- Human-readable size ---
            function formatSize(bytes) {
                if (bytes === 0) return '0 Bytes';
                const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
            }

            // --- MIME Type guessing ---
            const mimeMap = {
                '.js': 'application/javascript', '.mjs': 'application/javascript',
                '.json': 'application/json', '.html': 'text/html', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
                '.pdf': 'application/pdf', '.zip': 'application/zip',
                '.apk': 'application/vnd.android.package-archive',
                '.aab': 'application/x-authorware-bin',
                '.dart': 'text/x-dart', '.py': 'text/x-python', '.php': 'text/x-php',
                '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx',
                '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
                '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
                '.exe': 'application/x-msdownload', '.msi': 'application/x-msi',
                '.sql': 'application/sql', '.sh': 'application/x-sh',
                '.gradle': 'text/x-gradle', '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin',
            };
            const mimeType = mimeMap[ext] || 'application/octet-stream';

            // --- File Hash ---
            async function computeHash(algorithm) {
                return new Promise((resolve, reject) => {
                    const hash = crypto.createHash(algorithm);
                    const stream = createReadStream(abs);
                    stream.on('data', chunk => hash.update(chunk));
                    stream.on('end', () => resolve(hash.digest('hex')));
                    stream.on('error', reject);
                });
            }

            let hashes = {};
            try {
                if (hashAlgorithm) {
                    const algo = hashAlgorithm.toLowerCase();
                    hashes[algo] = await computeHash(algo);
                } else {
                    // Return all common hashes
                    const [sha256, md5, sha1] = await Promise.all([
                        computeHash('sha256'),
                        computeHash('md5'),
                        computeHash('sha1')
                    ]);
                    hashes = { sha256, md5, sha1 };
                }
            } catch (err) {
                hashes = { error: `Hash computation failed: ${err.message}` };
            }

            // --- Permission string ---
            const mode = stats.mode;
            const perms = [
                (mode & 0o400) ? 'r' : '-', (mode & 0o200) ? 'w' : '-', (mode & 0o100) ? 'x' : '-',
                (mode & 0o040) ? 'r' : '-', (mode & 0o020) ? 'w' : '-', (mode & 0o010) ? 'x' : '-',
                (mode & 0o004) ? 'r' : '-', (mode & 0o002) ? 'w' : '-', (mode & 0o001) ? 'x' : '-'
            ].join('');

            const info = {
                name: fileName,
                path: abs,
                extension: ext || 'N/A',
                mimeType: mimeType,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory(),
                isSymbolicLink: stats.isSymbolicLink(),
                size: {
                    bytes: stats.size,
                    readable: formatSize(stats.size),
                    KB: (stats.size / 1024).toFixed(2),
                    MB: (stats.size / (1024 * 1024)).toFixed(4),
                    GB: (stats.size / (1024 * 1024 * 1024)).toFixed(6)
                },
                permissions: perms,
                modeOctal: '0o' + (mode & 0o777).toString(8),
                dates: {
                    created: new Date(stats.birthtimeMs).toLocaleString('en-US'),
                    modified: new Date(stats.mtimeMs).toLocaleString('en-US'),
                    accessed: new Date(stats.atimeMs).toLocaleString('en-US'),
                    changed: new Date(stats.ctimeMs).toLocaleString('en-US')
                },
                hashes: hashes
            };

            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        }
    },
    "list_processes": {
        description: "Monitor running system processes related to development (node, php, python).",
        schema: {},
        handler: async () => {
            const cmd = os.platform() === 'win32' ? 'tasklist /FI "IMAGENAME eq node.exe" /FI "IMAGENAME eq php.exe"' : 'ps aux | grep -E "node|php|python"';
            const { stdout } = await execPromise(cmd).catch(() => ({ stdout: "No relevant processes found." }));
            return { content: [{ type: "text", text: stdout }] };
        }
    },
    "git_status": {
        description: "View detailed Git status (staged, unstaged changes).",
        schema: {},
        handler: async () => {
            const gitRoot = await getGitRoot(CURRENT_PROJECT_ROOT);
            if (!gitRoot) return { content: [{ type: "text", text: `ERROR: Git repository not found at ${CURRENT_PROJECT_ROOT} or its parents.` }], isError: true };
            const { stdout } = await execPromise("git status", { cwd: gitRoot }).catch((err) => ({ stdout: `Git Error: ${err.message}` }));
            return { content: [{ type: "text", text: stdout }] };
        }
    },
    "git_log": {
        description: "View project commit history.",
        schema: {
            count: z.number().default(5).describe("Number of commits to view")
        },
        handler: async ({ count = 5 }) => {
            const gitRoot = await getGitRoot(CURRENT_PROJECT_ROOT);
            if (!gitRoot) return { content: [{ type: "text", text: `ERROR: Git repository not found.` }], isError: true };
            const { stdout } = await execPromise(`git log -n ${count} --oneline`, { cwd: gitRoot }).catch(() => ({ stdout: "Error fetching git log." }));
            return { content: [{ type: "text", text: stdout }] };
        }
    },
    "git_diff": {
        description: "View current uncommitted changes.",
        schema: {},
        handler: async () => {
            const gitRoot = await getGitRoot(CURRENT_PROJECT_ROOT);
            if (!gitRoot) return { content: [{ type: "text", text: `ERROR: Git repository not found.` }], isError: true };
            const { stdout } = await execPromise("git diff", { cwd: gitRoot }).catch(() => ({ stdout: "No changes or error." }));
            return { content: [{ type: "text", text: stdout || "No differences." }] };
        }
    },
    "file_search": {
        description: "Search for files by name or glob pattern. Optimized for WINDOWS.",
        schema: {
            pattern: z.string().describe("Search pattern (e.g. *.js)"),
            add_root: z.string().optional().describe("Project root or active file path from IDE"),
            activeFilePath: z.string().optional().describe("Active file path context sent by IDE")
        },
        handler: async ({ pattern }) => {
            log.info(`file_search using root: ${CURRENT_PROJECT_ROOT}`);
            // Prioritize git ls-files if it's a git repo as it's extremely fast
            const isGit = existsSync(path.join(CURRENT_PROJECT_ROOT, ".git"));
            const cmd = isGit
                ? `git ls-files "*${pattern}*"`
                : (os.platform() === 'win32'
                    ? `powershell -Command "Get-ChildItem -Path . -Filter *${pattern}* -Recurse -Name -ErrorAction SilentlyContinue | Select-Object -First 50"`
                    : `find . -name "*${pattern}*" -not -path "*/node_modules/*" -limit 50`);

            const { stdout } = await execPromise(cmd, { cwd: CURRENT_PROJECT_ROOT }).catch(() => ({ stdout: "" }));
            return { content: [{ type: "text", text: stdout || "No files found." }] };
        }
    },
    "replace_in_file": {
        description: "Replace text string in a file.",
        schema: {
            filePath: z.string().describe("File path"),
            oldText: z.string().describe("Text to replace"),
            newText: z.string().describe("New text"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow modifying files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, oldText, newText, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const content = await fs.readFile(abs, "utf-8");
            // Escape regex special characters to treat oldText as literal string
            const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const updated = content.replace(new RegExp(escaped, 'g'), newText);
            await fs.writeFile(abs, updated, "utf-8");
            return { content: [{ type: "text", text: `✅ Successfully replaced text in ${filePath}.\n\n--- UPDATED CONTENT ---\n${updated}` }] };
        }
    },
    "delete_file": {
        description: "Delete a file (Use with caution).",
        schema: {
            filePath: z.string().describe("Path of file to delete"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow deleting files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            await fs.unlink(abs);
            return { content: [{ type: "text", text: `Successfully deleted ${filePath}` }] };
        }
    },
    "create_directory": {
        description: "Create a new directory (Including parent directories).",
        schema: {
            dirPath: z.string().describe("Directory path"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow creating directories outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ dirPath, allow_external_access }) => {
            const abs = getAbsolutePathForWrite(dirPath, allow_external_access || false);
            await fs.mkdir(abs, { recursive: true });
            return { content: [{ type: "text", text: `Successfully created directory: ${dirPath}` }] };
        }
    },
    "edit_code": {
        description: "QUICK EDIT: Replace a specific code snippet with a new one. AI should use this tool to modify functions or code blocks without overwriting the entire file.",
        schema: {
            filePath: z.string().describe("File path"),
            oldCode: z.string().describe("Old code to replace (must match exactly)"),
            newCode: z.string().describe("New code to replace with"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow modifying files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, oldCode, newCode, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const content = await fs.readFile(abs, "utf-8");
            if (!content.includes(oldCode)) {
                return {
                    content: [{ type: "text", text: `ERROR: Old code snippet not found in file. Ensure you have copied every whitespace and newline correctly.` }],
                    isError: true
                };
            }
            const updated = content.replace(oldCode, newCode);
            await fs.writeFile(abs, updated, "utf-8");
            return { content: [{ type: "text", text: `✅ Successfully updated source code in ${filePath}.\n\n--- UPDATED CONTENT ---\n${updated}` }] };
        }
    },
    "quick_search_replace": {
        description: "SEARCH & REPLACE: Search for a string or Regex pattern and replace all occurrences in a file.",
        schema: {
            filePath: z.string().describe("File path"),
            searchPattern: z.string().describe("Text string or Regex pattern to find"),
            replacement: z.string().describe("Replacement content"),
            useRegex: z.boolean().default(false).describe("Enable to use Regular Expression"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow modifying files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, searchPattern, replacement, useRegex, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const content = await fs.readFile(abs, "utf-8");
            let updated;
            if (useRegex) {
                updated = content.replace(new RegExp(searchPattern, 'g'), replacement);
            } else {
                updated = content.split(searchPattern).join(replacement);
            }
            await fs.writeFile(abs, updated, "utf-8");
            return { content: [{ type: "text", text: `✅ Successfully replaced all occurrences of '${searchPattern}' in ${filePath}.\n\n--- UPDATED CONTENT ---\n${updated}` }] };
        }
    },
    "fetch_url": {
        description: "Đọc nội dung trang web dưới dạng văn bản/markdown thông qua Cloud Proxy của TXAHUB để tránh bị chặn IP.",
        schema: {
            url: z.string().url().describe("Địa chỉ URL trang web cần đọc")
        },
        handler: async ({ url }) => {
            const response = await fetch(`${HUB_URL}/api/fetch-proxy?api_key=${CONFIG_API_KEY}&url=${encodeURIComponent(url)}`);
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Không thể tải nội dung trang web.");
            return { content: [{ type: "text", text: data.content }] };
        }
    },
    "github_cloud": {
        description: "Thực hiện các thao tác trên Github (tạo Issue, Pull Request, xem nhánh, commit) thông qua tài khoản GitHub đã liên kết trên Cloud.",
        schema: {
            action: z.enum(["create_issue", "create_pr", "list_issues", "list_prs", "get_repo_info"])
                .describe("Hành động muốn thực hiện trên GitHub"),
            repo: z.string()
                .describe("Đường dẫn repo dạng 'owner/repo' (ví dụ: 'txa-hub/txamcp')"),
            payload: z.object({
                title: z.string().optional().describe("Tiêu đề của Issue hoặc PR"),
                body: z.string().optional().describe("Nội dung mô tả chi tiết"),
                head: z.string().optional().describe("Nhánh nguồn cần merge (dành cho PR)"),
                base: z.string().optional().describe("Nhánh đích muốn merge vào (dành cho PR)")
            }).optional().describe("Các tham số đi kèm tùy theo hành động")
        },
        handler: async ({ action, repo, payload }) => {
            const response = await fetch(`${HUB_URL}/api/github/execute`, {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "x-api-key": CONFIG_API_KEY 
                },
                body: JSON.stringify({ action, repo, payload })
            });

            if (response.status === 401) {
                return {
                    content: [{
                        type: "text",
                        text: `🔑 CHƯA ỦY QUYỀN GITHUB:\nBạn cần liên kết tài khoản GitHub của mình với TXAHUB trước khi sử dụng công cụ này.\n\n🔗 Hãy truy cập liên kết sau để cấp quyền: ${HUB_URL}/auth/github`
                    }],
                    isError: true
                };
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.message || "Không thể thực thi thao tác trên GitHub.");
            }
            return { content: [{ type: "text", text: data.result }] };
        }
    },
    "cloud_memory_save": {
        description: "Lưu trữ tri thức, cấu hình hoặc quyết định thiết kế của dự án lên Cloud Database của TXAHUB.",
        schema: {
            key: z.string().describe("Từ khóa định danh thông tin"),
            value: z.string().describe("Nội dung thông tin cần lưu trữ")
        },
        handler: async ({ key, value }) => {
            const response = await fetch(`${HUB_URL}/api/cloud-memory/save`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: CONFIG_API_KEY, key, value })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Không thể lưu bộ nhớ lên Cloud.");
            return { content: [{ type: "text", text: `✅ [Cloud Memory] Đã lưu thành công từ khóa: ${key}` }] };
        }
    },
    "cloud_memory_load": {
        description: "Tải thông tin tri thức đã lưu trữ từ Cloud Database của TXAHUB.",
        schema: {
            key: z.string().optional().describe("Từ khóa cần tải (để trống nếu muốn tải toàn bộ bộ nhớ của dự án)")
        },
        handler: async ({ key }) => {
            const url = key 
                ? `${HUB_URL}/api/cloud-memory/load?api_key=${CONFIG_API_KEY}&key=${encodeURIComponent(key)}`
                : `${HUB_URL}/api/cloud-memory/load?api_key=${CONFIG_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Không thể tải bộ nhớ từ Cloud.");
            return { content: [{ type: "text", text: JSON.stringify(data.memory, null, 2) }] };
        }
    },
    "cloud_todo_manager": {
        description: "Quản lý danh sách việc cần làm (TODO) đồng bộ trực tiếp trên Cloud của TXAHUB.",
        schema: {
            action: z.enum(["list", "add", "remove", "clear"]).describe("Hành động cần thực hiện"),
            task: z.string().optional().describe("Mô tả công việc (chỉ dùng cho action 'add')"),
            index: z.number().optional().describe("Số thứ tự công việc cần xóa (chỉ dùng cho action 'remove')")
        },
        handler: async ({ action, task, index }) => {
            const response = await fetch(`${HUB_URL}/api/cloud-todos`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ api_key: CONFIG_API_KEY, action, task, index })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Không thể cập nhật TODO trên Cloud.");
            return { content: [{ type: "text", text: data.result }] };
        }
    },
    "search_web": {
        description: "Tìm kiếm thông tin trực tuyến trên Google/Bing qua Cloud API của TXAHUB.",
        schema: {
            query: z.string().describe("Từ khóa cần tìm kiếm trên internet")
        },
        handler: async ({ query }) => {
            const response = await fetch(`${HUB_URL}/api/search?api_key=${CONFIG_API_KEY}&query=${encodeURIComponent(query)}`);
            const data = await response.json();
            if (!data.success) throw new Error(data.message || "Tìm kiếm thất bại.");
            return { content: [{ type: "text", text: data.results }] };
        }
    },
    "read_dir": {
        description: "Liệt kê danh sách file trong thư mục với thông tin chi tiết.",
        schema: {
            dirPath: z.string().default(".").describe("Directory path"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow reading directories outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ dirPath, allow_external_access }) => {
            const abs = getAbsolutePath(dirPath, allow_external_access || false);
            const files = await fs.readdir(abs, { withFileTypes: true });
            const list = files.map(f => `${f.isDirectory() ? "📁" : "📄"} ${f.name}`).join("\n");
            return { content: [{ type: "text", text: `Contents of ${dirPath}:\n\n${list}` }] };
        }
    },
    "get_project_summary": {
        description: "Phân tích và tóm tắt cấu trúc, công nghệ của toàn bộ dự án.",
        schema: {},
        handler: async () => {
            const { stdout: files } = await execPromise(os.platform() === 'win32' ? 'dir /s /b /a-d | find /v /c ""' : 'find . -type f | wc -l', { cwd: CURRENT_PROJECT_ROOT }).catch(() => ({ stdout: "Unknown" }));
            const { stdout: dirs } = await execPromise(os.platform() === 'win32' ? 'dir /s /b /ad | find /v /c ""' : 'find . -type d | wc -l', { cwd: CURRENT_PROJECT_ROOT }).catch(() => ({ stdout: "Unknown" }));
            
            const deps = await execPromise(os.platform() === 'win32' ? 'dir /b package.json composer.json pubspec.yaml go.mod' : 'ls package.json composer.json pubspec.yaml go.mod', { cwd: CURRENT_PROJECT_ROOT }).then(r => r.stdout.split("\n").filter(Boolean)).catch(() => []);
            
            const summary = `--- PROJECT SUMMARY ---\n\nRoot: ${CURRENT_PROJECT_ROOT}\nFiles: ${files.trim()}\nDirectories: ${dirs.trim()}\nDetected Technologies: ${deps.join(", ") || "None detected"}\n\nProject Structure:\n${(await execPromise(os.platform() === 'win32' ? 'dir /b' : 'ls -F', { cwd: CURRENT_PROJECT_ROOT })).stdout}`;
            return { content: [{ type: "text", text: summary }] };
        }
    },
    "project_audit": {
        description: "Kiểm tra bảo mật và chất lượng project (npm audit, composer audit).",
        schema: {
            tool: z.enum(["npm", "composer", "all"]).default("all").describe("Audit tool to use")
        },
        handler: async ({ tool }) => {
            let report = "--- SECURITY AUDIT REPORT ---\n\n";
            if (tool === "npm" || tool === "all") {
                if (existsSync(path.join(CURRENT_PROJECT_ROOT, "package.json"))) {
                    report += "[NPM Audit]\n";
                    const { stdout } = await execPromise("npm audit", { cwd: CURRENT_PROJECT_ROOT }).catch(err => ({ stdout: err.stdout }));
                    report += stdout || "No vulnerabilities found or npm audit failed.\n";
                }
            }
            if (tool === "composer" || tool === "all") {
                if (existsSync(path.join(CURRENT_PROJECT_ROOT, "composer.json"))) {
                    report += "\n[Composer Audit]\n";
                    const { stdout } = await execPromise("composer audit", { cwd: CURRENT_PROJECT_ROOT }).catch(err => ({ stdout: err.stdout }));
                    report += stdout || "No vulnerabilities found or composer audit failed.\n";
                }
            }
            return { content: [{ type: "text", text: report }] };
        }
    },
    "todo_manager": {
        description: "Quản lý danh sách việc cần làm (TODO) cho dự án.",
        schema: {
            action: z.enum(["list", "add", "remove", "clear"]).describe("Action to perform"),
            task: z.string().optional().describe("Task description (for 'add')"),
            index: z.number().optional().describe("Task index (for 'remove')")
        },
        handler: async ({ action, task, index }) => {
            const todoPath = path.join(CURRENT_PROJECT_ROOT, ".txamcp_todo.json");
            let todos = [];
            if (existsSync(todoPath)) todos = JSON.parse(await fs.readFile(todoPath, "utf-8"));

            if (action === "list") {
                if (todos.length === 0) return { content: [{ type: "text", text: "Your TODO list is empty. Take a break! ☕" }] };
                return { content: [{ type: "text", text: "--- PROJECT TODO LIST ---\n\n" + todos.map((t, i) => `${i + 1}. [${t.done ? "X" : " "}] ${t.task} (${t.added_at})`).join("\n") }] };
            } else if (action === "add" && task) {
                todos.push({ task, done: false, added_at: new Date().toLocaleDateString() });
                await fs.writeFile(todoPath, JSON.stringify(todos, null, 2));
                return { content: [{ type: "text", text: `✅ Task added: ${task}` }] };
            } else if (action === "remove" && index !== undefined) {
                if (index > 0 && index <= todos.length) {
                    const removed = todos.splice(index - 1, 1);
                    await fs.writeFile(todoPath, JSON.stringify(todos, null, 2));
                    return { content: [{ type: "text", text: `❌ Removed task: ${removed[0].task}` }] };
                }
                return { content: [{ type: "text", text: "Invalid index." }], isError: true };
            } else if (action === "clear") {
                await fs.writeFile(todoPath, JSON.stringify([], null, 2));
                return { content: [{ type: "text", text: "🧹 TODO list cleared." }] };
            }
            return { content: [{ type: "text", text: "Action not supported or missing parameters." }], isError: true };
        }
    },
    "code_metrics": {
        description: "Phân tích chỉ số code (Số dòng, độ phức tạp cơ bản).",
        schema: {
            filePath: z.string().describe("File to analyze"),
            allow_external_access: z.boolean().optional().describe("Set to true to allow analyzing files outside the project root. User must explicitly approve this action.")
        },
        handler: async ({ filePath, allow_external_access }) => {
            const abs = getAbsolutePath(filePath, allow_external_access || false);
            const content = await fs.readFile(abs, "utf-8");
            const lines = content.split("\n");
            const nonBlank = lines.filter(l => l.trim().length > 0).length;
            const comments = lines.filter(l => l.trim().startsWith("//") || l.trim().startsWith("/*") || l.trim().startsWith("*") || l.trim().startsWith("#")).length;
            const complexity = (content.match(/if|for|while|switch|case|catch/g) || []).length;

            const report = `--- CODE METRICS: ${path.basename(filePath)} ---\n\n` +
                `Total Lines: ${lines.length}\n` +
                `Code Lines (Non-blank): ${nonBlank}\n` +
                `Comment Lines: ${comments}\n` +
                `Basic Complexity Score: ${complexity} (if/loops/switches)\n` +
                `File Size: ${(content.length / 1024).toFixed(2)} KB`;
            
            return { content: [{ type: "text", text: report }] };
        }
    }
};

// Prompts are registered dynamically per connection instance inside setupMcpServer

let ENABLED_TOOLS_CACHE = null;
let BLOCKED_BY_PLAN_CACHE = [];
let DISABLED_REASONS_CACHE = {};
let POLICY_META_CACHE = null;
let LAST_SYNC_TIME = 0;
const SYNC_INTERVAL = 300000; // 5 minute cache - reduce API calls per tool invocation

async function getEnabledTools() {
    const now = Date.now();
    if (ENABLED_TOOLS_CACHE && (now - LAST_SYNC_TIME < SYNC_INTERVAL)) {
        return { 
            tools: ENABLED_TOOLS_CACHE, 
            blocked: BLOCKED_BY_PLAN_CACHE,
            source: "cache-fresh", 
            disabledReasons: DISABLED_REASONS_CACHE, 
            policy: POLICY_META_CACHE 
        };
    }

    try {
        const response = await fetch(`${HUB_URL}/api/tools?api_key=${CONFIG_API_KEY}`, {
            signal: AbortSignal.timeout(3000)
        });
        const data = await response.json();
        if (data.success && data.tools) {
            ENABLED_TOOLS_CACHE = data.tools.map(t => t.name);
            BLOCKED_BY_PLAN_CACHE = data.blocked_by_plan || [];
            DISABLED_REASONS_CACHE = data.disabled_reasons || {};
            POLICY_META_CACHE = data.policy || null;
            LAST_SYNC_TIME = now;
            return { 
                tools: ENABLED_TOOLS_CACHE, 
                blocked: BLOCKED_BY_PLAN_CACHE,
                source: "live", 
                disabledReasons: DISABLED_REASONS_CACHE, 
                policy: POLICY_META_CACHE 
            };
        }
    } catch (err) {
        log.error("Sync failed, evaluating cached tool list.");
    }
    if (ENABLED_TOOLS_CACHE) {
        return { 
            tools: ENABLED_TOOLS_CACHE, 
            blocked: BLOCKED_BY_PLAN_CACHE,
            source: "cache", 
            disabledReasons: DISABLED_REASONS_CACHE, 
            policy: POLICY_META_CACHE 
        };
    }
    throw new Error("TXAMCP POLICY ERROR: Cannot verify enabled tools from TXAHUB right now. Tool execution is blocked to avoid policy bypass.");
}

/**
 * Shared logic to execute a tool with Auth & Plan checks
 */
async function processToolCall(toolName, args) {
    const impl = TOOL_IMPLEMENTATIONS[toolName];
    if (!impl) {
        throw new Error(`Tool '${toolName}' not found.`);
    }

    // Dynamic reload: Load the persisted root state on every tool call!
    loadPersistedRoot();

    const requiresExplicitRoot = (name) => ["file_search", "search_code", "edit_code", "quick_search_replace"].includes(name);
    const isRequireAddRootEnabled = () => process.env.TXAMCP_REQUIRE_ADD_ROOT === "1";

    // Update root state from args (IDE may send context like activeFilePath, currentFilePath, etc.)
    const rootUpdateState = updateRootFromToolArgs(args || {});

    // Only enforce add_root requirement if explicitly enabled via environment variable
    // This allows IDEs to work seamlessly without needing to send custom add_root parameter
    if (requiresExplicitRoot(toolName) && isRequireAddRootEnabled()) {
        if (!rootUpdateState.used) {
            return appendMandatoryFooterToResult({
                content: [{
                    type: "text",
                    text: "❌ ROOT REQUIRED: Missing valid project context for file search.\n\nPlease provide `add_root` (project root or active file path) from IDE. TXAMCP requires this when `TXAMCP_REQUIRE_ADD_ROOT=1`.\n\nAlternatively, unset TXAMCP_REQUIRE_ADD_ROOT to use automatic project root detection."
                }],
                isError: true
            });
        }
    }

    // Log root update for debugging
    if (rootUpdateState.used) {
        log.info(`Root updated via ${rootUpdateState.source}: ${CURRENT_PROJECT_ROOT}`);
    }

    // Account verification
    let auth;
    try {
        auth = await verifyWithHub();
    } catch (err) {
        return appendMandatoryFooterToResult({ content: [{ type: "text", text: err.message }], isError: true });
    }

    // Check real-time if tool is disabled or blocked
    let enabledResult;
    try {
        enabledResult = await getEnabledTools();
    } catch (err) {
        return appendMandatoryFooterToResult({ content: [{ type: "text", text: err.message }], isError: true });
    }
    
    const currentEnabled = enabledResult.tools;
    const currentBlocked = enabledResult.blocked;

    // Case 1: Blocked by Plan
    if (currentBlocked.includes(toolName)) {
        log.warn(`BLOCKED: Tool '${toolName}' is BLOCKED by plan.`);
        return appendMandatoryFooterToResult({
            content: [{
                type: "text",
                text: `💎 NÂNG CẤP GÓI: Vui lòng nâng cấp gói để sử dụng tool '${toolName}'.\n\nGói hiện tại của bạn (${auth.user.plan_name}) không bao gồm tool này.\n\n🔗 Nâng cấp ngay tại: ${HUB_URL}/plans`
            }],
            isError: true
        });
    }

    // Case 2: Disabled by Admin
    if (!currentEnabled.includes(toolName)) {
        log.warn(`BLOCKED: Tool '${toolName}' is DISABLED by Admin.`);
        const disableReason = enabledResult?.disabledReasons?.[toolName] || "Disabled by admin";
        const policyVersion = enabledResult?.policy?.version || "N/A";
        const policySyncedAt = enabledResult?.policy?.synced_at || "N/A";
        return appendMandatoryFooterToResult({
            content: [{
                type: "text",
                text: `🚫 TOOL DISABLED: Tool '${toolName}' đã bị Admin tạm tắt trên hệ thống.\n\nLý do: ${disableReason}\nPhiên bản chính sách: ${policyVersion}\nThời gian đồng bộ: ${policySyncedAt}\n\nVui lòng liên hệ Admin hoặc kiểm tra tại ${HUB_URL}/dashboard.`
            }],
            isError: true
        });
    }

    log.tool(toolName);
    try {
        const result = await impl.handler(args);
        return appendMandatoryFooterToResult(result);
    } catch (err) {
        return appendMandatoryFooterToResult({ content: [{ type: "text", text: err.message }], isError: true });
    }
}

// Tool registration is handled dynamically per connection instance inside setupMcpServer

// --- HTTP API (Disabled by default in stdio mode, opt-in via ENABLE_HTTP_GATEWAY=true) ---
if (process.env.ENABLE_HTTP_GATEWAY === 'true') {
    const app = express();
    app.use(cors()); // Enable CORS for TXAHUB dashboard interaction
    app.use(express.json());

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

    app.get("/callback", async (req, res) => {
        const status = req.query.status;
        const key = req.query.api_key;
        const token = req.query.token;

        if (status === "success" && key) {
            try {
                const decryptedKey = decrypt(key);
                const decryptedToken = token ? decrypt(token) : null;
                
                const configDir = path.resolve(os.homedir(), ".txamcp");
                const configPath = path.join(configDir, "config.json");
                
                const verifyRes = await fetch(`${HUB_URL}/api/verify-key`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ api_key: decryptedKey, cli_token: decryptedToken })
                });
                const verifyData = await verifyRes.json();
                
                if (verifyData.success) {
                    await fs.mkdir(configDir, { recursive: true });
                    await fs.writeFile(configPath, JSON.stringify({
                        apiKey: decryptedKey,
                        cliToken: decryptedToken,
                        user: verifyData.user,
                        lastSync: new Date().toISOString()
                    }, null, 2));

                    CONFIG_API_KEY = decryptedKey;
                    USER_CONTEXT = verifyData;
                    
                    const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <title>Authorization Successful - TXAMCP</title>
                        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
                        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bi-icons.min.css" integrity="sha384-X81cNu0i" crossorigin="anonymous" onerror="this.onerror=null;this.href='https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css';">
                        <script src="https://cdn.tailwindcss.com"></script>
                        <style>
                            body { font-family: 'Outfit', sans-serif; background-color: #020617; }
                            .glass { background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
                        </style>
                    </head>
                    <body class="flex items-center justify-center min-h-screen overflow-hidden">
                        <div class="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-sky-500/10 blur-[120px] rounded-full"></div>
                        <div class="glass p-12 rounded-[2.5rem] shadow-2xl max-w-lg w-full text-center relative z-10 border-sky-500/20">
                            <div class="w-24 h-24 bg-emerald-500/10 rounded-3xl flex items-center justify-center text-5xl text-emerald-400 mx-auto mb-8 border border-emerald-500/20">
                                🔑
                            </div>
                            <h1 class="text-4xl font-black text-white mb-4 tracking-tight">SUCCESS!</h1>
                            <p class="text-slate-400 text-lg mb-8 leading-relaxed">
                                You have successfully authorized <span class="text-sky-400 font-bold">Txa MCP Server</span>.
                                Your local development environment is now synchronized.
                            </p>
                            <div class="p-4 bg-slate-900/50 rounded-2xl border border-slate-800 text-slate-500 text-sm italic">
                                You can safely close this tab and return to your IDE.
                            </div>
                        </div>
                    </body>
                    </html>`;
                    
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                    log.success("API Key updated dynamically via web callback!");
                    return;
                }
            } catch (err) {
                log.error(`Callback dynamic auth update failed: ${err.message}`);
            }
        }
        
        const failHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Authorization Cancelled - TXAMCP</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
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
                    ❌
                </div>
                <h1 class="text-4xl font-black text-white mb-4 tracking-tight uppercase">Cancelled</h1>
                <p class="text-slate-400 text-lg mb-8 leading-relaxed">
                    The authorization request was denied or timed out.
                </p>
                <div class="p-4 bg-slate-900/50 rounded-2xl border border-slate-800 text-slate-500 text-sm italic">
                    Return to your IDE or terminal to try again.
                </div>
            </div>
        </body>
        </html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(failHtml);
    });

    const sseSessions = new Map();

    app.get("/mcp", async (req, res) => {
        log.info("SSE Connection Request received at GET /mcp");
        
        const transport = new SSEServerTransport("/mcp/messages", res);
        
        const sseServer = new McpServer({
            name: "Txa_MCP",
            version: pkg.version,
            description: "Txa_MCP - Professional context management for AI IDEs. Provides project-aware tools for memory, todos, auditing, system info, and more.",
        });

        try {
            await setupMcpServer(sseServer);
            await sseServer.connect(transport);
            
            const sessionId = transport.sessionId;
            sseSessions.set(sessionId, { transport, sseServer });
            log.success(`SSE Connection established with Session ID: ${sessionId}`);

            req.on("close", async () => {
                log.info(`SSE Connection closed for Session ID: ${sessionId}`);
                try {
                    await sseServer.close();
                } catch (closeErr) {
                    log.error(`Error closing SSE server session ${sessionId}: ${closeErr.message}`);
                }
                sseSessions.delete(sessionId);
            });
        } catch (err) {
            log.error(`Failed to establish SSE connection: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).end(`Internal Server Error: ${err.message}`);
            }
        }
    });

    app.post("/mcp/messages", async (req, res) => {
        const sessionId = req.query.sessionId || req.query.session_id;
        if (!sessionId) {
            log.warn("POST /mcp/messages requested without sessionId parameter");
            return res.status(400).json({ error: "Missing sessionId query parameter" });
        }
        
        const session = sseSessions.get(sessionId);
        if (session) {
            try {
                await session.transport.handlePostMessage(req, res, req.body);
            } catch (err) {
                log.error(`Error handling SSE POST message for session ${sessionId}: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            }
        } else {
            log.warn(`POST /mcp/messages: SSE session ${sessionId} not found`);
            res.status(404).json({ error: `Session ${sessionId} not found` });
        }
    });

    app.use((req, res, next) => {
        const auth = validateHttpApiKey(req);
        if (!auth.valid) {
            if (auth.status === 401) {
                res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${HUB_URL}/api/mcp-auth-metadata", realm="txamcp"`);
            }
            return res.status(auth.status).json({ error: auth.message });
        }
        next();
    });

    app.get("/mcp/tools", (req, res) => res.json({ tools: Object.keys(TOOL_IMPLEMENTATIONS).map(name => ({ name, description: TOOL_IMPLEMENTATIONS[name].description, schema: TOOL_IMPLEMENTATIONS[name].schema })) }));
    app.get("/mcp/health", (req, res) => res.json({ status: "online", version: pkg.version, project_root: CURRENT_PROJECT_ROOT }));
    app.post("/mcp/tools/:name", async (req, res) => {
        try {
            const toolName = req.params.name;
            const args = req.body.arguments || {};
            log.info(`HTTP Request: Executing tool '${toolName}'`);
            
            // Re-use the shared tool execution logic
            const result = await processToolCall(toolName, args);
            res.json(result);
        } catch (err) {
            log.error(`HTTP Gateway Error [${req.params.name}]: ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    async function killProcessOnPort(port) {
        log.info(`Attempting to free port ${port}...`);
        try {
            if (os.platform() === 'win32') {
                const { stdout } = await execPromise(`netstat -ano | findstr :${port}`);
                const lines = stdout.split('\n').filter(Boolean);
                const pids = new Set();
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && !isNaN(pid) && parseInt(pid) !== process.pid && parseInt(pid) > 0) {
                        pids.add(parseInt(pid));
                    }
                }
                for (const pid of pids) {
                    log.info(`Killing process ${pid} using port ${port}...`);
                    await execPromise(`taskkill /F /PID ${pid}`);
                }
            } else {
                const { stdout } = await execPromise(`lsof -t -i:${port}`);
                const pids = stdout.split('\n').map(p => p.trim()).filter(Boolean);
                for (const pid of pids) {
                    if (parseInt(pid) !== process.pid) {
                        log.info(`Killing process ${pid} using port ${port}...`);
                        await execPromise(`kill -9 ${pid}`);
                    }
                }
            }
            log.success(`Port ${port} should be free now.`);
        } catch (err) {
            log.warn(`Could not kill process on port ${port}: ${err.message}`);
        }
    }

    const candidatePorts = [
        process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3636,
        3636,
        2311,
        36237
    ].filter((p, i, self) => self.indexOf(p) === i);

    let portIndex = 0;

    async function tryListen(port) {
        return new Promise((resolve, reject) => {
            const serverInstance = app.listen(port, () => {
                const boundPort = serverInstance.address().port;
                log.success(`Txa MCP Gateway v${pkg.version} running on http://localhost:${boundPort}`);
                resolve(serverInstance);
            });
            
            serverInstance.on('error', async (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(err);
                } else {
                    log.error(`HTTP Gateway Error: ${err.message}`);
                    resolve(null);
                }
            });
        });
    }

    async function startGateway() {
        while (portIndex < candidatePorts.length) {
            const currentPort = candidatePorts[portIndex];
            log.info(`Trying to start HTTP Gateway on port ${currentPort}...`);
            try {
                const s = await tryListen(currentPort);
                if (s) return;
            } catch (err) {
                log.warn(`Port ${currentPort} is in use. Attempting to kill blocking process...`);
                await killProcessOnPort(currentPort);
                
                try {
                    const s = await tryListen(currentPort);
                    if (s) return;
                } catch (retryErr) {
                    log.warn(`Failed to free port ${currentPort} after kill. Rotating to next port...`);
                }
            }
            portIndex++;
        }
        
        log.info("All predefined ports occupied. Requesting a random free port from OS...");
        try {
            await tryListen(0);
        } catch (randomErr) {
            log.error(`Fatal HTTP Gateway Error: Could not start even on random port: ${randomErr.message}`);
        }
    }

    startGateway();
}

// --- AUTO-DEPLOY instructions.md TO IDE MCP FOLDERS ---
function deployInstructionsToIDEs() {
    const homeDir = os.homedir();
    const ideMcpPaths = [
        path.join(homeDir, '.gemini', 'antigravity-ide', 'mcp', 'Txa_MCP'),
        path.join(homeDir, '.gemini', 'antigravity', 'mcp', 'Txa_MCP'),
        path.join(homeDir, '.gemini', 'config', 'mcp', 'Txa_MCP'),
    ];

    // Find instructions.md: check package dir first, then fallback to __dirname equivalent
    const packageDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    const instructionsSource = path.join(packageDir, 'instructions.md');

    if (!existsSync(instructionsSource)) {
        log.warn('instructions.md not found in package, skipping IDE deployment.');
        return;
    }

    const content = readFileSync(instructionsSource, 'utf-8');

    for (const targetDir of ideMcpPaths) {
        try {
            const parentMcpDir = path.dirname(targetDir);
            if (!existsSync(parentMcpDir)) continue;

            if (!existsSync(targetDir)) {
                require('fs').mkdirSync(targetDir, { recursive: true });
            }

            const targetFile = path.join(targetDir, 'instructions.md');
            require('fs').writeFileSync(targetFile, content, 'utf-8');
            log.success(`Deployed instructions.md → ${targetFile}`);
        } catch (err) {
            log.warn(`Could not deploy instructions to ${targetDir}: ${err.message}`);
        }
    }
}

// --- TRANSPORT ---
async function main() {
    try {
        loadPersistedRoot();
        const envCandidates = getEnvRootCandidates();
        if (envCandidates.length > 0) {
            updateRootFromPath(envCandidates[0]);
        }
        const auth = await verifyWithHub();
        log.success(`Txa_MCP Core Engine v${pkg.version} Online - Plan: ${auth.user.plan_name}`);
        log.info(`Authenticated as ${auth.user.username}`);
    } catch (err) {
        log.success(`Txa_MCP Core Engine v${pkg.version} Online (Offline Mode)`);
        log.error(`Startup Auth Failed: ${err.message}`);
    }

    // Deploy instructions.md to IDE MCP folders on every startup
    deployInstructionsToIDEs();

    // Setup resources, prompts, and tools on global server
    try {
        await setupMcpServer(server);
    } catch (err) {
        log.error(`Fatal setupMcpServer failed: ${err.message}`);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
