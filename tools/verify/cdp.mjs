// Shared CDP helper: attach to the app's page and wait until the frontend is
// actually up.
//
// Two races have bitten this harness:
//
//   1. The devtools port answers about a second before the webview navigates,
//      so attaching immediately can land on `about:blank`.
//   2. The app shell (header, #app-version) renders before `refresh()`
//      finishes its invokes, so the recipe list is still empty for a moment.
//
// So: pick a target that has actually navigated, and hand callers a `waitFor`
// for anything that depends on loaded data.
export async function connect(port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /// The page target, preferring one that has left about:blank.
  const findPage = async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pages = targets.filter((t) => t.type === "page");
      return pages.find((t) => t.url && t.url !== "about:blank") ?? pages[0] ?? null;
    } catch {
      return null; // port not up yet
    }
  };

  let lastHref = null;
  let lastError = null;

  // Retry the whole attach: a target that stays on about:blank is a dead end,
  // and a fresh one usually appears within a second or two.
  while (Date.now() < deadline) {
    const page = await findPage();
    if (!page) {
      await sleep(300);
      continue;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));

    const evaluate = (expression) =>
      new Promise((res) => {
        const i = id++;
        pending.set(i, (m) =>
          res(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description),
        );
        ws.send(
          JSON.stringify({
            id: i,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });

    // Raw CDP call, for scripts that need exceptionDetails rather than a value.
    const send = (method, params = {}) =>
      new Promise((res) => {
        const i = id++;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    /// Poll an expression until it returns truthy.
    const waitFor = async (expression, waitMs = 20000) => {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        const value = await evaluate(expression);
        if (value) return value;
        await sleep(200);
      }
      return null;
    };

    // Give this target a few seconds to prove it is the real one.
    const attemptUntil = Math.min(deadline, Date.now() + 10000);
    let up = false;
    while (Date.now() < attemptUntil) {
      try {
        lastHref = await evaluate("location.href");
        up = await evaluate(
          "typeof window.__TAURI__ === 'object' && !!window.__TAURI__?.core?.invoke && !!document.querySelector('#app-version')",
        );
      } catch (err) {
        lastError = err.message;
        break;
      }
      if (up === true) return { ws, evaluate, send, page, waitFor };
      await sleep(300);
    }

    ws.close();
    if (up !== true) await sleep(300);
  }

  throw new Error(
    `frontend never initialised (last href: ${lastHref}${lastError ? `, ${lastError}` : ""})`,
  );
}
