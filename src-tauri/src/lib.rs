use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// The SQLite connection, guarded by a Mutex.
///
/// Tauri can call commands from several threads at once; a Mutex is a
/// "one thread at a time" lock, so two commands never interleave queries.
struct Db(Mutex<Connection>);

// ---------------------------------------------------------------------------
// Shapes of the data we send to the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct IngredientRow {
    id: i64,
    name: String,
    category: String,
    in_pantry: bool,
    /// "seed" (ships with the app) or "user" (you added it)
    source: String,
    /// other names that mean this ingredient ("green onion" -> scallion),
    /// so the search box can match the words a recipe actually uses
    aliases: Vec<String>,
}

/// One line of a recipe: "2 tbsp butter".
#[derive(Serialize)]
struct IngredientLine {
    name: String,
    /// the recipe's own wording when it is more specific than `name`
    /// ("dried soybeans" for the soybeans chip); empty means use `name`
    label: String,
    /// None = "to taste" (no number to scale)
    amount: Option<f64>,
    unit: String,
    /// do you have it right now?
    in_pantry: bool,
}

#[derive(Serialize)]
struct MatchRow {
    id: i64,
    name: String,
    steps: String,
    /// how many people the amounts below are written for
    servings: i64,
    /// how many ingredients the recipe needs in total
    total: i64,
    /// how many of those you DON'T currently have
    missing: i64,
    /// the full ingredient list, with amounts
    ingredients: Vec<IngredientLine>,
    /// "seed" (ships with the app) or "user" (you added it)
    source: String,
    /// where an imported recipe came from (Wikibooks), for the credit line
    source_url: Option<String>,
    /// e.g. "Wikibooks Cookbook, CC BY-SA 4.0"
    attribution: Option<String>,
}

/// What the frontend sends when adding/editing a recipe.
#[derive(Deserialize)]
struct RecipeIngredientInput {
    name: String,
    amount: Option<f64>,
    unit: String,
}

