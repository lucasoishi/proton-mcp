// Manual check against a real Proton Mail Bridge. Usage (after `npm run build`):
//   $env:PROTON_BRIDGE_USER="..."; $env:PROTON_BRIDGE_PASSWORD="..."; node scripts/smoke-mail.mjs
import { BridgeMail } from "../dist/mail/bridge.js";

const mail = new BridgeMail({
  host: process.env.PROTON_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.PROTON_BRIDGE_PORT ?? 1143),
  user: process.env.PROTON_BRIDGE_USER,
  password: process.env.PROTON_BRIDGE_PASSWORD,
});

const folders = await mail.listFolders();
console.log("folders:", folders.map((f) => `${f.path} (${f.messages ?? "?"}/${f.unseen ?? "?"} unread)`).join(", "));
const { messages, totalMatches } = await mail.search({ folder: "INBOX", limit: 3 });
console.log(`inbox: ${totalMatches} messages; newest 3:`);
for (const m of messages) console.log(`  #${m.uid} ${m.date?.slice(0, 10)} ${m.subject.slice(0, 60)}`);
if (messages[0]) {
  const full = await mail.read("INBOX", messages[0].uid);
  console.log(`read #${full.uid}: ${full.text.length} chars, ${full.attachments.length} attachment(s), still unread: ${full.unread}`);
}
