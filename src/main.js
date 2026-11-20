const { invoke } = window.__TAURI__.core;

// Show which build this is, so a friend's bug report can name a version.
// getVersion() reads the same value the installer and About box use.
window.__TAURI__.app
  .getVersion()
  .then((v) => {
    const el = document.querySelector("#app-version");
    if (el) el.textContent = `v${v}`;
  })
  .catch(() => {
    // no version to show is not worth breaking the app over
  });

// Current data from the Rust side.
let ingredients = [];
let matches = [];

// alias -> canonical name, e.g. "green onion" -> "scallion". Built from the
// catalog so the search box finds a recipe no matter which word it uses.
let aliasIndex = new Map();

// Quick-query state. `quickResults === null` means the quick query is OFF
// and the right panel scores your saved pantry. Anything else is the result
// of the last "cook with these" run.
let quickResults = null;
let quickQueryText = "";
let quickToken = 0; // guards against out-of-order replies

// The one search bar (in the header).
const searchInput = document.querySelector("#search");
const searchClear = document.querySelector("#search-clear");
const quickRun = document.querySelector("#quick-run");
const quickBanner = document.querySelector("#quick-banner");

// Add / delete UI.
const addIngredientBtn = document.querySelector("#add-ingredient-btn");
const addIngredientForm = document.querySelector("#add-ingredient-form");
const addRecipeBtn = document.querySelector("#add-recipe-btn");
const addRecipeForm = document.querySelector("#add-recipe-form");
const recipeSubmit = document.querySelector("#recipe-submit");
const categoryOptions = document.querySelector("#category-options");
const ingRows = document.querySelector("#recipe-ing-rows");
const servingsInput = document.querySelector("#new-recipe-servings");

// null = the recipe form is in "add" mode; a number = editing that recipe.
let editingRecipeId = null;

// ---------------------------------------------------------------------------
// Load everything from Rust
// ---------------------------------------------------------------------------

async function refresh() {
  [ingredients, matches] = await Promise.all([
    invoke("get_ingredients"),
    invoke("get_matches"),
  ]);
  aliasIndex = new Map();
  for (const ing of ingredients) {
    for (const a of ing.aliases ?? []) aliasIndex.set(a.toLowerCase(), ing.name);
  }
  renderAll();
}

/// Reload after anything that changes the catalog itself (add/delete),
/// then re-run the quick query if it's showing, so it isn't stale.
async function afterCatalogChange() {
  await refresh();
  // Deleting an ingredient also drops it off the shopping list, so reload
  // that too - otherwise the drawer would show a row that no longer exists.
  await refreshShopping();
  if (quickResults !== null) await runQuickQuery();
}

function renderAll() {
  renderPantry();
  renderMatches();
  renderCategories();
  syncSearchButtons();

  const n = ingredients.filter((i) => i.in_pantry).length;
  document.querySelector("#pantry-count").textContent = `${n} selected`;
}

// ---------------------------------------------------------------------------
// The search bar: one input, two jobs
//   typing    -> filter the chips on the left AND the recipes on the right
//   Enter     -> "cook with these": rank recipes against the typed words only
// ---------------------------------------------------------------------------

/// "eggs, rice, soy sauce" -> ["eggs", "rice", "soy sauce"]
function searchTerms() {
  return searchInput.value
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

searchInput.addEventListener("input", () => {
  renderPantry();
  renderMatches();
  syncSearchButtons();
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runQuickQuery();
  } else if (e.key === "Escape") {
    clearSearch();
  }
});

quickRun.addEventListener("click", runQuickQuery);
searchClear.addEventListener("click", clearSearch);

/// Show the ✕ and the "Cook with these" button only when they're useful.
function syncSearchButtons() {
  const hasText = searchInput.value.trim().length > 0;
  searchClear.hidden = !hasText && quickResults === null;
  quickRun.hidden = !hasText;
}

// ---------------------------------------------------------------------------
// Left panel: the ingredient picker
// ---------------------------------------------------------------------------

function renderPantry() {
  const terms = searchTerms();

  // Group the (filtered) ingredients by category, keeping a stable
  // display order - the order categories first appear in the data.
  const order = [...new Set(ingredients.map((i) => i.category))];
  const groups = new Map();
  for (const ing of ingredients) {
    const name = ing.name.toLowerCase();
    // Match the chip's own name or any of its other spellings, so typing
    // "green onion" still surfaces the "scallion" chip.
    const hit =
      !terms.length ||
      terms.some(
        (t) =>
          name.includes(t) ||
          (ing.aliases ?? []).some((a) => a.toLowerCase().includes(t))
      );
    if (!hit) continue;
    if (!groups.has(ing.category)) groups.set(ing.category, []);
    groups.get(ing.category).push(ing);
  }

  document.querySelector("#ingredient-groups").innerHTML = order
    .filter((cat) => groups.has(cat))
    .map(
      (cat) => `
      <div class="group">
        <h3>${esc(cat)}</h3>
        <div class="chips">
          ${groups.get(cat).map(chipHtml).join("")}
        </div>
      </div>`
    )
    .join("");

  if (groups.size === 0) {
    document.querySelector("#ingredient-groups").innerHTML =
      `<p class="hint small">No ingredient matches “${esc(searchInput.value.trim())}”.</p>`;
  }
}