/// One line of the shopping list: "500 g rice" or "dish soap".
#[derive(Serialize)]
struct ShoppingItemRow {
    id: i64,
    label: String,
    /// None = no number, just "buy it"
    amount: Option<f64>,
    unit: String,
    checked: bool,
    /// true = linked to a catalog ingredient, false = freeform ("dish soap").
    /// Both can have no amount, but only a catalog item means "to taste".
    from_catalog: bool,
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

fn init_db(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    // Tauri gives every app its own private data folder:
    //   C:\Users\Owner\AppData\Roaming\com.yitfong.pantrypedia
    // (the folder name is the app `identifier`, not the display name)
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("pantry.db"))?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ingredient (
            id       INTEGER PRIMARY KEY,
            name     TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL,
            -- 'seed' = shipped with the app, 'user' = you added it.
            -- The seeder only ever updates 'seed' rows, so your own
            -- entries can never be overwritten by an app update.
            source   TEXT NOT NULL DEFAULT 'seed'
        );
        CREATE TABLE IF NOT EXISTS recipe (
            id       INTEGER PRIMARY KEY,
            name     TEXT NOT NULL UNIQUE,
            steps    TEXT NOT NULL DEFAULT '',
            -- how many people this recipe's amounts are written for
            servings INTEGER NOT NULL DEFAULT 2,
            source   TEXT NOT NULL DEFAULT 'seed'
        );
        -- the bridge table: which recipe needs how much of which ingredient
        CREATE TABLE IF NOT EXISTS recipe_ingredient (
            recipe_id     INTEGER NOT NULL REFERENCES recipe(id),
            ingredient_id INTEGER NOT NULL REFERENCES ingredient(id),
            amount        REAL,               -- NULL = 'to taste'
            unit          TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (recipe_id, ingredient_id)
        );
        -- what you currently own (the only table that changes as you tap)
        CREATE TABLE IF NOT EXISTS pantry (
            ingredient_id INTEGER PRIMARY KEY REFERENCES ingredient(id),
            added_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- other names that mean the same ingredient: green onion -> scallion.
        -- Lets a recipe written with different words still match the chip you
        -- ticked, without showing five near-duplicate chips in the pantry.
        CREATE TABLE IF NOT EXISTS ingredient_alias (
            alias         TEXT PRIMARY KEY,
            ingredient_id INTEGER NOT NULL REFERENCES ingredient(id)
        );
        -- what you still need to buy. Not tied to one recipe: two recipes
        -- that both need rice merge into a single line.
        CREATE TABLE IF NOT EXISTS shopping_item (
            id            INTEGER PRIMARY KEY,
            -- NULL for freeform items (like dish soap) that aren't ingredients
            ingredient_id INTEGER REFERENCES ingredient(id),
            label         TEXT NOT NULL,
            amount        REAL,               -- NULL = just buy it, no number
            unit          TEXT NOT NULL DEFAULT '',
            checked       INTEGER NOT NULL DEFAULT 0,
            added_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ",
    )?;

    // Migrations for databases created by an older version.
    // ALTER TABLE ADD COLUMN only runs when the column is missing, so this
    // is safe on every launch.
    add_column_if_missing(&conn, "ingredient", "source", "TEXT NOT NULL DEFAULT 'seed'")?;
    add_column_if_missing(&conn, "recipe", "source", "TEXT NOT NULL DEFAULT 'seed'")?;
    add_column_if_missing(&conn, "recipe", "servings", "INTEGER NOT NULL DEFAULT 2")?;
    add_column_if_missing(&conn, "recipe", "source_url", "TEXT")?;
    add_column_if_missing(&conn, "recipe", "attribution", "TEXT")?;
    add_column_if_missing(&conn, "recipe_ingredient", "amount", "REAL")?;
    add_column_if_missing(&conn, "recipe_ingredient", "unit", "TEXT NOT NULL DEFAULT ''")?;
    // the recipe's own wording ("dried soybeans"), shown instead of the
    // catalog name ("soybean") so a list reads like the original page
    add_column_if_missing(
        &conn,
        "recipe_ingredient",
        "label",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    // Every launch: make sure the catalog is present and up to date.
    // This is idempotent, so it is safe to run on every start - and it
    // means NEW recipes/ingredients also reach databases created by
    // older versions of the app.
    ensure_catalog(&conn)?;
    Ok(conn)
}

/// Add a column only if the table doesn't already have it.
/// SQLite has no "ADD COLUMN IF NOT EXISTS", so we look first.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), rusqlite::Error> {
    let exists: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![column],
        |r| r.get(0),
    )?;
    if exists == 0 {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// The bundled catalog and recipes, compiled into the binary.
///
/// `include_str!` bakes the JSON in at build time, so the installer stays a
/// single file with no sidecar data to lose. Regenerate it with:
///
///   node tools/import-wikibooks.mjs build
const SEED_JSON: &str = include_str!("../data/seed.json");

/// Malay names for the catalog, sourced from data.gov.my's PriceCatcher item
/// lookup (CC BY 4.0). Kept separate from seed.json so regenerating the
/// Wikibooks catalog never wipes them. Like the seed aliases, these are only
/// ever added - an existing pantry or recipe is never rewritten.
const ALIASES_MS_JSON: &str = include_str!("../data/aliases-ms.json");

#[derive(Deserialize)]
struct Seed {
    ingredients: Vec<SeedIngredient>,
    aliases: Vec<SeedAlias>,
    recipes: Vec<SeedRecipe>,
}

#[derive(Deserialize)]
struct SeedIngredient {
    name: String,
    category: String,
}

#[derive(Deserialize)]
struct SeedAlias {
    /// another spelling, e.g. "green onion"
    alias: String,
    /// the catalog name it resolves to, e.g. "scallion"
    name: String,
}

#[derive(Deserialize)]
struct SeedRecipe {
    name: String,
    servings: i64,
    steps: String,
    /// where an imported recipe came from, for attribution
    source_url: Option<String>,
    attribution: Option<String>,
    ingredients: Vec<SeedLine>,
}

#[derive(Deserialize)]
struct SeedLine {
    name: String,
    /// the recipe's own wording, e.g. "dried soybeans" for `soybean`
    #[serde(default)]
    label: String,
    amount: Option<f64>,
    unit: String,
}

/// The starter data: ingredient catalog + aliases + recipes.
/// Runs on every launch; "INSERT OR IGNORE" / "ON CONFLICT" makes it
/// additive - existing rows (and your pantry) are never wiped.
///
/// Everything happens inside ONE transaction. That is not a micro-optimisation:
/// the 0.3.0 catalog is ~3,200 statements, and each statement outside a
/// transaction is its own implicit transaction with its own disk flush. Left
/// alone that made the window sit on a blank page for about 50 seconds on every
/// launch. Batched, it is a single commit and the app opens immediately.
fn ensure_catalog(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let seed: Seed = serde_json::from_str(SEED_JSON)?;
    let aliases_ms: Vec<SeedAlias> = serde_json::from_str(ALIASES_MS_JSON)?;
    // `unchecked_transaction` works on a shared reference, which is all we have
    // here - the caller holds the Mutex, so nothing else can be mid-write.
    let tx = conn.unchecked_transaction()?;

    // name -> id, so aliases and recipes can reference ingredients by name
    let mut id_of: HashMap<&str, i64> = HashMap::new();
    for ing in &seed.ingredients {
        tx.execute(
            "INSERT INTO ingredient (name, category, source) VALUES (?1, ?2, 'seed')
             ON CONFLICT(name) DO UPDATE SET category = excluded.category
             WHERE ingredient.source = 'seed'",
            params![ing.name, ing.category],
        )?;
        let id: i64 = tx.query_row(
            "SELECT id FROM ingredient WHERE name = ?1",
            params![ing.name],
            |r| r.get(0),
        )?;
        id_of.insert(&ing.name, id);
    }

    // Aliases are additive too: a later release can only add spellings, it
    // never removes one that an existing recipe might rely on. Malay names
    // come second so they sit alongside the Wikibooks English spellings.
    for a in seed.aliases.iter().chain(aliases_ms.iter()) {
        let Some(&ingredient_id) = id_of.get(a.name.as_str()) else {
            continue; // alias for an ingredient that isn't in this catalog
        };
        tx.execute(
            "INSERT OR IGNORE INTO ingredient_alias (alias, ingredient_id) VALUES (?1, ?2)",
            params![a.alias, ingredient_id],
        )?;
    }

    for r in &seed.recipes {
        tx.execute(
            "INSERT INTO recipe (name, steps, servings, source, source_url, attribution)
             VALUES (?1, ?2, ?3, 'seed', ?4, ?5)
             ON CONFLICT(name) DO UPDATE
                 SET steps       = excluded.steps,
                     servings    = excluded.servings,
                     source_url  = excluded.source_url,
                     attribution = excluded.attribution
             WHERE recipe.source = 'seed'",
            params![r.name, r.steps, r.servings, r.source_url, r.attribution],
        )?;
        let recipe_id: i64 = match tx.query_row(
            // Only a seed recipe: if you wrote your own recipe with the same
            // name, the upsert above changed nothing, and taking its id here
            // would wipe your ingredient list.
            "SELECT id FROM recipe WHERE name = ?1 AND source = 'seed'",
            params![r.name],
            |row| row.get(0),
        ) {
            Ok(id) => id,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(e) => return Err(Box::new(e)),
        };

        // A seed recipe owns its ingredient list completely, so clear it
        // first - that way removed/renamed lines don't linger.
        tx.execute(
            "DELETE FROM recipe_ingredient WHERE recipe_id = ?1",
            params![recipe_id],
        )?;
        for line in &r.ingredients {
            // A line naming an ingredient that didn't make the catalog would
            // be a dangling reference; skip it rather than fail the launch.
            let Some(&ingredient_id) = id_of.get(line.name.as_str()) else {
                continue;
            };
            tx.execute(
                "INSERT OR IGNORE INTO recipe_ingredient
                     (recipe_id, ingredient_id, amount, unit, label)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![recipe_id, ingredient_id, line.amount, line.unit, line.label],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Load every recipe's ingredient lines in one query, then hang them on the
/// matching MatchRows. `typed_ids` = Some(...) scores against a throwaway
/// pantry (the "cook with these" query) instead of the saved one.
fn attach_ingredients(
    conn: &Connection,
    list: &mut [MatchRow],
    typed_ids: Option<&[i64]>,
) -> rusqlite::Result<()> {
    // Build the "pantry" we score against: the real table, or a CTE made
    // from the ids the user typed.
    let (cte, bind): (String, Vec<i64>) = match typed_ids {
        Some(ids) => {
            let ph = ids.iter().map(|_| "(?)").collect::<Vec<_>>().join(", ");
            (
                format!("WITH typed_pantry(ingredient_id) AS (VALUES {ph})"),
                ids.to_vec(),
            )
        }
        None => (String::new(), Vec::new()),
    };
    let pantry = if typed_ids.is_some() {
        "typed_pantry"
    } else {
        "pantry"
    };

    let sql = format!(
        "{cte}
        SELECT ri.recipe_id, i.name, ri.amount, ri.unit,
               (p.ingredient_id IS NOT NULL) AS in_pantry,
               COALESCE(NULLIF(ri.label, ''), i.name) AS shown
        FROM recipe_ingredient ri
        JOIN ingredient i ON i.id = ri.ingredient_id
        LEFT JOIN {pantry} p ON p.ingredient_id = ri.ingredient_id
        ORDER BY ri.rowid"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(bind.iter()), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            IngredientLine {
                name: row.get(1)?,
                label: row.get(5)?,
                amount: row.get(2)?,
                unit: row.get(3)?,
                in_pantry: row.get(4)?,
            },
        ))
    })?;

    let mut by_recipe: HashMap<i64, Vec<IngredientLine>> = HashMap::new();
    for row in rows {
        let (recipe_id, line) = row?;
        by_recipe.entry(recipe_id).or_default().push(line);
    }
    for m in list.iter_mut() {
        m.ingredients = by_recipe.remove(&m.id).unwrap_or_default();
    }
    Ok(())
}

/// "eggs, Eggs , rice" -> ["eggs", "rice"] (trimmed, lowercased, deduped)
fn clean_ingredient_list(raw: &[RecipeIngredientInput]) -> Vec<RecipeIngredientInput> {
    let mut out: Vec<RecipeIngredientInput> = Vec::new();
    for item in raw {
        let name = item.name.trim().to_lowercase();
        if name.is_empty() || out.iter().any(|o| o.name == name) {
            continue;
        }
        out.push(RecipeIngredientInput {
            name,
            // a zero or negative amount is meaningless - treat as "to taste"
            amount: item.amount.filter(|a| *a > 0.0),
            unit: item.unit.trim().to_lowercase(),
        });
    }
    out
}

/// Find an ingredient by name (case-insensitive), creating it as a
/// "My ingredients" entry if the catalog doesn't have it yet.
fn ensure_ingredient(tx: &rusqlite::Transaction<'_>, name: &str) -> rusqlite::Result<i64> {
    let existing: Option<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM ingredient WHERE lower(name) = ?1")?;
        let mut rows = stmt.query(params![name])?;
        match rows.next()? {
            Some(row) => Some(row.get(0)?),
            None => None,
        }
    };
    match existing {
        Some(id) => Ok(id),
        None => {
            tx.execute(
                "INSERT INTO ingredient (name, category, source)
                 VALUES (?1, 'My ingredients', 'user')",
                params![name],
            )?;
            Ok(tx.last_insert_rowid())
        }
    }
}

/// Point a recipe at exactly these ingredients - used by both add and
/// update, so editing re-links instead of piling up duplicates.
fn set_recipe_ingredients(
    tx: &rusqlite::Transaction<'_>,
    recipe_id: i64,
    list: &[RecipeIngredientInput],
) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM recipe_ingredient WHERE recipe_id = ?1",
        params![recipe_id],
    )?;
    for item in list {
        let ing_id = ensure_ingredient(tx, &item.name)?;
        tx.execute(
            "INSERT OR IGNORE INTO recipe_ingredient
                 (recipe_id, ingredient_id, amount, unit)
             VALUES (?1, ?2, ?3, ?4)",
            params![recipe_id, ing_id, item.amount, item.unit],
        )?;
    }
    Ok(())
}

