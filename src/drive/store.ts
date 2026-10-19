import { promises as fs } from "node:fs";
import path from "node:path";
import { UserFacingError } from "../errors.js";
import { extensionOf, isReadable, readable, window } from "../extract.js";

export interface DriveEntry {
  path: string; // relative to the Drive folder, forward slashes
  type: "file" | "folder";
  size?: number;
  modified: string;
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_WALK = 20_000;
const MAX_CONTENT_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_SCAN_FILES = 1_000;

/**
 * Read-only access to the folder the Proton Drive desktop app keeps in sync.
 *
 *  - paths are relative to that folder; `..`, absolute paths and symlinks that leave it are refused
 *  - hidden files and folders (names starting with ".") are never listed or read
 *  - nothing is ever written, and nothing is sent over the network
 */
export class DriveStore {
  private constructor(private readonly root: string) {}

  static async open(dir: string): Promise<DriveStore> {
    let root: string;
    try {
      root = await fs.realpath(dir);
      if (!(await fs.stat(root)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new UserFacingError("The configured Proton Drive folder could not be read. Check --drive-dir or PROTON_DRIVE_DIR.");
    }
    return new DriveStore(root);
  }

  get name(): string {
    return path.basename(this.root);
  }

  /** Resolve a user-supplied relative path to a real path inside the root, or throw. */
  private async resolve(rel: string): Promise<string> {
    const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (/^[a-zA-Z]:/.test(clean) || clean.split("/").some((part) => part === ".." || (part.startsWith(".") && part !== "."))) {
      throw new UserFacingError("That path is not allowed (parent, absolute or hidden paths cannot be accessed).");
    }
    let real: string;
    try {
      real = await fs.realpath(path.join(this.root, clean));
    } catch {
      throw new UserFacingError(`Not found in Proton Drive: ${rel || "/"}`);
    }
    const back = path.relative(this.root, real);
    if (back.startsWith("..") || path.isAbsolute(back)) throw new UserFacingError("That path resolves outside the Proton Drive folder.");
    return real;
  }

  private rel(real: string): string {
    return path.relative(this.root, real).split(path.sep).join("/");
  }

  async list(folder = "", opts: { recursive?: boolean; limit?: number } = {}): Promise<{ entries: DriveEntry[]; truncated: boolean }> {
    const limit = opts.limit ?? 200;
    const start = await this.resolve(folder);
    if (!(await fs.stat(start)).isDirectory()) throw new UserFacingError(`${folder} is a file, not a folder.`);
    const entries: DriveEntry[] = [];
    let truncated = false;
    let visited = 0;
    const walk = async (dir: string): Promise<void> => {
      const children = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= limit || ++visited > MAX_WALK) {
          truncated = true;
          return;
        }
        let real: string;
        let stat;
        try {
          real = await fs.realpath(path.join(dir, child.name));
          const back = path.relative(this.root, real);
          if (back.startsWith("..") || path.isAbsolute(back)) continue; // symlink out of the folder
          stat = await fs.stat(real);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          entries.push({ path: this.rel(real), type: "folder", modified: stat.mtime.toISOString() });
          if (opts.recursive) await walk(real);
        } else if (stat.isFile()) {
          entries.push({ path: this.rel(real), type: "file", size: stat.size, modified: stat.mtime.toISOString() });
        }
        if (truncated) return;
      }
    };
    await walk(start);
    return { entries, truncated };
  }

  /** Find files by name (case-insensitive substring) and/or by text inside small plain-text files. */
  async search(opts: {
    name?: string | undefined;
    contains?: string | undefined;
    extension?: string | undefined;
    modifiedSince?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ matches: (DriveEntry & { snippet?: string })[]; truncated: boolean; note?: string }> {
    const limit = opts.limit ?? 50;
    const all = (await this.list("", { recursive: true, limit: MAX_WALK })).entries.filter((e) => e.type === "file");
    const name = opts.name?.toLowerCase();
    const needle = opts.contains?.toLowerCase();
    const ext = opts.extension?.toLowerCase().replace(/^\./, "");
    const since = opts.modifiedSince ? Date.parse(opts.modifiedSince) : undefined;
    const matches: (DriveEntry & { snippet?: string })[] = [];
    let scanned = 0;
    let skippedContent = false;
    for (const entry of all) {
      if (matches.length >= limit) return { matches, truncated: true };
      if (name && !entry.path.toLowerCase().includes(name)) continue;
      if (ext && extensionOf(entry.path) !== ext) continue;
      if (since !== undefined && Date.parse(entry.modified) < since) continue;
      if (needle) {
        const plain = isReadable(entry.path) && extensionOf(entry.path) !== "pdf";
        if (!plain || (entry.size ?? 0) > MAX_CONTENT_SCAN_BYTES || scanned >= MAX_CONTENT_SCAN_FILES) {
          skippedContent = true;
          continue;
        }
        scanned++;
        const text = await fs.readFile(path.join(this.root, entry.path), "utf8").catch(() => "");
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        matches.push({ ...entry, snippet: text.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, " ") });
      } else {
        matches.push(entry);
      }
    }
    return {
      matches,
      truncated: false,
      ...(skippedContent && { note: "Text search covers plain-text files up to 2 MB (not PDFs or larger files); others were skipped." }),
    };
  }

  async read(file: string, opts: { offset?: number | undefined; maxChars?: number | undefined; pdfPassword?: string | undefined } = {}) {
    const real = await this.resolve(file);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new UserFacingError(`${file} is a folder, not a file.`);
    if (stat.size > MAX_BYTES) throw new UserFacingError("File is larger than 25 MB.");
    const text = await readable(path.basename(real), await fs.readFile(real), { pdfPassword: opts.pdfPassword });
    return { path: this.rel(real), size: stat.size, modified: stat.mtime.toISOString(), ...window(text, opts.offset ?? 0, opts.maxChars ?? 20_000) };
  }
}
