// The bridge between free-text recipe ingredients and the pantry catalog.
//
// Wikibooks links each ingredient to a page, so "2 cloves of garlic" arrives as
// the page name "garlic" - but "green onion", "spring onion" and "scallion" are
// three pages for the same thing you'd buy. This file says which of them are
// the same ingredient, and adds the ones the original 65-item catalog lacked.
//
// Used by tools/import-wikibooks.mjs. Nothing here ships to the app directly:
// the app only sees the generated src-tauri/data/seed.json.

/// Ingredients the 65-item starter catalog didn't have.
/// [name, category, aliases]
export const CATALOG_ADDITIONS = [
  // --- Produce ---
  ["cilantro", "Produce", ["coriander", "coriander leaves", "fresh coriander"]],
  ["shallot", "Produce", ["shallots"]],
  ["lemongrass", "Produce", ["lemon grass"]],
  ["galangal", "Produce", []],
  ["eggplant", "Produce", ["aubergine", "brinjal"]],
  ["cabbage", "Produce", []],
  ["basil", "Produce", ["thai basil", "sweet basil", "holy basil"]],
  ["mint", "Produce", ["mint leaves"]],
  ["mango", "Produce", []],
  ["pineapple", "Produce", []],
  ["celery", "Produce", []],
  ["bamboo shoots", "Produce", ["bamboo shoot"]],
  ["daikon", "Produce", ["daikon radish", "white radish"]],
  ["fennel", "Produce", []],
  ["cauliflower", "Produce", []],
  ["broccoli", "Produce", []],
  ["corn", "Produce", ["sweetcorn", "corn kernels"]],
  ["dates", "Produce", ["date"]],
  ["kaffir lime leaves", "Produce", ["kaffir lime leaf", "makrut lime leaves"]],
  ["pandan", "Produce", ["pandan leaves", "pandan essence"]],
  ["curry leaves", "Produce", ["curry leaf"]],
  ["green beans", "Produce", ["green bean", "french beans", "string beans"]],
  ["peas", "Produce", ["pea", "garden peas"]],
  ["coconut", "Produce", ["fresh coconut", "grated coconut", "desiccated coconut"]],
  ["leek", "Produce", ["leeks"]],
  ["jackfruit", "Produce", []],

  // --- Dairy & Eggs ---
  ["cream", "Dairy & Eggs", ["heavy cream", "double cream", "whipping cream"]],
  ["ghee", "Dairy & Eggs", ["clarified butter"]],
  ["paneer", "Dairy & Eggs", []],
  ["buttermilk", "Dairy & Eggs", []],
  ["condensed milk", "Dairy & Eggs", ["sweetened condensed milk"]],

  // --- Meat & Protein ---
  ["beef", "Meat & Protein", ["beef steak", "beef strips", "stewing beef"]],
  ["pork", "Meat & Protein", ["pork belly", "pork loin", "pork mince"]],
  ["lamb", "Meat & Protein", ["mutton", "lamb chops"]],
  ["salmon", "Meat & Protein", []],
  ["fish", "Meat & Protein", ["white fish", "fish fillet", "fish fillets"]],
  ["ham", "Meat & Protein", []],
  ["sausage", "Meat & Protein", ["sausages"]],
  ["tempeh", "Meat & Protein", []],
  ["chickpeas", "Meat & Protein", ["chickpea", "garbanzo beans"]],
  ["lentils", "Meat & Protein", ["dal", "dhal", "lentil", "red lentils", "split peas"]],
  ["mung beans", "Meat & Protein", ["mung bean", "green gram"]],
  ["sardines", "Meat & Protein", ["sardine"]],
  ["anchovies", "Meat & Protein", ["anchovy", "dried anchovies"]],
  ["seitan", "Meat & Protein", []],

  // --- Pantry ---
  ["rice flour", "Pantry", []],
  ["chickpea flour", "Pantry", ["besan", "gram flour"]],
  ["cornstarch", "Pantry", ["corn flour", "tapioca starch"]],
  ["vinegar", "Pantry", ["white vinegar", "cider vinegar"]],
  ["stock", "Pantry", ["broth", "chicken stock", "vegetable stock", "beef stock", "bouillon cube"]],
  ["tomato paste", "Pantry", []],
  ["tomato sauce", "Pantry", ["passata"]],
  ["hoisin sauce", "Pantry", []],
  ["ketchup", "Pantry", ["tomato ketchup"]],
  ["mayonnaise", "Pantry", ["mayo"]],
  ["sriracha", "Pantry", []],
  ["worcestershire sauce", "Pantry", []],
  ["shrimp paste", "Pantry", ["terasi", "belacan"]],
  ["chili paste", "Pantry", ["chilli paste", "chili bean paste", "doubanjiang"]],
  ["rice wine", "Pantry", ["wine", "sake", "shaoxing wine", "cooking wine"]],
  ["mirin", "Pantry", []],
  ["dashi", "Pantry", ["bonito flakes", "konbu", "kombu"]],
  ["nori", "Pantry", ["seaweed", "nori sheets"]],
  ["wonton wrappers", "Pantry", ["wonton wrapper", "dumpling wrappers"]],
  ["baking soda", "Pantry", ["bicarbonate of soda"]],
  ["yeast", "Pantry", []],
  ["peanut butter", "Pantry", []],
  ["cocoa powder", "Pantry", []],
  ["msg", "Pantry", ["monosodium glutamate"]],
  ["vanilla", "Pantry", ["vanilla extract", "vanilla essence"]],
  ["palm sugar", "Pantry", ["jaggery", "gula jawa", "coconut sugar"]],
  ["brown sugar", "Pantry", []],
  ["cashews", "Pantry", ["cashew", "cashew nuts"]],
  ["almonds", "Pantry", ["almond", "flaked almonds"]],
  ["pistachios", "Pantry", ["pistachio"]],
  ["coconut oil", "Pantry", []],
  ["sago", "Pantry", ["sago pearls"]],
  ["raisins", "Pantry", ["raisin", "sultanas", "white raisins"]],
  ["candlenut", "Pantry", ["candlenuts", "kemiri"]],
  ["rosewater", "Pantry", ["rose water"]],
  ["barbecue sauce", "Pantry", ["bbq sauce", "barbeque sauce"]],
  ["semolina", "Pantry", ["fine semolina", "sooji", "rava"]],
  ["ginger garlic paste", "Pantry", []],

  // --- Spices ---
  ["cardamom", "Spices", ["green cardamom", "cardamom pods", "black cardamom"]],
  ["asafoetida", "Spices", ["hing"]],
  ["fenugreek", "Spices", ["fenugreek seeds", "methi"]],
  ["bay leaf", "Spices", ["bay leaves"]],
  ["star anise", "Spices", []],
  ["nutmeg", "Spices", []],
  ["saffron", "Spices", ["saffron threads"]],
  ["five spice powder", "Spices", ["five-spice powder"]],
  ["chili powder", "Spices", ["chile powder", "chilli powder", "red chile powder"]],
  ["cayenne pepper", "Spices", ["cayenne"]],
  ["paprika", "Spices", ["smoked paprika"]],
  ["mustard seeds", "Spices", ["mustard seed", "mustard", "black mustard seeds"]],
  ["nigella", "Spices", ["nigella seeds", "kalonji"]],
  ["poppy seeds", "Spices", ["poppy seed"]],
  ["tamarind", "Spices", ["tamarind paste", "tamarind pulp", "tamarind concentrate"]],
  ["cloves", "Spices", ["clove spice", "whole cloves"]],
  ["panch puran", "Spices", ["panch phoron", "bengali five spice"]],
  ["chaat masala", "Spices", []],
  ["tandoori masala", "Spices", []],
];