/// One ingredient chip. Ingredients you added also get a ✕ to delete them.
function chipHtml(ing) {
  const cls = `chip ${ing.in_pantry ? "on" : ""} ${ing.source === "user" ? "mine" : ""}`;
  const chip = `<button class="${cls}" data-id="${ing.id}">${esc(ing.name)}</button>`;
  if (ing.source !== "user") return chip;
  return `<span class="chip-wrap">${chip}<button class="chip-del"
    data-del-ingredient="${ing.id}" title="Delete “${esc(ing.name)}”">✕</button></span>`;
}

// Tap a chip: flip it in the database, then reload everything.
document.querySelector("#ingredient-groups").addEventListener("click", async (e) => {
  // ✕ on an ingredient you added
  const del = e.target.closest(".chip-del");
  if (del) {
    e.stopPropagation();
    if (!isArmed(del)) return;
    try {
      await invoke("delete_ingredient", { id: Number(del.dataset.delIngredient) });
      await afterCatalogChange();
      toast("Ingredient deleted.");
    } catch (err) {
      toast(String(err));
    }
    return;
  }

  const chip = e.target.closest(".chip");
  if (!chip) return;
  await invoke("toggle_ingredient", { id: Number(chip.dataset.id) });
  await refresh();
});

// ---------------------------------------------------------------------------
// Adding ingredients
// ---------------------------------------------------------------------------

addIngredientBtn.addEventListener("click", () => {
  addIngredientForm.hidden = !addIngredientForm.hidden;
  if (!addIngredientForm.hidden) {
    document.querySelector("#new-ingredient-name").focus();
  }
});

addIngredientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.querySelector("#new-ingredient-name").value.trim();
  const category = document.querySelector("#new-ingredient-category").value.trim();
  try {
    // "Add an ingredient you have" - so it goes straight into the pantry.
    const id = await invoke("add_ingredient", { name, category });
    await invoke("toggle_ingredient", { id });
    addIngredientForm.reset();
    addIngredientForm.hidden = true;
    await afterCatalogChange();
    toast(`Added “${name.toLowerCase()}” to your pantry.`);
  } catch (err) {
    toast(String(err));
  }
});

