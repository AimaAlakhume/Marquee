#!/usr/bin/env python3
"""Load the real unpacked extension and check the model plumbing.

There is no GPU in this container, so the model itself cannot run here. What is
checked is everything around it — that the manifest is accepted, the service
worker registers, the offscreen document is created and the 6MB vendored bundle
imports without throwing — and, most importantly, that a machine with no WebGPU
degrades to a clean message instead of a broken panel. That last path is the one
that protects the live demo.
"""
import asyncio, os, shutil, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, "extension")

# A service worker cannot deliver a message to its own onMessage listener, so the
# broker has to be called from somewhere else. The shipped extension gets a
# throwaway copy with one extra page that stands in for the content script; the
# extension that is submitted stays clean.
EXT = os.path.join(tempfile.mkdtemp(), "ext")
shutil.copytree(SRC, EXT)
# extension pages forbid inline script, so the probe's code is its own file
open(os.path.join(EXT, "__probe.html"), "w", encoding="utf-8").write(
    "<!doctype html><meta charset=utf-8><title>probe</title>"
    "<script src=__probe.js></script>")
open(os.path.join(EXT, "__probe.js"), "w", encoding="utf-8").write(
    "window.call = (op, extra) => new Promise(r =>"
    " chrome.runtime.sendMessage(Object.assign({ mq: 'llm', op }, extra || {}), r));")

async def main():
    fails = []
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            tempfile.mkdtemp(),
            headless=False,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--no-sandbox"],
        )
        errs = []
        ctx.on("weberror", lambda e: errs.append(str(e.error)))

        # 1. the service worker registers
        sw = None
        for _ in range(60):
            if ctx.service_workers:
                sw = ctx.service_workers[0]; break
            await asyncio.sleep(0.5)
        print("service worker:", "registered" if sw else "MISSING")
        if not sw: fails.append("service worker never registered")

        ext_id = sw.url.split("/")[2] if sw else None
        print("extension id:", ext_id)

        def worker():
            return ctx.service_workers[0] if ctx.service_workers else None

        # 2. from a page (not the worker): bring up the offscreen document
        probe = await ctx.new_page()
        await probe.goto(f"chrome-extension://{ext_id}/__probe.html")
        reply = await probe.evaluate("() => window.call('status')")
        print("status reply:", reply)
        if not (reply or {}).get("ok"): fails.append("model host did not answer a status call")

        sw = worker()
        if sw:
            n = await sw.evaluate("""async () => (await chrome.runtime.getContexts(
                  { contextTypes: ["OFFSCREEN_DOCUMENT"] })).length""")
            print("offscreen documents:", n)
            if n != 1: fails.append("offscreen document was not created")

        # 3. the vendored bundle imports and exposes the chosen model id
        if ext_id:
            pg = await ctx.new_page()
            await pg.goto(f"chrome-extension://{ext_id}/offscreen.html")
            info = await pg.evaluate("""async () => {
              const m = await import("./vendor/web-llm.js");
              return {
                exports: ["CreateMLCEngine","prebuiltAppConfig"].every(k => k in m),
                hasModel: m.prebuiltAppConfig.model_list
                  .some(x => x.model_id === "Llama-3.2-3B-Instruct-q4f16_1-MLC"),
                webgpu: "gpu" in navigator,
              };
            }""")
            print("bundle imports:", info["exports"], "· model id present:", info["hasModel"],
                  "· WebGPU here:", info["webgpu"])
            if not info["exports"]: fails.append("vendored bundle did not export the engine")
            if not info["hasModel"]: fails.append("chosen model id is not in prebuiltAppConfig")
            await pg.close()

        # 4. a load attempt must resolve either way, never hang
        out = await probe.evaluate("() => window.call('load')")
        print("load result:", out)
        if out is None: fails.append("load never returned")
        elif out.get("ok"): print("  (accepted; the download itself needs a network this container does not have)")
        elif not out.get("error"): fails.append("load failed without saying why")
        await probe.close()

        print("page errors:", errs or "none")
        await ctx.close()

    print()
    print("FAILURES:", fails if fails else "none")
    return 1 if fails else 0

raise SystemExit(asyncio.run(main()))
