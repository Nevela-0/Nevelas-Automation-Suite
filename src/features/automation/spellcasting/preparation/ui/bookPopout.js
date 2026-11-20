import { elementFromHtmlLike } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";

function popoutApi() {
  return typeof PopoutModule === "undefined" ? null : PopoutModule;
}

export function findPrototypePopout(id) {
  if (globalThis.game?.modules?.get?.("popout")?.active !== true) return null;
  const entries = popoutApi()?.singleton?.poppedOut?.values?.();
  if (!entries) return null;
  return Array.from(entries).find((state) => state?.app?.id === id
    && state.window && !state.window.closed) ?? null;
}

function outerFor(app) {
  return elementFromHtmlLike(app?.element) ?? app?.root?.closest?.(".window-app") ?? app?.root;
}

function returnControl(app, poppedOut) {
  const outer = outerFor(app);
  if (!poppedOut || !outer?.ownerDocument || outer.ownerDocument === globalThis.document) return null;
  const control = outer.querySelector?.(".window-header .popout-module-button");
  return typeof control?.click === "function" ? control : null;
}

export function getPrototypePopoutState(app) {
  const moduleActive = globalThis.game?.modules?.get?.("popout")?.active === true;
  const unavailable = (reason) => ({ moduleActive, available: false, reason, label: t("Open in separate window"), poppedOut: false, action: "open" });
  if (!app) return unavailable(t("Open a spellbook first."));
  if (!moduleActive) {
    return unavailable(t("PopOut! is unavailable."));
  }
  if (/ electron\//i.test(globalThis.navigator?.userAgent ?? "")) {
    return unavailable(t("Available in a regular browser. PopOut! does not support the Foundry desktop application."));
  }
  const api = popoutApi();
  if (typeof api?.popoutApp !== "function") return unavailable(t("PopOut! is not ready. Reopen the spellbook after the world has loaded."));
  if (app.functionality?.busy) return unavailable(t("Wait for the current spellbook action to finish."));
  const state = api.singleton?.poppedOut?.get?.(app.appId || app.id);
  const poppedOut = Boolean(state?.window && !state.window.closed);
  const owner = outerFor(app)?.ownerDocument;
  const action = poppedOut && owner && owner !== globalThis.document ? "return" : poppedOut ? "focus" : "open";
  const label = action === "return" ? t("Return to main window") : action === "focus" ? t("Focus separate window") : t("Open in separate window");
  return { moduleActive, available: true, reason: "", label, poppedOut, action };
}

export function openPrototypePopout(app) {
  const state = getPrototypePopoutState(app);
  if (!state.available) return { ...state, requested: false };
  if (state.action !== "focus") {
    if (app.functionality?.panels?.close?.({ restoreFocus: false }) === false) {
      return { ...state, requested: false, reason: t("Finish editing the inscription name before moving this spellbook to another window.") };
    }
    app.controller?.cancelActiveTurn?.({ restore: true });
  }
  if (state.action === "return") {

    app._preparePopin?.();
    try {
      const control = returnControl(app, true);
      if (control) control.click();
      else {

        popoutApi().singleton.poppedOut.get(app.appId || app.id).window.close();
      }
    }
    catch (error) { app._cancelPopin?.(); throw error; }
  } else popoutApi().popoutApp(app);
  return { ...state, requested: true };
}
