#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DriveStore } from "./drive/store.js";
import { UserFacingError } from "./errors.js";
import { BridgeMail } from "./mail/bridge.js";
import { createServer } from "./server.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `proton-mcp ${version}

A local, read-only MCP server for Proton Mail and Proton Drive. Each source is optional; configure at least one.

Mail (needs Proton Mail Bridge running and signed in; paid Proton plan):
  PROTON_BRIDGE_USER       username shown in Bridge's account settings (usually your address)
  PROTON_BRIDGE_PASSWORD   the Bridge-generated password (NOT your Proton password)
  --bridge-host <host>     default 127.0.0.1 (must be on this computer)
  --bridge-port <port>     default 1143 (the IMAP port shown in Bridge's settings)

Drive (reads the folder the Proton Drive desktop app syncs):
  --drive-dir <folder>     or PROTON_DRIVE_DIR

Other:
  PROTON_PDF_PASSWORD      only if your PDFs are password protected
  --help, --version
`;

function flag(argv: string[], name: string, env?: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return env ? process.env[env] || undefined : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const driveDir = flag(argv, "--drive-dir", "PROTON_DRIVE_DIR");
  const user = process.env["PROTON_BRIDGE_USER"];
  const password = process.env["PROTON_BRIDGE_PASSWORD"];
  if (!!user !== !!password) throw new UserFacingError("Set both PROTON_BRIDGE_USER and PROTON_BRIDGE_PASSWORD, or neither.");

  const port = Number(flag(argv, "--bridge-port", "PROTON_BRIDGE_PORT") ?? 1143);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserFacingError("--bridge-port must be a port number.");

  const mail = user && password ? new BridgeMail({ host: flag(argv, "--bridge-host", "PROTON_BRIDGE_HOST") ?? "127.0.0.1", port, user, password }) : undefined;
  const drive = driveDir ? await DriveStore.open(path.resolve(driveDir)) : undefined;

  if (!mail && !drive) {
    // stdout is reserved for the MCP protocol, so diagnostics go to stderr.
    process.stderr.write(`Nothing configured.\n\n${USAGE}`);
    process.exit(1);
  }

  const server = createServer({ mail, drive, pdfPassword: process.env["PROTON_PDF_PASSWORD"] || undefined }, version);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`proton-mcp ${version} ready (${[mail && "Mail via Bridge", drive && `Drive folder "${drive.name}"`].filter(Boolean).join(" + ")}, read-only)\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof UserFacingError ? error.message : "Unexpected error.";
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
