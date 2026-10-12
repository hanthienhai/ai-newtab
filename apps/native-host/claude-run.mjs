/**
 * Run one headless Claude Code turn (`claude -p`) in a throwaway directory.
 *
 * This is the whole "sandbox": the request's files are written into a fresh temp
 * dir, Claude Code runs there with only the tools the request names, the files
 * named in `collect` are read back, and the dir is deleted. Auth is whatever the
 * local `claude` CLI is logged in with (your Claude plan), never an API key.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");

/** `install.mjs` records the absolute CLI path, since Chrome starts the host with a thin PATH. */
export function claudePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  if (existsSync(CONFIG_PATH)) {
    const { claudePath } = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (claudePath) return claudePath;
  }
  return "claude";
}

/** Keep a request's paths inside its own directory. */
function inside(root, rel) {
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) throw new Error(`path escapes the run directory: ${rel}`);
  return full;
}

/**
 * @param {{
 *   model: string,
 *   systemPrompt: string,
 *   prompt: string,
 *   tools: string[],
 *   jsonSchema?: object,
 *   files?: Array<{ path: string, content: string }>,
 *   collect?: string[],
 * }} req
 * @param {(event: { type: "text", text: string } | { type: "tool", name: string, input?: unknown }) => void} onEvent
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ result: string, structured?: unknown, files: Record<string, string> }>}
 */
export async function runClaude(req, onEvent, signal) {
  // Windows hands out 8.3 short temp paths (C:\Users\NAME~1\...); Claude Code
  // asks for manual approval to write under those, which a headless run can't give.
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "ai-newtab-")));
  try {
    for (const file of req.files ?? []) {
      const full = inside(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content);
    }

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", req.model,
      "--system-prompt", req.systemPrompt,
      // Only the tools this step needs. No Bash, no web: page content is untrusted.
      "--tools", req.tools.join(","),
      ...(req.tools.length ? ["--allowedTools", req.tools.join(",")] : []),
      // Skip the user's hooks, permission rules and MCP servers; this run needs none of them.
      "--setting-sources", "",
      "--strict-mcp-config",
      // Don't keep a transcript of the user's pages under ~/.claude/projects.
      "--no-session-persistence",
    ];
    if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));

    const env = { ...process.env };
    // An API key in the environment would take precedence over the plan login.
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(claudePath(), args, { cwd: dir, env, windowsHide: true });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });

    // The prompt goes over stdin: a history digest can outgrow a Windows command line.
    child.stdin.end(req.prompt);

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });

    /** @type {any} */
    let final = null;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) onEvent({ type: "text", text: block.text });
          if (block.type === "tool_use") onEvent({ type: "tool", name: block.name, input: block.input });
        }
      } else if (msg.type === "result") {
        final = msg;
      }
    });

    const code = await new Promise((res, rej) => {
      child.on("error", rej);
      child.on("close", res);
    });
    signal?.removeEventListener("abort", abort);

    if (signal?.aborted) throw new Error("aborted");
    if (!final) throw new Error(`claude exited (${code}) without a result. ${stderr.trim()}`);
    if (final.is_error) throw new Error(`claude: ${final.result || final.subtype}`);

    /** @type {Record<string, string>} */
    const files = {};
    for (const rel of req.collect ?? []) {
      const full = inside(dir, rel);
      if (existsSync(full)) files[rel] = await readFile(full, "utf-8");
    }

    return { result: final.result ?? "", structured: final.structured_output, files };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
