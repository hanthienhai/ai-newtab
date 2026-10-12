/**
 * Chrome native messaging host. Chrome starts it per `connectNative()` port and
 * talks length-prefixed JSON over stdin/stdout (4-byte little-endian length).
 * stdout is the wire: never log to it, only to stderr.
 *
 *   page → host   { id, type: "ping" }
 *                 { id, type: "run", req }        (see claude-run.mjs)
 *                 { id, type: "cancel" }
 *   host → page   { id, type: "pong", version, loggedIn }
 *                 { id, type: "event", event }
 *                 { id, type: "result", result }
 *                 { id, type: "error", message }
 */
import { execFile } from "node:child_process";
import { claudePath, runClaude } from "./claude-run.mjs";

/** Chrome caps host → extension messages at 1 MB. */
const MAX_OUT_BYTES = 1024 * 1024;

const runs = new Map();

function send(msg) {
  let body = Buffer.from(JSON.stringify(msg), "utf-8");
  if (body.length > MAX_OUT_BYTES) {
    body = Buffer.from(JSON.stringify({ id: msg.id, type: "error", message: "host message over 1 MB" }));
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function handle(msg) {
  switch (msg.type) {
    case "ping": {
      const run = (args) =>
        new Promise((res) =>
          execFile(claudePath(), args, { windowsHide: true }, (err, out) => res(err ? null : out.trim())),
        );
      const [version, status] = await Promise.all([run(["--version"]), run(["auth", "status"])]);
      let loggedIn = false;
      try {
        loggedIn = Boolean(JSON.parse(status ?? "{}").loggedIn);
      } catch {
        // older CLI without JSON status: let the first run report auth errors
        loggedIn = true;
      }
      send({ id: msg.id, type: "pong", version, loggedIn });
      break;
    }
    case "run": {
      const controller = new AbortController();
      runs.set(msg.id, controller);
      try {
        const result = await runClaude(msg.req, (event) => send({ id: msg.id, type: "event", event }), controller.signal);
        send({ id: msg.id, type: "result", result });
      } catch (err) {
        send({ id: msg.id, type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        runs.delete(msg.id);
      }
      break;
    }
    case "cancel":
      runs.get(msg.id)?.abort();
      break;
    default:
      send({ id: msg.id, type: "error", message: `unknown message type: ${msg.type}` });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const body = buffer.subarray(4, 4 + len).toString("utf-8");
    buffer = buffer.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      console.error("[host] bad message", err);
      continue;
    }
    void handle(msg);
  }
});

// The port closed (tab gone, worker restarted, extension cancelled): stop any
// claude still running so it doesn't keep burning the plan's usage.
process.stdin.on("end", () => {
  for (const controller of runs.values()) controller.abort();
  setTimeout(() => process.exit(0), 2000);
});
