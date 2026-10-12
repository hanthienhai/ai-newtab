/**
 * Register the native messaging host with Chrome and Edge for the current user.
 *
 *   node apps/native-host/install.mjs              install
 *   node apps/native-host/install.mjs --uninstall  remove the registry keys
 *
 * Writes, next to this file: `config.json` (absolute path to the `claude` CLI),
 * a launcher (`host.cmd` on Windows, `host.sh` elsewhere) and the host manifest,
 * then points each browser at the manifest. Only the extension ID in
 * extension-key.json may connect.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.ainewtab.claude";
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, `${HOST_NAME}.json`);
const { id: extensionId } = JSON.parse(readFileSync(join(HERE, "extension-key.json"), "utf-8"));
const isWindows = platform() === "win32";

/** Where each browser looks for host manifests (per user). */
const TARGETS = isWindows
  ? [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    ]
  : platform() === "darwin"
    ? [
        join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
        join(homedir(), "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
      ]
    : [join(homedir(), ".config/google-chrome/NativeMessagingHosts"), join(homedir(), ".config/microsoft-edge/NativeMessagingHosts")];

function findClaude() {
  const out = execFileSync(isWindows ? "where" : "which", ["claude"], { encoding: "utf-8" });
  // `where` can list several matches (claude, claude.cmd, claude.exe); prefer the .exe.
  const hits = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return hits.find((h) => /\.exe$/i.test(h)) ?? hits[0];
}

function install() {
  const claudePath = findClaude();
  writeFileSync(join(HERE, "config.json"), JSON.stringify({ claudePath }, null, 2) + "\n");

  // Chrome starts the host with its own environment, so pin the node binary too.
  const launcher = join(HERE, isWindows ? "host.cmd" : "host.sh");
  const hostScript = join(HERE, "host.mjs");
  if (isWindows) {
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${hostScript}" %*\r\n`);
  } else {
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${hostScript}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }

  const manifest = {
    name: HOST_NAME,
    description: "Runs Claude Code (claude -p) for the AI Homepage extension",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  for (const target of TARGETS) {
    if (isWindows) {
      execFileSync("reg", ["add", target, "/ve", "/t", "REG_SZ", "/d", MANIFEST_PATH, "/f"], { stdio: "ignore" });
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + "\n");
    }
  }

  console.log(`claude:       ${claudePath}`);
  console.log(`manifest:     ${MANIFEST_PATH}`);
  console.log(`extension ID: ${extensionId}`);
  console.log(`registered for Chrome and Edge.`);
}

function uninstall() {
  for (const target of TARGETS) {
    if (isWindows) {
      try {
        execFileSync("reg", ["delete", target, "/f"], { stdio: "ignore" });
      } catch {
        // not registered
      }
    } else {
      const file = join(target, `${HOST_NAME}.json`);
      if (existsSync(file)) rmSync(file);
    }
  }
  console.log("native host unregistered.");
}

process.argv.includes("--uninstall") ? uninstall() : install();
