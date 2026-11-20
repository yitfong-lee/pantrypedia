// End-to-end check of the Wi-Fi link QR:
//   1. seed a list, open the overlay through the real button
//   2. fetch the URL the app hands out (what the phone would request)
//   3. decode the on-screen QR and confirm it holds that same URL
//   4. confirm a wrong path is refused
//   5. close the overlay and confirm the server is gone
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { connect } from "./cdp.mjs";

const { evaluate, send, ws } = await connect(process.argv[2] || "9380");
const results = {};

const items = [
  "500 g basmati rice",
  "2 onions",
  "1 head garlic",
  "200 ml coconut milk",
  "3 eggs",
  "1 tbsp curry powder",
  "400 g chicken thigh",
  "1 bunch scallion",
];

// 1. seed, reload so the drawer's in-memory list is current, then click QR.
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const existing = await invoke("get_shopping_list");
  for (const row of existing) await invoke("delete_shopping_item", { id: row.id });
  for (const label of ${JSON.stringify(items)}) await invoke("add_shopping_item", { label });
  return true;
})()`);
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 1800));

results.overlay = await evaluate(`(async () => {
  document.querySelector("#qr-list").click();
  await new Promise(r => setTimeout(r, 1200));
  const svg = document.querySelector("#qr-holder svg");
  const urlRow = document.querySelector("#qr-url");
  const rect = document.querySelector("#qr-holder").getBoundingClientRect();
  return {
    modalOpen: !document.querySelector("#qr-modal").hidden,
    hasSvg: !!svg,
    url: document.querySelector("#qr-url-text").textContent,
    urlRowShown: !urlRow.hidden,
    note: document.querySelector("#qr-note").textContent.trim(),
    holder: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };
})()`);

const url = results.overlay.url;
results.url = url;

// 2. what the phone would see
if (url) {
  const page = await fetch(url);
  const body = await page.text();
  results.fetch = {
    status: page.status,
    contentType: page.headers.get("content-type"),
    bytes: body.length,
    hasRice: body.includes("500 g basmati rice"),
    hasCount: /8 to buy of 8/.test(body),
    isHtml: body.startsWith("<!doctype html>"),
  };

  // 4. a guessed path must be refused
  const wrong = await fetch(url.replace(/\/[0-9a-f]{16}\//, "/guess/"));
  results.wrongPath = { status: wrong.status, leaksList: (await wrong.text()).includes("basmati") };
}

// 3. decode the QR as a phone camera would
if (results.overlay.holder) {
  const h = results.overlay.holder;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: h.x, y: h.y, width: h.w, height: h.h, scale: 2 },
    captureBeyondViewport: false,
  });
  const b64 = shot?.result?.data;
  if (b64) {
    const png = PNG.sync.read(Buffer.from(b64, "base64"));
    writeFileSync(join(tmpdir(), "pantrypedia-qr-link.png"), Buffer.from(b64, "base64"));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    results.qrDecode = {
      decoded: decoded ? decoded.data : null,
      matchesUrl: decoded ? decoded.data === url : false,
      modules: decoded ? decoded.version : null,
      image: `${png.width}x${png.height}`,
    };
  }
}

// 5. closing must shut the server down
await evaluate(`(async () => {
  document.querySelector("#qr-close").click();
  await new Promise(r => setTimeout(r, 400));
  return document.querySelector("#qr-modal").hidden;
})()`);
if (url) {
  let stillUp = true;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
  } catch {
    stillUp = false;
  }
  results.afterClose = { serverStillUp: stillUp };
}

console.log(JSON.stringify(results, null, 2));
ws.close();
