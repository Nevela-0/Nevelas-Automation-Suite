import { elementFromHtmlLike } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class PrototypeBookShell {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    const Abort = root.ownerDocument?.defaultView?.AbortController ?? AbortController;
    this.abort = new Abort();
    this.gesture = null;
    this.frame = null;
    this.frameWindow = null;
    this.settingsNavigationToken = 0;
  }

  bind() {
    const options = { signal: this.abort.signal };
    this.root.addEventListener("click", (event) => {
      const action = event.target.closest("[data-proto-action]")?.dataset.protoAction;
      if (action === "show-settings") { event.preventDefault(); this.showSettings(); }
      else if (action === "toggle-search") { event.preventDefault(); this.toggleSearch(); }
      else if (action === "popout-book") { event.preventDefault(); this.app.openSeparateWindow?.(); }
      else if (action === "dismiss-book") { event.preventDefault(); void this.dismiss(); }
      else if (action === "close-cover" || event.target.closest(".nas-proto-cover-front")) this.root.querySelector(".nas-proto-book-stage")?.focus();
    }, options);
    this.root.addEventListener("pointerdown", event => {
      if (event.target.closest?.("[data-proto-action]")?.dataset.protoAction === "dismiss-book") {

        event.preventDefault();
        return;
      }
      if (!this.app.closeConfirmationOpen) this.app.bringToFront?.();
    }, { ...options, capture: true });
    for (const [selector, kind] of [["[data-proto-drag]", "move"], ["[data-proto-resize]", "resize"]]) {
      const handle = this.root.querySelector(selector);
      handle?.addEventListener("pointerdown", (event) => this._start(event, handle, kind), options);
      handle?.addEventListener("pointermove", (event) => this._move(event), options);
      handle?.addEventListener("pointerup", (event) => this._finish(event), options);
      handle?.addEventListener("pointercancel", (event) => this._finish(event), options);
      handle?.addEventListener("lostpointercapture", (event) => this._finish(event), options);
      handle?.addEventListener("keydown", (event) => this._keyMove(event, kind), options);
    }
    const doc = this.root.ownerDocument;
    doc.addEventListener("pointerdown", (event) => {
      if (this.app.closeConfirmationOpen) return;
      const tray = this.root.querySelector("[data-proto-search-tray]");
      if (!tray?.hidden && !tray?.contains(event.target) && !event.target.closest?.("[data-proto-action='toggle-search']")) this.hideSearch();
    }, options);

    this.root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.app.searchOpen) { this.hideSearch(); this.root.querySelector("[data-proto-action='toggle-search']")?.focus(); }
      else if (this.gesture) this._finish();
      else void this.dismiss();
    }, { ...options, capture: true });
    this.root.addEventListener("keydown", event => {
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) event.stopPropagation();
    }, options);
    this.sync();
    return this;
  }

  showSettings({ management = false } = {}) {
    if (this.app.functionality?.busy || this.app.dismissing
      || this.root.querySelector(".nas-proto-book-stage")?.dataset.cover === "moving") return;
    this.hideSearch();
    if (!this.app.coverOpen) {
      this.app.controller?.setCover(true, { animate: false });
      this.app.coverOpen = true;
    }
    const token = ++this.settingsNavigationToken;
    this.app._navigateToFace(0, { onComplete: () => {
      if (token !== this.settingsNavigationToken || this.abort.signal.aborted || this.app.dismissing
        || (this.app.root && this.app.root !== this.root)) return;
      let focus = this.root.querySelector("[data-proto-control='book']") ?? this.root.querySelector("[data-proto-control='motion']");
      if (management) {
        const section = this.root.querySelector("[data-proto-management]");
        if (section) section.open = true;
        focus = this.root.querySelector("[data-proto-control='managed']") ?? focus;
      }
      focus?.focus();
      this.sync();
    } });
    this.sync();
  }

  toggleSearch() {
    if (this.app.dismissing) return;
    if (this.app.searchOpen) { this.hideSearch(); return; }
    if (!this.root.querySelector("[data-proto-search-tray]")) return;
    this.app.controller?.setCover(true, { animate: false });
    this.app.coverOpen = true;
    this.app.searchOpen = true;
    this.sync();
    this.root.querySelector("[data-proto-search]")?.focus();
  }

  hideSearch() {
    this.app.searchOpen = false;
    this.app.functionality?._dismissSearch();
    this.sync();
  }

  sync() {
    const stage = this.root.querySelector(".nas-proto-book-stage");
    const open = !this.app.dismissing && this.app.coverOpen && (!stage || stage.dataset.cover === "open");
    const tray = this.root.querySelector("[data-proto-search-tray]");
    if (tray) tray.hidden = !this.app.searchOpen;
    const detached = Boolean(globalThis.document && this.root.ownerDocument !== globalThis.document);
    for (const node of this.root.querySelectorAll("[data-proto-open-only]")) {
      const windowHandle = node.hasAttribute?.("data-proto-drag") || node.hasAttribute?.("data-proto-resize");
      const show = open && (node !== tray || this.app.searchOpen) && !(detached && windowHandle);
      node.hidden = !show;
      node.toggleAttribute?.("inert", !show);

      if (show) node.style?.removeProperty("display");
      else node.style?.setProperty("display", "none", "important");
    }
    const search = this.root.querySelector("[data-proto-action='toggle-search']");
    search?.setAttribute("aria-expanded", this.app.searchOpen ? "true" : "false");
    const setup = this.root.querySelector("[data-proto-action='show-settings']");
    setup?.setAttribute("aria-pressed", this.app.coverOpen && this.app.cursor === 0 ? "true" : "false");
    const navigating = this.app.controller?.isNavigating === true;
    const coverMoving = stage?.dataset.cover === "moving";
    const moving = navigating || coverMoving || (this.app.controller && !["idle", "peeling"].includes(this.app.controller.phase));
    for (const node of this.root.querySelectorAll("[data-proto-action='show-settings'], [data-proto-action='toggle-search'], [data-proto-action='close-cover']")) {
      const canRetarget = node.dataset.protoAction === "show-settings" && navigating && !coverMoving;
      node.disabled = Boolean((moving && !canRetarget) || this.app.functionality?.busy || this.app.dismissing
        || (node.dataset.protoAction === "close-cover" && !this.app.coverOpen));
    }
    this.app.syncPopoutControl?.();
  }

  dismiss() {
    return typeof this.app.dismissBook === "function" ? this.app.dismissBook() : this.app.close();
  }

  _bounds() {
    const outer = elementFromHtmlLike(this.app.element) ?? this.root;
    return outer.getBoundingClientRect();
  }

  _start(event, handle, kind) {
    if (event.button !== 0 || this.gesture) return;
    event.preventDefault();
    event.stopPropagation();
    this.app.controller?.cancelActiveTurn({ restore: true });
    const rect = this._bounds();
    this.gesture = { kind, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height, nextX: event.clientX, nextY: event.clientY };
    handle.setPointerCapture?.(event.pointerId);
  }

  _move(event) {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    event.preventDefault();
    this.gesture.nextX = event.clientX;
    this.gesture.nextY = event.clientY;
    if (this.frame === null) {
      const owner = this.root.ownerDocument?.defaultView;
      this.frameWindow = typeof owner?.requestAnimationFrame === "function" ? owner : globalThis;
      this.frame = this.frameWindow.requestAnimationFrame(() => { this.frame = null; this._flush(); });
    }
  }

  _flush() {
    const state = this.gesture;
    if (!state) return;
    const win = this.root.ownerDocument.defaultView;
    const dx = state.nextX - state.x, dy = state.nextY - state.y;
    if (state.kind === "resize") {
      const max = Math.max(360, Math.min(1200, win.innerWidth - Math.max(0, state.left) - 8));
      this.app.setPosition({ width: clamp(state.width + dx, Math.min(720, max), max) });
    } else this.app.setPosition({
      left: clamp(state.left + dx, 0, Math.max(0, win.innerWidth - state.width)),
      top: clamp(state.top + dy, 0, Math.max(0, win.innerHeight - state.height))
    });
  }

  _finish(event) {
    const state = this.gesture;
    if (!state || (event && event.pointerId !== state.pointerId)) return;
    if (event?.type === "pointerup") { state.nextX = event.clientX; state.nextY = event.clientY; }
    if (this.frame !== null) { this.frameWindow.cancelAnimationFrame(this.frame); this.frame = null; }
    this._flush();
    this.gesture = null;
    if (state.handle.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
  }

  _keyMove(event, kind) {
    if (this.gesture) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this._bounds(), step = event.shiftKey ? 40 : 10;
    this.app.controller?.cancelActiveTurn({ restore: true });
    this.gesture = { kind, left: rect.left, top: rect.top, width: rect.width, height: rect.height, x: 0, y: 0,
      nextX: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      nextY: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 };
    this._flush();
    this.gesture = null;
  }

  destroy() {
    this._finish();
    this.abort.abort();
  }
}
