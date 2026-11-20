# PantryPedia

Tell it what's in your kitchen, and it tells you what you can cook.

Tap the ingredients you own, and every recipe is scored by how much of it you
already have. Recipes that share something with your pantry float to the top;
the rest are listed underneath, clearly separated. Open a recipe to see the
quantities scaled to however many people you're feeding, and push whatever
you're missing onto a shopping list you can take to the shop on your phone.

- **320 ingredients, 353 recipes** - Chinese, Japanese, Korean, Thai, Indian,
  Malaysian, Vietnamese and Indonesian, plus Western staples
- **Aliases** — "green onion", "spring onion" and "scallion" are one chip, so a
  recipe written with different words still matches what you ticked
- **Add your own** ingredients and recipes; they're marked `mine` and can be
  edited or deleted. Seed data can't be deleted, only ignored
- **Portions** — every recipe has a base serving count and every ingredient a
  real amount, so "3 pax" recalculates everything (½ and ⅔ included)
- **Shopping list** — merges by ingredient + unit, so two recipes needing rice
  give you one line. Copy it as text, save a `.txt` to Downloads, or scan a
  **QR code** to open the list on your phone over Wi-Fi
- **Bought it?** Tick the line and "Move checked to pantry" puts it back in your
  pantry, which instantly re-scores every recipe

## Install

Both installers land in `src-tauri/target/release/bundle/`:

```
nsis/PantryPedia_<version>_x64-setup.exe   <- share this one
msi/PantryPedia_<version>_x64_en-US.msi    <- for machine-wide deployment
```

**NSIS `.exe`** — double-click, install, done. Per-user in
`%LOCALAPPDATA%\PantryPedia`, no admin rights, and the file itself carries the
PantryPedia icon.

**MSI** — installs per-machine into `C:\Program Files\PantryPedia` and asks for
admin (UAC) on install and uninstall. Useful when several Windows accounts share
a PC, or when IT needs a silent `msiexec /i PantryPedia.msi /qn`.

Both show the app icon in Settings → Apps. One Windows quirk is unavoidable: an
`.msi` file can never show its own icon in Explorer, because MSI is a database
container with no icon resource — Explorer falls back to `msiexec.exe`'s generic
logo. The `.exe` has no such limitation, which is why it's the better one to
hand out.

## Getting the list onto your phone

`QR` serves the list from your PC over your Wi-Fi for as long as the QR window
is open, and the code holds the link. Your phone's camera opens it in the phone's
browser — nothing to install, no account, no internet.

Two things have to be true, and both are one-time:

