/**
 * Contracts shared by every host that can drive the homepage agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.history` / `chrome.tabs` and a runner that
 * reaches Claude Code through native messaging; the Node test harness supplies a
 * fixture/fetch bridge and spawns Claude Code directly. Nothing in this package
 * may import `chrome`, `browser`, or `node:*`.
 */

/** One domain's worth of browsing history, narrowed to fit in a context window. */
export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  /** ISO 8601 — the model reasons about dates, not epoch milliseconds. */
  lastVisit: string;
  score: number;
  /** Capped. `urls[]` is dropped entirely. */
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  /** What the model is *not* seeing. Without this it assumes the digest is exhaustive. */
  totalSitesSeen: number;
  sites: SiteDigest[];
}

/** Raw per-domain history, as a BrowserBridge returns it — before `buildHistoryDigest` narrows it. */
export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  title: string;
  html: string;
}

/**
 * The two capabilities only a real browser has. Everything else the agent needs
 * (a filesystem, grep, read) comes from Claude Code's own tools in a temp dir.
 */
export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
}

/** Minimal persistence. `chrome.storage.local` in the extension. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** One headless Claude Code turn (`claude -p`), run in a fresh temp directory. */
export interface ClaudeRunRequest {
  /** Passed to `--model`. */
  model: string;
  /** Replaces Claude Code's default system prompt. */
  systemPrompt: string;
  /** The user message, sent over stdin. */
  prompt: string;
  /** Built-in Claude Code tools this turn may use, e.g. ["Read", "Grep"]. Empty for none. */
  tools: string[];
  /** Ask for structured output matching this JSON Schema; it comes back as `structured`. */
  jsonSchema?: object;
  /** Written into the temp directory before the turn starts (relative paths). */
  files?: Array<{ path: string; content: string }>;
  /** Temp-directory files to read back after the turn (relative paths). */
  collect?: string[];
}

export type ClaudeRunEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input?: unknown };

export interface ClaudeRunResult {
  /** The final assistant message. */
  result: string;
  structured?: unknown;
  /** Contents of the `collect` files that exist. */
  files: Record<string, string>;
}

/** Where Claude Code actually runs: a native messaging host in the extension, a child process in the harness. */
export interface ClaudeRunner {
  run(req: ClaudeRunRequest, onEvent: (event: ClaudeRunEvent) => void, signal?: AbortSignal): Promise<ClaudeRunResult>;
}

export type RunPhase =
  | "setup"
  | "choosing"
  | "history"
  | "scraping"
  | "analyzing"
  | "writing"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Streamed assistant prose, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
  /** Where the code came from: the written file, or a fenced block in the final message. */
  source: "output-file" | "message-fence";
}
