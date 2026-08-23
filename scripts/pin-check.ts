import { getPerchAuth } from "../src/auth.js";
import { baseUrl, MODEL_CALL_PATH } from "../src/upstream.js";

const auth = await getPerchAuth();
const slugs = process.argv.slice(2);

for (const slug of slugs) {
  const body = JSON.stringify({
    request: {
      lane: "chat",
      messages: [{ role: "user", content: "Say hi in 3 words" }],
      maxOutputTokens: 30,
    },
    runId: crypto.randomUUID(),
    lane: "chat",
    strictManual: false,
    preferredModelId: null,
    avoidModelIds: [],
    attribution: null,
    clientSurface: "cli",
    manualModelOptionId: slug,
  });
  const res = await fetch(`${baseUrl()}${MODEL_CALL_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body,
  });
  const text = await res.text();
  let out = `${slug}: HTTP ${res.status}`;
  if (!res.ok) {
    out += ` ${text.slice(0, 120)}`;
  } else {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const dbg = j.debug as Record<string, unknown> | undefined;
      out += ` -> served=${j.model} provider=${j.provider} modelUsed=${dbg?.modelUsed}`;
    } catch {
      out += " (unparseable)";
    }
  }
  console.log(out);
}
