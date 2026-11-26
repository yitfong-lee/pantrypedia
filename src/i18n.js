// UI strings for the app shell. Data (ingredient names, recipe titles and
// steps) does NOT live here: those come from the catalog and stay in the
// source language. This file only translates what the app itself says.

const DICT = {
  en: {
    searchPlaceholder: "Search ingredients or recipes…",
    searchClear: "Clear",
    list: "List",
    ingredients: "INGREDIENTS",
    loading: "loading…",
    add: "+ Add",
    addIngredientTitle: "Add an ingredient you have",
    newIngredientName: "Ingredient name (e.g. paneer)",
    newIngredientCategory: "Category (e.g. Frozen)",
    addIngredient: "Add ingredient",
    cancel: "Cancel",
    whatCanICook: "What can I cook?",
    cookWithThese: "Cook with these →",
    cookWith: "Cook with “{text}” →",
    rankByPantry: "← Rank by my pantry",
    back: "← Back",
    viewAllCount: "View all {n} recipes",
    viewAll: "View all recipes",
    viewAllTitle: "Show every recipe, A to Z",
    addRecipe: "+ Add recipe",
    addRecipeTitle: "Add a recipe of your own",
    recipeName: "Recipe name (e.g. Paneer Butter Masala)",
    serves: "Serves",
    ingredientsLabel: "Ingredients",
    amountOptional: 'amount is optional - leave it blank for "to taste"',
    addIngredientRow: "+ ingredient",
    steps: "Steps - what do you actually do?",
    saveRecipe: "Save recipe",
    saveChanges: "Save changes",
    selected: "{n} selected",
    quickBanner:
      "Only recipes that use <strong>{text}</strong> - your pantry chips are ignored until you leave this view.",
    backToPantry: "Back to my pantry",
    cookingWith: "Cooking with what you typed",
    allRecipes: "All recipes",
    startTitle: "Start with what's in your kitchen",
    startText1:
      "Tap ingredients on the left. Recipes that use more of them rise to the top, and the ones you can't cook yet drop below - nothing is hidden.",
    startViewAll: "View all {n} recipes",
    startText2:
      "Or use the search bar above: it filters as you type, and <kbd>Enter</kbd> looks those words up in the recipes.",
    noIngredientMatch: "No ingredient matches “{text}”.",
    noWordsMatch:
      "None of those words match a known ingredient.<br />Try real ingredients like <em>eggs, rice, tofu, noodles</em>.",
    noRecipeMatch: "No recipe matches “{text}”.",
    allIntro:
      "All {n} recipes, A to Z. Tap ingredients on the left to rank them by what you can cook.",
    matchesTyped: "Matches what you typed",
    matchesPantry: "Matches your pantry",
    noShared: "No shared ingredients",
    noneYet: "None of your ingredients yet",
    recipeOne: "recipe",
    recipeMany: "recipes",
    shoppingList: "🛒 Shopping list",
    shopClose: "Close",
    shopEmpty:
      "Nothing to buy yet.<br />Open a recipe and tap <strong>🛒 Add missing to list</strong>.",
    shopAddPlaceholder: "Add anything (e.g. dish soap)",
    shopAdd: "Add",
    copyList: "📋 Copy list",
    saveTxt: "💾 Save .txt",
    qr: "📱 QR",
    moveChecked: "Move checked to pantry",
    clearChecked: "Clear checked",
    clearAll: "Clear all",
    clearAllCount: "Sure? Delete {n}",
    clearAllTitle: "Remove every line from the list",
    toBuy: "{n} to buy",
    ticked: " · {n} ticked",
  },

  ms: {
    searchPlaceholder: "Cari bahan atau resipi…",
    searchClear: "Kosongkan",
    list: "Senarai",
    ingredients: "BAHAN-BAHAN",
    loading: "memuat…",
    add: "+ Tambah",
    addIngredientTitle: "Tambah bahan yang anda ada",
    newIngredientName: "Nama bahan (cth. paneer)",
    newIngredientCategory: "Kategori (cth. Sejuk beku)",
    addIngredient: "Tambah bahan",
    cancel: "Batal",
    whatCanICook: "Apa yang boleh saya masak?",
    cookWithThese: "Masak dengan ini →",
    cookWith: "Masak dengan “{text}” →",
    rankByPantry: "← Susun ikut pantry saya",
    back: "← Kembali",
    viewAllCount: "Lihat semua {n} resipi",
    viewAll: "Lihat semua resipi",
    viewAllTitle: "Tunjuk semua resipi, A hingga Z",
    addRecipe: "+ Tambah resipi",
    addRecipeTitle: "Tambah resipi sendiri",
    recipeName: "Nama resipi (cth. Ayam Goreng Mentega)",
    serves: "Hidangan",
    ingredientsLabel: "Bahan-bahan",
    amountOptional: 'kuantiti tidak wajib - biarkan kosong untuk "ikut rasa"',
    addIngredientRow: "+ bahan",
    steps: "Langkah - apa yang anda buat?",
    saveRecipe: "Simpan resipi",
    saveChanges: "Simpan perubahan",
    selected: "{n} dipilih",
    quickBanner:
      "Hanya resipi yang guna <strong>{text}</strong> - cip pantry anda diabaikan sampai anda keluar dari paparan ini.",
    backToPantry: "Kembali ke pantry saya",
    cookingWith: "Masak dengan apa yang anda taip",
    allRecipes: "Semua resipi",
    startTitle: "Mulakan dengan apa yang ada di dapur anda",
    startText1:
      "Ketik bahan di sebelah kiri. Resipi yang guna lebih banyak daripadanya naik ke atas, dan yang belum boleh dimasak turun ke bawah - tiada yang disembunyikan.",
    startViewAll: "Lihat semua {n} resipi",
    startText2:
      "Atau guna bar carian di atas: ia menapis semasa anda taip, dan <kbd>Enter</kbd> mencari kata-kata itu dalam resipi.",
    noIngredientMatch: "Tiada bahan sepadan dengan “{text}”.",
    noWordsMatch:
      "Tiada kata-kata itu sepadan dengan bahan yang diketahui.<br />Cuba bahan seperti <em>telur, beras, tauhu, mi</em>.",
    noRecipeMatch: "Tiada resipi sepadan dengan “{text}”.",
    allIntro:
      "Semua {n} resipi, A hingga Z. Ketik bahan di sebelah kiri untuk menyusunnya mengikut apa yang boleh anda masak.",
    matchesTyped: "Sepadan dengan apa yang anda taip",
    matchesPantry: "Sepadan dengan pantry anda",
    noShared: "Tiada bahan yang sama",
    noneYet: "Tiada bahan anda lagi",
    recipeOne: "resipi",
    recipeMany: "resipi",
    shoppingList: "🛒 Senarai beli-belah",
    shopClose: "Tutup",
    shopEmpty:
      "Tiada apa untuk dibeli.<br />Buka resipi dan ketik <strong>🛒 Tambah yang kurang ke senarai</strong>.",
    shopAddPlaceholder: "Tambah apa sahaja (cth. sabun cuci pinggan)",
    shopAdd: "Tambah",
    copyList: "📋 Salin senarai",
    saveTxt: "💾 Simpan .txt",
    qr: "📱 QR",
    moveChecked: "Pindahkan yang ditick ke pantry",
    clearChecked: "Kosongkan yang ditick",
    clearAll: "Kosongkan semua",
    clearAllCount: "Pastikan? Padam {n}",
    clearAllTitle: "Buang semua baris dari senarai",
    toBuy: "{n} untuk dibeli",
    ticked: " · {n} ditick",
  },
};

const STORAGE_KEY = "pantrypedia.lang";

function readLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && DICT[saved]) return saved;
  } catch {
    // localStorage can be unavailable in a restricted webview; English is fine.
  }
  return "en";
}

let current = readLang();

export function lang() {
  return current;
}

/** Translate a key, filling {name} placeholders from vars. */
export function t(key, vars = {}) {
  let text = DICT[current]?.[key] ?? DICT.en[key] ?? key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Switch language and remember it for the next launch. */
export function setLang(next) {
  current = DICT[next] ? next : "en";
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // remembering the choice is a nicety, not a requirement
  }
  document.documentElement.lang = current;
  return current;
}

/** Apply translations to static markup marked with data-i18n attributes. */
export function applyI18n() {
  document.documentElement.lang = current;
  for (const el of document.querySelectorAll("[data-i18n], [data-i18n-placeholder], [data-i18n-title]")) {
    if (el.dataset.i18n !== undefined) el.textContent = t(el.dataset.i18n);
    if (el.dataset.i18nPlaceholder !== undefined)
      el.placeholder = t(el.dataset.i18nPlaceholder);
    if (el.dataset.i18nTitle !== undefined) el.title = t(el.dataset.i18nTitle);
  }
}