/// The category box suggests categories that already exist.
function renderCategories() {
  const cats = [...new Set(ingredients.map((i) => i.category))];
  categoryOptions.innerHTML = cats
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Right panel box: quick query ("cook with these")
// ---------------------------------------------------------------------------

async function runQuickQuery() {
  const text = searchInput.value.trim();
  if (!text) return;

  // Every run bumps the token; only the newest reply may paint the screen.
  const token = ++quickToken;
  const results = await invoke("search_recipes", { query: text });
  if (token !== quickToken) return;

  quickResults = results;
  quickQueryText = text;
  renderMatches();
  syncSearchButtons();
}

function clearSearch() {
  quickToken++; // cancel any in-flight reply
  quickResults = null;
  quickQueryText = "";
  searchInput.value = "";
  searchInput.focus();
  renderAll();
}

// ---------------------------------------------------------------------------
// Right panel: the recipe list (pantry matches OR quick-query results)
// ---------------------------------------------------------------------------

/// Does this recipe match any typed word? Recipe name OR any ingredient.
function matchesFilter(m, terms) {
  if (!terms.length) return true;
  const names = [m.name.toLowerCase(), ...m.ingredients.map((l) => l.name.toLowerCase())];
  return terms.some((t) => {
    // "green onion" should find a recipe that says "scallion"
    const canonical = aliasIndex.get(t);
    return names.some(
      (n) => n.includes(t) || (canonical !== undefined && n.includes(canonical.toLowerCase()))
    );
  });
}

function renderMatches() {
  const list = document.querySelector("#match-list");
  const terms = searchTerms();
  const usingQuick = quickResults !== null;

  // Quick query on: show what the typed ingredients can make.
  // Quick query off: score every recipe against your saved pantry.
  const source = usingQuick ? quickResults : matches;

  quickBanner.hidden = !usingQuick;
  if (usingQuick) {
    quickBanner.innerHTML = `Matching only what you typed:
      <strong>${esc(quickQueryText)}</strong> - your pantry chips are ignored.
      Press Enter to update.`;
  }

  const anyPantry = ingredients.some((i) => i.in_pantry);

  // Nothing tapped, nothing searched: show the whole cookbook instead of an
  // empty panel, with a one-line nudge on how to rank it. Seeing what the app
  // can actually do beats a hint that asks you to trust it first.
  const browsing = !usingQuick && !anyPantry && !terms.length;

  if (usingQuick && source.length === 0) {
    list.innerHTML = `<p class="hint">None of those words match a known ingredient.<br />
      Try real ingredients like <em>eggs, rice, tofu, noodles</em>.</p>`;
    return;
  }

  const shown = source.filter((m) => matchesFilter(m, terms));
  if (shown.length === 0) {
    list.innerHTML = `<p class="hint">No recipe matches “${esc(searchInput.value.trim())}”.</p>`;
    return;
  }

  // Empty pantry = browsing the cookbook, so no split.
  if (!usingQuick && !anyPantry) {
    const intro = browsing
      ? `<p class="hint browse">All ${shown.length} recipes, A to Z.
           Tap ingredients on the left to rank them by what you can cook,
           or type in the search bar and press <kbd>Enter</kbd>.</p>`
      : `<p class="muted count">${shown.length} ${
          shown.length === 1 ? "recipe" : "recipes"
        }</p>`;
    list.innerHTML = intro + shown.map(recipeCard).join("");
    return;
  }

  // Split: recipes that use at least one thing you own vs. recipes that
  // use nothing you own. "Have" = total - missing (both already sent by
  // Rust, so no extra database call is needed for this).
  const haveSome = shown.filter((m) => m.total - m.missing > 0);
  const haveNone = shown.filter((m) => m.total - m.missing === 0);

  let html = "";
  if (haveSome.length) {
    html +=
      `<div class="section-title">${usingQuick ? "Matches what you typed" : "Matches your pantry"}` +
      ` <span class="muted">${haveSome.length}</span></div>` +
      haveSome.map(recipeCard).join("");
  }
  if (haveNone.length) {
    html +=
      `<div class="section-title none">${
        usingQuick ? "No shared ingredients" : "None of your ingredients yet"
      } <span class="muted">${haveNone.length}</span></div>` +
      `<div class="dim">${haveNone.map(recipeCard).join("")}</div>`;
  }
  list.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Portions: scaling a recipe from its base servings to yours
// ---------------------------------------------------------------------------

// recipe id -> the pax count you last picked. Lives outside the render so
// tapping an ingredient (which re-renders the whole list) keeps your choice.
const servingsChoice = new Map();

function targetServings(m) {
  return servingsChoice.get(m.id) || m.servings || 1;
}

/// 0.30000000000000004 -> "0.3", 2 -> "2", and 0.5 -> "½" (cooking
/// amounts are read by eye, not by calculator).
const FRACTIONS = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [1 / 3, "⅓"],
  [0.5, "½"],
  [2 / 3, "⅔"],
  [0.75, "¾"],
];

function fmtNum(n) {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(frac - value) < 0.02) {
      return whole > 0 ? `${whole}${glyph}` : glyph;
    }
  }
  return String(Math.round(n * 100) / 100);
}

/// "eggs" at 1 pax -> "egg". Only for plain plurals, so "asparagus" and
/// "couscous" are left alone.
function fmtName(name, amount) {
  if (amount !== 1 || !name.endsWith("s")) return name;
  if (/(ss|us|is|ous)$/.test(name)) return name;
  return name.slice(0, -1);
}

// Units that already read fine after any number ("200 g", "2 tbsp").
const UNIT_NO_PLURAL = new Set(["g", "kg", "ml", "l", "tsp", "tbsp", "pinch"]);
// The one irregular in the catalog.
const UNIT_PLURALS = { leaf: "leaves" };

/// "1 slice" -> "4 slices", but "200 g" stays "200 g".
function fmtUnit(unit, amount) {
  if (!unit) return "";
  if (amount === 1 || UNIT_NO_PLURAL.has(unit) || unit.endsWith("s")) return unit;
  return UNIT_PLURALS[unit] || `${unit}s`;
}

/// "2", "1 tbsp", "to taste" - amount already scaled to `target` pax.
function fmtQty(amount, unit, target, base) {
  if (amount === null || amount === undefined) return "to taste";
  const scaled = (amount * target) / base;
  const unitText = fmtUnit(unit, scaled);
  return unitText ? `${fmtNum(scaled)} ${unitText}` : fmtNum(scaled);
}

