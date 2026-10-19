import { UserFacingError } from "./errors.js";
import { extractPdfText } from "./pdf.js";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log", "yml", "yaml", "ini", "toml", "eml", "ics", "vcf", "rtf",
]);

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Whether `readable()` can turn a file with this name or content type into text. */
export function isReadable(name: string, contentType?: string): boolean {
  const ext = extensionOf(name);
  if (ext === "pdf" || TEXT_EXTENSIONS.has(ext)) return true;
  if (!contentType) return false;
  return contentType === "application/pdf" || contentType.startsWith("text/") || contentType === "application/json";
}

/** Crude but safe HTML to text: drops scripts and styles, keeps line structure, decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text of a file's bytes. PDFs are read in-process; HTML is flattened; other binary formats are refused. */
export async function readable(
  name: string,
  data: Uint8Array,
  opts: { contentType?: string | undefined; pdfPassword?: string | undefined } = {},
): Promise<string> {
  const ext = extensionOf(name);
  if (ext === "pdf" || opts.contentType === "application/pdf") return extractPdfText(data, opts.pdfPassword);
  if (!isReadable(name, opts.contentType)) {
    throw new UserFacingError(
      `"${name}" is not a text or PDF file, so its contents cannot be shown. Supported: PDF and ${[...TEXT_EXTENSIONS].join(", ")}.`,
    );
  }
  const text = Buffer.from(data).toString("utf8");
  return ext === "html" || ext === "htm" || opts.contentType === "text/html" ? htmlToText(text) : text;
}

/** Cut text to a window so a huge file cannot flood the agent's context. */
export function window(text: string, offset: number, maxChars: number) {
  const slice = text.slice(offset, offset + maxChars);
  return { text: slice, offset, totalChars: text.length, truncated: offset + slice.length < text.length };
}
