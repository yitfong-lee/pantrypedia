// Adversarial testing of every free-text field in PantryPedia.
// Drives the real release binary through CDP and checks that hostile input
// cannot (a) execute as HTML/JS, (b) change the database, or (c) hang the app.
//
// Run with run-cdp.ps1, like the other suites. WARNING: this adds and then
// deletes test rows; run-cdp's caller should wipe the test database afterwards.
import { connect } from "./cdp.mjs";

const { evaluate, waitFor } = await connect(process.argv[2] || "9400");
const report = {};

// Trap anything the app throws while we push weird text at it.
await evaluate(`
  window.__advErrors = [];
  window.addEventListener("error", e => window.__advErrors.push(String(e.message)));
  window.addEventListener("unhandledrejection", e => window.__advErrors.push("rejection: " + String(e.reason)));
`);
await waitFor("!!document.querySelector('#match-list .start')");

const counts = `(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const ing = await invoke("get_ingredients");
  const matches = await invoke("get_matches");
  return { ingredients: ing.length, recipes: matches.length };
})()`;
report.baseline = await evaluate(counts);

const payloads = [
  { name: "sql-drop", text: "'; DROP TABLE recipe; --" },
  { name: "sql-or", text: "' OR 1=1 --" },
  { name: "xss-img", text: '<img src=x onerror="window.__pwnedImg=1">' },
  { name: "xss-script", text: '"><script>window.__pwnedScript=1</script>' },
  { name: "like-wildcards", text: "%_'" },
  { name: "unicode-emoji", text: "🍚 رز ü ñ 中文" },
  { name: "very-long", text: "A".repeat(10000) },
  { name: "whitespace", text: "   " },
  { name: "empty", text: "" },
];

report.searchField = {};
for (const p of payloads) {
  report.searchField[p.name] = await evaluate(`(async () => {
    const input = document.querySelector("#search");
    input.value = ${JSON.stringify(p.text)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, 400));

    const injected = document.querySelectorAll(
      "#ingredient-groups img, #ingredient-groups script, " +
      "#match-list img, #match-list script, " +
      "#quick-banner img, #quick-banner script"
    ).length;
    const hintEl = document.querySelector("#ingredient-groups .hint");
    // textContent SHOULD show the literal "<img ...>" as text. The bug would
    // be an actual element appearing in innerHTML.
    const hintEscaped = hintEl ? !/<img|<script/i.test(hintEl.innerHTML) : null;

    // Enter runs the Rust quick query against these exact words.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 1100));
    const banner = document.querySelector("#quick-banner");

    const result = {
      ms: Math.round(performance.now() - t0),
      injectedNodes: injected,
      pwned: [window.__pwnedImg ?? null, window.__pwnedScript ?? null],
      hintEscaped,
      quickShown: banner ? !banner.hidden : false,
      quickText: banner && !banner.hidden
        ? banner.textContent.replace(/\\s+/g, " ").trim().slice(0, 110)
        : null,
      cards: document.querySelectorAll("#match-list details.recipe").length,
      errors: window.__advErrors.slice(),
    };

    // Leave the view as we found it for the next payload.
    const back = document.querySelector("#quick-off");
    if (back) back.click();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    return result;
  })()`);
}