/// One recipe card. Kept separate so both sections render identically.
function recipeCard(m) {
  const base = m.servings || 1;
  const target = targetServings(m);

  const badge =
    m.missing === 0
      ? `<span class="badge ok">cook now</span>`
      : m.missing === 1
        ? `<span class="badge close">1 missing</span>`
        : `<span class="badge far">${m.missing} missing</span>`;

  // "you still need ..." - derived from the ingredient lines, so it always
  // agrees with what the list below shows.
  const missingNames = m.ingredients
    .filter((l) => !l.in_pantry)
    .map((l) => l.label || l.name);
  const missing =
    m.missing > 0
      ? `<div class="missing">you still need
          ${missingNames.map((n) => `<span class="miss-chip">${esc(n)}</span>`).join(" ")}
        </div>`
      : "";

  const lines = m.ingredients
    .map((l) => {
      const scaled = l.amount === null ? null : (l.amount * target) / base;
      return `
      <li class="${l.in_pantry ? "have" : "need"}" data-name="${esc(l.label || l.name)}">
        <span class="qty" data-amount="${l.amount === null ? "" : l.amount}" data-unit="${esc(
          l.unit
        )}">${fmtQty(l.amount, l.unit, target, base)}</span>
        <span class="iname">${esc(fmtName(l.label || l.name, scaled))}</span>
      </li>`;
    })
    .join("");

  // Recipes you added are marked, and can be edited or deleted.
  const mine = m.source === "user" ? `<span class="badge mine">mine</span>` : "";
  const actions =
    m.source === "user"
      ? `<button class="edit" data-edit-recipe="${m.id}" title="Edit this recipe">✎</button>
         <button class="del" data-del-recipe="${m.id}" title="Delete this recipe">✕</button>`
      : "";

  // Only offer the shopping list when we're scoring against the REAL pantry.
  // In quick-query mode "missing" means "not in the words you typed", so the
  // button would promise more than the Rust side would actually add.
  const addMissing =
    m.missing > 0 && quickResults === null
      ? `<div class="card-actions">
           <button class="ghost tiny add-missing" data-add-missing="${m.id}">
             🛒 Add ${m.missing} missing to list
           </button>
         </div>`
      : "";

  return `
  <details class="recipe ${m.missing === 0 ? "ready" : ""}"
           data-id="${m.id}" data-base="${base}" data-target="${target}">
    <summary>
      ${badge}
      <span class="rname">${esc(m.name)}</span>
      ${mine}
      <span class="sub">${m.total - m.missing} of ${m.total}</span>
      ${actions}
    </summary>

    <div class="servings">
      <span class="muted">Serves</span>
      <button class="step" data-step="-1" title="Fewer people">−</button>
      <strong class="pax-n">${target}</strong>
      <button class="step" data-step="1" title="More people">+</button>
      <span class="muted">pax</span>
      <span class="scale-note muted">${
        target === base ? `written for ${base}` : `scaled from ${base}`
      }</span>
    </div>

    <ul class="ing-lines">${lines}</ul>
    ${addMissing}
    <div class="steps">${esc(m.steps)}</div>
    ${missing}
    ${credit(m)}
  </details>`;
}

/// Imported recipes must credit their source: Wikibooks Cookbook is CC BY-SA
/// 4.0, which requires attribution and a link back. Recipes you wrote have no
/// attribution, so nothing is shown for them.
function credit(m) {
  if (!m.attribution) return "";
  const text = `<span class="credit-text">${esc(m.attribution)}</span>`;
  return m.source_url
    ? `<div class="credit">${text} ·
         <a href="${esc(m.source_url)}" target="_blank" rel="noreferrer">original recipe</a>
       </div>`
    : `<div class="credit">${text}</div>`;
}

// The − / + stepper. Updates the numbers in place instead of re-rendering,
// so the card you're looking at stays open.
document.querySelector("#match-list").addEventListener("click", (e) => {
  const step = e.target.closest(".step");
  if (!step) return;

  const card = step.closest(".recipe");
  const base = Number(card.dataset.base) || 1;
  const current = Number(card.dataset.target) || base;
  const next = Math.min(50, Math.max(1, current + Number(step.dataset.step)));
  if (next === current) return;

  card.dataset.target = String(next);
  servingsChoice.set(Number(card.dataset.id), next);

  card.querySelector(".pax-n").textContent = String(next);
  for (const li of card.querySelectorAll(".ing-lines li")) {
    const qty = li.querySelector(".qty");
    const raw = qty.dataset.amount;
    const amount = raw === "" ? null : Number(raw);
    qty.textContent = fmtQty(amount, qty.dataset.unit, next, base);
    li.querySelector(".iname").textContent = fmtName(
      li.dataset.name,
      amount === null ? 0 : (amount * next) / base
    );
  }
  card.querySelector(".scale-note").textContent =
    next === base ? `written for ${base}` : `scaled from ${base}`;
});

