// Verify 0.3.3's UI restructure:
//   1. the default view is a starting point, not 353 cards
//   2. "View all recipes" (start panel and header) shows / leaves the A-Z list
//   3. "Cook with ..." says which words it will use, and the banner offers a way back
//   4. ingredient groups fold, and a folded group lists the ingredients you have
import { connect } from "./cdp.mjs";

const { ws, evaluate, waitFor } = await connect(process.argv[2] || "9350");

const out = {};

// 1. cold start: one clear next step, no recipe cards yet
await waitFor("!!document.querySelector('#match-list .start')");
out.start = await evaluate(`({
  cards: document.querySelectorAll("#match-list details.recipe").length,
  title: document.querySelector("#results-title").textContent.trim(),
  startButton: document.querySelector("#start-view-all").textContent.trim(),
  headerButton: document.querySelector("#view-all-btn").textContent.trim(),
  quickRunHidden: document.querySelector("#quick-run").hidden,
})`);

// 2. the start button really does show the whole cookbook
await evaluate(`document.querySelector("#start-view-all").click()`);
await waitFor("document.querySelectorAll('#match-list details.recipe').length > 0");
out.browse = await evaluate(`({
  cards: document.querySelectorAll("#match-list details.recipe").length,
  title: document.querySelector("#results-title").textContent.trim(),
  hint: document.querySelector("#match-list .hint.browse")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
  headerButton: document.querySelector("#view-all-btn").textContent.trim(),
})`);

// 3. and the header button goes back to the starting point
await evaluate(`document.querySelector("#view-all-btn").click()`);
await new Promise((r) => setTimeout(r, 250));
out.backToStart = await evaluate(`({
  start: !!document.querySelector("#match-list .start"),
  cards: document.querySelectorAll("#match-list details.recipe").length,
  headerButton: document.querySelector("#view-all-btn").textContent.trim(),
})`);

// 4. the "cook with" button names the words it will use, not just "these"
out.quickLabel = await evaluate(`(() => {
  const input = document.querySelector("#search");
  input.value = "milk";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return {
    label: document.querySelector("#quick-run").textContent.trim(),
    hidden: document.querySelector("#quick-run").hidden,
  };
})()`);

// 5. running it: banner says what is being ignored, and offers the way back
out.quick = await evaluate(`(async () => {
  document.querySelector("#quick-run").click();
  await new Promise(r => setTimeout(r, 1200));
  const b = document.querySelector("#quick-banner");
  return {
    bannerShown: !b.hidden,
    banner: b.textContent.replace(/\\s+/g, " ").trim(),
    hasBack: !!document.querySelector("#quick-off"),
    cards: document.querySelectorAll("#match-list details.recipe").length,
    title: document.querySelector("#results-title").textContent.trim(),
  };
})()`);

// 6. "Back to my pantry" leaves the typed-only view and clears the box
out.quickBack = await evaluate(`(async () => {
  document.querySelector("#quick-off").click();
  await new Promise(r => setTimeout(r, 350));
  return {
    bannerHidden: document.querySelector("#quick-banner").hidden,
    start: !!document.querySelector("#match-list .start"),
    search: document.querySelector("#search").value,
    title: document.querySelector("#results-title").textContent.trim(),
  };
})()`);

// 7. ingredient groups: tick two chips, then fold the group
out.groups = await evaluate(`(async () => {
  const group = document.querySelector("#ingredient-groups .group");
  const cat = group.querySelector(".group-head").dataset.group;
  const total = document.querySelectorAll("#ingredient-groups .group").length;
  const chips = [...group.querySelectorAll(".chip")].slice(0, 2);
  const ids = chips.map(c => c.dataset.id);
  const names = chips.map(c => c.textContent.trim());
  // one at a time: a tap re-renders the panel, so the second element is stale
  for (const id of ids) {
    document.querySelector('#ingredient-groups .chip[data-id="' + id + '"]').click();
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 400));

  const g = document.querySelector("#ingredient-groups .group"); // re-rendered
  const head = g.querySelector(".group-head");
  const before = {
    count: head.querySelector(".gcount").textContent.trim(),
    hasClass: g.classList.contains("has"),
    chipsVisible: getComputedStyle(g.querySelector(".chips")).display !== "none",
    pickedVisible: getComputedStyle(head.querySelector(".gpicked")).display !== "none",
    picked: head.querySelector(".gpicked").textContent.trim(),
  };

  head.click();
  await new Promise(r => setTimeout(r, 200));
  const g2 = document.querySelector("#ingredient-groups .group");
  const after = {
    folded: g2.classList.contains("folded"),
    chipsVisible: getComputedStyle(g2.querySelector(".chips")).display !== "none",
    pickedVisible: getComputedStyle(g2.querySelector(".gpicked")).display !== "none",
    picked: g2.querySelector(".gpicked").textContent.trim(),
    aria: g2.querySelector(".group-head").getAttribute("aria-expanded"),
  };

  // a search must never hide its own hits inside a folded group
  const input = document.querySelector("#search");
  input.value = names[0];
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const searched = {
    groups: document.querySelectorAll("#ingredient-groups .group").length,
    folded: document.querySelector("#ingredient-groups .group").classList.contains("folded"),
    chipsVisible: getComputedStyle(document.querySelector("#ingredient-groups .group .chips")).display !== "none",
  };
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));

  return { cat, total, names, before, after, searched };
})()`);

// 8. the fold survives a tap elsewhere, and the results are ranked again
out.persist = await evaluate(`(async () => {
  const other = document.querySelectorAll("#ingredient-groups .group")[1];
  other.querySelector(".chip").click();
  await new Promise(r => setTimeout(r, 800));
  const first = document.querySelector("#ingredient-groups .group");
  return {
    stillFolded: first.classList.contains("folded"),
    picked: first.querySelector(".gpicked")?.textContent.trim() ?? null,
    sections: [...document.querySelectorAll("#match-list .section-title")].map(s => s.textContent.replace(/\\s+/g, " ").trim()),
    cards: document.querySelectorAll("#match-list details.recipe").length,
    title: document.querySelector("#results-title").textContent.trim(),
  };
})()`);

// 9. leave the database as we found it
out.cleanup = await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const all = await invoke("get_ingredients");
  const on = all.filter(i => i.in_pantry);
  for (const i of on) await invoke("toggle_ingredient", { id: i.id });
  return on.length;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
