import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const app = await readFile(new URL("./app.mjs", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = () => ({ status: "manual_review", topic: null, draft: null });

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response, classifyModel, timeoutMs) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!input || Array.isArray(input) || typeof input.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timer;
  try {
    // Race enforces the deadline even if a provider ignores the abort signal.
    const raw = await Promise.race([
      Promise.resolve().then(() => classifyModel(input.text.trim(), { signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Model deadline exceeded"));
        }, timeoutMs);
      }),
    ]);
    const result = JSON.parse(raw);
    if (!result || Array.isArray(result) || !topics.has(result.topic) ||
        typeof result.draft !== "string" || !result.draft.trim()) {
      return json(response, 200, manualReview());
    }
    // Whitelist fields: provider output cannot override our workflow status.
    return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft.trim() });
  } catch {
    return json(response, 200, manualReview());
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ classifyModel = classify, timeoutMs = 300 } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/app.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(app);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifyModel, timeoutMs);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () => {
    console.log(`Open http://127.0.0.1:${server.address().port}`);
  });
}
