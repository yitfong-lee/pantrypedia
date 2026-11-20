// Verify 0.3.0: bigger catalog, alias-aware matching, attribution on
// imported recipes, and that the A-Z browse view still works.
import { connect } from "./cdp.mjs";

const { ws, evaluate, waitFor } = await connect(process.argv[2] || "9350");

const snap = `({
  cards: document.querySelectorAll("#match-list details.recipe").length,
  ingredients: document.querySelectorAll("#ingredient-groups .chip").length,
  browseHint: document.querySelector("#match-list .hint.browse")?.textContent?.replace(/\\\\s+/g, " ").trim() ?? null,
  sections: [...document.querySelectorAll("#match-list .section-title")].map(s => s.textContent.replace(/\\\\s+/g, " ").trim()),
  credits: document.querySelectorAll("#match-list .credit").length,
  firstCredit: document.querySelector("#match-list .credit")?.textContent?.replace(/\\\\s+/g, " ").trim() ?? null,
  firstCreditHref: document.querySelector("#match-list .credit a")?.getAttribute("href") ?? null,
  names: [...document.querySelectorAll("#match-list .rname")].slice(0, 3).map(n => n.textContent.trim()),
})`;

const results = {};

// 1. cold state: empty pantry, no search. 0.3.3 turned the default view into a
// starting point, so the A-Z list now needs the "View all recipes" button.
await waitFor("!!document.querySelector('#match-list .start')");
results.start = await evaluate(`({
  cards: document.querySelectorAll("#match-list details.recipe").length,
  title: document.querySelector("#results-title")?.textContent?.trim() ?? null,
  viewAll: document.querySelector("#start-view-all")?.textContent?.trim() ?? null,
})`);

await evaluate(`document.querySelector("#start-view-all").click()`);
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");
results.browse = await evaluate(snap);

// 2. alias search: "green onion" must find recipes whose lines say "scallion"
results.aliasSearch = await evaluate(`(async () => {
  const input = document.querySelector("#search");
  input.value = "green onion";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const cards = [...document.querySelectorAll("#match-list details.recipe")];
  return {
    cards: cards.length,
    caption: document.querySelector("#match-list .count")?.textContent?.trim() ?? null,
    usesScallion: cards.some(c => [...c.querySelectorAll(".iname")].some(i => i.textContent.trim() === "scallion")),
    usesGreenOnionLine: cards.some(c => [...c.querySelectorAll(".iname")].some(i => /green onion/i.test(i.textContent))),
    sample: cards.slice(0, 2).map(c => c.querySelector(".rname").textContent.trim()),
  };
})()`);

// 3. the chip panel should also surface scallion for "green onion"
results.aliasChip = await evaluate(`({
  chips: [...document.querySelectorAll("#ingredient-groups .chip")].map(c => c.textContent.trim().toLowerCase()),
  count: document.querySelector("#ingredient-groups .chip")?.textContent?.trim() ?? null,
})`);

// 4. quick query via Enter, alias-aware in Rust
results.quickQuery = await evaluate(`(async () => {
  const input = document.querySelector("#search");
  input.value = "green onion";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const banner = document.querySelector("#quick-banner");
  return {
    bannerShown: banner ? !banner.hidden : false,
    cards: document.querySelectorAll("#match-list details.recipe").length,
    names: [...document.querySelectorAll("#match-list .rname")].slice(0, 3).map(n => n.textContent.trim()),
  };
})()`);

// 5. clear, then tick rice and check the ranked split still works
results.afterTick = await evaluate(`(async () => {
  const input = document.querySelector("#search");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_ingredients");
  const rice = all.find(i => i.name === "rice");
  await invoke("toggle_ingredient", { id: rice.id });
  return "ticked rice";
})()`);

await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 1200));
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");
results.ranked = await evaluate(snap);

// 6. tidy up: untick rice so the app is left as found
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_ingredients");
  for (const i of all.filter(x => x.in_pantry)) await invoke("toggle_ingredient", { id: i.id });
  return null;
})()`);

// 7. imported recipes must read like their source page: Homemade Tempeh says
// "dried soybeans" (not "soybean"), and its banana leaves are equipment, not
// an ingredient. Kuih Bakul keeps its banana leaves.
results.labels = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_matches");
  const pick = (name) => {
    const r = all.find((m) => m.name === name);
    return r ? r.ingredients.map((l) => l.label || l.name) : null;
  };
  const tempeh = pick("Homemade Tempeh");
  const kuih = pick("Kuih Bakul (Malaysian Sweet Browned Rice Cake)");
  return {
    tempeh,
    tempehOk:
      !!tempeh &&
      tempeh.includes("dried soybeans") &&
      tempeh.includes("cider vinegar") &&
      tempeh.includes("tempeh starter") &&
      !tempeh.some((n) => /banana/i.test(n)),
    kuihHasBananaLeaf: !!kuih && kuih.some((n) => /banana/i.test(n)),
  };
})()`);

console.log(JSON.stringify(results, null, 2));
ws.close();
