// Verify the new "Clear all": it asks twice, and only the second click deletes.
import { connect } from "./cdp.mjs";

const { evaluate, ws } = await connect(process.argv[2] || "9400");
const results = {};

// Start from a known list of 3.
await evaluate(`(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const existing = await invoke("get_shopping_list");
  for (const row of existing) await invoke("delete_shopping_item", { id: row.id });
  for (const label of ["2 onions", "1 head garlic", "500 g rice"]) {
    await invoke("add_shopping_item", { label });
  }
  return true;
})()`);
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 1800));

// Open the drawer and read the button before touching it.
results.before = await evaluate(`(async () => {
  document.querySelector("#shopping-btn").click();
  await new Promise(r => setTimeout(r, 400));
  return {
    drawerOpen: document.querySelector("#shopping-drawer").classList.contains("open"),
    label: document.querySelector("#clear-all").textContent.trim(),
    armed: document.querySelector("#clear-all").classList.contains("armed"),
    rows: document.querySelectorAll("#shop-list li").length,
  };
})()`);

// First click: arms, deletes nothing.
results.firstClick = await evaluate(`(async () => {
  document.querySelector("#clear-all").click();
  await new Promise(r => setTimeout(r, 500));
  const rows = await window.__TAURI__.core.invoke("get_shopping_list");
  return {
    label: document.querySelector("#clear-all").textContent.trim(),
    armed: document.querySelector("#clear-all").classList.contains("armed"),
    dbRows: rows.length,
    domRows: document.querySelectorAll("#shop-list li").length,
  };
})()`);

// Second click: deletes.
results.secondClick = await evaluate(`(async () => {
  document.querySelector("#clear-all").click();
  await new Promise(r => setTimeout(r, 700));
  const rows = await window.__TAURI__.core.invoke("get_shopping_list");
  return {
    label: document.querySelector("#clear-all").textContent.trim(),
    armed: document.querySelector("#clear-all").classList.contains("armed"),
    dbRows: rows.length,
    domRows: document.querySelectorAll("#shop-list li").length,
    toast: document.querySelector("#toast").textContent.trim(),
    badge: document.querySelector("#shopping-count").textContent.trim(),
    emptyText: document.querySelector("#shop-list").textContent.trim().slice(0, 80),
  };
})()`);

// Arming then closing the drawer must not leave it armed.
// The item goes in through the database, so reload first: the drawer's list is
// in memory and the button would otherwise think the list is still empty.
await evaluate(`(async () => {
  await window.__TAURI__.core.invoke("add_shopping_item", { label: "1 loaf bread" });
  return true;
})()`);
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 1800));

results.disarmOnClose = await evaluate(`(async () => {
  document.querySelector("#shopping-btn").click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector("#clear-all").click();          // arm it
  await new Promise(r => setTimeout(r, 200));
  const armedLabel = document.querySelector("#clear-all").textContent.trim();
  document.querySelector("#shopping-close").click();      // close while armed
  await new Promise(r => setTimeout(r, 300));
  document.querySelector("#shopping-btn").click();        // reopen
  await new Promise(r => setTimeout(r, 300));
  const after = {
    armedLabel,
    labelAfterReopen: document.querySelector("#clear-all").textContent.trim(),
    stillHasItem: (await window.__TAURI__.core.invoke("get_shopping_list")).length,
  };
  // tidy up
  await window.__TAURI__.core.invoke("clear_shopping_list");
  document.querySelector("#shopping-close").click();
  return after;
})()`);

// An armed button must give up on its own after 5 seconds.
await evaluate(`(async () => {
  await window.__TAURI__.core.invoke("add_shopping_item", { label: "2 onions" });
  return true;
})()`);
await evaluate("location.reload()");
await new Promise((r) => setTimeout(r, 1800));

results.autoDisarm = await evaluate(`(async () => {
  document.querySelector("#shopping-btn").click();
  await new Promise(r => setTimeout(r, 300));
  document.querySelector("#clear-all").click();
  await new Promise(r => setTimeout(r, 200));
  const armedLabel = document.querySelector("#clear-all").textContent.trim();
  await new Promise(r => setTimeout(r, 5600));
  const after = {
    armedLabel,
    labelAfter5s: document.querySelector("#clear-all").textContent.trim(),
    armedAfter5s: document.querySelector("#clear-all").classList.contains("armed"),
    rowsLeft: (await window.__TAURI__.core.invoke("get_shopping_list")).length,
  };
  await window.__TAURI__.core.invoke("clear_shopping_list");
  document.querySelector("#shopping-close").click();
  return after;
})()`);

console.log(JSON.stringify(results, null, 2));
ws.close();
