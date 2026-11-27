// Capture a clean app screenshot for the GitHub social preview.
// Shows the 0.3.5 search chip: typing "nasi" ranks the recipes automatically
// and the passive chip reports how many were found.
import { writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";

const port = process.argv[2] || "9399";
const out = process.argv[3] || "pantry-app-shot.png";
const { evaluate, send, waitFor } = await connect(port);

await waitFor("!!document.querySelector('#match-list .start')");

// Malay UI, as the new card advertises.
await evaluate(`
  localStorage.setItem("pantrypedia.lang", "ms");
  location.reload();
`);
await new Promise((r) => setTimeout(r, 1800));
await waitFor("!!document.querySelector('#match-list .start')");

// Type a Malay ingredient: the debounced search runs on its own.
await evaluate(`(async () => {
  const input = document.querySelector("#search");
  input.value = "nasi";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  return {
    chip: document.querySelector("#quick-chip")?.textContent.trim() ?? null,
    cards: document.querySelectorAll("#match-list details.recipe").length,
  };
})()`);

// Render at 2x so the card can scale it down without going blurry.
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 720,
  deviceScaleFactor: 2,
  mobile: false,
});
await new Promise((r) => setTimeout(r, 600));

const shot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
});
writeFileSync(out, Buffer.from(shot.result.data, "base64"));

// Leave no trace: clear the search and restore English for the next suite.
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const input = document.querySelector("#search");
  const back = document.querySelector("#quick-off");
  if (back) back.click();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  localStorage.setItem("pantrypedia.lang", "en");
  await invoke("clear_shopping_list");
})()`);

console.log(`saved ${out}`);
process.exit(0);
