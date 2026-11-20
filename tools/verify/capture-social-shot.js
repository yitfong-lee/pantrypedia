// Capture a clean app screenshot for the GitHub social preview.
// Launches through run-cdp.ps1 like the other suites.
import { writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";

const port = process.argv[2] || "9399";
const out = process.argv[3] || "pantry-app-shot.png";
const { evaluate, send, waitFor } = await connect(port);

await waitFor("!!document.querySelector('#match-list .start')");

// A few everyday ingredients so the ranked list has something to show.
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_ingredients");
  const wanted = ["rice", "eggs", "butter", "garlic", "soy sauce", "milk", "onion", "chicken"];
  for (const name of wanted) {
    const i = all.find(x => x.name.toLowerCase() === name);
    if (i && !i.in_pantry) await invoke("toggle_ingredient", { id: i.id });
  }
  location.reload();
})()`);

await new Promise((r) => setTimeout(r, 1600));
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");

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

// Leave the test database as we found it.
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  for (const i of await invoke("get_ingredients")) {
    if (i.in_pantry) await invoke("toggle_ingredient", { id: i.id });
  }
  return "clean";
})()`);

console.log(`saved ${out}`);
process.exit(0);
