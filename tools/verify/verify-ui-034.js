// Verify 0.3.4: the "Add N missing to list" button lives in the
// "you still need ..." row, right beside the chips it acts on.
import { connect } from "./cdp.mjs";

const { evaluate, waitFor } = await connect(process.argv[2] || "9350");
const out = {};

await waitFor("!!document.querySelector('#match-list .start')");

// tick rice so there are recipes with exactly one missing thing
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_ingredients");
  const rice = all.find(i => i.name === "rice");
  await invoke("toggle_ingredient", { id: rice.id });
  location.reload();
})()`);
await new Promise((r) => setTimeout(r, 1500));
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");

// open the first card that has exactly one missing ingredient
out.card = await evaluate(`(async () => {
  const cards = [...document.querySelectorAll("#match-list details.recipe")];
  const card = cards.find(c => c.querySelector(".badge.close"));
  if (!card) return { error: "no 1-missing card" };
  card.open = true;
  await new Promise(r => setTimeout(r, 200));

  const row = card.querySelector(".missing");
  const btn = row?.querySelector(".add-missing") ?? null;
  const chips = [...(row?.querySelectorAll(".miss-chip") ?? [])];
  const rowBox = row.getBoundingClientRect();
  const btnBox = btn ? btn.getBoundingClientRect() : null;
  const chipBox = chips[0]?.getBoundingClientRect() ?? null;
  const steps = card.querySelector(".steps");

  return {
    name: card.querySelector(".rname").textContent.trim(),
    buttonText: btn?.textContent.replace(/\\s+/g, " ").trim() ?? null,
    buttonInsideRow: !!btn,
    oldWrapperGone: !card.querySelector(".card-actions"),
    chips: chips.map(c => c.textContent.trim()),
    // the button must sit on the same line as the chips, not below the steps
    sameLineAsChips:
      !!btnBox && !!chipBox &&
      Math.abs((btnBox.y + btnBox.height / 2) - (chipBox.y + chipBox.height / 2)) < 12,
    afterChips: !!btnBox && !!chipBox && btnBox.x > chipBox.x,
    insideRowBox:
      !!btnBox &&
      btnBox.y >= rowBox.y - 1 &&
      btnBox.bottom <= rowBox.bottom + 1,
    stepsAboveRow: !!steps && steps.getBoundingClientRect().bottom <= rowBox.y + 1,
  };
})()`);

// clicking it still fills the shopping list with exactly those items
out.click = await evaluate(`(async () => {
  const card = [...document.querySelectorAll("#match-list details.recipe")]
    .find(c => c.querySelector(".missing .add-missing"));
  card.open = true;
  const btn = card.querySelector(".missing .add-missing");
  const expected = card.querySelectorAll(".missing .miss-chip").length;
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  const invoke = window.__TAURI__.core.invoke;
  const list = await invoke("get_shopping_list");
  return {
    expected,
    listLength: list.length,
    labels: list.map(i => i.label),
    drawerOpen: document.querySelector("#shopping-drawer").classList.contains("open"),
    toast: document.querySelector("#toast").textContent.trim(),
  };
})()`);

// tidy up: empty the shopping list and the pantry
out.cleanup = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  await invoke("clear_shopping_list");
  const all = await invoke("get_ingredients");
  for (const i of all.filter(x => x.in_pantry)) await invoke("toggle_ingredient", { id: i.id });
  return "clean";
})()`);

console.log(JSON.stringify(out, null, 2));
process.exit(0);