/// Source text -> canonical name. Lowercased on both sides.
/// These point at ingredients the catalog already had, so nothing new appears
/// in the pantry panel - only the matching gets smarter.
export const ALIASES = {
  // chili
  chiles: "chili pepper",
  chile: "chili pepper",
  chilli: "chili pepper",
  "chilli pepper": "chili pepper",
  chili: "chili pepper",
  "red chile": "chili pepper",
  "green chili": "chili pepper",
  "red chili": "chili pepper",
  jalapeño: "chili pepper",
  jalapeno: "chili pepper",
  "bird's eye chili": "chili pepper",

  // alliums
  onions: "onion",
  "green onion": "scallion",
  "green onions": "scallion",
  "spring onion": "scallion",
  "spring onions": "scallion",
  "salad onion": "scallion",

  // sugars
  "granulated sugar": "sugar",
  "white sugar": "sugar",
  "caster sugar": "sugar",
  "powdered sugar": "sugar",
  "icing sugar": "sugar",

  // flour
  "all-purpose flour": "flour",
  "plain flour": "flour",
  "wheat flour": "flour",
  "white flour": "flour",

  // pepper
  pepper: "black pepper",
  "white pepper": "black pepper",
  "ground black pepper": "black pepper",

  // oils
  oil: "vegetable oil",
  "cooking oil": "vegetable oil",
  "peanut oil": "vegetable oil",
  "sunflower oil": "vegetable oil",
  "canola oil": "vegetable oil",

  // eggs
  egg: "eggs",
  "hard boiled eggs": "eggs",
  "egg yolk": "eggs",
  "egg yolks": "eggs",
  "boiled egg": "eggs",

  // rice
  "steamed rice": "rice",
  "basmati rice": "rice",
  "sushi rice": "rice",
  "sushi/sushi rice": "rice",
  "jasmine rice": "rice",
  "long grain rice": "rice",

  // dairy
  yoghurt: "yogurt",
  "plain yogurt": "yogurt",
  ghee: "ghee",
  "clarified butter": "ghee",

  // protein
  chicken: "chicken breast",
  "chicken#breast": "chicken breast",
  "chicken breasts": "chicken breast",
  prawn: "shrimp",
  prawns: "shrimp",
  tuna: "canned tuna",
  peanuts: "peanuts",
  peanut: "peanuts",

  // sauces and pastes
  "light soy sauce": "soy sauce",
  "dark soy sauce": "soy sauce",
  "miso soup": "miso paste",
  "thai curry paste": "curry paste",
  "red curry paste": "curry paste",
  "green curry paste": "curry paste",
  "kaeng chu chee curry paste": "curry paste",

  // noodles
  noodle: "egg noodles",
  noodles: "egg noodles",
  vermicelli: "rice noodles",

  // sauces and stocks
  miso: "miso paste",
  sherry: "rice wine",
  "cooking sherry": "rice wine",
  "dehydrated broth": "stock",
  "bouillon powder": "stock",
  "chicken bouillon powder": "stock",
  "chicken stock powder": "stock",
  "stock cube": "stock",
  "stock cubes": "stock",
  "rice wine vinegar": "rice vinegar",
  "wine vinegar": "vinegar",
  "potato starch": "cornstarch",
  "potato flour": "cornstarch",

  // eggs
  "egg white": "eggs",
  "egg whites": "eggs",

  // fruit
  "lemon juice": "lemon",
  "lime juice": "lime",

  // seeds / flakes
  "sesame seed": "sesame seeds",
  "red pepper flakes": "chili flakes",
  "chile flakes": "chili flakes",

  // herbs
  coriander: "cilantro",

  // odds and ends that show up often in Asian recipes
  capsicum: "bell pepper",
  "red capsicum": "bell pepper",
  peppercorn: "black pepper",
  peppercorns: "black pepper",
  maida: "flour",
  "whole wheat": "flour",
  soy: "soy sauce",
  cheese: "cheddar cheese",
  "nuoc mam": "fish sauce",
  "kecap manis": "soy sauce",
  "sweet soy sauce": "soy sauce",
};