1. **Same Wi-Fi.** The phone and the PC must be on the same network.
2. **Windows Firewall has to allow it.** The first time, Windows asks whether
   PantryPedia may communicate on your networks — tick **Private** and allow it.
   If you never saw that prompt (or clicked no), add the rule once in an
   **administrator** PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "PantryPedia (phone sharing)" `
     -Direction Inbound -Program "$env:LOCALAPPDATA\PantryPedia\pantrypedia.exe" `
     -Action Allow -Profile Private,Public
   ```

   This matters because Windows marks new Wi-Fi networks **Public** by default,
   and the Public profile blocks incoming connections. If the phone shows
   "site can't be reached", this is why — not the app.

The link only works while the window is open; closing it stops the server. The
address carries a random path, so nobody else on the network can guess it.

If sharing is blocked and you'd rather not touch firewall settings, **Copy** and
**Save .txt** both work with no network at all — save the file and send it to
yourself with WhatsApp, Telegram, Phone Link, whatever you already use.

## Changelog

**0.3.4** — the **🛒 Add 2 missing to list** button moved into the "you still
need ..." row, next to the ingredient chips it puts on the list. It used to sit
above the steps, a screen away from the chips that explain it. Same button, same
behaviour — just where you would look for it.

**0.3.3** — a clearer place to start. The app used to open on all 353 recipes at
once, which said nothing about what to do next; the default view is now a short
"start with what's in your kitchen" panel, and the full A–Z list sits behind
**View all recipes** (on that panel, and in the header — where the same button
turns into "← Back"). **Cook with "…" →** now names the words it will use: it
cooks with the *search box*, not with your pantry chips, and the banner says so
in as many words and offers **Back to my pantry**. Ingredient categories fold:
each header shows how many of that group you have ("2/12") and, folded, lists
them by name, so you can check and edit one corner of the pantry at a time.
Typing in the search bar always unfolds groups, so a search can never hide its
own hits.

**0.3.2** — ingredient lists now read like the page they came from. 0.3.1 kept
the right *ingredients* but showed the pantry name for each one, so **Homemade
Tempeh** said "soybean" instead of "dried soybeans" and lost the words "cider
vinegar" and "tempeh starter". Each recipe line now carries the source's own
wording and the app displays that, while matching your pantry by the canonical
name underneath. A new `audit` command compares all 309 imported recipes against
their Wikibooks pages line by line: phantom, missing, equipment-only and
reworded lines are all zero (the one flag is Kuih Bakul's banana leaves, which
really are an ingredient there). The audit also turned up wrong entries in the
alias table — `konbu` and `bonito flakes` were aliases of *dashi*, `cider
vinegar` of *vinegar*, `white pepper` of *black pepper*, `potato starch` of
*cornstarch*, `split peas` of *lentils*, `mustard` of *mustard seeds*, and
`coriander seeds` of *cilantro* — all of which put the wrong thing in a list.
Those are now their own ingredients, and units, ranges ("¼–½ cup"), HTML
entities ("&frac14; tsp") and mixed numbers ("2 ½") parse properly. The catalog
grew from 296 to 320 ingredients, aliases from 423 to 544, and dropped lines
from 256 to 175 (still almost all water and ice).

**0.3.1** — imported recipes were quietly losing ingredients: the importer threw
away any line it couldn't match, so **Tub Tim Krob** shipped without water
chestnuts and **Kuih Bakul** without glutinous rice flour or banana leaves. The
importer now reads the line's own wording instead of only its wiki link (so
"sticky/glutinous rice flour" stays glutinous), understands bracketed amounts
and unfamiliar units, keeps food named in a *Special equipment* list, and skips
*Warnings* and *Bibliography*. The catalog grew from 167 to 296 ingredients and
dropped ingredient lines fell from 500 to 256 — and most of those are water and
ice, which the app deliberately ignores. Six more recipes also became complete
enough to include.

**0.3.0** — the recipe list grew from 44 to 347, imported from Wikibooks
Cookbook (see Credits). Ingredient matching is now alias-aware, so "green
onion" finds recipes that say "scallion". Imported recipes carry a credit line
and a link to the original. Seeding the bigger catalog also got batched into
one transaction — unbatched it held the window blank for ~50s on every launch.
The phone QR now holds a link to a page served over Wi-Fi instead of the raw
text, because phones ignore text QR codes. The shopping list also gained
**Clear all** — it asks twice (the button turns red and says how many lines
will go) so a mis-click can't wipe a list you spent time building.

**0.2.2** — the recipe list now shows every recipe A–Z before you tap anything,
instead of an empty hint, so you can see what the app can do first.

**0.2.1** — fixed: deleting an ingredient you had ticked failed with
`foreign key constraint failed`. Deleting a recipe had the same latent bug.

**0.2.0** — renamed from PantryMate; QR code sharing; version shown in the
header.

## Where your data lives

```
%APPDATA%\com.yitfong.pantrypedia\pantry.db
```

One SQLite file. Back it up by copying it; reset the app by deleting the folder.
Installing a new build does **not** touch it, so your pantry survives upgrades.

## Credits

Most of the recipes come from the [Wikibooks Cookbook](https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents),
which is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Each imported recipe shows its licence and a link to the original page, and the
recipe text stays under that licence — share-alike applies to it.

The 44 hand-written recipes and the whole app are original. The app's code is
[MIT licensed](LICENSE); the recipe data keeps its Wikibooks licence, spelled
out in [SEED-DATA-LICENSE.md](SEED-DATA-LICENSE.md).

Recipe data is regenerated with:

```powershell
node tools/import-wikibooks.mjs fetch   # cache raw wikitext (polite, rate-limited)
node tools/import-wikibooks.mjs parse   # check what the parser gets out
node tools/import-wikibooks.mjs build   # write src-tauri/data/seed.json
node tools/import-wikibooks.mjs audit   # compare the seed against the source pages
```

`audit` is the one that catches silent data loss. It walks every imported
recipe and reports four kinds of problem: a stored line no bullet on the page
can produce (*phantom*), a bullet naming real food that produced no row
(*missing*), a row backed only by the *Equipment* list (*equipment*), and a row
whose displayed wording does not appear on the page (*wording*). It writes
`tools/.cache/audit.json` with the source and stored lists side by side, so a
disagreement is easy to see. It should report `phantom: 0, missing: 0,
wording: 0` — the single equipment row is Kuih Bakul's banana leaves, which are
genuinely an ingredient there.

`tools/ingredient-map.mjs` is the bridge between free-text recipe ingredients
and the pantry catalog: which extra ingredients to add, and which names mean
the same thing.

## Developing

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"   # cargo isn't on PATH by default
npm run tauri dev      # hot-ish reload: rebuilds on src-tauri changes
npm run tauri build    # the installer
```

