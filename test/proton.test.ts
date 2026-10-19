import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DriveStore } from "../src/drive/store.js";
import { htmlToText } from "../src/extract.js";
import { assertLoopback } from "../src/mail/bridge.js";
import type { MailSource } from "../src/mail/source.js";
import { createServer } from "../src/server.js";

function makeDrive() {
  const root = mkdtempSync(path.join(tmpdir(), "proton-drive-"));
  mkdirSync(path.join(root, "Taxes"));
  mkdirSync(path.join(root, ".hidden"));
  writeFileSync(path.join(root, "notes.md"), "# Plan\nRenew the passport in March.");
  writeFileSync(path.join(root, "Taxes", "irpf.csv"), "a,b\n1,2\n");
  writeFileSync(path.join(root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, ".hidden", "secret.txt"), "secret");
  const outside = mkdtempSync(path.join(tmpdir(), "proton-outside-"));
  writeFileSync(path.join(outside, "leak.txt"), "leaked");
  return { root, outside };
}

describe("DriveStore", () => {
  it("lists, searches and reads files, hiding dot-folders", async () => {
    const { root } = makeDrive();
    const drive = await DriveStore.open(root);
    const all = await drive.list("", { recursive: true });
    assert.deepEqual(all.entries.map((e) => e.path).sort(), ["Taxes", "Taxes/irpf.csv", "notes.md", "photo.png"]);
    assert.equal((await drive.search({ name: "irpf" })).matches[0]?.path, "Taxes/irpf.csv");
    assert.match((await drive.search({ contains: "passport" })).matches[0]?.snippet ?? "", /Renew the passport/);
    assert.match((await drive.read("notes.md")).text, /passport/);
  });

  it("refuses traversal, hidden paths, absolute paths and binary files", async () => {
    const { root } = makeDrive();
    const drive = await DriveStore.open(root);
    await assert.rejects(drive.read("../x"), /not allowed/);
    await assert.rejects(drive.read(".hidden/secret.txt"), /not allowed/);
    await assert.rejects(drive.read("C:/Windows/win.ini"), /not allowed/);
    await assert.rejects(drive.read("photo.png"), /not a text or PDF/);
  });

  it("does not follow a symlink out of the folder", async (t) => {
    const { root, outside } = makeDrive();
    try {
      symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      return t.skip("cannot create symlinks here");
    }
    const drive = await DriveStore.open(root);
    await assert.rejects(drive.read("link/leak.txt"), /outside/);
    assert.ok(!(await drive.list("", { recursive: true })).entries.some((e) => e.path.includes("leak")));
  });

  it("pages long text", async () => {
    const { root } = makeDrive();
    writeFileSync(path.join(root, "long.txt"), "x".repeat(50));
    const part = await (await DriveStore.open(root)).read("long.txt", { maxChars: 20 });
    assert.equal(part.text.length, 20);
    assert.equal(part.truncated, true);
    assert.equal(part.totalChars, 50);
  });
});

describe("mail guards", () => {
  it("only talks to a loopback Bridge", () => {
    assertLoopback("127.0.0.1");
    assertLoopback("localhost");
    assert.throws(() => assertLoopback("mail.example.com"), /on this computer/);
  });
  it("flattens HTML", () => {
    assert.equal(htmlToText("<style>p{}</style><p>Hi&nbsp;<b>there</b></p><script>x()</script>"), "Hi there");
  });
});

const fakeMail: MailSource = {
  listFolders: async () => [{ path: "INBOX", messages: 1, unseen: 1 }],
  search: async (q) => ({
    totalMatches: 1,
    messages: [{ uid: 7, date: "2026-10-01T00:00:00.000Z", from: "a@b.c", to: "me@proton.me", subject: `hit ${q.folder}`, unread: true, size: 10 }],
  }),
  read: async (_f, uid) => ({
    uid, date: null, from: "a@b.c", to: "", cc: "", subject: "s", messageId: null, unread: true, size: 1,
    text: "hello world", attachments: [{ index: 0, filename: "n.txt", contentType: "text/plain", size: 5 }],
  }),
  attachment: async () => ({ filename: "n.txt", contentType: "text/plain", data: Buffer.from("attached text") }),
};

