# proton-mcp

A local, **read-only** [MCP](https://modelcontextprotocol.io) server that lets an AI agent search and read your Proton Mail and Proton Drive.

Proton has no public API for either product, so this uses the two routes Proton itself supports for third-party access:

| Source | How | Needs |
|---|---|---|
| **Mail** | IMAP to [Proton Mail Bridge](https://proton.me/mail/bridge) on your own computer | Paid Proton plan; Bridge installed, running and signed in |
| **Drive** | The folder the Proton Drive desktop app keeps in sync | Proton Drive desktop app |

Both are optional; configure either or both. Your Proton password is never used.

## Tools

| Tool | Source | What it does |
|---|---|---|
| `list_mail_folders` | Mail | Folders and labels with message / unread counts |
| `search_mail` | Mail | Newest-first search by sender, recipient, subject, body text, dates, unread |
| `read_mail` | Mail | Headers, text body (paged) and attachment list of one message |
| `read_mail_attachment` | Mail | Text of a PDF / text / CSV / JSON / HTML attachment, in memory only |
| `list_drive_files` | Drive | Files and folders, optionally recursive |
| `search_drive_files` | Drive | By name, extension, modified date, or text inside plain-text files |
| `read_drive_file` | Drive | Text of a PDF or text file (paged) |

All tools are annotated read-only. Long documents are returned in windows (`maxChars`, `offset`).

## Setup

### Mail (Proton Mail Bridge)

1. Install Bridge, sign in, and open your account's **Mailbox configuration**.
2. Note the **username** and the Bridge-generated **password** (this is not your Proton password) and the IMAP port (default 1143).
3. Set `PROTON_BRIDGE_USER` and `PROTON_BRIDGE_PASSWORD`. Bridge must be running whenever you use the mail tools.

### Drive

Point `--drive-dir` (or `PROTON_DRIVE_DIR`) at the folder the Proton Drive app syncs. If you use online-only files, reading one makes the app download it first.

### Register with your agent

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "proton": {
      "command": "node",
      "args": ["C:/Users/lucas/Documents/proton-mcp/dist/index.js", "--drive-dir", "C:/path/to/Proton Drive"],
      "env": {
        "PROTON_BRIDGE_USER": "you@proton.me",
        "PROTON_BRIDGE_PASSWORD": "<password from Bridge>"
      }
    }
  }
}
```

Options: `--bridge-host` (loopback only), `--bridge-port`, `PROTON_PDF_PASSWORD`.

## Privacy and safety

- **Read-only, enforced by tests.** Mailboxes are opened with IMAP `EXAMINE` and messages fetched with `BODY.PEEK`, so nothing is marked read. There is no SMTP code and no call that changes flags, moves or deletes messages. Nothing writes to disk (attachments are read in memory). `test/proton.test.ts` fails if any source file adds such a call.
- **Local only.** The Bridge host must be `127.0.0.1` / `localhost`; anything else is refused at startup. Bridge uses a self-signed certificate, so verification is off, which is only acceptable because of that rule. No other network code exists.
- **Drive confinement.** Paths are relative to the sync folder; `..`, absolute paths, hidden (`.`) entries and symlinks that leave the folder are refused.
- **Credentials** come from environment variables, not command-line flags (which show up in process lists). Nothing is logged.
- **Prompt injection.** Emails and documents are written by third parties and may contain text aimed at your agent. Tool descriptions tell the model to treat content as data, but that is a mitigation, not a guarantee. This server can't send mail or change anything, which limits the damage.
- **The agent you connect decides what happens to the answers.** With a cloud model, the mail and files it reads go to that provider.

## Limits

- Mail search uses Bridge's IMAP search, so it only covers what Bridge has synced; Proton's own encrypted-search features aren't available.
- Mail bodies: plain text, falling back to flattened HTML. Only PDF and text-like attachments can be read.
- Drive text search covers plain-text files up to 2 MB, not PDFs. PDFs have to be opened with `read_drive_file`.
- Shared-with-me folders appear only if the desktop app syncs them.

## Development

```bash
npm test
npm run typecheck
npm run dev -- --drive-dir <folder>
```

Layout: `src/mail/` (source interface + Bridge IMAP), `src/drive/store.ts`, `src/extract.ts` (PDF/text/HTML to text), `src/server.ts` (tools), `src/index.ts` (CLI).

The automated tests run the mail side against a fake IMAP source and the Drive side against a temporary folder. I have also run the server by hand against my own Proton Bridge and Proton Drive folder; that manual check is not part of the test suite.

## Built with AI assistance

Most of the code, tests and documentation in this repository were written by an AI assistant (Claude Code, by Anthropic), working from my requirements and constraints: read-only access, local-only connections, and no way for the agent to change or send anything. I directed the design and ran and checked it against my own account. It is a small personal project tested on one person's mailbox, so treat it as unreviewed software: read the code before pointing it at mail you care about.

## License

MIT
