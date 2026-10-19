/** What the server needs from a mailbox. The real implementation talks to Proton Mail Bridge; tests use a fake. */

export interface MailFolder {
  path: string;
  specialUse?: string;
  messages?: number;
  unseen?: number;
}

export interface MailSummary {
  uid: number;
  date: string | null;
  from: string;
  to: string;
  subject: string;
  unread: boolean;
  size: number | null;
}

export interface MailSearch {
  folder: string;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  unreadOnly?: boolean | undefined;
  limit: number;
}

export interface MailAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  cc: string;
  messageId: string | null;
  text: string;
  attachments: MailAttachment[];
}

export interface MailSource {
  listFolders(): Promise<MailFolder[]>;
  search(query: MailSearch): Promise<{ messages: MailSummary[]; totalMatches: number }>;
  read(folder: string, uid: number): Promise<MailMessage>;
  attachment(folder: string, uid: number, index: number): Promise<{ filename: string; contentType: string; data: Uint8Array }>;
}
