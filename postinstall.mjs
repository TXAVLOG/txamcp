#!/usr/bin/env node

/**
 * TXAMCP Postinstall Script
 * 
 * Automatically deploys instructions.md to IDE MCP schema folders
 * after `npm install -g txamcp`.
 * 
 * Supported IDEs:
 * - Antigravity IDE (.gemini/antigravity-ide/mcp/Txa_MCP/)
 * - Gemini Config (.gemini/config/mcp/Txa_MCP/)  [fallback]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INSTRUCTIONS_SOURCE = path.join(__dirname, 'instructions.md');
const SERVER_NAME = 'Txa_MCP';

// Known IDE MCP schema folder paths (relative to home directory)
const IDE_MCP_PATHS = [
    path.join('.gemini', 'antigravity-ide', 'mcp', SERVER_NAME),
    path.join('.gemini', 'antigravity', 'mcp', SERVER_NAME),
    path.join('.gemini', 'config', 'mcp', SERVER_NAME),
];

function deployInstructions() {
    const homeDir = os.homedir();

    // Check if instructions.md source exists
    if (!fs.existsSync(INSTRUCTIONS_SOURCE)) {
        console.log('[TXAMCP] ⚠ instructions.md not found in package, skipping deployment.');
        return;
    }

    const instructionsContent = fs.readFileSync(INSTRUCTIONS_SOURCE, 'utf-8');
    let deployed = 0;

    for (const relPath of IDE_MCP_PATHS) {
        const targetDir = path.join(homeDir, relPath);
        const targetFile = path.join(targetDir, 'instructions.md');

        try {
            // Only deploy if the IDE MCP folder exists (meaning IDE is installed and has this server registered)
            // OR if the parent mcp/ folder exists (meaning the IDE is installed)
            const parentMcpDir = path.dirname(targetDir);
            if (!fs.existsSync(parentMcpDir)) {
                continue; // IDE not installed or MCP folder doesn't exist
            }

            // Create the server-specific folder if it doesn't exist
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Write instructions.md
            fs.writeFileSync(targetFile, instructionsContent, 'utf-8');
            deployed++;
            console.log(`[TXAMCP] ✔ Deployed instructions.md → ${targetFile}`);
        } catch (err) {
            // Don't fail installation if deployment fails
            console.log(`[TXAMCP] ⚠ Could not deploy to ${targetDir}: ${err.message}`);
        }
    }

    if (deployed === 0) {
        console.log('[TXAMCP] ℹ No IDE MCP folders detected. instructions.md will be deployed on first server startup.');
    } else {
        console.log(`[TXAMCP] ✔ Successfully deployed instructions.md to ${deployed} IDE(s).`);
    }
}

function installVsixExtension() {
    try {
        const files = fs.readdirSync(__dirname);
        const vsixFile = files.find(f => f.endsWith('.vsix'));
        if (!vsixFile) {
            console.log('[TXAMCP] ℹ No .vsix extension package found in npm folder, skipping IDE extension installation.');
            return;
        }
        const absoluteVsixPath = path.join(__dirname, vsixFile);

        const IDES = [
            { name: 'VS Code', cmd: 'code' },
            { name: 'Cursor', cmd: 'cursor' },
            { name: 'Windsurf', cmd: 'windsurf' },
            { name: 'Trae', cmd: 'trae' }
        ];

        for (const ide of IDES) {
            try {
                // Check if the command exists in PATH by running it with --version
                execSync(`${ide.cmd} --version`, { stdio: 'ignore' });
                
                // If it exists, install the extension!
                console.log(`[TXAMCP] Attempting to install extension to ${ide.name}...`);
                execSync(`${ide.cmd} --install-extension "${absoluteVsixPath}"`, { stdio: 'ignore' });
                console.log(`[TXAMCP] ✔ Successfully installed VS Code extension in ${ide.name}!`);
            } catch (e) {
                // Quietly ignore if IDE is not installed or command not in PATH
            }
        }
    } catch (err) {
        console.log(`[TXAMCP] ⚠ Error during extension auto-install: ${err.message}`);
    }
}

// Run
deployInstructions();
installVsixExtension();