// The same hostile strings sent straight at the Rust search command.
report.rustSearch = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const out = {};
  for (const [name, q] of [
    ["drop", "'; DROP TABLE recipe; --"],
    ["or", "' OR 1=1 --"],
    ["wildcard", "%"],
    ["quotes", '""""'],
  ]) {
    try {
      const rows = await invoke("search_recipes", { query: q });
      out[name] = { ok: true, rows: rows.length };
    } catch (e) {
      out[name] = { ok: false, error: String(e) };
    }
  }
  return out;
})()`);

// Storage fields: ingredient name/category, recipe name/steps/unit,
// freeform shopping label. Use deliberately hostile values for all of them.
const XSS = '<img src=x onerror="window.__pwnedStored=1">';
const SQL = "'; DROP TABLE ingredient; --";
report.storedFields = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const out = {};
  const xss = ${JSON.stringify(XSS)};
  const sql = ${JSON.stringify(SQL)};
  try { out.ingredientId = await invoke("add_ingredient", { name: xss, category: sql }); }
  catch (e) { out.ingredientError = String(e); }
  try { out.recipeId = await invoke("add_recipe", {
    name: xss, steps: sql, servings: 4,
    ingredients: [{ name: xss, amount: 1, unit: sql }],
  }); }
  catch (e) { out.recipeError = String(e); }
  try { await invoke("add_shopping_item", { label: xss }); out.shopping = "added"; }
  catch (e) { out.shoppingError = String(e); }
  return out;
})()`);

// Render everything from disk again: this is the path a real user sees.
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 2000));
await waitFor("!!document.querySelector('#match-list .start')");
await evaluate(`
  window.__advErrors = [];
  window.addEventListener("error", e => window.__advErrors.push(String(e.message)));
  window.addEventListener("unhandledrejection", e => window.__advErrors.push("rejection: " + String(e.reason)));
`);
report.afterReload = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const cards = await invoke("get_matches");
  const injectedRecipe = cards.find(c => c.source === "user") ?? null;
  const list = document.querySelector("#match-list") ?? { textContent: "" };
  const groups = document.querySelector("#ingredient-groups") ?? { textContent: "" };
  const drawer = document.querySelector("#shopping-drawer") ?? { textContent: "" };
  // View all recipes so the user-made card is on screen, then open it.
  const viewAll = document.querySelector("#start-view-all");
  if (viewAll) viewAll.click();
  await new Promise(r => setTimeout(r, 500));
  const card = [...document.querySelectorAll("#match-list details.recipe")]
    .find(c => c.querySelector(".rname")?.textContent?.includes("<img"));
  if (card) card.open = true;
  await new Promise(r => setTimeout(r, 200));
  return {
    recipes: cards.length,
    storedRecipeText: injectedRecipe?.name ?? null,
    injectedDomNodes: document.querySelectorAll("img, script, svg[onload]").length,
    pwnedStored: window.__pwnedStored ?? null,
    ingredientChipHasLiteralText: groups.textContent.includes("<img src=x"),
    cardHasLiteralText: list.textContent.includes("<img src=x"),
    drawerHasLiteralText: drawer.textContent.includes("<img src=x"),
    errors: window.__advErrors.slice(),
  };
})()`);

// A classic path-traversal filename for the "save .txt" button: separators
// must be stripped before the file is written into Downloads.
report.filenameTraversal = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  try {
    const path = await invoke("save_text_file", {
      filename: "..\\\\..\\\\Desktop\\\\pwned-adversarial.txt",
      contents: "should stay inside Downloads",
    });
    return { ok: true, wrote: path };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})()`);

// Only web links should be allowed out of the app.
report.openExternal = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const out = {};
  for (const [name, url] of [["js", "javascript:alert(1)"], ["file", "file:///C:/Windows/win.ini"]]) {
    try { await invoke("open_external", { url }); out[name] = "ACCEPTED (bad)"; }
    catch (e) { out[name] = "rejected: " + String(e); }
  }
  return out;
})()`);

// Did any table survive? Counts must match the baseline apart from our two
// temporary user rows, which are removed here.
report.afterAttack = await evaluate(counts);

report.cleanup = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const cards = await invoke("get_matches");
  for (const c of cards.filter(c => c.source === "user")) await invoke("delete_recipe", { id: c.id });
  const ing = await invoke("get_ingredients");
  for (const i of ing.filter(i => i.source === "user")) await invoke("delete_ingredient", { id: i.id });
  await invoke("clear_shopping_list");
  return "cleaned";
})()`);
report.final = await evaluate(counts);
report.finalErrors = await evaluate("window.__advErrors.slice()");

console.log(JSON.stringify(report, null, 2));
process.exit(0);
