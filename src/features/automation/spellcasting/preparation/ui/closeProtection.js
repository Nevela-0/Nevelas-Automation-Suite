import { elementFromHtmlLike } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";
const APPROVED_CLOSE = Symbol("spellbook-approved-close");

export function approvedPrototypeClose(options = {}) {
  return Object.defineProperty({ ...options }, APPROVED_CLOSE, { value: true });
}

export function isApprovedPrototypeClose(options) {
  return options?.[APPROVED_CLOSE] === true;
}

export function confirmPrototypeDiscard(app) {
  const doc = app.root?.ownerDocument ?? elementFromHtmlLike(app.element)?.ownerDocument ?? globalThis.document;
  const owner = doc?.defaultView;
  if (!doc?.createElement || !doc.body?.appendChild) {
    return Promise.resolve(owner?.confirm?.(t("Discard unsaved spellbook changes and close?")) === true);
  }
  const previousFocus = doc.activeElement;
  const overlay = doc.createElement("div");
  overlay.setAttribute("data-proto-close-confirm", "");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "2147483647", display: "grid", placeItems: "center",
    background: "rgba(15, 10, 7, .55)", padding: "16px"
  });
  const dialog = doc.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t("Unsaved spellbook changes"));
  Object.assign(dialog.style, {
    width: "min(430px, calc(100vw - 32px))", padding: "22px", border: "1px solid #9d8050",
    borderRadius: "5px", color: "#3d2d1d", background: "#eee0bb", boxShadow: "0 14px 42px #0008",
    fontFamily: "Georgia, serif"
  });
  const heading = doc.createElement("h2");
  heading.textContent = t("Unsaved spellbook changes");
  Object.assign(heading.style, { fontSize: "20px", margin: "0 0 12px", color: "inherit", border: "0" });
  const description = doc.createElement("p");
  description.textContent = t("Closing will discard unsaved preparation and option changes, including other spellbooks opened in this window.");
  Object.assign(description.style, { lineHeight: "1.45", margin: "0 0 20px" });
  const actions = doc.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "10px", justifyContent: "flex-end" });
  const keep = doc.createElement("button"), discard = doc.createElement("button");
  for (const button of [keep, discard]) {
    button.type = "button";
    Object.assign(button.style, { width: "auto", padding: "8px 12px", minHeight: "34px", lineHeight: "1.2" });
  }
  keep.textContent = t("Keep editing");
  discard.textContent = t("Discard and close");
  actions.append(keep, discard);
  dialog.append(heading, description, actions);
  overlay.appendChild(dialog);

  let finish;
  const answer = new Promise(resolve => {
    let settled = false;
    finish = accepted => {
      if (settled) return;
      settled = true;
      overlay.remove();
      if (!accepted && previousFocus?.isConnected !== false) {
        try { previousFocus?.focus?.({ preventScroll: true }); } catch {   }
      }
      resolve(accepted);
    };
    keep.addEventListener("click", () => finish(false));
    discard.addEventListener("click", () => finish(true));
    overlay.addEventListener("pointerdown", event => event.stopPropagation());
    overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
    overlay.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        (doc.activeElement === keep ? discard : keep).focus();
      }
    }, { capture: true });
    doc.body.appendChild(overlay);
    keep.focus();
  });
  answer.cancel = () => finish(false);
  return answer;
}

export class PrototypeCloseProtection {
  constructor(app) {
    this.app = app;
    this.pending = null;
    this.windows = new Map();
    this.approved = false;
    this.returning = false;
    this.destroyed = false;
  }

  hasUnsavedWork() {
    const ui = this.app.functionality;
    return Boolean(ui?.hasUnsavedWork?.() || ui?.panels?.hasPendingChanges?.());
  }

  request(options, proceed) {
    if (isApprovedPrototypeClose(options)) return proceed(options);
    if (this.pending) return this.pending;
    if (this.app.closePromise) return this.app.closePromise;
    if (this.app.functionality?.busy) return Promise.resolve(false);
    const finish = () => {
      if (this.destroyed || this.app.functionality?.busy) return false;
      this.approved = true;
      return proceed(approvedPrototypeClose(options));
    };
    if (!this.hasUnsavedWork()) {
      const result = finish();
      this.pending = Promise.resolve(result);
      return this.pending;
    }

    this.app.closeConfirmationOpen = true;
    const refreshSuspended = typeof this.app.functionality?.suspendRefresh === "function";
    if (refreshSuspended) this.app.functionality.suspendRefresh();
    const resumePanels = this.app.functionality?.panels?.suspendDismissal?.();
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    this.pending = pending;
    void (async () => {
      try {
        this.confirmation = this.app._confirmDiscardDraft();
        return await this.confirmation ? await finish() : false;
      } catch (error) {
        this.app.functionality?._error?.(error);
        return false;
      } finally {
        this.confirmation = null;
        this.app.closeConfirmationOpen = false;
        resumePanels?.();
        if (!this.app.dismissing && !this.destroyed) {
          this.approved = false;
          this.pending = null;
          if (refreshSuspended) this.app.functionality?.resumeRefresh?.();
        }
      }
    })().then(complete, () => complete(false));
    return pending;
  }

  beginPopin() {
    this.returning = true;
    if (this.returnTimer) globalThis.clearTimeout(this.returnTimer);
    const owner = this.app.root?.ownerDocument?.defaultView;

    this.returnTimer = globalThis.setTimeout(() => {
      this.returnTimer = null;
      if (!owner?.closed) this.returning = false;
    }, 0);
  }

  endPopin() {
    if (this.returnTimer) globalThis.clearTimeout(this.returnTimer);
    this.returnTimer = null;
    this.returning = false;
    this.approved = false;
    this.confirmation?.cancel?.();
  }

  bind(ownerWindow = this.app.root?.ownerDocument?.defaultView) {
    if (this.destroyed) return;
    const main = globalThis.document?.defaultView ?? globalThis.window;
    const desired = new Set([main, ownerWindow].filter(win => typeof win?.addEventListener === "function"));
    for (const [win, release] of this.windows) {
      if (!desired.has(win)) { release(); this.windows.delete(win); }
    }
    for (const win of desired) {
      if (this.windows.has(win)) continue;
      const beforeUnload = event => {

        if (win !== main || this.approved || this.app.dismissing) return;
        if (!this.app.functionality?.busy && !this.hasUnsavedWork()) return;
        event.preventDefault();
        event.returnValue = "";
      };
      const unload = () => {
        if (win === main) this.approved = true;
        this.confirmation?.cancel?.();
      };
      const doc = win.document;
      const nativeReturn = event => {
        const outer = elementFromHtmlLike(this.app.element);
        if (doc !== globalThis.document && outer?.contains?.(event.target)
          && event.target?.closest?.(".window-header .popout-module-button")) this.beginPopin();
      };
      win.addEventListener("beforeunload", beforeUnload);
      win.addEventListener("unload", unload);
      doc?.addEventListener?.("click", nativeReturn, { capture: true });
      this.windows.set(win, () => {
        win.removeEventListener("beforeunload", beforeUnload);
        win.removeEventListener("unload", unload);
        doc?.removeEventListener?.("click", nativeReturn, { capture: true });
      });
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.returnTimer) globalThis.clearTimeout(this.returnTimer);
    this.returnTimer = null;
    this.confirmation?.cancel?.();
    for (const release of this.windows.values()) release();
    this.windows.clear();
  }
}
