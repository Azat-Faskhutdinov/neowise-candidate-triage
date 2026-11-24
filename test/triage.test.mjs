import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { createTriageController } from "../app.mjs";

const manual = { status: "manual_review", topic: null, draft: null };
let server;
let base;

before(async () => {
  server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(body, url = base) {
  const response = await fetch(`${url}/api/triage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  return { code: response.status, body: await response.json() };
}

for (const body of ["", "{", "null", "[]", '"text"', "42", "{}", '{"text":null}', '{"text":3}', '{"text":[]}', '{"text":{}}', '{"text":""}', '{"text":" \\n\\t "}']) {
  test(`API rejects invalid input: ${body || "empty body"}`, async () => {
    assert.deepEqual(await post(body), { code: 400, body: { status: "invalid_input" } });
  });
}

for (const [text, topic] of [["Когда доставка?", "delivery"], ["Какая стоимость?", "pricing"], ["Здравствуйте", "other"]]) {
  test(`API classifies a valid request as ${topic}`, async () => {
    const result = await post(JSON.stringify({ text }));
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." });
  });
}
for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`API falls back to manual review: ${marker}`, async () => {
    assert.deepEqual(await post(JSON.stringify({ text: marker })), { code: 200, body: manual });
  });
}

async function withProvider(provider, callback, timeoutMs = 300) {
  const app = createApp({ classifyModel: provider, timeoutMs });
  app.listen(0, "127.0.0.1"); await once(app, "listening");
  try { await callback(`http://127.0.0.1:${app.address().port}`); }
  finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
}

test("invalid input never calls the model", async () => {
  let calls = 0;
  await withProvider(() => { calls += 1; throw new Error("Must not be called"); }, async url => {
    assert.equal((await post('{"text":"   "}', url)).code, 400);
    assert.equal(calls, 0);
  });
});
test("deadline returns even when provider ignores cancellation; abort signal is sent", async () => {
  let signal;
  await withProvider((_text, options) => { signal = options.signal; return new Promise(() => {}); }, async url => {
    const result = await Promise.race([
      post('{"text":"hello"}', url),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Deadline did not complete")), 1000); timer.unref(); }),
    ]);
    assert.deepEqual(result, { code: 200, body: manual });
    assert.equal(signal.aborted, true);
  }, 30);
});
for (const raw of ["null", "[]", '"x"', "42", '{}', '{"topic":"delivery","draft":null}', '{"topic":"delivery","draft":3}', '{"topic":"constructor","draft":"text"}', '{"topic":"other","draft":"\\t\\n "}']) {
  test(`model output must satisfy semantic contract: ${raw}`, async () => {
    await withProvider(async () => raw, async url => assert.deepEqual(await post('{"text":"hello"}', url), { code: 200, body: manual }));
  });
}
test("provider cannot override status or expose extra fields; draft is trimmed", async () => {
  await withProvider(async () => JSON.stringify({ topic: "other", draft: "  OK  ", status: "manual_review", secret: "not part of contract" }), async url => {
    assert.deepEqual(await post('{"text":"hello"}', url), { code: 200, body: { status: "ready", topic: "other", draft: "OK" } });
  });
});
test("HTML and browser module are served; unknown paths remain 404", async () => {
  const page = await fetch(`${base}/`); assert.match(await page.text(), /id="draft"/);
  const script = await fetch(`${base}/app.mjs`); assert.match(script.headers.get("content-type"), /javascript/); assert.match(await script.text(), /createTriageController/);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

const response = body => ({ ok: true, status: 200, json: async () => body });
const ready = draft => ({ status: "ready", topic: "delivery", draft });
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function view(fetchImpl, timeoutMs) {
  const states = [];
  const submit = createTriageController({ fetchImpl, timeoutMs, render: state => states.push(state) });
  return { submit, states, last: () => states.at(-1) };
}

test("UI rejects whitespace without a request and clears previous draft", async () => {
  let calls = 0;
  const ui = view(async () => { calls += 1; return response(ready("old")); });
  await ui.submit("hello"); await ui.submit(" \t ");
  assert.equal(calls, 1); assert.equal(ui.last().status, "invalid_input"); assert.equal(ui.last().draft, ""); assert.equal(ui.last().topic, null);
});
for (const scenario of [manual, { status: "ready", topic: "refund", draft: "bad" }, { status: "ready", topic: "other", draft: "  " }, null]) {
  test(`UI clears an existing draft on unusable API result: ${JSON.stringify(scenario)}`, async () => {
    let calls = 0;
    const ui = view(async () => response(++calls === 1 ? ready("old") : scenario));
    await ui.submit("first"); assert.equal(ui.last().draft, "old");
    const pending = ui.submit("next"); assert.equal(ui.last().draft, "");
    await pending; assert.equal(ui.last().status, "manual_review"); assert.equal(ui.last().draft, ""); assert.equal(ui.last().topic, null); assert.equal(ui.last().loading, false);
  });
}
for (const failure of ["network", "http", "json", "timeout"]) {
  test(`UI offers manual review and clears old draft on ${failure}`, async () => {
    let calls = 0;
    const ui = view(async () => {
      if (++calls === 1) return response(ready("old"));
      if (failure === "network") throw new Error("offline");
      if (failure === "http") return { ok: false, status: 500, json: async () => ({}) };
      if (failure === "json") return { ok: true, json: async () => { throw new SyntaxError("invalid json"); } };
      return new Promise(() => {});
    }, 20);
    await ui.submit("first"); await ui.submit("next");
    assert.equal(ui.last().status, "manual_review"); assert.equal(ui.last().draft, ""); assert.equal(ui.last().loading, false);
  });
}
test("out-of-order responses cannot overwrite the latest result", async () => {
  const a = deferred(); const b = deferred(); let calls = 0; let firstSignal;
  const ui = view((_url, options) => { if (++calls === 1) { firstSignal = options.signal; return a.promise; } return b.promise; });
  const first = ui.submit("first"); const second = ui.submit("second");
  assert.equal(firstSignal.aborted, true);
  b.resolve(response(ready("fresh"))); await second;
  a.resolve(response(ready("stale"))); await first;
  assert.equal(ui.last().draft, "fresh"); assert.equal(ui.last().status, "ready");
});
test("an old failure cannot stop loading or replace the latest result", async () => {
  const a = deferred(); const b = deferred(); let calls = 0;
  const ui = view(() => ++calls === 1 ? a.promise : b.promise);
  const first = ui.submit("first"); const second = ui.submit("second");
  a.reject(new Error("old failure")); await first; assert.equal(ui.last().loading, true);
  b.resolve(response(ready("fresh"))); await second; assert.equal(ui.last().draft, "fresh");
});
test("editing input invalidates pending work and clears the old draft", async () => {
  const pending = deferred(); const ui = view(() => pending.promise);
  const request = ui.submit("old input"); ui.submit.reset();
  pending.resolve(response(ready("stale"))); await request;
  assert.equal(ui.last().status, "idle"); assert.equal(ui.last().draft, "");
});
