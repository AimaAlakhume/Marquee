/* Marquee — service worker.
 *
 * It owns one thing: the offscreen document that hosts the on-device model.
 * The service worker itself cannot run the model (no WebGPU in an MV3 worker),
 * so it creates the offscreen page, relays messages to it, and forwards the
 * loader's progress events back to whichever tab is listening.
 *
 * With the model switched off, none of this ever runs.
 */
const OFFSCREEN = "offscreen.html";
let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return c.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ["WORKERS"],
    justification: "Runs the on-device language model on WebGPU, which is not available in a service worker.",
  }).finally(() => { creating = null; });
  return creating;
}

/* progress events travel offscreen -> here -> every Marquee tab */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.mq !== "llm-event") return;
  if (sender.tab) return;                       // only relay what came from offscreen
  chrome.tabs.query({}, tabs => {
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, msg).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.mq !== "llm") return;
  (async () => {
    try {
      await ensureOffscreen();
      const reply = await chrome.runtime.sendMessage({
        mq: "llm-offscreen", op: msg.op, model: msg.model, args: msg.args,
      });
      sendResponse(reply || { ok: false, error: "no reply from the model host" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
