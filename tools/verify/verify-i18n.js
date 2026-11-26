// Verify the UI language prototype: the toggle changes app text, remembers the
// choice across a reload, and never touches catalog data (recipe titles stay
// exactly as they came from Wikibooks).
import { connect } from "./cdp.mjs";

const { evaluate, waitFor } = await connect(process.argv[2] || "9408");
const out = {};

await evaluate(`
  window.__i18nErrors = [];
  window.addEventListener("error", e => window.__i18nErrors.push(String(e.message)));
`);
await waitFor("!!document.querySelector('#match-list .start')");

const snap = `({
  lang: document.documentElement.lang,
  saved: localStorage.getItem("pantrypedia.lang"),
  toggle: document.querySelector("#lang-toggle").textContent.trim(),
  resultsTitle: document.querySelector("#results-title").textContent.trim(),
  startTitle: document.querySelector("#match-list .start-title")?.textContent.trim() ?? null,
  startButton: document.querySelector("#start-view-all")?.textContent.trim() ?? null,
  searchPlaceholder: document.querySelector("#search").placeholder,
  ingredientsLabel: document.querySelector("#pantry-panel .panel-hint span").textContent.trim(),
  drawerTitle: document.querySelector("#shopping-drawer h2").textContent.trim(),
  shopPlaceholder: document.querySelector("#shop-add-input").placeholder,
  firstRecipe: document.querySelector("#match-list .rname")?.textContent.trim() ?? null,
  errors: window.__i18nErrors.slice(),
})`;

out.english = await evaluate(snap);

// Toggle to Malay.
await evaluate(`document.querySelector("#lang-toggle").click()`);
await new Promise((r) => setTimeout(r, 500));
out.malay = await evaluate(snap);

// The choice must survive a reload, and the app must be Malay from the start.
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 2000));
await waitFor("!!document.querySelector('#match-list .start')");
await evaluate(`
  window.__i18nErrors = [];
  window.addEventListener("error", e => window.__i18nErrors.push(String(e.message)));
`);
out.afterReload = await evaluate(snap);

// Back to English, and the saved value follows.
await evaluate(`document.querySelector("#lang-toggle").click()`);
await new Promise((r) => setTimeout(r, 500));
out.backToEnglish = await evaluate(snap);

// Catalog data must be untouched: 353 recipes and 320 ingredients either way.
out.dataIntact = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  return {
    recipes: (await invoke("get_matches")).length,
    ingredients: (await invoke("get_ingredients")).length,
  };
})()`);

out.checks = {
  // A returning user has "en" explicitly saved; a first-run user has null.
  startsEnglish:
    out.english.lang === "en" &&
    (out.english.saved === null || out.english.saved === "en"),
  englishStartText: out.english.startTitle === "Start with what's in your kitchen",
  malayStartText:
    out.malay.startTitle === "Mulakan dengan apa yang ada di dapur anda",
  malayResultsTitle: out.malay.resultsTitle === "Apa yang boleh saya masak?",
  malayPlaceholder: out.malay.searchPlaceholder === "Cari bahan atau resipi…",
  malayDrawer: out.malay.drawerTitle === "🛒 Senarai beli-belah",
  malayStartButton: /^Lihat semua 353 resipi$/.test(out.malay.startButton ?? ""),
  toggleLabel: out.english.toggle === "BM" && out.malay.toggle === "EN",
  savedToStorage: out.malay.saved === "ms",
  persistedAcrossReload:
    out.afterReload.lang === "ms" &&
    out.afterReload.saved === "ms" &&
    out.afterReload.startTitle === "Mulakan dengan apa yang ada di dapur anda",
  backToEnglishSaved:
    out.backToEnglish.lang === "en" && out.backToEnglish.saved === "en",
  catalogCountsIntact:
    out.dataIntact.recipes === 353 && out.dataIntact.ingredients === 320,
  noErrors: [...out.english.errors, ...out.malay.errors, ...out.afterReload.errors, ...out.backToEnglish.errors].length === 0,
};

console.log(JSON.stringify(out, null, 2));
process.exit(0);