// Credit links ("original recipe") open in the real browser. Left alone, a
// click would navigate the app window itself to Wikibooks and there'd be no
// way back to your pantry.
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[href^='http']");
  if (!link) return;
  e.preventDefault();
  invoke("open_external", { url: link.href }).catch(() => {
    toast("Couldn't open that link.");
  });
});

// Edit or delete a recipe you added.
document.querySelector("#match-list").addEventListener("click", async (e) => {
  // 🛒 on a recipe: put everything you're missing on the shopping list,
  // scaled to the pax count shown on that card.
  const addMissing = e.target.closest(".add-missing");
  if (addMissing) {
    e.preventDefault();
    const card = addMissing.closest(".recipe");
    const servings = Number(card.dataset.target) || 1;
    try {
      const n = await invoke("add_missing_to_list", {
        recipeId: Number(addMissing.dataset.addMissing),
        servings,
      });
      await refreshShopping();
      if (n > 0) {
        toast(`Added ${n} item${n === 1 ? "" : "s"} for ${servings} pax.`);
        openDrawer();
      } else {
        toast("You already have everything for that one.");
      }
    } catch (err) {
      toast(String(err));
    }
    return;
  }

  const edit = e.target.closest(".edit");
  if (edit) {
    e.preventDefault(); // don't expand/collapse the <details>
    e.stopPropagation();
    startEditRecipe(Number(edit.dataset.editRecipe));
    return;
  }

  const del = e.target.closest(".del");
  if (!del) return;
  e.preventDefault(); // don't expand/collapse the <details>
  e.stopPropagation();
  if (!isArmed(del)) return;
  try {
    await invoke("delete_recipe", { id: Number(del.dataset.delRecipe) });
    await afterCatalogChange();
    toast("Recipe deleted.");
  } catch (err) {
    toast(String(err));
  }
});

// ---------------------------------------------------------------------------
// Adding & editing recipes
// ---------------------------------------------------------------------------

/// One editable ingredient line: name, amount, unit. Amount is optional.
function addIngredientRow(line = { name: "", amount: null, unit: "" }) {
  const row = document.createElement("div");
  row.className = "ing-row";
  row.innerHTML = `
    <input class="ing-name" placeholder="ingredient (e.g. paneer)" value="${esc(line.name)}" />
    <input class="ing-amount" type="number" step="any" min="0" placeholder="amt"
           value="${line.amount === null || line.amount === undefined ? "" : line.amount}" />
    <input class="ing-unit" placeholder="unit" value="${esc(line.unit || "")}" />
    <button type="button" class="row-del" title="Remove this line">✕</button>`;
  ingRows.appendChild(row);
  return row;
}

/// Read the rows back into the shape Rust expects:
/// [{ name, amount: number|null, unit }]
function readIngredientRows() {
  return [...ingRows.querySelectorAll(".ing-row")]
    .map((row) => {
      const amountText = row.querySelector(".ing-amount").value.trim();
      return {
        name: row.querySelector(".ing-name").value.trim(),
        amount: amountText === "" ? null : Number(amountText),
        unit: row.querySelector(".ing-unit").value.trim(),
      };
    })
    .filter((l) => l.name);
}

document.querySelector("#add-ing-row").addEventListener("click", () => {
  addIngredientRow().querySelector(".ing-name").focus();
});

ingRows.addEventListener("click", (e) => {
  const del = e.target.closest(".row-del");
  if (!del) return;
  // Keep one row on screen, otherwise the form looks broken.
  if (ingRows.children.length === 1) {
    del.closest(".ing-row").querySelectorAll("input").forEach((i) => (i.value = ""));
  } else {
    del.closest(".ing-row").remove();
  }
});

addRecipeBtn.addEventListener("click", () => {
  // Clicking "+ Add recipe" while the form is open closes it (and drops
  // any edit in progress).
  if (!addRecipeForm.hidden) {
    closeRecipeForm();
    return;
  }
  closeRecipeForm(); // start from a clean "add" state
  addRecipeForm.hidden = false;
  document.querySelector("#new-recipe-name").focus();
});

/// Put the form back to "add a new recipe" and hide it.
function closeRecipeForm() {
  editingRecipeId = null;
  addRecipeForm.reset();
  servingsInput.value = "2";
  ingRows.innerHTML = "";
  addIngredientRow();
  addRecipeForm.hidden = true;
  recipeSubmit.textContent = "Save recipe";
}

