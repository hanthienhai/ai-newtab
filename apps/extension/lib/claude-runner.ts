import type { ClaudeRunEvent, ClaudeRunRequest, ClaudeRunResult, ClaudeRunner } from "@homepage/agent-core";

/** Must match HOST_NAME in apps/native-host/install.mjs. */
export const NATIVE_HOST = "com.ainewtab.claude";

const NOT_INSTALLED =
  "Can't reach the Claude Code helper. Run `node apps/native-host/install.mjs` in the repo, then reload the extension.";

type HostMsg =
  | { id: number; type: "pong"; version: string | null; loggedIn: boolean }
  | { id: number; type: "event"; event: ClaudeRunEvent }
  | { id: number; type: "result"; result: ClaudeRunResult }
  | { id: number; type: "error"; message: string };

/**
 * Talk to the native host over one `connectNative` port per call. Chrome starts
 * the host process when the port opens and kills it when the port closes, so a
 * cancelled or abandoned build also stops its `claude` process. An open native
 * port also keeps the MV3 service worker alive for the length of the turn.
 */
function call<T>(
  msg: { type: "ping" } | { type: "run"; req: ClaudeRunRequest },
  onEvent: (event: ClaudeRunEvent) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = 1;
    const port = browser.runtime.connectNative(NATIVE_HOST);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
      port.disconnect();
    };
    const onAbort = () => finish(() => reject(new Error("aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });

    port.onMessage.addListener((raw: unknown) => {
      const m = raw as HostMsg;
      if (m.type === "event") onEvent(m.event);
      else if (m.type === "error") finish(() => reject(new Error(m.message)));
      else if (m.type === "result") finish(() => resolve(m.result as T));
      else if (m.type === "pong") finish(() => resolve(m as T));
    });
    port.onDisconnect.addListener(() => {
      const reason = browser.runtime.lastError?.message ?? "";
      finish(() =>
        reject(new Error(/not found|forbidden/i.test(reason) ? `${NOT_INSTALLED} (${reason})` : `Claude Code helper exited. ${reason}`)),
      );
    });
    port.postMessage({ id, ...msg });
  });
}

/** Check the helper is installed and `claude` is logged in, with an actionable message if not. */
export async function checkClaudeCode(): Promise<string> {
  const pong = await call<{ version: string | null; loggedIn: boolean }>({ type: "ping" }, () => {});
  if (!pong.version) throw new Error("The helper can't find the `claude` CLI. Install Claude Code, then rerun the installer.");
  if (!pong.loggedIn) throw new Error("Claude Code isn't logged in. Run `claude auth login` in a terminal, then retry.");
  return pong.version;
}

export const nativeClaudeRunner: ClaudeRunner = {
  run: (req, onEvent, signal) => call<ClaudeRunResult>({ type: "run", req }, onEvent, signal),
};
