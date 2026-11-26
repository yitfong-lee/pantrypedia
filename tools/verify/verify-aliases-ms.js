// Verify the PriceCatcher Malay aliases on the release build.
// A Malay word must behave exactly like its English ingredient name:
// same chip highlighted, same recipes ranked, same quick query.
import { connect } from "./cdp.mjs";

const { evaluate, waitFor } = await connect(process.argv[2] || "9405");
const out = {};
await waitFor("!!document.querySelector('#match-list .start')");

// 1. The aliases actually reached the database.
out.loaded = await evaluate(`(async () => {
  const all = await window.__TAURI__.core.invoke("get_ingredients");
  const pick = n => all.find(i => i.name === n) ?? null;
  const has = (n, a) => !!pick(n)?.aliases?.includes(a);
  return {
    ingredients: all.length,
    beras: has("rice", "beras"),
    ayam: has("chicken breast", "ayam"),
    bawangMerah: has("shallot", "bawang merah"),
    kicap: has("soy sauce", "kicap"),
    kunyit: has("turmeric", "kunyit"),
    santan: has("coconut milk", "santan"),
    malayCount: all.reduce((n, i) => n + i.aliases.length, 0),
  };
})()`);

// Type a term and report both the chip panel and the ranked recipe cards.
const probe = async (text) =>
  await evaluate(`(async () => {
    const input = document.querySelector("#search");
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 450));
    return {
      chips: [...document.querySelectorAll("#ingredient-groups .chip")]
        .map(c => c.textContent.trim().toLowerCase())
        .filter(n => n.length),
      cards: [...document.querySelectorAll("#match-list details.recipe .rname")]
        .map(n => n.textContent.trim()),
      totalCards: document.querySelectorAll("#match-list details.recipe").length,
    };
  })()`);

out.englishRice = await probe("rice");
out.malayBeras = await probe("beras");
out.englishChicken = await probe("chicken");
out.malayAyam = await probe("ayam");
out.malayBawangMerah = await probe("bawang merah");
out.malayKicap = await probe("kicap");

// The decisive check: the Malay word must select the same chip and the same
// recipe set as the English name it maps to.
out.matches = {
  riceChipSame:
    JSON.stringify(out.englishRice.chips) === JSON.stringify(out.malayBeras.chips),
  riceCardsSame:
    JSON.stringify(out.englishRice.cards) === JSON.stringify(out.malayBeras.cards),
  chickenChipSame:
    JSON.stringify(out.englishChicken.chips) === JSON.stringify(out.malayAyam.chips),
  chickenCardsSame:
    JSON.stringify(out.englishChicken.cards) === JSON.stringify(out.malayAyam.cards),
  bawangMerahFindsShallot: out.malayBawangMerah.chips.includes("shallot"),
  kicapFindsSoySauce: out.malayKicap.chips.includes("soy sauce"),
};

// Enter runs the Rust quick query against those same Malay words.
out.quick = await evaluate(`(async () => {
  const input = document.querySelector("#search");
  input.value = "beras, ayam";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const banner = document.querySelector("#quick-banner");
  return {
    shown: banner ? !banner.hidden : false,
    text: banner?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 120) ?? null,
    cards: [...document.querySelectorAll("#match-list details.recipe .rname")]
      .slice(0, 6).map(n => n.textContent.trim()),
  };
})()`);

// Leave the search box clean for any suite that runs next.
await evaluate(`(async () => {
  const input = document.querySelector("#search");
  const back = document.querySelector("#quick-off");
  if (back) back.click();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
})()`);

console.log(JSON.stringify(out, null, 2));
process.exit(0);
