import { spawn } from "child_process";
import chalk from "chalk";
import boxen from "boxen";

const log = {
  header: (msg) => console.log(chalk.cyan.bold(`\n>>> ${msg} <<<`)),
  success: (msg) => console.log(chalk.green(`✔ ${msg}`)),
  error: (msg) => console.log(chalk.red(`✖ ${msg}`)),
  info: (msg) => console.log(chalk.blue(`ℹ ${msg}`)),
  json: (obj) => {
    const str = JSON.stringify(obj, null, 2);
    console.log(chalk.gray(str));
  }
};

const server = spawn("node", ["mcp-server.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

function sendRequest(method, params, id) {
  const request = { jsonrpc: "2.0", method, params, id };
  server.stdin.write(JSON.stringify(request) + "\n");
}

let responsesReceived = 0;
const expectedResponses = 7;

server.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);
      if (response.result) {
        responsesReceived++;
        
        const toolName = response.id === 1 ? "list_repositories" :
                         response.id === 2 ? "get_dependencies" :
                         response.id === 3 ? "search_code" :
                         response.id === 4 ? "list_workspaces" :
                         response.id === 5 ? "fix_minimal (Prompt)" :
                         response.id === 6 ? "github_cloud (list_branches)" :
                         response.id === 7 ? "github_cloud (list_collaborators)" : "unknown";

        let content = "";
        if (response.result.content) {
          content = response.result.content[0].text;
        } else if (response.result.messages) {
          content = `[PROMPT RESPONSE]\nRole: ${response.result.messages[0].role}\nContent: ${response.result.messages[0].content.text}`;
        } else {
          content = "No content";
        }
        
        console.log(boxen(chalk.white(content), {
          title: chalk.magenta.bold(` RESPONSE: ${toolName} `),
          titleAlignment: 'left',
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }));

        if (responsesReceived === expectedResponses) {
          log.success("ALL TOOLS VERIFIED SUCCESSFULLY");
          process.exit(0);
        }
      }
    } catch (e) {
      // Not JSON, probably server log
    }
  }
});

log.header("TESTING MCP TOOLS VIA STDIO");

server.on("spawn", () => {
  setTimeout(() => {
    log.info("Sending requests...");
    sendRequest("tools/call", { name: "list_repositories", arguments: {} }, 1);
    sendRequest("tools/call", { name: "get_dependencies", arguments: {} }, 2);
    sendRequest("tools/call", { name: "search_code", arguments: { query: "server.registerTool" } }, 3);
    sendRequest("tools/call", { name: "list_workspaces", arguments: {} }, 4);
    sendRequest("prompts/get", { name: "fix_minimal", arguments: { issue: "test", code: "test" } }, 5);
    sendRequest("tools/call", { name: "github_cloud", arguments: { action: "list_branches", repo: "TXAVLOG/txamcp" } }, 6);
    sendRequest("tools/call", { name: "github_cloud", arguments: { action: "list_collaborators", repo: "TXAVLOG/txamcp" } }, 7);
  }, 1000);
});
