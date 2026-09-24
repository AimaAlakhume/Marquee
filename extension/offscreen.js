/* Marquee — on-device model host.
 *
 * WebGPU is not available in an MV3 service worker, so the engine lives here,
 * in an offscreen document: a real renderer with the extension's own origin and
 * CSP, so nothing depends on the host page's content-security policy.
 *
 * Nothing in this file can reach the catalogue or the ranking code. It takes a
 * sentence, returns JSON, and every field it returns is re-validated by the
 * content script before agent.js is allowed to see it.
 */
import { CreateMLCEngine, prebuiltAppConfig } from "./vendor/web-llm.js";

const DEFAULT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

let engine = null;
let loading = null;
let state = { phase: "idle", progress: 0, text: "", model: DEFAULT_MODEL, error: null };

function post(msg) {
  try { chrome.runtime.sendMessage({ mq: "llm-event", ...msg }); } catch (_) {}
}

function setState(patch) {
  state = { ...state, ...patch };
  post({ event: "state", state });
}

async function load(model) {
  if (engine) return { ok: true, already: true };
  if (loading) return loading;

  const id = model || DEFAULT_MODEL;
  const known = prebuiltAppConfig.model_list.some(m => m.model_id === id);
  if (!known) {
    setState({ phase: "error", error: `unknown model id: ${id}` });
    return { ok: false, error: `unknown model id: ${id}` };
  }

  setState({ phase: "loading", progress: 0, text: "starting", model: id, error: null });

  loading = (async () => {
    try {
      if (!("gpu" in navigator)) throw new Error("this browser has no WebGPU");
      engine = await CreateMLCEngine(id, {
        initProgressCallback: p => setState({
          phase: "loading",
          progress: typeof p.progress === "number" ? p.progress : 0,
          text: p.text || "",
        }),
      });
      setState({ phase: "ready", progress: 1, text: "ready" });
      return { ok: true };
    } catch (e) {
      engine = null;
      setState({ phase: "error", error: String(e && e.message || e) });
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      loading = null;
    }
  })();

  return loading;
}

async function chat({ system, user, schema, maxTokens = 300 }) {
  if (!engine) throw new Error("model not loaded");
  const response_format = schema
    ? { type: "json_object", schema: JSON.stringify(schema) }
    : { type: "json_object" };

  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    response_format,
  });
  return reply.choices?.[0]?.message?.content ?? "";
}

async function unload() {
  if (engine) { try { await engine.unload(); } catch (_) {} }
  engine = null;
  setState({ phase: "idle", progress: 0, text: "", error: null });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.mq !== "llm-offscreen") return;
  (async () => {
    try {
      if (msg.op === "load") {
        /* The download runs for minutes and an MV3 service worker is not
           guaranteed to live that long, so the reply goes back at once and
           progress travels as state events instead. The offscreen document
           holds the engine, so a worker restart costs nothing. */
        load(msg.model);
        return sendResponse({ ok: true, started: true, state });
      }
      if (msg.op === "status") return sendResponse({ ok: true, state });
      if (msg.op === "unload") return sendResponse(await unload());
      if (msg.op === "chat")   return sendResponse({ ok: true, content: await chat(msg.args || {}) });
      sendResponse({ ok: false, error: `unknown op: ${msg.op}` });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;   // keep the channel open for the async reply
});

post({ event: "offscreen-ready" });