async function connect(sources: Parameters<typeof createServer>[0]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(sources, "test").connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("MCP server", () => {
  it("exposes only the tools for configured sources, all read-only", async () => {
    const mailOnly = await connect({ mail: fakeMail });
    const names = (await mailOnly.listTools()).tools;
    assert.deepEqual(names.map((t) => t.name).sort(), ["list_mail_folders", "read_mail", "read_mail_attachment", "search_mail"]);
    assert.ok(names.every((t) => t.annotations?.readOnlyHint === true));

    const driveOnly = await connect({ drive: await DriveStore.open(makeDrive().root) });
    assert.deepEqual((await driveOnly.listTools()).tools.map((t) => t.name).sort(), ["list_drive_files", "read_drive_file", "search_drive_files"]);
  });

  it("serves mail and drive calls", async () => {
    const client = await connect({ mail: fakeMail, drive: await DriveStore.open(makeDrive().root) });
    assert.match(textOf(await client.callTool({ name: "search_mail", arguments: { subject: "x" } })), /hit INBOX/);
    assert.match(textOf(await client.callTool({ name: "read_mail", arguments: { uid: 7 } })), /hello world/);
    assert.match(textOf(await client.callTool({ name: "read_mail_attachment", arguments: { uid: 7, index: 0 } })), /attached text/);
    assert.match(textOf(await client.callTool({ name: "read_drive_file", arguments: { path: "notes.md" } })), /passport/);
    const bad = await client.callTool({ name: "read_drive_file", arguments: { path: "../etc" } });
    assert.equal(bad.isError, true);
  });
});

describe("privacy rules", () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const walk = (dir: string): { file: string; text: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [{ file: path.relative(srcDir, path.join(dir, e.name)).replace(/\\/g, "/"), text: readFileSync(path.join(dir, e.name), "utf8") }] : [],
    );
  // Comments may mention what the code does not do, so rules are checked against code only.
  const sources = walk(srcDir).map((s) => ({ ...s, text: s.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") }));

  it("never writes files, spawns processes, or uses http/fetch", () => {
    const forbidden = /\b(writeFile|appendFile|createWriteStream|writeFileSync|unlink|rm|rmdir|rename|copyFile|mkdir)\s*\(|child_process|node:https?['"]|(?<![.\w])fetch\s*\(|XMLHttpRequest|WebSocket/;
    for (const { file, text } of sources) assert.ok(!forbidden.test(text), `${file} uses a forbidden API`);
  });

  it("has no SMTP or mailbox-changing IMAP calls", () => {
    const mutating = /smtp|nodemailer|\.(messageFlagsAdd|messageFlagsSet|messageFlagsRemove|messageDelete|messageMove|messageCopy|append|mailboxCreate|mailboxDelete|mailboxRename)\s*\(/i;
    for (const { file, text } of sources) assert.ok(!mutating.test(text), `${file} can change the mailbox`);
  });

  it("only the Bridge module touches the network, and always opens mailboxes read-only", () => {
    for (const { file, text } of sources) {
      if (file !== "mail/bridge.ts") assert.ok(!/imapflow|node:net|node:tls/.test(text), `${file} must not do networking`);
    }
    const bridge = sources.find((s) => s.file === "mail/bridge.ts")!.text;
    assert.ok(/readOnly:\s*true/.test(bridge));
    assert.equal((bridge.match(/getMailboxLock\(/g) ?? []).length, 1);
  });

  it("never logs", () => {
    for (const { file, text } of sources) assert.ok(!/console\./.test(text), `${file} uses console`);
  });
});