/// Page names that are units, techniques or packaging - never ingredients.
/// Kept separate from the app: this is import plumbing.
export const NOT_INGREDIENT = new Set(
  [
    "tablespoon", "teaspoon", "gram", "kilogram", "millilitre", "milliliter",
    "litre", "liter", "cup", "ounce", "pound", "pint", "quart", "gallon",
    "fluid ounce", "dessertspoon", "centimetre (cm)", "centimetre", "inch",
    "cm", "ml", "l", "g", "kg", "oz", "lb", "tbsp", "tsp", "pinch", "each",
    "clove", "cloves", "slice", "slices", "can", "cans", "piece", "pieces",
    "bunch", "stalk", "sprig", "head", "handful", "packet", "packets",
    "slicing", "slice", "mincing", "mince", "dicing", "dice", "chopping",
    "chop", "cube", "cubing", "grating", "grate", "grater", "crushing",
    "crush", "beating", "whisking", "mashing", "peeling", "peel", "roasting",
    "roast", "boiling", "boil", "frying", "fry", "deep fat frying", "steaming",
    "simmering", "sautéing", "sauteing", "baking", "grilling", "mixing",
    "stirring", "measuring", "serving", "garnish", "julienne", "ingredients",
    "equipment", "recipe", "oil and fat", "vegetable", "food coloring",
    // everyone has water; tracking it in a pantry is noise
    "water", "warm water", "cold water", "ice", "ice cubes", "carbonated water",
  ].map((s) => s.toLowerCase()),
);
