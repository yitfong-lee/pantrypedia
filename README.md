# PantryPedia

Tell it what's in your kitchen, and it tells you what you can cook.

Tap the ingredients you own, and every recipe is scored by how much of it you
already have. Recipes that share something with your pantry float to the top;
the rest are listed underneath, clearly separated. Open a recipe to see the
quantities scaled to however many people you're feeding, and push whatever
you're missing onto a shopping list you can take to the shop on your phone.

- **167 ingredients, 347 recipes** — Chinese, Japanese, Korean, Thai, Indian,
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

The 44 hand-written recipes and the whole app are original.

Recipe data is regenerated with:

```powershell
node tools/import-wikibooks.mjs fetch   # cache raw wikitext (polite, rate-limited)
node tools/import-wikibooks.mjs parse   # check what the parser gets out
node tools/import-wikibooks.mjs build   # write src-tauri/data/seed.json
```

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