### One gotcha worth remembering

`tauri.conf.json` has no `devUrl`, so `src/` (HTML/CSS/JS) is **baked into the
binary at compile time** by `generate_context!`. Cargo can't see that dependency
on its own, so `src-tauri/build.rs` emits `cargo:rerun-if-changed=../src` to
watch the folder.

Without that line the trap is silent: edit the frontend, run `tauri build`, and
it finishes in ~10 seconds showing you the *old* UI, because cargo saw no Rust
change and only re-patched the exe with bundle metadata. If a release build
finishes suspiciously fast, it didn't rebuild — look for a `Compiling` line, not
just `Finished`.

Note that `cargo clean -p <name>` cleans the **debug** profile. To force a
release rebuild it's `cargo clean --release -p pantrypedia`.

### Delete order matters

The schema declares `REFERENCES` but no `ON DELETE CASCADE`, and the bundled
SQLite is built with foreign keys **on**, so a parent row cannot go before its
children:

```rust
// wrong: pantry.ingredient_id still points at this row
DELETE FROM ingredient WHERE id = ?1;
DELETE FROM pantry     WHERE ingredient_id = ?1;   // too late

// right: children first, inside one transaction
DELETE FROM pantry        WHERE ingredient_id = ?1;
DELETE FROM shopping_item WHERE ingredient_id = ?1;
DELETE FROM ingredient    WHERE id = ?1;
```

`delete_ingredient` and `delete_recipe` both do it children-first. Ownership
(`source = 'user'`) is checked with a `SELECT` up front rather than by counting
rows from the parent `DELETE`, because that `DELETE` now happens last.

### Layout

| File | What's in it |
| --- | --- |
| `src-tauri/src/lib.rs` | Schema, seed catalog, every `#[tauri::command]`, `invoke_handler` |
| `src/main.js` | Search, recipe cards, quantity formatting, shopping list, export |
| `src/index.html` | Header, both panels, add/edit forms, shopping drawer |
| `src/styles.css` | Dark theme, sticky panels, stepper, drawer |
| `src/vendor/qrcode.js` | Vendored `qrcode-generator` (MIT) — classic script, no build step |

### Schema, briefly

`ingredient` ← `recipe_ingredient` → `recipe`, with `pantry` holding the
ingredient ids you own and `shopping_item` holding what you still need.
`source` (`'seed'` / `'user'`) is what keeps your own rows safe from the
re-seeding that runs on every launch.

Quantities live on the *link* (`recipe_ingredient.amount` / `.unit`), not on the
ingredient, because "300 g rice" is a fact about one recipe, not about rice.
`amount = NULL` means "to taste".