/// The fields add_recipe and update_recipe both insist on.
fn validate_recipe(
    name: &str,
    steps: &str,
    servings: i64,
    ingredients: &[RecipeIngredientInput],
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Give the recipe a name.".into());
    }
    if steps.trim().is_empty() {
        return Err("Add the steps, so future-you knows what to do.".into());
    }
    if !(1..=50).contains(&servings) {
        return Err("Servings should be between 1 and 50.".into());
    }
    if clean_ingredient_list(ingredients).is_empty() {
        return Err("List at least one ingredient.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands (what the frontend can call)
// ---------------------------------------------------------------------------

/// Every ingredient, with whether it's currently in your pantry.
#[tauri::command]
fn get_ingredients(db: State<Db>) -> Result<Vec<IngredientRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // ingredient id -> its other names, fetched once rather than per row
    let mut aliases: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT ingredient_id, alias FROM ingredient_alias ORDER BY alias")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, alias) = row.map_err(|e| e.to_string())?;
            aliases.entry(id).or_default().push(alias);
        }
    }

    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.name, i.category,
                    (p.ingredient_id IS NOT NULL) AS in_pantry,
                    i.source
             FROM ingredient i
             LEFT JOIN pantry p ON p.ingredient_id = i.id
             ORDER BY i.category, i.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            Ok(IngredientRow {
                id,
                name: row.get(1)?,
                category: row.get(2)?,
                in_pantry: row.get(3)?,
                source: row.get(4)?,
                aliases: aliases.get(&id).cloned().unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Tap an ingredient: adds it to the pantry if absent, removes it if present.
/// Returns the new state (true = now in pantry).
#[tauri::command]
fn toggle_ingredient(db: State<Db>, id: i64) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let removed = conn
        .execute("DELETE FROM pantry WHERE ingredient_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if removed > 0 {
        return Ok(false); // it was in the pantry, we just removed it
    }
    conn.execute("INSERT INTO pantry (ingredient_id) VALUES (?1)", params![id])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Every recipe with its ingredient lines and how many you're missing,
/// best-first (fully cookable on top).
#[tauri::command]
fn get_matches(db: State<Db>) -> Result<Vec<MatchRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "
            SELECT r.id, r.name, r.steps, r.servings, r.source,
                   r.source_url, r.attribution,
                   COUNT(*) AS total,
                   SUM(CASE WHEN p.ingredient_id IS NULL
                            THEN 1 ELSE 0 END) AS missing
            FROM recipe r
            JOIN  recipe_ingredient ri ON ri.recipe_id    = r.id
            JOIN  ingredient i         ON i.id            = ri.ingredient_id
            LEFT JOIN pantry p         ON p.ingredient_id = ri.ingredient_id
            GROUP BY r.id
            ORDER BY missing ASC, r.name ASC
            ",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok(MatchRow {
                id: row.get(0)?,
                name: row.get(1)?,
                steps: row.get(2)?,
                servings: row.get(3)?,
                source: row.get(4)?,
                source_url: row.get(5)?,
                attribution: row.get(6)?,
                total: row.get(7)?,
                missing: row.get(8)?,
                ingredients: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    attach_ingredients(&conn, &mut rows, None).map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Quick query: rank recipes against ONLY the ingredients typed in,
/// ignoring the saved pantry. Same matching idea, different pantry.
#[tauri::command]
fn search_recipes(db: State<Db>, query: String) -> Result<Vec<MatchRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // "eggs, rice, soy sauce" -> ["eggs", "rice", "soy sauce"]
    let terms: Vec<String> = query
        .split(',')
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    // Find the ingredient(s) a typed word means. Exact name wins first
    // ("rice" -> rice, NOT rice vinegar), then an alias ("green onion" ->
    // scallion); only if both miss do we fall back to "contains", so "egg"
    // finds eggs and "chicken" finds chicken breast.
    let mut ids: Vec<i64> = Vec::new();
    for term in &terms {
        let exact: Vec<i64> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM ingredient WHERE lower(name) = ?1
                     UNION
                     SELECT ingredient_id FROM ingredient_alias WHERE alias = ?1",
                )
                .map_err(|e| e.to_string())?;
            let found = stmt
                .query_map(params![term], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            found
        };
        if !exact.is_empty() {
            ids.extend(exact);
            continue;
        }
        let mut stmt = conn
            .prepare("SELECT id FROM ingredient WHERE name LIKE ?1")
            .map_err(|e| e.to_string())?;
        let found = stmt
            .query_map(params![format!("%{}%", term)], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        for id in found {
            ids.push(id.map_err(|e| e.to_string())?);
        }
    }
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new()); // nothing typed is a known ingredient
    }

    // A CTE (WITH ... AS) makes a temporary "pantry" out of the typed ids,
    // so the rest of the query is the same shape as get_matches.
    let placeholders = (1..=ids.len())
        .map(|i| format!("(?{i})"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "
        WITH typed_pantry(ingredient_id) AS (VALUES {placeholders})
        SELECT r.id, r.name, r.steps, r.servings, r.source,
               r.source_url, r.attribution,
               COUNT(*) AS total,
               SUM(CASE WHEN p.ingredient_id IS NULL
                        THEN 1 ELSE 0 END) AS missing
        FROM recipe r
        JOIN  recipe_ingredient ri ON ri.recipe_id    = r.id
        JOIN  ingredient i         ON i.id            = ri.ingredient_id
        LEFT JOIN typed_pantry p   ON p.ingredient_id = ri.ingredient_id
        GROUP BY r.id
        HAVING SUM(CASE WHEN p.ingredient_id IS NOT NULL
                        THEN 1 ELSE 0 END) > 0
        ORDER BY missing ASC, r.name ASC
        "
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok(MatchRow {
                id: row.get(0)?,
                name: row.get(1)?,
                steps: row.get(2)?,
                servings: row.get(3)?,
                source: row.get(4)?,
                source_url: row.get(5)?,
                attribution: row.get(6)?,
                total: row.get(7)?,
                missing: row.get(8)?,
                ingredients: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    attach_ingredients(&conn, &mut rows, Some(&ids)).map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Add an ingredient of your own. Names are case-insensitive-unique.
#[tauri::command]
fn add_ingredient(db: State<Db>, name: String, category: String) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Err("Give the ingredient a name.".into());
    }
    let category = {
        let c = category.trim();
        if c.is_empty() {
            "My ingredients".to_string()
        } else {
            c.to_string()
        }
    };

    // The UNIQUE index is case-sensitive, so check ourselves to keep
    // "Eggs" from sneaking in next to "eggs".
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ingredient WHERE lower(name) = ?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!("“{name}” is already in the list."));
    }

    conn.execute(
        "INSERT INTO ingredient (name, category, source) VALUES (?1, ?2, 'user')",
        params![name, category],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Add a recipe of your own. Any ingredient you name that isn't in the
/// catalog yet gets created too (category "My ingredients").
#[tauri::command]
fn add_recipe(
    db: State<Db>,
    name: String,
    steps: String,
    servings: i64,
    ingredients: Vec<RecipeIngredientInput>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let name = name.trim().to_string();
    let steps = steps.trim().to_string();
    validate_recipe(&name, &steps, servings, &ingredients)?;
    let wanted = clean_ingredient_list(&ingredients);

    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recipe WHERE lower(name) = lower(?1)",
            params![name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(format!("“{name}” is already in the cookbook."));
    }

    // A transaction = all-or-nothing. If anything fails halfway, the
    // half-built recipe is rolled back instead of left dangling.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO recipe (name, steps, servings, source)
         VALUES (?1, ?2, ?3, 'user')",
        params![name, steps, servings],
    )
    .map_err(|e| e.to_string())?;
    let recipe_id = tx.last_insert_rowid();
    set_recipe_ingredients(&tx, recipe_id, &wanted).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(recipe_id)
}

/// Edit a recipe you added: rename it, rewrite the steps, change servings,
/// or change the ingredient amounts. Seed recipes stay read-only.
#[tauri::command]
fn update_recipe(
    db: State<Db>,
    id: i64,
    name: String,
    steps: String,
    servings: i64,
    ingredients: Vec<RecipeIngredientInput>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let name = name.trim().to_string();
    let steps = steps.trim().to_string();
    validate_recipe(&name, &steps, servings, &ingredients)?;
    let wanted = clean_ingredient_list(&ingredients);

    let mine: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recipe WHERE id = ?1 AND source = 'user'",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if mine == 0 {
        return Err("Only recipes you added can be edited.".into());
    }

    // Renaming onto an existing recipe would break the UNIQUE name.
    let clash: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM recipe WHERE lower(name) = lower(?1) AND id <> ?2",
            params![name, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if clash > 0 {
        return Err(format!("“{name}” is already in the cookbook."));
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE recipe SET name = ?1, steps = ?2, servings = ?3
         WHERE id = ?4 AND source = 'user'",
        params![name, steps, servings, id],
    )
    .map_err(|e| e.to_string())?;
    set_recipe_ingredients(&tx, id, &wanted).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete a recipe - only one you added. Seed recipes are protected.
#[tauri::command]
fn delete_recipe(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Ownership check first, so a seed recipe is refused before anything is
    // touched. (Checked with a SELECT rather than by counting the rows a
    // DELETE affected, because the child rows have to go first - see below.)
    let source: Option<String> = tx
        .query_row(
            "SELECT source FROM recipe WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match source.as_deref() {
        None => return Err("That recipe no longer exists.".into()),
        Some("user") => {}
        Some(_) => return Err("Only recipes you added can be deleted.".into()),
    }

    // Children before parent. `recipe_ingredient.recipe_id` references
    // `recipe(id)` with no ON DELETE CASCADE, and SQLite enforces foreign
    // keys here, so deleting the recipe first fails with
    // "foreign key constraint failed".
    tx.execute(
        "DELETE FROM recipe_ingredient WHERE recipe_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM recipe WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete an ingredient - only one you added, and only if no recipe uses
/// it (otherwise a recipe could silently lose an ingredient).
#[tauri::command]
fn delete_ingredient(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Ownership check first, so a seed ingredient is refused before anything
    // is touched.
    let source: Option<String> = tx
        .query_row(
            "SELECT source FROM ingredient WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match source.as_deref() {
        None => return Err("That ingredient no longer exists.".into()),
        Some("user") => {}
        Some(_) => return Err("Only ingredients you added can be deleted.".into()),
    }

    let used: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM recipe_ingredient WHERE ingredient_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if used > 0 {
        return Err(format!(
            "That ingredient is used by {used} recipe(s). Delete the recipe first."
        ));
    }

    // Children before parent. `pantry.ingredient_id` and
    // `shopping_item.ingredient_id` both reference `ingredient(id)` with no
    // ON DELETE CASCADE, and SQLite enforces foreign keys here, so deleting
    // the ingredient first fails with "foreign key constraint failed" -
    // which is exactly what happened when it was still ticked (a `pantry`
    // row existed).
    tx.execute(
        "DELETE FROM pantry WHERE ingredient_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // ...and any other spellings of it, which also reference ingredient(id).
    tx.execute(
        "DELETE FROM ingredient_alias WHERE ingredient_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // ...and off the shopping list, or it would dangle.
    tx.execute(
        "DELETE FROM shopping_item WHERE ingredient_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM ingredient WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shopping list
// ---------------------------------------------------------------------------

/// Put an ingredient on the list, merging with a line that's already there
/// for the same ingredient + unit: "200 g rice" + "300 g rice" = "500 g rice".
/// Re-adding also unticks the line, because now you need to buy it again.
fn add_or_merge_shopping(
    tx: &rusqlite::Transaction<'_>,
    ingredient_id: i64,
    label: &str,
    amount: Option<f64>,
    unit: &str,
) -> rusqlite::Result<()> {
    let existing: Option<(i64, Option<f64>)> = {
        let mut stmt = tx.prepare(
            "SELECT id, amount FROM shopping_item
             WHERE ingredient_id = ?1 AND unit = ?2",
        )?;
        let mut rows = stmt.query(params![ingredient_id, unit])?;
        match rows.next()? {
            Some(row) => Some((row.get(0)?, row.get(1)?)),
            None => None,
        }
    };

    match existing {
        Some((id, old)) => {
            // Two "buy it, no number" lines stay without a number.
            let merged = match (old, amount) {
                (None, None) => None,
                (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
            };
            tx.execute(
                "UPDATE shopping_item SET amount = ?1, checked = 0 WHERE id = ?2",
                params![merged, id],
            )?;
        }
        None => {
            tx.execute(
                "INSERT INTO shopping_item (ingredient_id, label, amount, unit)
                 VALUES (?1, ?2, ?3, ?4)",
                params![ingredient_id, label, amount, unit],
            )?;
        }
    }
    Ok(())
}

/// Everything on the list, unchecked items first.
#[tauri::command]
fn get_shopping_list(db: State<Db>) -> Result<Vec<ShoppingItemRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, amount, unit, checked,
                    (ingredient_id IS NOT NULL) AS from_catalog
             FROM shopping_item
             ORDER BY checked ASC, label ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ShoppingItemRow {
                id: row.get(0)?,
                label: row.get(1)?,
                amount: row.get(2)?,
                unit: row.get(3)?,
                checked: row.get(4)?,
                from_catalog: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// "Add what I'm missing for this recipe", scaled to the pax you picked.
/// Returns how many lines were added.
#[tauri::command]
fn add_missing_to_list(db: State<Db>, recipe_id: i64, servings: i64) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // The recipe's own base, so scaling matches what the card showed.
    let base: i64 = tx
        .query_row(
            "SELECT servings FROM recipe WHERE id = ?1",
            params![recipe_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let base = if base < 1 { 1 } else { base };
    let target = servings.clamp(1, 50);

    let lines: Vec<(i64, String, Option<f64>, String, bool)> = {
        let mut stmt = tx
            .prepare(
                "SELECT ri.ingredient_id, i.name, ri.amount, ri.unit,
                        (p.ingredient_id IS NOT NULL) AS in_pantry
                 FROM recipe_ingredient ri
                 JOIN ingredient i ON i.id = ri.ingredient_id
                 LEFT JOIN pantry p ON p.ingredient_id = ri.ingredient_id
                 WHERE ri.recipe_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![recipe_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut added = 0usize;
    for (ing_id, name, amount, unit, in_pantry) in lines {
        if in_pantry {
            continue; // you have it - nothing to buy
        }
        let scaled = amount.map(|a| a * target as f64 / base as f64);
        add_or_merge_shopping(&tx, ing_id, &name, scaled, &unit).map_err(|e| e.to_string())?;
        added += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// Add anything by typing it. If the name is a known ingredient we link it,
/// so "Move checked to pantry" knows where it belongs.
#[tauri::command]
fn add_shopping_item(db: State<Db>, label: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let typed = label.trim();
    if typed.is_empty() {
        return Err("Type what you want to add.".into());
    }

    let known: Option<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name FROM ingredient WHERE lower(name) = lower(?1)")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![typed]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(row) => Some((
                row.get(0).map_err(|e| e.to_string())?,
                row.get(1).map_err(|e| e.to_string())?,
            )),
            None => None,
        }
    };

    if let Some((ing_id, name)) = known {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        add_or_merge_shopping(&tx, ing_id, &name, None, "").map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM shopping_item
             WHERE ingredient_id IS NULL AND lower(label) = lower(?1)",
            params![typed],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists > 0 {
        return Err(format!("“{typed}” is already on the list."));
    }

    conn.execute(
        "INSERT INTO shopping_item (ingredient_id, label) VALUES (NULL, ?1)",
        params![typed],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Tick or untick a line. Returns the new state.
#[tauri::command]
fn toggle_shopping_item(db: State<Db>, id: i64) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let checked: i64 = conn
        .query_row(
            "SELECT checked FROM shopping_item WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let new = if checked == 0 { 1 } else { 0 };
    conn.execute(
        "UPDATE shopping_item SET checked = ?1 WHERE id = ?2",
        params![new, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(new == 1)
}

/// Take one line off the list (this one is immediate - a shopping list is
/// not precious data, unlike a recipe).
#[tauri::command]
fn delete_shopping_item(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM shopping_item WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove every ticked line without touching the pantry.
#[tauri::command]
fn clear_checked_shopping(db: State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM shopping_item WHERE checked = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// Empty the list completely - the "start over" button. Separate from
/// `clear_checked_shopping`, which only removes what you ticked off.
#[tauri::command]
fn clear_shopping_list(db: State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM shopping_item", [])
        .map_err(|e| e.to_string())?;
    Ok(n)
}

/// The closing move: everything you ticked goes into the pantry, then comes
/// off the list. Freeform items ("dish soap") just come off.
#[tauri::command]
fn move_checked_to_pantry(db: State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let moved = tx
        .execute(
            "INSERT OR IGNORE INTO pantry (ingredient_id)
             SELECT ingredient_id FROM shopping_item
             WHERE checked = 1 AND ingredient_id IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM shopping_item WHERE checked = 1", [])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(moved)
}

// ---------------------------------------------------------------------------
// Taking the list to the shops
// ---------------------------------------------------------------------------

// Note: with no `devUrl` in tauri.conf.json, src/ is baked into the binary by
// `generate_context!` below. Editing the HTML/JS/CSS therefore needs a real
// recompile of this crate, not just an app restart.

/// Write the shopping list as a plain .txt in your Downloads folder, and hand
/// back the full path so the UI can say where it landed.
///
/// The frontend builds the text: it already knows the fraction glyphs, unit
/// plurals and "to taste" rules, and duplicating those here would let the two
/// drift apart. This side only does the file part.
#[tauri::command]
fn save_text_file(app: AppHandle, filename: String, contents: String) -> Result<String, String> {
    // Only a file NAME comes from the frontend. Stripping path separators and
    // the characters Windows forbids means a crafted name can't escape
    // Downloads, and can't make the write fail with a confusing OS error.
    let safe: String = filename
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let safe = safe.trim().to_string();
    let safe = if safe.is_empty() {
        "shopping-list.txt".to_string()
    } else {
        safe
    };

    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Couldn't find your Downloads folder: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(safe);
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save the file: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Open a link in the user's normal browser.
///
/// Without this, clicking a link inside the app would navigate the app window
/// itself to Wikibooks - replacing the UI with a web page and no way back.
/// Only https links are accepted, so a malformed recipe row can't ask the app
/// to launch something arbitrary.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only web links can be opened.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Show a saved file in Explorer, with the file itself selected - so the next
/// step (right-click > Send to > your phone) is one move away.
#[tauri::command]
fn reveal_file(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sharing the list with a phone
// ---------------------------------------------------------------------------
//
// The first version put the whole list into the QR code as plain text. It
// encoded correctly (checked by decoding a screenshot), but phones do not know
// what to do with a text QR: the camera app says "QR code" and offers nothing.
// Camera apps are built for links.
//
// So the code now holds a link, and the app serves the list itself on the local
// network for as long as the QR window is open. The phone opens it in its own
// browser - no app, no account, no internet, nothing installed on the phone.

/// One line as the phone will see it.
#[derive(Deserialize)]
struct ShareItem {
    label: String,
    checked: bool,
}

/// A server that is currently running, so it can be shut down again.
struct ShareServer {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

/// `None` while nothing is being shared.
#[derive(Default)]
struct ShareState(Mutex<Option<ShareServer>>);

impl ShareState {
    /// Stop the running server, if any, and wait for its thread to notice.
    fn stop(&self) {
        // A panic in the accept thread would poison the lock; the share state
        // is not worth propagating that for, so take the inner value.
        let mut guard = match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut server) = guard.take() {
            server.stop.store(true, Ordering::Relaxed);
            if let Some(join) = server.join.take() {
                let _ = join.join();
            }
        }
    }
}

/// The address this machine would use to reach the outside world.
///
/// Connecting a UDP socket sends no packets - it just asks the OS to pick the
/// local interface it *would* use, which is the LAN address a phone can reach.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

/// A short unguessable path, so the list is not sitting at "/" for anyone who
/// happens to port-scan while the window is open.
fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    // RandomState is seeded randomly per process, so hashing the clock gives a
    // token that is different every time without pulling in a RNG crate.
    let mut hasher = RandomState::new().build_hasher();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(nanos);
    format!("{:016x}", hasher.finish())
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The page the phone opens: the list, big enough to read while walking.
fn render_share_page(title: &str, items: &[ShareItem]) -> String {
    let left = items.iter().filter(|i| !i.checked).count();
    let total = items.len();

    let mut rows = String::new();
    for item in items {
        rows.push_str(&format!(
            "<li class=\"{}\"><span class=\"box\">{}</span><span>{}</span></li>",
            if item.checked { "got" } else { "need" },
            if item.checked { "✓" } else { "" },
            escape_html(&item.label),
        ));
    }

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ color-scheme: light; }}
  body {{
    margin: 0;
    padding: 20px 16px 40px;
    font: 17px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9;
    color: #16181d;
  }}
  main {{ max-width: 560px; margin: 0 auto; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .count {{ margin: 0 0 20px; color: #6b7280; font-size: 15px; }}
  ul {{ list-style: none; margin: 0; padding: 0; }}
  li {{
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 4px;
    border-bottom: 1px solid #e3e6ea;
  }}
  .box {{
    flex: none;
    width: 22px;
    height: 22px;
    margin-top: 1px;
    border: 2px solid #9aa1ad;
    border-radius: 5px;
    text-align: center;
    font-size: 15px;
    line-height: 22px;
    color: #16a34a;
  }}
  li.got .box {{ border-color: #16a34a; }}
  li.got span:last-child {{ text-decoration: line-through; color: #8b91a0; }}
  .foot {{ margin-top: 28px; color: #8b91a0; font-size: 13px; }}
</style>
</head>
<body>
<main>
<h1>{title}</h1>
<p class="count">{left} to buy of {total}</p>
<ul>{rows}</ul>
<p class="foot">Served by PantryPedia on your computer. This page stops working when you close the QR window.</p>
</main>
</body>
</html>"#,
        title = escape_html(title),
    )
}

/// Answer one HTTP request. Only the exact token path is served; anything else
/// gets a 404, so the list is not discoverable by guessing.
fn serve_share_request(mut stream: TcpStream, expected: &str, page: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = [0u8; 4096];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    // First line is "GET /token/ HTTP/1.1".
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");

    let (status, body) = if path == expected || path == expected.trim_end_matches('/') {
        ("200 OK", page.to_string())
    } else {
        (
            "404 Not Found",
            "<!doctype html><meta charset=\"utf-8\"><title>Not found</title>\
             <p style=\"font:16px sans-serif;padding:24px\">Nothing here."
                .to_string(),
        )
    };

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// Start serving the list and return the URL to put in the QR code.
#[tauri::command]
fn start_share(
    state: State<ShareState>,
    title: String,
    items: Vec<ShareItem>,
) -> Result<String, String> {
    state.stop(); // only ever one at a time

    // Port 0 = let the OS pick a free one, so two copies of the app (or another
    // program) can never collide on a fixed port.
    let listener =
        TcpListener::bind("0.0.0.0:0").map_err(|e| format!("Couldn't start sharing: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Couldn't start sharing: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Couldn't start sharing: {e}"))?
        .port();

    let ip = lan_ip().ok_or_else(|| {
        "This computer doesn't seem to be on a network. Use Copy or Save .txt instead.".to_string()
    })?;
    let token = random_token();
    let page = render_share_page(&title, &items);
    let url = format!("http://{ip}:{port}/{token}/");

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let expected = format!("/{token}/");
    let join = std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => serve_share_request(stream, &expected, &page),
                // Nothing waiting: nap instead of spinning the CPU.
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(_) => break,
            }
        }
    });

    *state.0.lock().map_err(|e| e.to_string())? = Some(ShareServer {
        stop,
        join: Some(join),
    });

    Ok(url)
}

/// Stop serving. Called when the QR window closes.
#[tauri::command]
fn stop_share(state: State<ShareState>) {
    state.stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Runs once at startup: open (and if needed create) the database.
            let conn = init_db(app.handle())?;
            app.manage(Db(Mutex::new(conn)));
            app.manage(ShareState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_ingredients,
            toggle_ingredient,
            get_matches,
            search_recipes,
            add_ingredient,
            add_recipe,
            update_recipe,
            delete_recipe,
            delete_ingredient,
            get_shopping_list,
            add_missing_to_list,
            add_shopping_item,
            toggle_shopping_item,
            delete_shopping_item,
            clear_checked_shopping,
            clear_shopping_list,
            move_checked_to_pantry,
            save_text_file,
            reveal_file,
            open_external,
            start_share,
            stop_share
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
