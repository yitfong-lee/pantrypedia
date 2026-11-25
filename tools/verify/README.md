# Verification scripts

End-to-end checks that drive the **real release binary** through Chrome DevTools
Protocol, rather than poking at the database directly. Every check asserts what
a person would actually see in the app.

## Run everything

```powershell
npm install                 # jsqr and pngjs are dev dependencies here
npm run tauri build
powershell -ExecutionPolicy Bypass -File tools\verify\verify-all.ps1
```

**Warning:** the suite kills `pantrypedia.exe` and deletes
`%APPDATA%\com.yitfong.pantrypedia` before and after it runs, so the cold-start
checks begin with an empty pantry. Don't run it while you're using the app —
your pantry and shopping list will be wiped.

## Run one suite

```powershell
powershell -ExecutionPolicy Bypass -File tools\verify\run-cdp.ps1 `
  -Port 9390 -Test tools\verify\verify-030.js
```

`run-cdp.ps1` launches the release exe with a debugging port, waits until the
port really answers, runs one Node script, then kills the app.

| Script | What it checks |
|---|---|
| `verify-030.js` | 353 cards on the A–Z view, 320 ingredient chips, alias search ("green onion" → scallion), ranked split, source wording on recipe lines |
| `verify-qr-link.js` | QR overlay, the LAN URL actually serves the list, a wrong path gets 404, the QR decodes to that URL, and the server stops on close |
| `verify-ui-033.js` | Cold start shows the start panel with 0 cards, both "View all recipes" buttons, "Cook with 'milk'" wording and its way back, foldable groups |
| `verify-ui-034.js` | "Add N missing to list" sits in the "you still need" row and still fills the list |
| `verify-clear-all.js` | First click arms Clear all, second clears, closing the drawer disarms it, and it auto-disarms after 5s |
| `adversarial-inputs.js` | Hostile text (SQL injection, HTML/JS, `%` wildcards, unicode, 10k chars) through the search box and every storage field; checks nothing executes, the database survives, and path/URL fields refuse traversal and non-web links |

Each script prints one JSON object. `false`, `null` or a missing field is the
thing to look for — there are no assertion libraries involved.