/// Fill the form with an existing recipe and switch it to "edit" mode.
function startEditRecipe(id) {
  const r =
    matches.find((m) => m.id === id) ||
    (quickResults || []).find((m) => m.id === id);
  if (!r) return;

  editingRecipeId = id;
  document.querySelector("#new-recipe-name").value = r.name;
  servingsInput.value = String(r.servings || 1);
  ingRows.innerHTML = "";
  r.ingredients.forEach((l) => addIngredientRow(l));
  if (!r.ingredients.length) addIngredientRow();
  document.querySelector("#new-recipe-steps").value = r.steps;
  recipeSubmit.textContent = "Save changes";

  addRecipeForm.hidden = false;
  addRecipeForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  document.querySelector("#new-recipe-name").focus();
}

addRecipeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.querySelector("#new-recipe-name").value.trim();
  const steps = document.querySelector("#new-recipe-steps").value.trim();
  const servings = Number(servingsInput.value) || 1;
  const list = readIngredientRows();

  const editing = editingRecipeId;
  try {
    if (editing === null) {
      await invoke("add_recipe", { name, steps, servings, ingredients: list });
    } else {
      await invoke("update_recipe", {
        id: editing,
        name,
        steps,
        servings,
        ingredients: list,
      });
    }
    closeRecipeForm();
    await afterCatalogChange();
    toast(editing === null ? `Saved “${name}”.` : `Updated “${name}”.`);
  } catch (err) {
    toast(String(err));
  }
});

// Any "Cancel" button closes and clears its own form.
document.addEventListener("click", (e) => {
  const cancel = e.target.closest("[data-cancel]");
  if (!cancel) return;
  const form = cancel.closest("form");
  if (!form) return;
  if (form === addRecipeForm) {
    closeRecipeForm();
  } else {
    form.reset();
    form.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Shopping list
// ---------------------------------------------------------------------------

let shopping = [];

const shoppingBtn = document.querySelector("#shopping-btn");
const shoppingDrawer = document.querySelector("#shopping-drawer");
const shoppingClose = document.querySelector("#shopping-close");
const shoppingCount = document.querySelector("#shopping-count");
const shoppingSummary = document.querySelector("#shopping-summary");
const shopList = document.querySelector("#shop-list");
const shopAddForm = document.querySelector("#shop-add-form");
const shopAddInput = document.querySelector("#shop-add-input");
const moveCheckedBtn = document.querySelector("#move-checked");
const clearCheckedBtn = document.querySelector("#clear-checked");
const clearAllBtn = document.querySelector("#clear-all");

function openDrawer() {
  shoppingDrawer.classList.add("open");
  shoppingDrawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  shoppingDrawer.classList.remove("open");
  shoppingDrawer.setAttribute("aria-hidden", "true");
  // Never leave "Clear all" armed behind a closed drawer.
  disarmClearAll();
}

shoppingBtn.addEventListener("click", () => {
  if (shoppingDrawer.classList.contains("open")) closeDrawer();
  else openDrawer();
});

shoppingClose.addEventListener("click", closeDrawer);

async function refreshShopping() {
  shopping = await invoke("get_shopping_list");
  renderShopping();
}

function renderShopping() {
  const left = shopping.filter((i) => !i.checked).length;
  const done = shopping.length - left;

  shoppingCount.textContent = String(left);
  shoppingCount.classList.toggle("has", left > 0);
  shoppingSummary.textContent = shopping.length
    ? `${left} to buy${done ? ` · ${done} ticked` : ""}`
    : "";

  if (!shopping.length) {
    shopList.innerHTML = `<li class="shop-empty">
      Nothing to buy yet.<br />Open a recipe and tap
      <strong>🛒 Add missing to list</strong>.
    </li>`;
    return;
  }

  shopList.innerHTML = shopping
    .map((item) => {
      // "200 g", "to taste" (catalog ingredient, no number), or blank
      // (freeform item like "dish soap").
      const qty =
        item.amount !== null
          ? fmtQty(item.amount, item.unit, 1, 1)
          : item.from_catalog
            ? "to taste"
            : "";
      return `
    <li class="shop-item ${item.checked ? "done" : ""}" data-id="${item.id}">
      <input type="checkbox" ${item.checked ? "checked" : ""} />
      <span class="qty">${qty}</span>
      <span class="label">${esc(item.label)}</span>
      <button class="shop-del" data-del-shop="${item.id}" title="Remove">✕</button>
    </li>`;
    })
    .join("");
}

// Tick / untick a line.
shopList.addEventListener("change", async (e) => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  const li = box.closest(".shop-item");
  try {
    await invoke("toggle_shopping_item", { id: Number(li.dataset.id) });
    await refreshShopping();
  } catch (err) {
    toast(String(err));
  }
});

// Remove a single line - immediate, because a list isn't precious data.
shopList.addEventListener("click", async (e) => {
  const del = e.target.closest(".shop-del");
  if (!del) return;
  try {
    await invoke("delete_shopping_item", { id: Number(del.dataset.delShop) });
    await refreshShopping();
  } catch (err) {
    toast(String(err));
  }
});

// Type anything: a known ingredient gets linked, anything else is freeform.
shopAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = shopAddInput.value.trim();
  if (!label) return;
  try {
    await invoke("add_shopping_item", { label });
    shopAddInput.value = "";
    await refreshShopping();
  } catch (err) {
    toast(String(err));
  }
});

