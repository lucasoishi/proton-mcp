import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { UserFacingError } from "../errors.js";
import { htmlToText } from "../extract.js";
import type { MailAttachment, MailFolder, MailMessage, MailSearch, MailSource, MailSummary } from "./source.js";

export interface BridgeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Proton Mail Bridge listens on the loopback interface with a self-signed certificate, so certificate
 * checks are switched off for it, which is only safe because the host must be a loopback address.
 * Refusing anything else means the Bridge password can never be sent across a network.
 */
export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host.toLowerCase())) {
    throw new UserFacingError(`Proton Mail Bridge must be on this computer: the host must be 127.0.0.1 or localhost, not "${host}".`);
  }
}

const formatAddress = (a: AddressObject | AddressObject[] | undefined): string => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : (a?.text ?? ""));

/**
 * Read-only mail access over IMAP to Proton Mail Bridge.
 *
 * Every mailbox is opened read-only (IMAP EXAMINE) and messages are fetched with BODY.PEEK, so
 * nothing is marked as read and no flag, folder or message can be changed. Only IMAP is used:
 * there is no SMTP code, so nothing can be sent either.
 */
export class BridgeMail implements MailSource {
  constructor(private readonly config: BridgeConfig) {
    assertLoopback(config.host);
  }

  private async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: false, // Bridge upgrades the connection with STARTTLS
      auth: { user: this.config.user, pass: this.config.password },
      tls: { rejectUnauthorized: false }, // Bridge's certificate is self-signed; the host is checked to be loopback
      logger: false, // the default logger would print message data
    });
    client.on("error", () => {}); // surfaced through the failing call instead
    try {
      await client.connect();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ECONNREFUSED") {
        throw new UserFacingError(`Could not reach Proton Mail Bridge at ${this.config.host}:${this.config.port}. Is Bridge running and signed in?`);
      }
      if ((error as { authenticationFailed?: boolean }).authenticationFailed) {
        throw new UserFacingError("Proton Mail Bridge rejected the login. Use the username and password shown in Bridge's account settings (not your Proton password).");
      }
      throw new UserFacingError("Could not connect to Proton Mail Bridge.");
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async inFolder<T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      let lock;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
      } catch {
        throw new UserFacingError(`Mail folder not found: ${folder}. Use list_mail_folders to see the exact names.`);
      }
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  listFolders(): Promise<MailFolder[]> {
    return this.withClient(async (client) => {
      const folders: MailFolder[] = [];
      for (const box of await client.list()) {
        if (box.flags?.has("\\Noselect")) continue;
        const folder: MailFolder = { path: box.path, ...(box.specialUse && { specialUse: box.specialUse }) };
        try {
          const status = await client.status(box.path, { messages: true, unseen: true });
          if (status) {
            folder.messages = status.messages;
            folder.unseen = status.unseen;
          }
        } catch {
          // counts are a nicety
        }
        folders.push(folder);
      }
      return folders;
    });
  }

  search(query: MailSearch): Promise<{ messages: MailSummary[]; totalMatches: number }> {
    return this.inFolder(query.folder, async (client) => {
      const criteria: Record<string, unknown> = {};
      if (query.from) criteria["from"] = query.from;
      if (query.to) criteria["to"] = query.to;
      if (query.subject) criteria["subject"] = query.subject;
      if (query.text) criteria["body"] = query.text;
      if (query.since) criteria["since"] = new Date(`${query.since}T00:00:00`);
      if (query.before) criteria["before"] = new Date(`${query.before}T00:00:00`);
      if (query.unreadOnly) criteria["seen"] = false;
      const found = (await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || [];
      const newest = found.slice(-query.limit);
      const messages: MailSummary[] = [];
      if (newest.length > 0) {
        for await (const m of client.fetch(newest, { uid: true, envelope: true, flags: true, size: true }, { uid: true })) {
          messages.push({
            uid: m.uid,
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
            from: (m.envelope?.from ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", "),
            to: (m.envelope?.to ?? []).map((a) => a.address ?? "").join(", "),
            subject: m.envelope?.subject ?? "",
            unread: !m.flags?.has("\\Seen"),
            size: m.size ?? null,
          });
        }
      }
      messages.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return { messages, totalMatches: found.length };
    });
  }

  private async fetchParsed(folder: string, uid: number): Promise<{ parsed: ParsedMail; unread: boolean; size: number | null }> {
    return this.inFolder(folder, async (client) => {
      const head = await client.fetchOne(String(uid), { uid: true, flags: true, size: true }, { uid: true });
      if (!head) throw new UserFacingError(`No message with uid ${uid} in ${folder}.`);
      if ((head.size ?? 0) > MAX_MESSAGE_BYTES) throw new UserFacingError("That message is larger than 30 MB.");
      const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!full || !full.source) throw new UserFacingError(`No message with uid ${uid} in ${folder}.`);
      return { parsed: await simpleParser(full.source), unread: !head.flags?.has("\\Seen"), size: head.size ?? null };
    });
  }

  async read(folder: string, uid: number): Promise<MailMessage> {
    const { parsed, unread, size } = await this.fetchParsed(folder, uid);
    const attachments: MailAttachment[] = parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index}`,
      contentType: a.contentType,
      size: a.size,
    }));
    return {
      uid,
      date: parsed.date ? parsed.date.toISOString() : null,
      from: parsed.from?.text ?? "",
      to: formatAddress(parsed.to),
      cc: formatAddress(parsed.cc),
      subject: parsed.subject ?? "",
      messageId: parsed.messageId ?? null,
      unread,
      size,
      text: parsed.text ?? (parsed.html ? htmlToText(parsed.html) : ""),
      attachments,
    };
  }

  async attachment(folder: string, uid: number, index: number) {
    const { parsed } = await this.fetchParsed(folder, uid);
    const part = parsed.attachments[index];
    if (!part) throw new UserFacingError(`Message ${uid} has no attachment number ${index}.`);
    return { filename: part.filename ?? `attachment-${index}`, contentType: part.contentType, data: part.content };
  }
}
