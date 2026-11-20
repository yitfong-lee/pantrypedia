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

/// Wikitext writes fractions and accents as HTML entities: "&frac14; tsp",
/// "&frac12; cup", "cr&egrave;me". Decode the handful that turn up in
/// ingredient lists, plus any numeric entity.
const ENTITIES = {
  frac12: "½", frac14: "¼", frac34: "¾", frac13: "⅓", frac23: "⅔", frac18: "⅛",
  deg: "°", nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö",
  auml: "ä", ntilde: "ñ", ocirc: "ô", icirc: "î", ecirc: "ê", acirc: "â",
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function cleanLine(s) {
  return decodeEntities(unlink(stripRefs(s)))
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

/// "1 1/2 cups" -> 1.5, "3-4" -> 3, "1–2" -> 1, "½" -> 0.5, "2 ½" -> 2.5,
/// "200" -> 200
function parseAmount(text) {
  const t = text.trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  // "2 ½ tsp salt": a whole number followed by a fraction glyph
  const whole = t.match(/^(\d+)\s*([½⅓⅔¼¾⅛])/);
  if (whole) return Number(whole[1]) + FRACTION[whole[2]];
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
  [/\b(decilit(?:re|er)s?|dl)\b/i, "dl"],
  [/\b(centilit(?:re|er)s?|cl)\b/i, "cl"],
  [/\b(lit(?:re|er)s?|l)\b/i, "l"],
  [/\b(cups?)\b/i, "cup"],
  [/\b(pints?|pts?)\b/i, "pint"],
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
  [/\b(packets?)\b/i, "packet"],
  [/\b(pods?)\b/i, "pod"],
  [/\b(cubes?)\b/i, "cube"],
  [/\b(inch(?:es)?)\b/i, "in"],
  [/\b(drops?)\b/i, "drop"],
  [/\b(grinds?)\b/i, "grind"],
  [/\b(quarts?)\b/i, "quart"],
  [/\b(gallons?)\b/i, "gallon"],
];

/// The unit word on an ingredient line: "3 large handfuls" ->
/// { unit: "handful", word: "handfuls" }.
///
/// Scans the leading words left to right, so the *first* unit wins: "2 cups
/// (480 ml)" is cups, not the ml in the conversion note. Only whole words
/// count, so a name like "ground almonds" never turns into "g".
function parseUnit(text) {
  // Only the words before a bracket or a comma can be the unit: "10 elackai
  // (cardamom pods)" must not read "pods" as the unit.
  const head = text.split(/[(\[]/)[0].split(",")[0];
  const words = head.split(/\s+/).filter(Boolean).slice(0, 3);
  for (const word of words) {
    const bare = word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
    if (!bare) continue;
    for (const [re, unit] of UNIT_ALIASES) {
      if (re.test(bare)) return { unit, word: bare };
    }
  }
  return null;
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
    unit = parseUnit(inner)?.unit ?? "";
    rest = rest.slice(paren[0].length);
  }

  // "ea. Chinese sweet sausages", "each orange": a count word, not a name.
  rest = rest.replace(/^(?:ea\.?|each)\s+/i, "");

  // "about 500 g", "a little over ½ cup": hedge words before the number.
  rest = rest.replace(
    /^(?:about|approx\.?|approximately|around|a little over|a little under|just over|just under|a good|a scant|scant)\s+/i,
    "",
  );

  if (amount === null) amount = parseAmount(rest);
  if (amount !== null) {
    rest = rest
      .replace(
        /^\s*(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*[½⅓⅔¼¾⅛]|\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*[–-]?\s*\d*|[½⅓⅔¼¾⅛](?:\s*[–-]\s*(?:\d+(?:\.\d+)?|[½⅓⅔¼¾⅛]))?)/,
        "",
      )
      // "4 ea. (400 g) medium onions": the count word follows the number.
      .replace(/^\s*(?:ea\.?|each)\b[\s.]*/i, "")
      .trim();
  }
  // A parenthetical right after the amount is usually a metric/imperial
  // conversion: "200 g (7 oz) beef".
  rest = rest.replace(/^\([^)]*\)\s*/, "").trim();

  // The unit word can sit behind an adjective ("3 large handfuls"), so take
  // out the word that actually matched rather than the first word of the line.
  const stripUnit = (found) => {
    if (!found) return;
    const words = rest.split(/\s+/);
    const at = words.findIndex(
      (w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase() === found.word.toLowerCase(),
    );
    if (at < 0) return;
    const left = words.filter((_, i) => i !== at);
    const named = left.some((w) => {
      const bare = w.replace(/[^a-z0-9]/gi, "").toLowerCase();
      return bare && !ADJECTIVES.has(bare) && !/^\d+$/.test(bare);
    });
    // "* 4 [[Cookbook:Clove|cloves]]" and "8 whole cloves" are the spice, not a
    // bare unit: if only adjectives would be left, the unit word *was* the name.
    if (!named) return;
    const after = left
      .join(" ")
      .replace(/\s+of\s+/i, " ") // "small of coriander leaves"
      .replace(/^of\s+/i, "")
      .trim();
    if (after) rest = after;
  };

  if (amount === null) {
    // A unit word with no number in front of it: "* tbsp red curry paste",
    // "packets Marie Biscuits". Left in place it swallows the name, and the
    // line resolves to nothing.
    const lead = parseUnit(rest);
    if (lead && rest.trim().split(/\s+/).length > 1) {
      unit = lead.unit;
      stripUnit(lead);
    }
  }

  if (!unit) {
    const found = parseUnit(rest);
    if (found) {
      unit = found.unit;
      stripUnit(found);
    }
  }

  const targets = linkTargets(raw).filter((t) => !NOT_INGREDIENT.has(t));
  return { amount, unit, text: rest, links: targets, raw: line };
}

/// The visible ingredient name on a line, with the amount, unit, bracketed
/// notes, trailing instruction and filler words taken off.
function cleanedName(ing) {
  return ing.text
    .replace(/\([^)]*\)/g, " ") // (see notes), (optional)
    .split(/\s*,\s*|\s+[–—]\s+/)[0] // ", sifted", " – made from kelp"
    .replace(
      /\s+(?:for|to)\s+(?:deep[- ]?fry(?:ing)?|shallow[- ]?fry(?:ing)?|fry(?:ing)?|garnish(?:ing)?|serv(?:e|ing)|dusting|greasing|coating|stuffing)\b.*$/i,
      "",
    )
    .replace(/^(?:the\s+)?green parts? of\s+/i, "") // "green part of scallions"
    .replace(/\b(?:ea\.?|each)\b/gi, " ")
    .replace(/^of\s+/i, "") // "1.5 dl of chicken broth"
    .replace(/^the\s+/i, "") // "the black pepper"
    .replace(
      // repeated, so "plus some more…" loses both words
      /^(?:(?:or so|a few|a couple of|cake of|spoonful of|spoonful|plus|and|a|some|more|several)\s+(?:drops?\s+(?:of\s+)?)?)+/i,
      "",
    )
    .replace(/^of\s+/i, "") // "½ of a medium sized onion"
    .replace(/\s+/g, " ")
    .trim();
}

/// The names to try for one parsed line, most trustworthy first.
///
/// The line's own text comes first: qualifiers often sit *outside* the link
/// ("250 g sticky/glutinous [[Cookbook:Rice Flour|rice flour]]"), and using
/// only the link threw "glutinous" away, turning it into plain rice flour.
/// The links are the fallback, and the last link is the one the page treats as
/// the ingredient ("1 cup milk or [[Cookbook:Coconut Milk|coconut milk]]").
function candidateNames(ing) {
  const cleaned = cleanedName(ing);

  // "Banana leaves or aluminium foil to wrap", "black vinegar and shredded
  // ginger": the first half is the ingredient, the rest is an alternative or
  // a second item. Try the whole phrase first, then each half.
  const halves = cleaned.split(/\s+(?:or|and)\s+/i);

  return [cleaned, ...halves, ...ing.links.slice().reverse()].filter(Boolean);
}

/// A bare ingredient name with no instruction attached: "Banana leaves".
/// Used to decide whether a line in an equipment list is really food.
function isPlainName(ing) {
  const t = ing.text
    .replace(/\([^)]*\)/g, " ") // "(optional)", "(fresh or thawed)"
    .replace(/[.,;:]+$/, "")
    .trim();
  if (!t) return false;
  if (/[,;:]/.test(t)) return false; // a list of things
  if (/\b(?:or|and|for|to|with|at least|about)\b/i.test(t)) return false;
  return t.split(/\s+/).length <= 3;
}

/// Is this word a unit rather than part of a name? "tsp", "handfuls".
function isUnitWord(word) {
  const bare = word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
  if (!bare) return false;
  return UNIT_ALIASES.some(([re]) => re.test(bare));
}

/// The wording shown in the app: the recipe's own phrase when it says more
/// than the catalog name. "dried soybeans" is displayed as written even though
/// it matches the "soybeans" chip. An empty result means use the catalog name.
function displayLabel(ing, matched, canonical) {
  const text = cleanedName(ing);
  // "Banana leaves or aluminium foil to wrap" names two things; the half that
  // resolved is the ingredient. Otherwise the page's own words win, even when
  // a wiki link is what made the match.
  const source = /\s+(?:or|and)\s+/i.test(text) ? matched : text || matched;
  const label = (source ?? "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim()
    .toLowerCase();
  if (!label || label === canonical || label.length > 60) return "";
  // What is left is sometimes only the measurement ("tsp salt", "handfuls
  // dried") because the noun was a comma-separated note. Showing that is worse
  // than showing the catalog name, so drop it.
  const words = label.split(" ");
  if (/^\d/.test(label)) return "";
  if (words.some(isUnitWord)) return "";
  if (words.every((w) => ADJECTIVES.has(w))) return "";
  return label;
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
  "cubed", "thinly", "thickly", "julienned", "peeled", "freshly", "heaping",
  "heaped", "level", "rounded", "scant", "generous", "loosely", "firmly", "packed",
  // temperature and cuisine words: "warm milk" is milk, "Japanese rice" is rice
  "warm", "cold", "lukewarm", "iced", "chilled", "boiling", "room temperature",
  "japanese", "chinese", "thai", "indian", "korean", "vietnamese", "italian",
  "mexican", "french", "greek", "spanish", "turkish", "malaysian", "indonesian",
  "filipino", "burmese", "himalayan", "kosher", "sea", "metric",
  // colour and state words that only describe the ingredient after them
  "orange", "yellow", "purple", "pink", "brown", "golden", "smooth",
  "uncooked", "instant", "granulated", "powdered", "cracked", "split", "sized",
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
  // "onions" -> "onion", "potatoes" -> "potato", "berries" -> "berry".
  const lookup = (key) => {
    const hit = direct(key);
    if (hit) return hit;
    if (!key.endsWith("s")) {
      const plural = direct(key + "s");
      if (plural) return plural;
    } else {
      if (!/(ss|us|is|ous)$/.test(key)) {
        const singular = direct(key.slice(0, -1));
        if (singular) return singular;
      }
      if (/oes$/.test(key)) {
        const o = direct(key.slice(0, -2));
        if (o) return o;
      }
      if (/ies$/.test(key)) {
        const y = direct(key.slice(0, -3) + "y");
        if (y) return y;
      }
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
    // Four trims, because recipe lines stack them up. "yellow/orange" counts
    // as one adjective when both halves are colours.
    const isAdj = (w) =>
      ADJECTIVES.has(w) || (w.includes("/") && w.split("/").every((p) => ADJECTIVES.has(p)));
    let words = key.split(" ");
    for (let i = 0; i < 4 && words.length > 1 && isAdj(words[0]); i++) {
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

async function loadCatalog() {
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

  return { current, catalog, aliases, conflicts, resolve: makeResolver(catalog, aliases) };
}

async function build() {
  const { current, catalog, aliases, conflicts, resolve } = await loadCatalog();

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
        label: "",
        amount: l.amount,
        unit: l.unit ?? "",
      })),
    });
  }

  const { recipes: imported } = parseAll();
  const dropped = new Map(); // raw name -> times dropped
  const collapsedPairs = new Map(); // "canonical <- source wording" -> times
  const stats = { kept: 0, dropped: 0, collapsed: 0, recipes: 0 };

  for (const r of imported) {
    const name = slug(r.page);
    if (seen.has(name.toLowerCase())) continue;

    // One ingredient per canonical name; same thing twice = keep the first
    // amount rather than double-count it.
    const lines = new Map();
    const add = (ing) => {
      let canonical = null;
      let matched = "";
      for (const candidate of candidateNames(ing)) {
        canonical = resolve(candidate);
        if (canonical) {
          matched = candidate;
          break;
        }
      }
      if (!canonical) {
        stats.dropped++;
        const key = candidateNames(ing)[0] ?? ing.raw;
        dropped.set(key, (dropped.get(key) ?? 0) + 1);
        return false;
      }
      stats.kept++;
      if (lines.has(canonical)) {
        stats.collapsed++;
        const key = `${canonical} <- ${displayLabel(ing, matched, canonical) || matched}`;
        collapsedPairs.set(key, (collapsedPairs.get(key) ?? 0) + 1);
        return true;
      }
      lines.set(canonical, {
        name: canonical,
        label: displayLabel(ing, matched, canonical),
        amount: ing.amount,
        unit: ing.unit,
      });
      return true;
    };

    for (const ing of r.ingredients) add(ing);
    // A hardware list can still name real food - Kuih Bakul lines its tins
    // with banana leaves, and that belongs in the ingredients. But "Banana
    // leaves, zip-lock bags or shallow dishes for incubating" is a choice of
    // containers, not an ingredient, so only a bare name counts.
    for (const ing of r.equipment) if (isPlainName(ing)) add(ing);

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
  console.log(`collapsed: ${stats.collapsed} lines (two names that map to one ingredient)`);
  if (collapsedPairs.size) {
    console.log("  most common collapses:");
    for (const [pair, n] of [...collapsedPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${String(n).padStart(3)}  ${pair}`);
    }
  }
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

// --- audit -----------------------------------------------------------------

/// Compare the shipped seed against the source pages, recipe by recipe.
///
/// The build can only ever emit what the parser saw, so a plain re-parse would
/// always agree with itself. This checks the things a re-parse cannot:
///   phantom  - a stored line no source bullet supports
///   missing  - a source bullet that names real food but produced no row
///   equipment- a stored line that came only from the hardware list
/// and writes a side-by-side file for eyeballing the rest.
async function audit() {
  const { resolve } = await loadCatalog();
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  const byUrl = new Map(seed.recipes.filter((r) => r.source_url).map((r) => [r.source_url, r]));
  const { recipes } = parseAll();

  const rows = [];
  const flags = [];
  const summary = { recipes: 0, phantom: 0, missing: 0, equipment: 0, wording: 0, clean: 0 };

  const stem = (w) => w.replace(/(?:es|s)$/i, "");

  for (const r of recipes) {
    const stored = byUrl.get(r.url);
    if (!stored) continue; // lost to a name collision with an earlier page
    summary.recipes++;

    const bullets = [...r.ingredients, ...r.equipment];
    const before = flags.length;

    // Everything the source page can produce, by the same rules the build uses.
    const producible = new Set();
    const resolvedBullets = [];
    for (const b of bullets) {
      let canonical = null;
      for (const c of candidateNames(b)) {
        canonical = resolve(c);
        if (canonical) break;
      }
      resolvedBullets.push({ bullet: b, canonical });
      if (canonical) producible.add(canonical);
    }

    for (const row of stored.ingredients) {
      // 1. no bullet on the page can produce this ingredient at all
      if (!producible.has(row.name)) {
        summary.phantom++;
        flags.push({ kind: "phantom", recipe: stored.name, name: row.name, label: row.label });
        continue;
      }

      const support = resolvedBullets.filter((x) => x.canonical === row.name);

      // 2. only the hardware list mentions it
      if (support.every((x) => r.equipment.includes(x.bullet))) {
        summary.equipment++;
        flags.push({
          kind: "equipment",
          recipe: stored.name,
          name: row.name,
          label: row.label,
          bullet: support[0].bullet.raw,
        });
        continue;
      }

      // 3. the wording shown is not on the page (typo, wrong link, leftover).
      // Only meaningful when a label exists: an empty label means we are
      // showing the catalog name, which the page is not expected to contain.
      if (!row.label) continue;
      const shown = row.label.toLowerCase();
      const words = shown.split(/\s+/).filter((w) => w.length > 2).map(stem);
      const onPage = support.some((x) => {
        const hay = new Set(x.bullet.raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));
        return words.every((w) => hay.has(w) || [...hay].some((h) => h.startsWith(w) || w.startsWith(h)));
      });
      if (!onPage) {
        summary.wording++;
        flags.push({
          kind: "wording",
          recipe: stored.name,
          name: row.name,
          label: row.label,
          bullet: support[0].bullet.raw,
        });
      }
    }

    // 4. a source line naming real food that produced no row
    for (const { bullet, canonical } of resolvedBullets) {
      if (!canonical) continue;
      if (stored.ingredients.some((i) => i.name === canonical)) continue;
      // An alternative container in the hardware list ("banana leaves,
      // zip-lock bags or shallow dishes") is deliberately not an ingredient.
      if (r.equipment.includes(bullet) && !isPlainName(bullet)) continue;
      summary.missing++;
      flags.push({ kind: "missing", recipe: stored.name, name: canonical, bullet: bullet.raw });
    }

    rows.push({
      recipe: stored.name,
      url: stored.source_url,
      source: bullets.map((b) => b.raw),
      stored: stored.ingredients.map(
        (i) => `${i.label || i.name}${i.amount ? ` (${i.amount}${i.unit ? " " + i.unit : ""})` : ""}`,
      ),
      flags: flags.length - before,
    });
    if (flags.length === before) summary.clean++;
  }

  const out = join(CACHE, "audit.json");
  writeFileSync(out, JSON.stringify({ summary, flags, rows }, null, 2) + "\n");

  console.log(`audited ${summary.recipes} imported recipes`);
  console.log(`  clean:     ${summary.clean}`);
  console.log(`  phantom:   ${summary.phantom} stored lines no source bullet can produce`);
  console.log(`  missing:   ${summary.missing} source lines that produced no row`);
  console.log(`  equipment: ${summary.equipment} rows backed only by the hardware list`);
  console.log(`  wording:   ${summary.wording} rows whose wording is not on the page`);
  console.log(`\nwrote ${out}`);

  for (const kind of ["phantom", "missing", "equipment", "wording"]) {
    const list = flags.filter((f) => f.kind === kind);
    if (!list.length) continue;
    console.log(`\n--- ${kind} (${list.length}) ---`);
    for (const f of list.slice(0, 30)) {
      console.log(
        `  ${f.recipe}: ${f.name}${f.label ? ` ["${f.label}"]` : ""}${f.bullet ? ` <- ${f.bullet}` : ""}`,
      );
    }
    if (list.length > 30) console.log(`  ... and ${list.length - 30} more in the file`);
  }
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
} else if (cmd === "audit") {
  await audit();
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
  console.log("usage: node tools/import-wikibooks.mjs fetch|parse|build|audit|debug <title>");
}