// Bought it: ticked ingredients go into the pantry, then leave the list.
moveCheckedBtn.addEventListener("click", async () => {
  try {
    const n = await invoke("move_checked_to_pantry");
    if (n === 0 && !shopping.some((i) => i.checked)) {
      toast("Tick something first, then move it.");
      return;
    }
    await refresh(); // the pantry changed, so the recipe scores changed too
    await refreshShopping();
    toast(n ? `Moved ${n} into your pantry.` : "Cleared the ticked items.");
  } catch (err) {
    toast(String(err));
  }
});

clearCheckedBtn.addEventListener("click", async () => {
  try {
    const n = await invoke("clear_checked_shopping");
    await refreshShopping();
    toast(n ? `Removed ${n} item${n === 1 ? "" : "s"}.` : "Nothing ticked.");
  } catch (err) {
    toast(String(err));
  }
});

// "Clear all" is the one button here that throws away work you did, so it asks
// twice: the first click arms it for a few seconds, the second does it. No
// dialog box - the button itself turns into the question.
let clearAllArmed = false;
let clearAllTimer = null;

function disarmClearAll() {
  clearAllArmed = false;
  if (clearAllTimer) clearTimeout(clearAllTimer);
  clearAllTimer = null;
  clearAllBtn.textContent = "Clear all";
  clearAllBtn.classList.remove("armed");
}

