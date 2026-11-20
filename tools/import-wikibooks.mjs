// Import recipes from Wikibooks Cookbook (CC BY-SA 4.0) into PantryPedia's
// seed format.
//
//   node tools/import-wikibooks.mjs fetch     # download + cache wikitext
//   node tools/import-wikibooks.mjs parse     # parse the cache, report ingredients
//   node tools/import-wikibooks.mjs build     # write src-tauri/data/seed.json
//
// Step 1 caches raw wikitext under tools/.cache/ so parsing can be iterated
// without hitting the API again. Wikimedia rate-limits hard: keep the delay
// and send a real User-Agent.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_INGREDIENT } from "./ingredient-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".cache");
const API = "https://en.wikibooks.org/w/api.php";
const UA = "PantryPediaRecipeImport/1.0 (personal cooking app; one-off seed import)";

// The cuisines this app cares about, plus a few staples. 322 pages at the time
// of writing; the importer takes whatever is there and skips what won't parse.
const CUISINES = [
  "Chinese recipes",
  "Japanese recipes",
  "Korean recipes",
  "Thai recipes",
  "Indian recipes",
  "Malaysian recipes",
  "Vietnamese recipes",
  "Indonesian recipes",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params, attempt = 1) {
  const q = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const res = await fetch(`${API}?${q}`, { headers: { "User-Agent": UA } });
  const text = await res.text();
  if (!text.trim().startsWith("{")) {
    // Wikimedia answers "You are making too many requests" with plain text.
    if (attempt <= 8) {
      const wait = Math.min(2000 * 2 ** (attempt - 1), 60000);
      console.log(`  rate limited, waiting ${wait / 1000}s (attempt ${attempt})`);
      await sleep(wait);
      return api(params, attempt + 1);
    }
    throw new Error(`API refused after ${attempt} attempts: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
}

// --- fetch -----------------------------------------------------------------

async function titlesFor(category) {
  const out = [];
  let cont = null;
  do {
    const params = {
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmtype: "page",
      cmlimit: "500",
    };
    if (cont) params.cmcontinue = cont;
    const j = await api(params);
    for (const m of j.query?.categorymembers ?? []) out.push(m.title);
    cont = j.continue?.cmcontinue ?? null;
    await sleep(600);
  } while (cont);
  return out;
}

async function fetchWikitext(titles, pages, pageFile) {
  const BATCH = 50; // the API's maximum for titles=
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const j = await api({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: batch.join("|"),
    });
    for (const p of j.query?.pages ?? []) {
      const text = p.revisions?.[0]?.slots?.main?.content;
      if (text) pages[p.title] = text;
    }
    // Save every batch: a rate-limit block halfway through must not lose the
    // pages already downloaded.
    writeFileSync(pageFile, JSON.stringify(pages));
    console.log(`  ${Object.keys(pages).length}/${titles.length} cached`);
    await sleep(2000);
  }
  return pages;
}

async function fetchAll() {
  mkdirSync(CACHE, { recursive: true });
  const titleFile = join(CACHE, "titles.json");
  let titles;
  if (existsSync(titleFile)) {
    titles = JSON.parse(readFileSync(titleFile, "utf8"));
    console.log(`titles cached: ${titles.length}`);
  } else {
    const all = new Set();
    for (const c of CUISINES) {
      const t = await titlesFor(c);
      console.log(`${c.padEnd(22)} ${t.length}`);
      for (const x of t) all.add(x);
    }
    titles = [...all].sort();
    writeFileSync(titleFile, JSON.stringify(titles, null, 2));
  }

  const pageFile = join(CACHE, "wikitext.json");
  const pages = existsSync(pageFile) ? JSON.parse(readFileSync(pageFile, "utf8")) : {};
  const missing = titles.filter((t) => !pages[t]);
  if (missing.length) {
    await fetchWikitext(missing, pages, pageFile);
  }
  console.log(`cached wikitext for ${Object.keys(pages).length} pages`);
}

// --- parse -----------------------------------------------------------------

// Units, techniques and packaging pages are never ingredients. The list lives
// in ingredient-map.mjs so the parser and the catalog builder agree; this used
// to be a second copy that drifted and let "pinch" and "julienne" through.

function stripRefs(s) {
  return s.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[\s\S]*?<\/ref>/gi, "");
}

/// [[Cookbook:Soy Sauce|soy sauce]] -> "soy sauce"; [[Cookbook:Onion]] -> "onion"
/// [[Cookbook:Soy_Sauce]] -> "soy sauce"
function unlink(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, target) =>
      target.replace(/^Cookbook:/i, "").replace(/_/g, " "),
    );
}

function cleanLine(s) {
  return unlink(stripRefs(s))
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[(https?:)?\/\/[^\s\]]+\s*([^\]]*)\]/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/// Link targets on a line, lowercased, without the Cookbook: prefix.
/// Some lines link to Wikipedia instead ("[[wikipedia:bay leaf|bay leaf]]");
/// the namespace has to go too, or the resolver never sees "bay leaf".
function linkTargets(s) {
  const out = [];
  for (const m of s.matchAll(/\[\[(?:Cookbook:)?([^\]|]+)(?:\|[^\]]*)?\]\]/gi)) {
    out.push(
      m[1]
        .replace(/^[a-z-]+:/i, "") // wikipedia:, w:, wikt:, Cookbook:
        .replace(/_/g, " ")
        .trim()
        .toLowerCase(),
    );
  }
  return out;
}

// Headings can contain `=` inside a <ref>, so match the outer `== … ==` pair
// lazily rather than forbidding `=` in the middle.
const SECTION = /^=+\s*(.+?)\s*=+\s*$/;

function sections(wikitext) {
  const out = {};
  let current = "_lead";
  for (const line of wikitext.split(/\r?\n/)) {
    const m = line.match(SECTION);
    if (m) {
      current = m[1].toLowerCase();
      out[current] ??= [];
    } else {
      (out[current] ??= []).push(line);
    }
  }
  return out;
}

const FRACTION = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅛": 0.125 };

/// "1 1/2 cups" -> 1.5, "3-4" -> 3, "1–2" -> 1, "½" -> 0.5, "200" -> 200
function parseAmount(text) {
  const t = text.trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const range = t.match(/^(\d+(?:\.\d+)?)\s*[–-]\s*\d/);
  if (range) return Number(range[1]);
  const plain = t.match(/^(\d+(?:\.\d+)?)/);
  if (plain) return Number(plain[1]);
  for (const [glyph, value] of Object.entries(FRACTION)) {
    if (t.startsWith(glyph)) return value;
  }
  return null;
}

const UNIT_ALIASES = [
  [/\b(tablespoons?|tbsps?|tbs|tbsp)\b/i, "tbsp"],
  [/\b(teaspoons?|tsps?|tsp)\b/i, "tsp"],
  [/\b(kilograms?|kgs?)\b/i, "kg"],
  [/\b(grams?|g)\b/i, "g"],
  [/\b(millilit(?:re|er)s?|ml)\b/i, "ml"],
  [/\b(lit(?:re|er)s?|l)\b/i, "l"],
  [/\b(cups?)\b/i, "cup"],
  [/\b(pounds?|lbs?)\b/i, "lb"],
  [/\b(ounces?|oz)\b/i, "oz"],
  [/\bcloves?\b/i, "clove"],
  [/\bslices?\b/i, "slice"],
  [/\b(cans?|tins?)\b/i, "can"],
  [/\b(pieces?)\b/i, "piece"],
  [/\b(bunch(?:es)?)\b/i, "bunch"],
  [/\b(stalks?)\b/i, "stalk"],
  [/\b(sprigs?)\b/i, "sprig"],
  [/\b(heads?)\b/i, "head"],
  [/\bpinch(?:es)?\b/i, "pinch"],
  [/\bhandfuls?\b/i, "handful"],
];

function parseUnit(text) {
  for (const [re, unit] of UNIT_ALIASES) {
    if (re.test(text)) return unit;
  }
  return "";
}

/// One ingredient bullet -> { amount, unit, text, links }
function parseIngredientLine(raw) {
  const line = cleanLine(raw.replace(/^\*+\s*/, ""));
  if (!line) return null;

  let rest = line;
  let amount = null;
  let unit = "";

  // Some lists put the amount in brackets: "(250 ml) water", "(about ½ lb)
  // ground fish". Read the number out of the brackets instead of failing on
  // the "(" and dropping the line.
  const paren = rest.match(/^\(([^)]*)\)\s*/);
  if (paren) {
    const inner = paren[1].replace(/^about\s+/i, "").trim();
    amount = parseAmount(inner);
    unit = parseUnit(inner);
    rest = rest.slice(paren[0].length);
  }

  // "ea. Chinese sweet sausages", "each orange": a count word, not a name.
  rest = rest.replace(/^(?:ea\.?|each)\s+/i, "");

  if (amount === null) amount = parseAmount(rest);
  if (amount !== null) {
    rest = rest
      .replace(/^\s*(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*[–-]?\s*\d*|[½⅓⅔¼¾⅛])/, "")
      .trim();
  }
  // A parenthetical right after the amount is usually a metric/imperial
  // conversion: "200 g (7 oz) beef".
  rest = rest.replace(/^\([^)]*\)\s*/, "").trim();

  if (!unit) unit = parseUnit(rest.slice(0, 24));
  if (unit) {
    const before = rest;
    const stripped = before.replace(/^[^\s]*\s*/, "").trim();
    // "* 4 [[Cookbook:Clove|cloves]]" is the spice, not a bare unit. If taking
    // the unit word away leaves nothing, the word *was* the ingredient.
    rest = stripped ? stripped.replace(/^of\s+/i, "").trim() : before;
  }

  const targets = linkTargets(raw).filter((t) => !NOT_INGREDIENT.has(t));
  return { amount, unit, text: rest, links: targets, raw: line };
}

/// The names to try for one parsed line, most trustworthy first.
///
/// The line's own text comes first: qualifiers often sit *outside* the link
/// ("250 g sticky/glutinous [[Cookbook:Rice Flour|rice flour]]"), and using
/// only the link threw "glutinous" away, turning it into plain rice flour.
/// The links are the fallback, and the last link is the one the page treats as
/// the ingredient ("1 cup milk or [[Cookbook:Coconut Milk|coconut milk]]").
function candidateNames(ing) {
  const cleaned = ing.text
    .replace(/\([^)]*\)/g, " ") // (see notes), (optional)
    .split(",")[0] // ", sifted", ", finely chopped"
    .replace(
      /\s+(?:for|to)\s+(?:deep[- ]?fry(?:ing)?|shallow[- ]?fry(?:ing)?|fry(?:ing)?|garnish(?:ing)?|serv(?:e|ing)|dusting|greasing|coating|stuffing)\b.*$/i,
      "",
    )
    .replace(/^(?:the\s+)?green parts? of\s+/i, "") // "green part of scallions"
    .replace(/\b(?:ea\.?|each)\b/gi, " ")
    .replace(/^(?:a few|a couple of|a|some|several)\s+(?:drops?\s+(?:of\s+)?)?/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // "Banana leaves or aluminium foil to wrap", "black vinegar and shredded
  // ginger": the first half is the ingredient, the rest is an alternative or
  // a second item. Try the whole phrase first, then each half.
  const halves = cleaned.split(/\s+(?:or|and)\s+/i);

  return [cleaned, ...halves, ...ing.links.slice().reverse()].filter(Boolean);
}

// Wikibooks recipes do not all use `==Ingredients==`. Plenty split the list
// into sub-sections - "Marinade ingredients", "Curry ingredients", "Carrot
// namul" - and some call the steps "Preparation", "Process" or just "Recipe".
// So instead of looking up heading names, walk the page and decide what each
// heading *starts*, then take the shape of the bullet:
//
//   before the steps heading  ->  `*` bullets are ingredients
//   after  the steps heading  ->  `#` bullets are steps (and `*` are notes)
//
// Heading level matters: `=== Garnishing Powder ===` under `== Procedure ==`
// is part of the procedure, not a new section. Only level-2 headings change
// the section; deeper ones inherit it.
const STEPS_HEADING =
  /^(procedure|method|directions?|instructions?|preparation|preparing|steps?|cooking|process|recipe|to (?:make|cook|prepare)|assembly|pickling|sandwich assembly)/i;
// A hardware list. Its bullets are mostly not groceries, but a few are -
// "Banana leaves" to line a kuih tin, "cheesecloth" to drain yogurt - so the
// bullets are parsed and only the ones that name a real ingredient survive.
const EQUIPMENT_HEADING = /^(?:special\s+)?(?:equipment|utensils?|tools?)\b/i;
const SKIP_HEADING =
  /^(notes?|tips?|variations?|references?|sources?|bibliograph|external links?|see also|videos?|comments?|servings?|garnish|difficulty|categor|warnings?|cautions?|hints?|storage|nutrition|allergen|further reading)/i;

/// Headings can carry refs and templates: "Ingredients<ref>{{cite web…".
function headingText(line) {
  return cleanLine(line.replace(/^=+\s*/, "").replace(/\s*=+\s*$/, ""));
}

/// Walk a page once and hand back the bullets, classified.
function walk(wikitext) {
  const ingredientLines = [];
  const equipmentLines = [];
  const stepLines = [];
  let section = "lead"; // mode set by the last level-2 heading
  let mode = "lead"; // effective mode, including level-3+ inheritance

  for (const raw of wikitext.split(/\r?\n/)) {
    const line = raw.trim();

    if (SECTION.test(line)) {
      const level = line.match(/^=+/)[0].length;
      const h = headingText(line);

      if (level <= 2) {
        if (STEPS_HEADING.test(h)) section = "steps";
        else if (EQUIPMENT_HEADING.test(h)) section = "equipment";
        else if (SKIP_HEADING.test(h)) section = "skip";
        // Once the method starts, later plain headings are still the method
        // ("Assembly", "Serving"): a recipe never returns to raw ingredients.
        else section = section === "steps" ? "steps" : "ingredients";
        mode = section;
      } else {
        // Sub-heading: inherit, unless it is clearly a hardware list.
        if (section === "steps") mode = "steps";
        else if (EQUIPMENT_HEADING.test(h)) mode = "equipment";
        else mode = section;
      }
      continue;
    }

    if (mode === "steps") {
      if (/^#+/.test(line)) stepLines.push(line);
      continue;
    }
    if (mode === "skip") continue;

    if (/^\*+/.test(line)) {
      if (mode === "equipment") {
        equipmentLines.push(line);
      } else if (mode === "ingredients" || /\[\[Cookbook:/i.test(line)) {
        // In the lead (before any heading) only trust bullets that link to a
        // Cookbook page - bare bullets up there are usually notes.
        ingredientLines.push(line);
      }
    }
  }

  return { ingredientLines, equipmentLines, stepLines };
}

function parsePage(title, wikitext) {
  const { ingredientLines, equipmentLines, stepLines } = walk(wikitext);
  if (!ingredientLines.length || !stepLines.length) return null;

  const servings = (() => {
    const m = wikitext.match(/\|\s*Servings\s*=\s*([^\n|}]+)/i);
    const n = m && parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 && n <= 12 ? n : 2;
  })();

  return {
    page: title,
    url: `https://en.wikibooks.org/wiki/${encodeURI(title.replace(/ /g, "_"))}`,
    servings,
    ingredients: ingredientLines.map(parseIngredientLine).filter(Boolean),
    equipment: equipmentLines.map(parseIngredientLine).filter(Boolean),
    steps: stepLines.map((l) => cleanLine(l.replace(/^#+\s*/, ""))).filter(Boolean),
  };
}

function parseAll() {
  const pages = JSON.parse(readFileSync(join(CACHE, "wikitext.json"), "utf8"));
  const recipes = [];
  const skipped = [];
  for (const [title, text] of Object.entries(pages)) {
    const r = parsePage(title, text);
    if (r && r.ingredients.length >= 2 && r.steps.length >= 1) recipes.push(r);
    else skipped.push(title);
  }
  return { recipes, skipped };
}

// --- report ----------------------------------------------------------------

function report(recipes) {
  console.log(`\nparsed ${recipes.length} recipes`);
  const linkCount = new Map();
  const textCount = new Map();
  let noLink = 0;
  let lines = 0;

  for (const r of recipes) {
    for (const ing of r.ingredients) {
      lines++;
      if (ing.links.length) {
        const key = ing.links[0];
        linkCount.set(key, (linkCount.get(key) ?? 0) + 1);
      } else {
        noLink++;
        const key = ing.text.toLowerCase().replace(/[(),].*$/, "").trim();
        textCount.set(key, (textCount.get(key) ?? 0) + 1);
      }
    }
  }

  console.log(`ingredient lines: ${lines} (${noLink} without a link, ${((noLink / lines) * 100).toFixed(1)}%)`);
  const top = [...linkCount.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`distinct linked ingredients: ${top.length}`);
  console.log("\ntop 60 linked ingredient pages:");
  for (const [name, n] of top.slice(0, 60)) console.log(`  ${String(n).padStart(4)}  ${name}`);
  const cov = [50, 100, 150, 200, 300].map((n) => {
    const sum = top.slice(0, n).reduce((a, [, c]) => a + c, 0);
    return `${n} names = ${((sum / lines) * 100).toFixed(0)}% of lines`;
  });
  console.log("\ncoverage: " + cov.join(" | "));

  console.log("\ntop 30 unlinked ingredient text:");
  for (const [name, n] of [...textCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }

  writeFileSync(join(CACHE, "parsed.json"), JSON.stringify(recipes, null, 2));
  console.log(`\nwrote ${join(CACHE, "parsed.json")}`);
}

// --- build -----------------------------------------------------------------

const SEED_PATH = join(HERE, "..", "src-tauri", "data", "seed.json");

/// Lowercase, strip accents and decoration. "Jalapeño" -> "jalapeno",
/// "salt, to taste" -> "salt", "flour#wheat flour" -> "flour".
function normalizeName(raw) {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/#.*$/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\bto taste\b/g, "")
    .replace(/-/g, " ") // "finely-chopped" -> "finely chopped"
    .replace(/[^a-z0-9 ' /]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that describe a state of an ingredient rather than a different
// ingredient: "white raisins" is raisins, "whole cloves" is cloves.
const ADJECTIVES = new Set([
  "white", "red", "green", "black", "fresh", "dried", "dry", "ground", "whole",
  "large", "small", "medium", "fine", "finely", "chopped", "sliced", "minced",
  "grated", "crushed", "raw", "cooked", "frozen", "canned", "tinned", "ripe",
  "boneless", "skinless", "thin", "thick", "hot", "sweet", "light", "dark",
  "plain", "natural", "unsalted", "salted", "extra", "virgin", "toasted", "young",
  "beaten", "boiled", "fried", "grilled", "roasted", "steamed", "mixed",
  "crystallised", "crystallized", "shredded", "quartered", "pounded", "smashed",
  "pressed", "shelled", "skinned", "sifted", "soaked", "drained", "rinsed",
  "halved", "seeded", "deseeded", "trimmed", "thawed", "softened", "melted",
  "cubed", "thinly", "thickly", "julienned", "peeled",
]);

/// Resolve one raw ingredient name to a catalog name, or null to drop it.
function makeResolver(catalog, aliases) {
  const direct = (key) => {
    if (!key) return null;
    if (catalog.has(key)) return key;
    if (aliases.has(key)) return aliases.get(key);
    return null;
  };

  // Direct, then plural <-> singular: "bean sprout" -> "bean sprouts",
  // "onions" -> "onion".
  const lookup = (key) => {
    const hit = direct(key);
    if (hit) return hit;
    if (!key.endsWith("s")) {
      const plural = direct(key + "s");
      if (plural) return plural;
    } else if (!/(ss|us|is|ous)$/.test(key)) {
      const singular = direct(key.slice(0, -1));
      if (singular) return singular;
    }
    return null;
  };

  return (raw) => {
    const key = normalizeName(raw);
    if (!key) return null;

    const first = lookup(key);
    if (first) return first;

    // "sushi/sushi rice", "salt/pepper" -> try each side of the slash
    if (key.includes("/")) {
      for (const part of key.split("/").map((s) => s.trim()).filter(Boolean)) {
        const hit = lookup(part);
        if (hit) return hit;
      }
    }

    // "white raisins" -> "raisins", "finely sliced white onion" -> "onion".
    // Four trims, because recipe lines stack them up.
    let words = key.split(" ");
    for (let i = 0; i < 4 && words.length > 1 && ADJECTIVES.has(words[0]); i++) {
      words = words.slice(1);
      const hit = lookup(words.join(" "));
      if (hit) return hit;
    }

    return null;
  };
}

function slug(title) {
  return title.replace(/^Cookbook:/, "");
}

async function build() {
  const { CATALOG_ADDITIONS, ALIASES } = await import("./ingredient-map.mjs");

  // 1. the catalog: the hand-written 65 first, then the additions
  const current = JSON.parse(readFileSync(join(CACHE, "current-seed.json"), "utf8"));
  const catalog = new Map(); // name -> { category, aliases: [] }
  for (const i of current.ingredients) {
    catalog.set(i.name, { category: i.category, aliases: [] });
  }
  for (const [name, category, aliases] of CATALOG_ADDITIONS) {
    if (!catalog.has(name)) catalog.set(name, { category, aliases: [] });
    catalog.get(name).aliases.push(...aliases);
  }

  // 2. the alias table: name -> canonical, from the additions and ALIASES
  const aliases = new Map();
  const conflicts = [];
  const addAlias = (alias, canonical) => {
    // Same normalization the resolver applies, so "Jalapeño" in the map still
    // matches "jalapeno" coming out of a recipe.
    const key = normalizeName(alias);
    if (!key || key === canonical) return;
    if (!catalog.has(canonical)) {
      conflicts.push(`${key} -> ${canonical} (no such ingredient)`);
      return;
    }
    if (aliases.has(key) && aliases.get(key) !== canonical) {
      conflicts.push(`${key} -> ${aliases.get(key)} vs ${canonical}`);
      return;
    }
    aliases.set(key, canonical);
  };
  for (const [name, , list] of CATALOG_ADDITIONS) for (const a of list) addAlias(a, name);
  for (const [alias, canonical] of Object.entries(ALIASES)) addAlias(alias, canonical);

  const resolve = makeResolver(catalog, aliases);

  // 3. the recipes: hand-written ones first, then Wikibooks
  const out = {
    ingredients: [...catalog.entries()]
      .map(([name, v]) => ({ name, category: v.category }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // The full alias table: "green onion" -> "scallion". The app seeds this
    // into `ingredient_alias` so a recipe that says "green onion" still
    // matches a pantry chip that says "scallion".
    aliases: [...aliases.entries()]
      .map(([alias, name]) => ({ alias, name }))
      .sort((a, b) => a.alias.localeCompare(b.alias)),
    recipes: [],
  };
  const seen = new Set();
  for (const r of current.recipes) {
    seen.add(r.name.toLowerCase());
    out.recipes.push({
      name: r.name,
      servings: r.servings,
      steps: r.steps,
      source_url: null,
      attribution: null,
      ingredients: r.ingredients.map((l) => ({
        name: l.name,
        amount: l.amount,
        unit: l.unit ?? "",
      })),
    });
  }

  const { recipes: imported } = parseAll();
  const dropped = new Map(); // raw name -> times dropped
  const stats = { kept: 0, dropped: 0, recipes: 0 };

  for (const r of imported) {
    const name = slug(r.page);
    if (seen.has(name.toLowerCase())) continue;

    // One ingredient per canonical name; same thing twice = keep the first
    // amount rather than double-count it.
    const lines = new Map();
    const add = (ing) => {
      let canonical = null;
      for (const candidate of candidateNames(ing)) {
        canonical = resolve(candidate);
        if (canonical) break;
      }
      if (!canonical) {
        stats.dropped++;
        const key = candidateNames(ing)[0] ?? ing.raw;
        dropped.set(key, (dropped.get(key) ?? 0) + 1);
        return false;
      }
      stats.kept++;
      if (!lines.has(canonical)) {
        lines.set(canonical, { name: canonical, amount: ing.amount, unit: ing.unit });
      }
      return true;
    };

    for (const ing of r.ingredients) add(ing);
    // A hardware list can still name real food ("Banana leaves" to line a
    // kuih tin). Keep those, and only those - "steamer" never resolves.
    for (const ing of r.equipment) add(ing);

    // A recipe stripped down to one ingredient isn't worth showing.
    if (lines.size < 2) continue;

    out.recipes.push({
      name,
      servings: r.servings,
      steps: r.steps.join(" "),
      source_url: r.url,
      attribution: "Wikibooks Cookbook, CC BY-SA 4.0",
      ingredients: [...lines.values()],
    });
    stats.recipes++;
    seen.add(name.toLowerCase());
  }

  out.recipes.sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(dirname(SEED_PATH), { recursive: true });
  writeFileSync(SEED_PATH, JSON.stringify(out, null, 2) + "\n");

  console.log(`catalog: ${out.ingredients.length} ingredients, ${aliases.size} aliases`);
  console.log(`recipes: ${out.recipes.length} (${current.recipes.length} hand-written, ${stats.recipes} imported)`);
  console.log(`ingredient lines: ${stats.kept} kept, ${stats.dropped} dropped`);
  if (conflicts.length) {
    console.log(`\nalias conflicts (${conflicts.length}):`);
    for (const c of conflicts.slice(0, 15)) console.log("  " + c);
  }
  const worst = [...dropped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log("\nmost-dropped ingredient names:");
  for (const [name, n] of worst) console.log(`  ${String(n).padStart(3)}  ${name}`);
  // Set DUMP_DROPPED=<path> to get the whole list for curation.
  if (process.env.DUMP_DROPPED) {
    const all = [...dropped.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    writeFileSync(process.env.DUMP_DROPPED, JSON.stringify(all, null, 2) + "\n");
    console.log(`dumped all ${all.length} dropped names to ${process.env.DUMP_DROPPED}`);
  }
  console.log(`\nwrote ${SEED_PATH}`);
}

const cmd = process.argv[2] ?? "parse";
if (cmd === "fetch") {
  await fetchAll();
} else if (cmd === "parse") {
  const { recipes, skipped } = parseAll();
  report(recipes);
  if (skipped.length) console.log(`\nskipped ${skipped.length}: ${skipped.slice(0, 8).join(", ")}...`);
} else if (cmd === "build") {
  await build();
} else if (cmd === "debug") {
  // Show why one page did or didn't parse: node tools/import-wikibooks.mjs debug "Cookbook:X"
  const pages = JSON.parse(readFileSync(join(CACHE, "wikitext.json"), "utf8"));
  const title = process.argv[3] ?? "";
  const text = pages[title] ?? Object.entries(pages).find(([t]) => t.includes(title))?.[1];
  if (!text) {
    console.log(`no cached page matching "${title}"`);
  } else {
    const r = parsePage(title, text);
    if (!r) {
      const { ingredientLines, stepLines } = walk(text);
      console.log(`  ingredient bullets: ${ingredientLines.length}, step bullets: ${stepLines.length}`);
      console.log("  null result: needs >=1 ingredient bullet and >=1 step bullet");
    } else {
      console.log(JSON.stringify(r, null, 2));
    }
  }
} else {
  console.log("usage: node tools/import-wikibooks.mjs fetch|parse|build|debug <title>");
}
