import { runHomepageBuild, type RunPhase } from "@homepage/agent-core";
import { rebuildIntervalMs, shouldAutoRebuild } from "./auto-rebuild";
import { browserBridge } from "./browser-bridge";
import { checkClaudeCode, nativeClaudeRunner } from "./claude-runner";
import { closeOrphanScraperWindow } from "./scraper";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveHomepage } from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a build is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer (an open native port does too, but the scraping
 * step between the two Claude Code turns has none).
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Storage snapshots are throttled so narration deltas don't flood chrome.storage. */
const SNAPSHOT_THROTTLE_MS = 2_000;
/** A late-joining tab doesn't need the whole narration, just enough to look alive. */
const NARRATION_STORAGE_CAP = 2_000;

/**
 * Owns the single build. Runs `runHomepageBuild` in the worker, holds live state,
 * enforces a single-flight lock, broadcasts progress to every connected tab, and
 * mirrors a throttled snapshot to storage.
 *
 * There is one instance per service worker — i.e. one per browser profile — so
 * single-flight is per-profile, which is the right grain.
 */
export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The tick in flight, if any. A browser launch wakes the worker with several
   * ticks at once (worker load, onStartup, the missed alarm); without this they
   * all read the same stale timestamps and each start a build.
   */
  private ticking: Promise<void> | null = null;
  /** The running build, so a restart can wait for it to wind down. */
  private current: Promise<void> | null = null;

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
        break;
      case "startBuild":
        void (msg.restart ? this.restartBuild() : this.startBuild());
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      // Port went away between the has-check and the post; drop it.
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  // ---- heartbeat -----------------------------------------------------------

  /**
   * Called on worker wake and on every alarm tick: consider the scheduled
   * rebuild. A build cut off by a worker kill is not resumed — the native port
   * closed with it, which stopped its `claude` process — so the next scheduled
   * or manual build starts fresh.
   */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick() {
    if (this.running) {
      // A run is live but the worker may have just woken; make sure the
      // self-keepalive is ticking so the active turn stays warm.
      this.startKeepalive();
      return;
    }

    // A snapshot still marked running belongs to a build that died with the worker.
    const snap = await extensionStore.get<BuildState>(KEYS.buildSnapshot);
    if (snap?.running) {
      this.state = { ...snap, running: false, phase: "error", error: "The build was interrupted. Rebuild to try again." };
      await this.mirror(true);
    }
    // No build is running, so any scraper window still open was left behind.
    await closeOrphanScraperWindow();

    await this.maybeAutoRebuild();
  }

  /** Whether opening the day's first tab should already show a fresh homepage. */
  private async maybeAutoRebuild() {
    const [settings, homepage, lastAttempt] = await Promise.all([
      loadSettings(),
      loadHomepage(),
      extensionStore.get<string>(KEYS.lastAutoBuildAttempt),
    ]);
    const now = new Date();

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        isRunning: this.running,
        lastBuildTimestamp: homepage?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        intervalMs: rebuildIntervalMs(settings.rebuildIntervalHours),
        now,
      })
    ) {
      return;
    }

    // Stamp the attempt before starting so a second wake (or a cancel/failure)
    // doesn't re-trigger it within the interval.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild();
  }

  // ---- the build -----------------------------------------------------------

  startBuild(): Promise<void> {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored — a build is already running");
      return this.current ?? Promise.resolve(); // single-flight: a second start just attaches.
    }

    // Take the lock and the abort handle before the first await, so two starts
    // in the same moment can't both pass the check above, and a cancel that
    // lands while settings load still reaches this build.
    this.running = true;
    this.controller = new AbortController();
    this.current = this.runBuild(this.controller.signal).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /**
   * Cancel the running build, if any, and start a fresh one once it has wound
   * down. Saving a new prompt mid-build uses this: a plain start would be
   * ignored and the prompt would only apply to the build after next.
   */
  async restartBuild() {
    if (this.running) {
      this.cancel();
      await this.current;
    }
    await this.startBuild();
  }

  private async runBuild(signal: AbortSignal) {
    this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup" };
    this.broadcast({ kind: "snapshot", state: this.state });
    this.startKeepalive();
    console.log("[BuildManager] build started");

    try {
      // Read settings inside the run, so a build started right after a save
      // uses the new prompt and model.
      const { systemPrompt, model } = await loadSettings();
      const version = await checkClaudeCode(signal);
      this.onLog(`claude ${version}, model ${model}`);

      const result = await runHomepageBuild({
        runner: nativeClaudeRunner,
        bridge: browserBridge,
        userSystemPrompt: systemPrompt,
        model,
        signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      // Persist the raw TSX; the page transpiles it for preview.
      await saveHomepage(result.code);

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", code: result.code });
      await this.mirror(true);
      console.log("[BuildManager] build done", { bytes: result.code.length, source: result.source });
    } catch (error) {
      if (signal.aborted) {
        // The user cancelled: go back to idle, not to a "Build failed" banner.
        this.state = { ...INITIAL_BUILD_STATE };
        this.broadcast({ kind: "snapshot", state: this.state });
        await this.mirror(true);
        console.log("[BuildManager] build cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      console.error("[BuildManager] build failed", error);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  cancel() {
    this.controller?.abort();
  }

  // ---- callback fan-out ----------------------------------------------------

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  // ---- storage mirror ------------------------------------------------------

  /**
   * Mirror a lightweight snapshot to storage so a tab that opens while the worker
   * is asleep paints last-known state instantly; the heartbeat then revives the
   * live run. Deltas go over the port; storage only gets a throttled snapshot.
   */
  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  // ---- worker keepalive ----------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      // A cheap chrome API call resets the ~30s idle-unload timer while a turn is
      // in flight (the in-flight session fetch does most of the work; this covers
      // the gaps between requests).
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  // ---- failure surfacing ---------------------------------------------------

  private notifyFailure(message: string) {
    // Only ping when nobody is watching — an open tab already shows the error
    // inline. A headless daily build that fails otherwise vanishes silently.
    if (this.ports.size > 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Homepage build failed",
        message: message.slice(0, 200),
      });
    } catch {
      // notifications permission missing or API unavailable — nothing else to do.
    }
  }
}
