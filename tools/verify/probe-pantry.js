import { connect } from "./cdp.mjs";

const { ws, evaluate, waitFor } = await connect(process.argv[2] || "9392");
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");
const out = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const ings = await invoke("get_ingredients");
  const inPantry = ings.filter((i) => i.in_pantry).map((i) => i.name);
  const matches = await invoke("get_matches");
  const ready = matches.filter((m) => m.missing === 0).length;
  const some = matches.filter((m) => m.total - m.missing > 0).length;
  return {
    ingredients: ings.length,
    inPantryCount: inPantry.length,
    inPantry: inPantry.slice(0, 20),
    recipes: matches.length,
    ready,
    some,
    sections: [...document.querySelectorAll("#match-list .section-title")].map((s) =>
      s.textContent.replace(/\\s+/g, " ").trim()
    ),
    browseHint: document.querySelector("#match-list .hint.browse")?.textContent?.replace(/\\s+/g, " ").trim() ?? null,
  };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