clearAllBtn.addEventListener("click", async () => {
  if (!shopping.length) {
    toast("The list is already empty.");
    return;
  }

  if (!clearAllArmed) {
    clearAllArmed = true;
    clearAllBtn.textContent = `Sure? Delete ${shopping.length}`;
    clearAllBtn.classList.add("armed");
    clearAllTimer = setTimeout(disarmClearAll, 5000);
    return;
  }

  disarmClearAll();
  try {
    const n = await invoke("clear_shopping_list");
    await refreshShopping();
    toast(`Cleared ${n} item${n === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(String(err));
  }
});

// ---------------------------------------------------------------------------
// Taking the list to the shops
// ---------------------------------------------------------------------------

const copyListBtn = document.querySelector("#copy-list");
const saveListBtn = document.querySelector("#save-list");
const savedNote = document.querySelector("#saved-note");
const savedNoteText = document.querySelector("#saved-note-text");
const openFolderBtn = document.querySelector("#open-folder");

// The path of the file we last wrote, so "Open folder" knows what to reveal.
let lastSavedPath = "";

/// "6 slices bread", "to taste salt", "dish soap" - the line without its tick.
/// Amounts are already scaled when they go onto the list, hence 1/1.
function shoppingWhat(item) {
  const qty =
    item.amount !== null
      ? fmtQty(item.amount, item.unit, 1, 1)
      : item.from_catalog
        ? "to taste"
        : "";
  return qty ? `${qty} ${item.label}` : item.label;
}

/// One line of text: "☐ 6 slices bread", "☑ dish soap".
function shoppingLine(item) {
  const what = shoppingWhat(item);
  // ☐ / ☑ rather than "x" / "-": they survive copy-paste into a phone note
  // and read at a glance while you're pushing a trolley.
  return `${item.checked ? "☑" : "☐"} ${what}`;
}

/// The whole list as plain text. Deliberately dull format - no tables, no
/// emoji headers - so it pastes cleanly into Notes, WhatsApp or Phone Link.
function shoppingListText() {
  const today = new Date().toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const left = shopping.filter((i) => !i.checked).length;
  const heading = [
    `PantryPedia shopping list - ${today}`,
    `${left} to buy of ${shopping.length}`,
    "",
  ];
  return [...heading, ...shopping.map(shoppingLine)].join("\r\n");
}

/// One file per day: saving twice just updates today's list instead of
/// littering Downloads with near-identical files.
function shoppingFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `pantrypedia-list-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
}

/// Clipboard with a fallback. The async clipboard API needs a secure context
/// and can be blocked outright, so if it fails we fall back to the old
/// hidden-textarea trick.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

copyListBtn.addEventListener("click", async () => {
  if (!shopping.length) {
    toast("The list is empty - nothing to copy.");
    return;
  }
  const ok = await copyText(shoppingListText());
  toast(
    ok
      ? "Copied. Paste it into Notes, WhatsApp or Phone Link."
      : "Couldn't reach the clipboard - use Save .txt instead."
  );
});

saveListBtn.addEventListener("click", async () => {
  if (!shopping.length) {
    toast("The list is empty - nothing to save.");
    return;
  }
  try {
    const path = await invoke("save_text_file", {
      filename: shoppingFileName(),
      contents: shoppingListText(),
    });
    lastSavedPath = path;
    savedNoteText.textContent = `Saved to ${path}`;
    savedNote.hidden = false;
    toast("Saved. Open the folder and send it to your phone.");
  } catch (err) {
    toast(String(err));
  }
});

openFolderBtn.addEventListener("click", async () => {
  if (!lastSavedPath) return;
  try {
    await invoke("reveal_file", { path: lastSavedPath });
  } catch (err) {
    toast(String(err));
  }
});

// ---------------------------------------------------------------------------
// QR code - the shopping list, on your phone
// ---------------------------------------------------------------------------
//
// The code holds a LINK, not the list itself. Phones know exactly what to do
// with a link (open it in the browser); a QR full of plain text just makes the
// camera app say "QR code" and offer nothing, which is what happened when the
// list itself was encoded. So the app serves the list on the local network
// while this window is open, and the phone reads it there.

const qrBtn = document.querySelector("#qr-list");
const qrModal = document.querySelector("#qr-modal");
const qrHolder = document.querySelector("#qr-holder");
const qrNote = document.querySelector("#qr-note");
const qrCloseBtn = document.querySelector("#qr-close");
const qrUrlRow = document.querySelector("#qr-url");
const qrUrlText = document.querySelector("#qr-url-text");
const qrCopyUrl = document.querySelector("#qr-copy-url");

let qrOpen = false;

/// Draw `text` as a QR code. Error correction "M" rather than "L": the payload
/// is now a short URL, so there is plenty of room, and M survives a bit of
/// screen glare.
function drawQr(text) {
  // typeNumber 0 = "pick the smallest version that fits this much data"
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  // margin 4 modules = the white quiet zone scanners need to find the edges
  qrHolder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4 });
}

async function showQr() {
  if (!shopping.length) {
    toast("The list is empty - nothing to scan.");
    return;
  }

  qrOpen = true;
  qrModal.hidden = false;
  qrHolder.hidden = false;
  qrHolder.innerHTML = "";
  qrUrlRow.hidden = true;
  qrNote.textContent = "Starting the link…";

  try {
    const url = await invoke("start_share", {
      title: "PantryPedia shopping list",
      items: shopping.map((i) => ({ label: shoppingWhat(i), checked: i.checked })),
    });

    drawQr(url);

    qrUrlText.textContent = url;
    qrUrlRow.hidden = false;
    qrNote.textContent =
      "Scan with your phone camera - it opens the list in your browser. " +
      "Your phone must be on the same Wi-Fi as this computer. If the page won't " +
      "load, Windows Firewall is blocking PantryPedia - allow it once.";
  } catch (err) {
    // No network, or the port could not be opened: say what to do instead.
    qrHolder.hidden = true;
    qrNote.textContent = `${err}. Use Copy or Save .txt instead.`;
  }
}

function hideQr() {
  if (!qrOpen) return;
  qrOpen = false;
  qrModal.hidden = true;
  qrHolder.innerHTML = ""; // drop the SVG, nothing to keep in memory
  // Stop serving the moment the window closes, so the list is not left on the
  // network while you are not looking at it.
  invoke("stop_share").catch(() => {});
}

qrBtn.addEventListener("click", showQr);

qrCloseBtn.addEventListener("click", hideQr);

qrCopyUrl.addEventListener("click", async () => {
  const ok = await copyText(qrUrlText.textContent);
  toast(ok ? "Link copied - paste it into your phone's browser." : "Couldn't copy the link.");
});

// Clicking the dark backdrop closes; clicking inside the card must not.
qrModal.addEventListener("click", (e) => {
  if (e.target === qrModal) hideQr();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && qrOpen) hideQr();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Destructive buttons need two clicks: the first arms them for 3 seconds,
/// the second actually deletes. No scary native dialog needed.
const armedTimers = new WeakMap();

function isArmed(btn) {
  if (btn.dataset.armed === "1") return true;
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.title = "Click again to delete";
  clearTimeout(armedTimers.get(btn));
  armedTimers.set(
    btn,
    setTimeout(() => {
      btn.dataset.armed = "";
      btn.classList.remove("armed");
    }, 3000)
  );
  return false;
}

/// A one-line message at the bottom of the window.
let toastTimer = null;

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

// Escape user/data text so it can never be interpreted as HTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// Load the app: recipes/pantry first, then the shopping list.
refresh();
refreshShopping();
