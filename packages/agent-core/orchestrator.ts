import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { DEFAULT_MODEL, type HomepageModel } from "./models";
import {
  OUTPUT_FILE,
  PAGES_DIR,
  PICK_SYSTEM_PROMPT,
  WRITE_SYSTEM_PROMPT,
  buildPickMessage,
  buildWriteMessage,
} from "./prompt";
import { DEFAULTS, PICK_PAGES_SCHEMA } from "./schemas";
import type { BrowserBridge, ClaudeRunEvent, ClaudeRunner, HomepageBuildResult, RunCallbacks, RunPhase } from "./types";

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

export interface RunOptions {
  runner: ClaudeRunner;
  bridge: BrowserBridge;
  userSystemPrompt?: string;
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
}

/**
 * A build is two Claude Code turns with the browser work in between:
 *
 *   history digest ──▶ claude -p (pick ≤8 URLs, structured output)
 *                  ──▶ open them in the user's browser, sanitize
 *                  ──▶ claude -p (Read/Grep the saved pages, Write homepage.tsx)
 *
 * Splitting it means the runner never has to call back into the browser
 * mid-turn: each turn gets everything it needs up front.
 */
export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { runner, bridge, callbacks, signal } = opts;
  const model = opts.model ?? DEFAULT_MODEL;
  const now = opts.now ?? new Date();
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");

  // ---- history → digest (in the browser) ----
  emit.phase("history", `${DEFAULTS.daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({
    daysToAnalyze: DEFAULTS.daysToAnalyze,
    maxResults: DEFAULTS.maxResults,
  });
  const digest = buildHistoryDigest(sites, {
    daysToAnalyze: DEFAULTS.daysToAnalyze,
    maxResults: DEFAULTS.maxResults,
    totalSitesSeen,
  });
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  if (digest.sites.length === 0) throw new Error("No browsing history in the last two weeks to build from.");

  // ---- turn 1: pick pages ----
  emit.phase("choosing");
  const pick = await runner.run(
    {
      model,
      systemPrompt: PICK_SYSTEM_PROMPT,
      prompt: buildPickMessage({ now, userSystemPrompt: opts.userSystemPrompt, digest }),
      tools: [],
      jsonSchema: PICK_PAGES_SCHEMA,
    },
    () => {},
    signal,
  );
  const urls = pickedUrls(pick.structured, pick.result);
  emit.log(`picked: ${urls.join(", ")}`);

  // ---- open pages (in the browser) ----
  emit.phase("scraping", `${urls.length} pages`);
  const { pages, failed } = await bridge.getPageHtml({ urls, loadDelayMs: DEFAULTS.loadDelayMs });
  for (const f of failed) emit.log(`failed ${f.url}: ${f.reason}`);
  if (pages.length === 0) {
    throw new Error(`None of the chosen pages could be opened: ${failed.map((f) => f.url).join(", ")}`);
  }
  const saved = pages.map((page, i) => ({ ...page, path: `${PAGES_DIR}/${slugifyUrl(page.url)}_${i}.html` }));
  for (const p of saved) emit.log(`saved ${p.url} -> ${p.path} (${p.html.length}b)`);

  // ---- turn 2: read pages, write the component ----
  emit.phase("analyzing");
  const write = await runner.run(
    {
      model,
      systemPrompt: WRITE_SYSTEM_PROMPT,
      prompt: buildWriteMessage({ now, userSystemPrompt: opts.userSystemPrompt, pages: saved, failed }),
      tools: ["Read", "Grep", "Glob", "Write"],
      files: saved.map((p) => ({ path: p.path, content: p.html })),
      collect: [OUTPUT_FILE],
    },
    (event) => onWriteEvent(event, emit),
    signal,
  );

  emit.phase("writing");
  const deliverable = collectDeliverable(write.files[OUTPUT_FILE], write.result, emit);
  emit.phase("done");
  return deliverable;
}

function onWriteEvent(event: ClaudeRunEvent, emit: Emit) {
  if (event.type === "text") {
    emit.text(event.text);
    return;
  }
  emit.phase(event.name === "Write" ? "writing" : "analyzing", event.name);
  const input = event.input as { file_path?: string; path?: string; pattern?: string } | undefined;
  emit.log(`${event.name} ${input?.file_path ?? input?.pattern ?? input?.path ?? ""}`.trim());
}

/** Structured output first; fall back to any URLs in the reply text. */
function pickedUrls(structured: unknown, text: string): string[] {
  const fromSchema = (structured as { urls?: unknown } | undefined)?.urls;
  const raw = Array.isArray(fromSchema) ? fromSchema : (text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []);
  const urls = [
    ...new Set(
      raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)),
    ),
  ].slice(0, DEFAULTS.maxPages);
  if (urls.length === 0) throw new Error(`Claude did not choose any pages. Reply: ${text.slice(0, 300)}`);
  return urls;
}

const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

/** Strip a ```tsx fence, if the model wrapped the file contents in one. */
function stripFence(text: string): string {
  const fenced = text.match(CODE_FENCE);
  return (fenced ? fenced[1] : text).trim();
}

function collectDeliverable(file: string | undefined, finalMessage: string, emit: Emit): HomepageBuildResult {
  if (file?.trim()) {
    emit.log(`deliverable: ${OUTPUT_FILE} (${file.length}b)`);
    return { code: stripFence(file), source: "output-file" };
  }

  // Fallback: the model sometimes answers with the component inline instead of
  // writing it. Better than failing the run outright.
  const fenced = finalMessage.match(CODE_FENCE);
  if (fenced && fenced[1].includes("PersonalizedHomepage")) {
    emit.log("deliverable recovered from message fence");
    return { code: fenced[1].trim(), source: "message-fence" };
  }

  throw new Error(
    `Claude produced no homepage. Expected ./${OUTPUT_FILE}. Final message: ${finalMessage.slice(0, 400)}`,
  );
}
