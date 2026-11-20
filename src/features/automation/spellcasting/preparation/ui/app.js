import { elementFromHtmlLike } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";
import {
  canMovePrototypeCursor,
  compilePrototypeBook,
  createPrototypeDraft,
  getPrototypeTurnSpec,
  getPrototypeView,
  normalizePrototypeCursor
} from "./bookModel.js";
import { PrototypePageTurnController } from "./pageTurnController.js";
import { PrototypeFunctionality } from "./functionalUi.js";
import { PrototypeBookShell } from "./bookShell.js";
import { clonePrototypeFaceForMotion } from "./pageTurnVisuals.js";
import { getPrototypePopoutState, openPrototypePopout } from "./bookPopout.js";
import { PrototypeCloseProtection, approvedPrototypeClose, confirmPrototypeDiscard, isApprovedPrototypeClose } from "./closeProtection.js";
import { getSpellbookAnimationMode, SPELLBOOK_ANIMATION_MODES, SPELLBOOK_PREPARATION_SETTING_KEYS } from "../settings.js";

const MODULE_ID = "nevelas-automation-suite";
const TEMPLATE_PATH = `modules/${MODULE_ID}/src/templates/spellbook/book.html`;
const PROTOTYPE_ID = "nas-spellbook-redesign-prototype";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hideBookRegion(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.style.setProperty("display", "none", "important");
  else element.style.removeProperty("display");
}

function formatFaceLabel(face) {
  if (!face) return t("No page");
  if (face.content) return t("{level}, page {number} of {total}", {level: face.levelLabel, number: face.pageNumber, total: face.pageCount});
  if (face.kind === "insideFront") return t("Inside front cover");
  if (face.kind === "insideBack") return t("Inside back cover");
  return face.title || t("Blank page");
}

