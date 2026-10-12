/**
 * End-to-end build through the local Claude Code CLI (needs `claude auth login`).
 *
 * Exercises the exact orchestrator the extension runs, with a fixture/fetch
 * bridge standing in for chrome.history and chrome.tabs, and the native host's
 * own `runClaude` standing in for the native messaging hop. Verifies: page
 * picking via structured output, pages written to the run directory, Read/Grep
 * over them, and the written deliverable.
 *
 * Run: pnpm agent:run
 */
import { runHomepageBuild, type ClaudeRunner, type HomepageModel } from "@homepage/agent-core";
import { mkdirSync, writeFileSync } from "node:fs";
// @ts-expect-error plain ESM module without types
import { runClaude } from "../apps/native-host/claude-run.mjs";
import { OUT_DIR, OUT_PATH, nodeBridge } from "./node-bridge";

const localRunner: ClaudeRunner = { run: runClaude };

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const started = Date.now();
  let lastPhase = "";

  const result = await runHomepageBuild({
    runner: localRunner,
    bridge: nodeBridge,
    userSystemPrompt: process.env.HOMEPAGE_PROMPT,
    model: process.env.HOMEPAGE_MODEL as HomepageModel | undefined,
    callbacks: {
      onPhase: (phase, detail) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          process.stdout.write(`\n\x1b[36m[${phase}]\x1b[0m${detail ? " " + detail : ""}\n`);
        }
      },
      onText: (text) => process.stdout.write(text),
      onLog: (line) => process.stdout.write(`\n\x1b[90m  · ${line}\x1b[0m\n`),
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  writeFileSync(OUT_PATH, result.code);

  console.log("\n\n========== RESULT ==========");
  console.log(`source       : ${result.source}`);
  console.log(`code length  : ${result.code.length} bytes`);
  console.log(`elapsed      : ${elapsed}s`);
  console.log(`written to   : ${OUT_PATH}`);

  // Shape checks. The real proof is `pnpm agent:verify`, which
  // transforms, evaluates and server-renders the component.
  const checks: Array<[string, boolean]> = [
    // `export default function PersonalizedHomepage()` and
    // `export default PersonalizedHomepage;` are both valid.
    ["default-exports the component", /export\s+default\s+(function\s+)?PersonalizedHomepage\b/.test(result.code)],
    ["imports React", /import\s+React/.test(result.code)],
    ["no non-React imports", !/from\s+['"](?!react['"])[^'"]+['"]/.test(result.code)],
    ["has real hrefs", /https?:\/\//.test(result.code)],
  ];

  console.log("\n========== CONTRACT ==========");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "✅" : "❌"} ${label}`);
    if (!pass) ok = false;
  }
  console.log(`\nNext: pnpm agent:verify`);

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[run-agent] fatal:", err);
  process.exit(1);
});