export class SpellbookPrototypeApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: PROTOTYPE_ID,
      classes: ["nas-spellbook-prototype-app"],
      template: TEMPLATE_PATH,
      title: t("Spellbook"),
      width: 900,
      height: "auto",
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  static async open(actor, bookId, options = {}) {
    const { openSpellbookPrototype } = await import("./launcher.js");
    return openSpellbookPrototype({ ...options, actor, bookId });
  }

  constructor(options = {}) {
    super({}, options);
    this.fixtureKey = "actor";
    this.layoutPreference = "wide";
    this.displayMode = "wide";
    this.motionMode = getSpellbookAnimationMode();
    this.motionPreferenceSaving = false;
    this.coverOpen = false;
    this.cursor = 0;
    this.fixture = null;
    this.book = null;
    this.draft = new Map();
    this.root = null;
    this.controller = null;
    this.bookShell = null;
    this.shellPhase = null;
    this.searchOpen = false;
    this.dismissing = false;
    this.closeConfirmationOpen = false;
    this.popoutHooks = [];
    this.resizeObserver = null;
    this.observedWorkspaceWidth = null;
    this.observedWorkspaceHeight = null;
    this.fixture = { key: "actor", actorName: "", bookName: "", castingMode: "", spells: [], levels: [] };
    this.book = compilePrototypeBook(this.fixture);
    this.functionality = new PrototypeFunctionality(this, options);
  }

  getData() {
    const view = getPrototypeView(this.book, this.cursor, this.displayMode);
    const totalsByLevel = this._totalsByLevel();
    const faces = this.book.faces.map((face) => {
      const total = totalsByLevel.get(face.level) ?? 0;
      const cap = face.content ? this._levelCap(face.level) : 0;
      return {
        ...face,
        setup: face.kind === "insideFront",
        visible: view.faceIndexes.includes(face.index),
        left: this.displayMode === "wide" && view.left?.index === face.index,
        right: this.displayMode === "wide" && view.right?.index === face.index,
        single: this.displayMode === "single" && view.faceIndexes.includes(face.index),
        preparedTotal: total,
        preparedCap: cap ?? "?",
        overLimit: face.content && cap !== null && total > cap,
        spells: face.spells.map((spell) => ({
          ...spell,
          prepared: this.draft.get(spell.id) ?? 0,
          hasMetamagic: Boolean(spell.metamagic)
        }))
      };
    });

    const data = {
      fixture: this.fixture,
      motionOptions: [
        { value: "full", label: t("Full"), selected: this.motionMode === "full" },
        { value: "reduced", label: t("Reduced"), selected: this.motionMode === "reduced" },
        { value: "off", label: t("Off"), selected: this.motionMode === "off" }
      ],
      displayMode: this.displayMode,
      motionMode: this.motionMode,
      motionPreferenceSaving: this.motionPreferenceSaving,
      coverOpen: this.coverOpen,
      faces,
      bookmarks: this.book.bookmarks.map((bookmark) => ({
        ...bookmark,
        active: view.faceIndexes.some((faceIndex) => this.book.faces[faceIndex]?.level === bookmark.level)
      })),
      currentFace: this.cursor,
      maxFace: Math.max(0, this.book.faces.length - 1),
      faceStatus: this._viewStatus(view),
      canPrevious: this.coverOpen,
      canNext: !this.coverOpen || canMovePrototypeCursor(this.book, this.cursor, this.displayMode, 1)
    };
    return { ...(this.functionality?.data(data) ?? data), popout: getPrototypePopoutState(this) };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = elementFromHtmlLike(html);
    if (!root?.querySelector) return;

    this.controller?.destroy();
    this.bookShell?.destroy();
    this.bookShell = null;
    this.shellPhase = null;
    this.resizeObserver?.disconnect?.();
    this.root = root;
    this._bindDraftControls(root);
    this._bindReviewControls(root);
    this._createController(root);
    this._setupResponsiveLayout(root);
    this._syncCanonicalView(this.cursor);
    this._syncCoverState();
    this._refreshDraftUi();
    this.functionality?.bind(root);
    this.bookShell = new PrototypeBookShell(this, root).bind();
    this._syncCoverPaper();
    this._bindPopoutHooks();
    this._bindSpellbookSettings();
    this._closeProtection().bind();
    this._showRequestedOptions();

  }

  showOptions() {
    this.showOptionsAfterRender = true;
    if (this.rendered) this._showRequestedOptions();
    return this;
  }

  _showRequestedOptions() {
    if (!this.showOptionsAfterRender || !this.bookShell || this.functionality?.busy || this.dismissing) return;
    this.showOptionsAfterRender = false;
    this.bookShell.showSettings({ management: true });
  }

  _bindDraftControls(root) {
    for (const input of root.querySelectorAll(".nas-proto-prepared-count")) {
      input.addEventListener("input", () => {
        const spellId = input.dataset.spellId;
        const value = this.functionality?.normalizeCount(spellId, input.value)
          ?? Math.max(0, Math.trunc(Number(input.value) || 0));
        input.value = `${value}`;
        this.draft.set(spellId, value);
        this._refreshDraftUi();
      });
    }

    for (const button of root.querySelectorAll("[data-proto-step]")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const row = button.closest("[data-spell-id]");
        const input = row?.querySelector(".nas-proto-prepared-count");
        if (!input) return;
        const value = Number(input.value) + Number(button.dataset.protoStep || 0);
        const next = this.functionality?.normalizeCount(input.dataset.spellId, value)
          ?? Math.max(0, Math.trunc(value || 0));
        input.value = `${next}`;
        this.draft.set(input.dataset.spellId, next);
        this._refreshDraftUi();
      });
    }
  }

  syncPopoutControl() {
    const state = getPrototypePopoutState(this);
    const button = this.root?.querySelector("[data-proto-action='popout-book']");
    if (button) {
      button.disabled = !state.available || this.dismissing;
      button.setAttribute("aria-label", state.label);
      button.title = state.available ? state.label : state.reason;
      button.toggleAttribute("data-proto-popin", state.action === "return");
      if (!state.moduleActive) { hideBookRegion(button, true); button.setAttribute("inert", ""); }
    }
  }

  openSeparateWindow() {
    if (this.dismissing) return;
    try {
      const result = openPrototypePopout(this);
      if (!result.requested) this.functionality?._error(new Error(result.reason));
    } catch (error) { this.functionality?._error(error); }
  }

  _bindPopoutHooks() {
    if (this.popoutHooks.length || typeof globalThis.Hooks?.on !== "function") return;
    const loaded = Hooks.on("PopOut:loaded", (app) => {
      if (app !== this || this.dismissing || !this.root?.isConnected) return;
      this._bindOwnerDocument();
    });
    this.popoutHooks.push(["PopOut:loaded", loaded]);
    const loading = Hooks.on("PopOut:loading", (app, owner) => {
      if (app === this) this._closeProtection().bind(owner);
    });
    this.popoutHooks.push(["PopOut:loading", loading]);
    const popped = Hooks.on("PopOut:popout", (app, owner) => {
      if (app !== this) return;
      this._closeProtection().bind(owner);
      this._guardPopoutClose(owner);
    });
    this.popoutHooks.push(["PopOut:popout", popped]);
    const returned = Hooks.on("PopOut:popin", app => {
      if (app !== this) return;
      this._closeProtection().endPopin();
      this._closeProtection().bind();
    });
    this.popoutHooks.push(["PopOut:popin", returned]);
    const closed = Hooks.on("PopOut:close", (app, node) => {
      if (app !== this) return;
      if (!this.dismissing && !this._closeProtection().approved) {
        this._returnFromClosedPopout();
        return;
      }

      if (node?.style) node.style.visibility = "hidden";
      void this.close(approvedPrototypeClose({ animate: false }));
    });
    this.popoutHooks.push(["PopOut:close", closed]);
  }

  _bindOwnerDocument() {
    this.bookShell?.destroy();
    this.controller?.destroy();
    this.resizeObserver?.disconnect();
    this.functionality?.bind(this.root);
    this._createController(this.root);
    this.bookShell = new PrototypeBookShell(this, this.root).bind();
    this.observedWorkspaceWidth = this.observedWorkspaceHeight = null;
    this._setupResponsiveLayout(this.root);
    this.syncPopoutControl();
    this._closeProtection().bind();
  }

  _returnFromClosedPopout() {

    this._clearPopoutReturn();
    const transfer = {};
    this.popoutReturn = transfer;
    transfer.timer = globalThis.setTimeout(() => {
      if (this.popoutReturn === transfer) this.popoutReturn = null;
    }, 0);
    this._closeProtection().endPopin();
    this.functionality?.panels?.moveToDocument(globalThis.document);
    this._bindOwnerDocument();
    if (this.position) this.setPosition({ ...this.position });
    this.bringToTop?.();
  }

  _clearPopoutReturn() {
    if (this.popoutReturn) globalThis.clearTimeout(this.popoutReturn.timer);
    this.popoutReturn = null;
  }

  _closeProtection() {
    return this.closeProtection ??= new PrototypeCloseProtection(this);
  }

  _confirmDiscardDraft() {
    return confirmPrototypeDiscard(this);
  }

  _preparePopin() {
    this._closeProtection().beginPopin();
  }

  _cancelPopin() {
    this._closeProtection().endPopin();
  }

  _guardPopoutClose(owner) {
    if (this.close?.prototypeCloseGuard === this) return;
    const delegatedClose = this.close;
    const guarded = (...args) => this._closeProtection().request(args[0] ?? {}, async options => {

      await this._beginDismissal(options);
      const result = await delegatedClose.call(this, options, ...args.slice(1));

      if (!this.closePromise) await SpellbookPrototypeApp.prototype.close.call(this, options);
      if (owner && !owner.closed) owner.close?.();
      return result;
    });
    guarded.prototypeCloseGuard = this;
    this.close = guarded;
  }

  _bindReviewControls(root) {
    root.querySelector("[data-proto-control='motion']")?.addEventListener("change", event => {
      void this._saveMotionPreference(event.currentTarget.value);
    });
    this._syncMotionControl();
    root.querySelector("[data-proto-action='close-cover']")?.addEventListener("click", () => this.controller?.closeCover());
    for (const bookmark of root.querySelectorAll("[data-proto-bookmark]")) {
      bookmark.addEventListener("click", () => this._navigateToFace(Number(bookmark.dataset.faceIndex)));
    }
  }

  _createController(root) {
    const stage = root.querySelector(".nas-proto-book-stage");
    if (!stage) return;

    this.controller = new PrototypePageTurnController({
      root,
      stage,
      getMotionMode: () => this._effectiveMotionMode(),
      getTurnSpec: (direction) => getPrototypeTurnSpec(this.book, this.cursor, this.displayMode, direction),
      getCursor: () => this.cursor,
      jumpToCursor: (cursor) => this._syncCanonicalView(cursor),
      getFaceElement: (faceIndex) => this._faceElement(faceIndex),
      showTransitionUnderlay: (spec) => this._showTransitionUnderlay(spec),
      commitTurn: (spec) => {
        this.cursor = spec.destinationCursor;
        this._syncCanonicalView(this.cursor);
      },
      cancelTurn: (spec) => {
        this.cursor = spec.sourceCursor;
        this._syncCanonicalView(this.cursor);
      },
      getCoverOpen: () => this.coverOpen,
      prepareCover: (scrollTop) => {
        if (this.cursor !== 0) this._syncCanonicalView(0);
        this._syncCoverInteraction();
        this._syncCoverPaper(scrollTop);
        this._syncNavigationState();
      },
      setCoverOpen: (open) => {
        this.coverOpen = open;
        this._syncCoverState();
      },
      onPhaseChange: (phase, progress) => {
        if (phase !== "idle" && phase !== "peeling") this.functionality?.panels?.close({ restoreFocus: false });
        if (phase !== this.shellPhase) {
          this.shellPhase = phase;
          if (phase !== "idle") this.functionality?.previews?.hide();
          if (phase !== "idle" && phase !== "peeling") this.bookShell?.hideSearch();
          else this.bookShell?.sync();
        }
      }
    });
    this.controller.bind();
  }

  _setupResponsiveLayout(root) {
    const workspace = root.querySelector(".nas-proto-book-workspace");
    if (!workspace) return;
    const sync = () => this._syncResponsiveMode();
    const Observer = root.ownerDocument?.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (typeof Observer === "function") {
      this.resizeObserver = new Observer(sync);
      this.resizeObserver.observe(workspace);
    }
    sync();
  }

  _syncResponsiveMode() {
    if (!this.root) return;
    const workspace = this.root.querySelector(".nas-proto-book-workspace");
    const workspaceRect = workspace?.getBoundingClientRect?.();
    const width = workspaceRect?.width ?? 0;
    const height = workspaceRect?.height ?? 0;
    const widthChanged = this.observedWorkspaceWidth !== null
      && Math.abs(width - this.observedWorkspaceWidth) > 0.5;
    const heightChanged = this.observedWorkspaceHeight !== null
      && Math.abs(height - this.observedWorkspaceHeight) > 0.5;
    this.observedWorkspaceWidth = width;
    this.observedWorkspaceHeight = height;
    if ((widthChanged || heightChanged) && this.controller?.phase !== "idle") {
      this.controller.cancelActiveTurn({ restore: true });
    }
    if ((widthChanged || heightChanged) && Number.isFinite(this.position?.left) && Number.isFinite(this.position?.top)) {
      this.setPosition({ left: this.position.left, top: this.position.top });
    }

    this.layoutPreference = "wide";
    if (this.displayMode === "wide") {
      this._syncLayoutClass();
      return;
    }

    this.controller?.cancelActiveTurn({ restore: true });
    this.displayMode = "wide";
    this.cursor = normalizePrototypeCursor(this.book, this.cursor, this.displayMode);
    this._syncLayoutClass();
    this._syncCanonicalView(this.cursor);
  }

  _syncLayoutClass() {
    if (!this.root) return;
    this.root.classList.toggle("nas-proto-layout-wide", this.displayMode === "wide");
    this.root.classList.toggle("nas-proto-layout-single", this.displayMode === "single");
    const label = this.root.querySelector("[data-proto-display-mode]");
    if (label) label.textContent = this.displayMode === "wide" ? t("Two-page") : t("Single-page");
  }

  _syncMotionClass() {
    if (!this.root) return;
    for (const mode of ["full", "reduced", "off"]) {
      this.root.classList.toggle(`nas-proto-motion-${mode}`, this.motionMode === mode);
    }
  }

  _syncMotionControl() {
    const control = this.root?.querySelector?.("[data-proto-control='motion']");
    if (!control) return;
    control.value = this.motionMode;
    control.disabled = Boolean(this.motionPreferenceSaving || this.dismissing);
  }

  _bindSpellbookSettings() {
    if (this.settingsHook !== undefined || typeof globalThis.Hooks?.on !== "function") return;
    this.settingsHook = Hooks.on("nasSpellbookSettingsChanged", key => {
      if (this.dismissing) return;
      if (key === SPELLBOOK_PREPARATION_SETTING_KEYS.ANIMATION_MODE && !this.motionPreferenceSaving) {

        const mode = getSpellbookAnimationMode();
        if (mode !== this.motionMode) this._setMotionMode(mode);
      }
      if (key === SPELLBOOK_PREPARATION_SETTING_KEYS.MODE || key === "enableMetamagicAutomation") {
        this.functionality?.refresh();
      }
    });
  }

  _unbindSpellbookSettings() {
    if (this.settingsHook !== undefined) globalThis.Hooks?.off?.("nasSpellbookSettingsChanged", this.settingsHook);
    this.settingsHook = undefined;
  }

  _setMotionMode(mode) {
    this.controller?.cancelActiveTurn({ restore: true });
    this.motionMode = mode;
    this._syncMotionClass();
    this._syncMotionControl();
  }

  async _saveMotionPreference(mode) {
    if (!Object.values(SPELLBOOK_ANIMATION_MODES).includes(mode)
      || this.motionPreferenceSaving || this.dismissing || this.closeConfirmationOpen) {
      this._syncMotionControl();
      return false;
    }
    this.motionPreferenceSaving = true;
    try {
      this._setMotionMode(mode);
      const key = SPELLBOOK_PREPARATION_SETTING_KEYS.ANIMATION_MODE;
      if (globalThis.game?.settings?.settings?.has?.(`${MODULE_ID}.${key}`) !== true
        || typeof globalThis.game?.settings?.set !== "function") {
        throw new Error(t("The personal animation setting is unavailable. Reload Foundry and try again."));
      }
      await game.settings.set(MODULE_ID, key, mode);
      return true;
    } catch (error) {
      this._setMotionMode(getSpellbookAnimationMode());
      globalThis.ui?.notifications?.warn?.(t("Page motion could not be saved. {error}", { error: error?.message || t("Try again.") }));
      return false;
    } finally {
      this.motionPreferenceSaving = false;
      const mode = getSpellbookAnimationMode();
      if (!this.dismissing && mode !== this.motionMode) this._setMotionMode(mode);
      else this._syncMotionControl();
    }
  }

  _effectiveMotionMode() {
    if (this.motionMode === "off") return "off";
    const reduceMotion = this.root?.ownerDocument?.defaultView
      ?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    return reduceMotion ? "reduced" : this.motionMode;
  }

  _faceElement(faceIndex) {
    return this.root?.querySelector?.(`.nas-proto-face[data-face-index="${faceIndex}"]`) ?? null;
  }

  _showFaceAssignments(assignments) {
    if (!this.root) return;
    const assignmentMap = new Map(assignments.map((entry) => [entry.index, entry.side]));
    for (const face of this.root.querySelectorAll(".nas-proto-canonical .nas-proto-face")) {
      const index = Number(face.dataset.faceIndex);
      const side = assignmentMap.get(index);
      const visible = Boolean(side);
      face.hidden = !visible;
      face.toggleAttribute("inert", !visible);
      face.classList.toggle("nas-proto-face-active", visible);
      face.classList.toggle("nas-proto-face-left", side === "left");
      face.classList.toggle("nas-proto-face-right", side === "right");
      face.classList.toggle("nas-proto-face-single", side === "single");
    }
    this._syncCoverInteraction();
  }

  _syncCanonicalView(cursor) {
    if (!this.root) return;
    this.cursor = normalizePrototypeCursor(this.book, cursor, this.displayMode);
    const view = getPrototypeView(this.book, this.cursor, this.displayMode);
    const assignments = this.displayMode === "single"
      ? [{ index: view.faceIndexes[0], side: "single" }]
      : [
        ...(view.left ? [{ index: view.left.index, side: "left" }] : []),
        ...(view.right ? [{ index: view.right.index, side: "right" }] : [])
      ];
    this._showFaceAssignments(assignments);
    this._syncNavigationState(view);
    this._syncPageDepth(view);
    this._announceView(view);
    this.bookShell?.sync();
  }

  _syncCoverPaper(scrollTop = 0) {
    const source = this._faceElement(0);
    const target = this.root?.querySelector(".nas-proto-cover-endpaper");
    if (!source || !target) return;
    const snapshot = clonePrototypeFaceForMotion(source);
    if (!snapshot) return;
    snapshot.classList.remove("nas-proto-motion-source", "nas-proto-face-single", "nas-proto-face-right");
    snapshot.classList.add("nas-proto-cover-endpaper", "nas-proto-cover-snapshot", "nas-proto-face-left");
    target.replaceWith(snapshot);
    const settingsPage = snapshot.querySelector(".nas-proto-setup-page");
    if (settingsPage) settingsPage.scrollTop = scrollTop;
  }

  _showTransitionUnderlay(spec) {
    if (this.displayMode === "single") {
      this._showFaceAssignments([{ index: spec.destinationView.faceIndexes[0], side: "single" }]);
      return;
    }

    const assignments = spec.direction > 0
      ? [
        ...(spec.sourceView.left ? [{ index: spec.sourceView.left.index, side: "left" }] : []),
        ...(spec.destinationView.right ? [{ index: spec.destinationView.right.index, side: "right" }] : [])
      ]
      : [
        ...(spec.destinationView.left ? [{ index: spec.destinationView.left.index, side: "left" }] : []),
        ...(spec.sourceView.right ? [{ index: spec.sourceView.right.index, side: "right" }] : [])
      ];
    this._showFaceAssignments(assignments);
  }

  _syncNavigationState(view = getPrototypeView(this.book, this.cursor, this.displayMode)) {
    if (!this.root) return;
    const previous = this.root.querySelector("[data-proto-turn='previous']");
    const next = this.root.querySelector("[data-proto-turn='next']");
    const coverMoving = this.root.querySelector(".nas-proto-book-stage")?.dataset.cover === "moving";
    const canPrevious = !coverMoving && this.coverOpen;
    const canNext = !coverMoving && (!this.coverOpen || canMovePrototypeCursor(this.book, this.cursor, this.displayMode, 1));
    if (previous) previous.disabled = !canPrevious;
    if (next) next.disabled = !canNext;
    previous?.setAttribute("aria-label", this.cursor === 0 ? t("Close the spellbook") : t("Turn to the previous page"));
    next?.setAttribute("aria-label", this.coverOpen ? t("Turn to the next page") : t("Open the spellbook"));

    for (const bookmark of this.root.querySelectorAll("[data-proto-bookmark]")) {
      bookmark.disabled = coverMoving || !this.coverOpen;
      const level = Number(bookmark.dataset.level);
      bookmark.classList.toggle(
        "nas-proto-bookmark-active",
        view.faceIndexes.some((faceIndex) => this.book.faces[faceIndex]?.level === level)
      );
    }

    const range = this.root.querySelector("[data-proto-control='face']");
    if (range) {
      range.value = `${this.cursor}`;
      range.disabled = coverMoving || !this.coverOpen;
    }
    const progress = this.root.querySelector("[data-proto-control='progress']");
    if (progress) progress.disabled = coverMoving || !this.coverOpen;
  }

  _syncCoverInteraction() {
    if (!this.root) return;
    const stage = this.root.querySelector(".nas-proto-book-stage");
    const moving = stage?.dataset.cover === "moving";
    const canonical = this.root.querySelector(".nas-proto-canonical");
    canonical?.toggleAttribute("inert", moving || !this.coverOpen);

    hideBookRegion(canonical, !moving && !this.coverOpen);
    const insideFront = this._faceElement(0);
    if (insideFront) hideBookRegion(insideFront, moving || !insideFront.classList.contains("nas-proto-face-active"));
    const cover = this.root.querySelector("[data-proto-cover]");
    cover?.toggleAttribute("inert", moving || this.coverOpen);
    cover?.setAttribute("aria-hidden", moving || this.coverOpen ? "true" : "false");
    const front = cover?.querySelector(".nas-proto-cover-front");
    if (front) front.disabled = moving || this.coverOpen;
    hideBookRegion(cover?.querySelector(".nas-proto-cover-inside"), !moving);
  }

  _syncCoverState() {
    if (!this.root) return;
    const stage = this.root.querySelector(".nas-proto-book-stage");
    if (stage) stage.dataset.cover = this.coverOpen ? "open" : "closed";
    this._syncCoverInteraction();
    this._syncNavigationState();
    this._announceView(getPrototypeView(this.book, this.cursor, this.displayMode));
  }

  _syncPageDepth(view) {
    const stage = this.root?.querySelector?.(".nas-proto-book-stage");
    if (!stage) return;

    const lastSpread = normalizePrototypeCursor(this.book, this.book.faces.length - 1, "wide");
    const currentSpread = normalizePrototypeCursor(this.book, view.cursor, "wide");
    const progress = lastSpread > 0 ? clamp(currentSpread / lastSpread, 0, 1) : 0;
    const leftDepth = Math.round(progress * 6 * 100) / 100;
    const rightDepth = 6 - leftDepth;
    stage.style.setProperty("--nas-proto-book-progress", `${progress}`);
    stage.style.setProperty("--nas-proto-left-depth", `${leftDepth}px`);
    stage.style.setProperty("--nas-proto-right-depth", `${rightDepth}px`);
    const leftStack = stage.querySelector(".nas-proto-page-stack-left");
    const rightStack = stage.querySelector(".nas-proto-page-stack-right");
    if (leftStack) leftStack.hidden = leftDepth === 0;
    if (rightStack) rightStack.hidden = rightDepth === 0;
  }

  _announceView(view) {
    const status = this._viewStatus(view);
    const visible = this.root?.querySelector?.(".nas-proto-view-status");
    const live = this.root?.querySelector?.(".nas-proto-live-region");
    this.root?.querySelector(".nas-proto-canonical")?.setAttribute("aria-label", status);
    if (visible) visible.textContent = status;
    if (live) live.textContent = status;
  }

  _viewStatus(view) {
    if (!this.coverOpen) return t("Closed spellbook");
    return view.faceIndexes
      .map((faceIndex) => formatFaceLabel(this.book.faces[faceIndex]))
      .join(" | ");
  }

  _jumpToFace(faceIndex) {
    if (!this.coverOpen || this.root?.querySelector(".nas-proto-book-stage")?.dataset.cover === "moving") return;
    this.controller?.cancelActiveTurn({ restore: true });
    this.functionality?.panels?.close({ restoreFocus: false });
    this.cursor = normalizePrototypeCursor(this.book, faceIndex, this.displayMode);
    this._syncCanonicalView(this.cursor);
  }

  _navigateToFace(faceIndex, { onComplete } = {}) {
    if (!this.coverOpen || this.dismissing || this.functionality?.busy
      || this.root?.querySelector(".nas-proto-book-stage")?.dataset.cover === "moving") return false;
    this.functionality?.panels?.close({ restoreFocus: false });
    const target = normalizePrototypeCursor(this.book, faceIndex, this.displayMode);
    return this.controller?.navigateTo(target, { onComplete }) ?? false;
  }

  _levelCap(level) {
    return this.functionality?.levelCap?.(level) ?? null;
  }

  _totalsByLevel() {
    return this.functionality?.totalsByLevel?.() ?? new Map();
  }

  _refreshDraftUi() {
    if (!this.root) return;
    for (const input of this.root.querySelectorAll(".nas-proto-canonical .nas-proto-prepared-count")) {
      input.value = `${this.draft.get(input.dataset.spellId) ?? 0}`;
    }
    const totals = this._totalsByLevel();
    for (const counter of this.root.querySelectorAll("[data-proto-level-counter]")) {
      const level = Number(counter.dataset.level);
      const total = totals.get(level) ?? 0;
      const cap = this._levelCap(level);
      counter.textContent = `${total} / ${cap ?? "?"}`;
      counter.closest(".nas-proto-page-header")?.classList.toggle("nas-proto-over-limit", cap !== null && total > cap);
    }
    this.functionality?.refresh();
  }

  async _updateObject(_event, _formData) {
    return this.functionality?.apply();
  }

  async _beginDismissal(options = {}) {
    if (this.dismissFade) return this.dismissFade;
    this.dismissing = true;
    this.searchOpen = false;
    const root = this.root;
    const outer = elementFromHtmlLike(this.element);
    this.bookShell?.sync();
    this.bookShell?.destroy();
    this.resizeObserver?.disconnect();
    this.controller?.pauseForDismissal?.();
    if (this.functionality) {
      this.functionality.bindAbort?.abort();
      this.functionality.destroyed = true;
      this.functionality.contextToken = (this.functionality.contextToken ?? 0) + 1;
    }
    this.functionality?.panels?.close({ restoreFocus: false, discardDraft: true });
    if (root) { root.dataset.dismiss = "true"; root.setAttribute("inert", ""); }
    if (outer) {
      const rect = outer.getBoundingClientRect();

      outer.style.width = `${rect.width}px`;
      outer.style.height = `${rect.height}px`;
      const owner = outer.ownerDocument?.defaultView;
      if (owner && outer.ownerDocument !== globalThis.document) {

        owner.addEventListener("unload", () => outer.remove(), { once: true });
      }
    }
    const motion = this._effectiveMotionMode();
    const duration = options.animate === false || motion === "off" ? 0 : motion === "reduced" ? 80 : 140;
    this.dismissFade = (async () => {
      if (!outer || !duration || typeof outer.animate !== "function") return;
      try {
        this.dismissAnimation = outer.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease-out", fill: "forwards" });
        await this.dismissAnimation.finished;
      } catch (_error) {   }
    })();
    return this.dismissFade;
  }

  async dismissBook(options = {}) {

    return this._closeProtection().request(options, async approved => {
      await this._beginDismissal(approved);
      return this.close(approvedPrototypeClose({ ...approved, animate: false }));
    });
  }

  async close(options = {}) {
    if (this.popoutReturn && !isApprovedPrototypeClose(options)) {
      this._clearPopoutReturn();
      return false;
    }
    return this._closeProtection().request(options, approved => {
      if (!this.closePromise) this.closePromise = this._finishDismissal(approved);
      return this.closePromise;
    });
  }

  async _finishDismissal(options) {
    this._clearPopoutReturn();
    const outer = elementFromHtmlLike(this.element);
    await this._beginDismissal(options);
    this.closeProtection?.destroy();
    this._unbindSpellbookSettings();
    this.bookShell?.destroy();
    this.bookShell = null;
    this.functionality?.destroy();
    this.controller?.destroy();
    this.controller = null;
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    this.observedWorkspaceWidth = null;
    this.observedWorkspaceHeight = null;
    this.root = null;
    for (const [name, hook] of this.popoutHooks) globalThis.Hooks?.off?.(name, hook);
    this.popoutHooks = [];
    try { return await super.close({ ...options, submit: false, animate: false }); }
    finally {

      outer?.remove?.();
      this.dismissAnimation?.cancel();
    }
  }
}

export { PROTOTYPE_ID };

export { SpellbookPrototypeApp as SpellbookPreparationApp };
