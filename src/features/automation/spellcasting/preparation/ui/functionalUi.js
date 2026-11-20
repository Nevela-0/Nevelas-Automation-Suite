import { createNasId } from "../../../utils/nasIds.js";
import { clonePlainData } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";
import { compilePrototypeBook, createPrototypeDraft, normalizePrototypeCursor } from "./bookModel.js";
import { applyActorPreparation, getActorPreparationValidation, getActorSpellbookChoices, importActorSpells, loadActorSpellbook, startEmptyActorSpellbook } from "../actorPreparation.js";
import { buildPrototypeSpellName, createSpellPanels } from "./spellPanels.js";
import { getKnownSpells } from "../knownSpells.js";
import { getGeneratedPreparedSpellItemFlag, getSourceItemForKnownSpell } from "../preparedItems.js";
import { calculatePreparedSlotLevel, getMetamagicSummary, normalizeMetamagicSelections } from "../metamagicInscription.js";
import { isSpellbookManagementEnabled } from "../preferences.js";
import { saveSpellbookOptions } from "../management.js";
import { contextHasDirtyOptions, contextHasDirtyPreparation, draftMetadata as metadata, rebasePreparation } from "./draftRefresh.js";
import { getPrototypeSlotCounterLabels, getPrototypeSlotInformation } from "./slotInformation.js";
import { getPendingSpellbookIds } from "../flags.js";
import { planRandomSpellbookPreparation } from "../randomPreparation.js";
import { PrototypeSpellPreviews } from "./spellPreviews.js";
import { isSpellbookPreparationFullModeEnabled } from "../settings.js";

const text = (value) => `${value ?? ""}`.trim();
const actorKey = (actor, bookId) => `${actor?.uuid || actor?.id || "actor"}:${bookId}`;
const displayName = (spell) => buildPrototypeSpellName(spell.name, spell.preparedEntry);
const removalLabel = (spell) => spell?.isVariant ? t("Remove inscription") : t("Remove from spellbook");
const sameActor = (a, b) => a === b || Boolean(a && b && a.uuid && b.uuid && a.uuid === b.uuid);
const tokenKey = actor => actor?.token?.uuid || (actor?.uuid?.includes(".Token.") ? actor.uuid.slice(0, actor.uuid.lastIndexOf(".Actor.")) : null);

function actorForRefresh(tracked, changed) {
  if (sameActor(tracked, changed)) return changed;
  if (!tokenKey(tracked) || tokenKey(changed)) return null;
  const token = tracked.token ?? tracked.parent;
  if (token?.isLinked === true || token?.actorLink === true || !sameActor(token?.baseActor, changed)) return null;

  return sameActor(token?.actor, tracked) ? token.actor : null;
}

export class PrototypeFunctionality {
  constructor(app, options = {}) {
    this.app = app;
    this.actor = null;
    this.bookId = "";
    this.root = null;
    this.contexts = new Map();
    this.contextToken = 0;
    this.busy = false;
    this.destroyed = false;
    this.search = "";
    this.searchDismissed = false;
    this.selectedSpellId = "";
    this.managementEnabled = true;
    this.restMode = "inherit";
    this.notice = "";
    this.lastSaveError = "";
    this.restRefreshes = new Map();
    this.restRequests = new Map();
    this.documentRefreshes = new Map();
    this.liveHooks = [];
    this.refreshSuspensions = 0;
    this.randomRestOperations = new Map();
    this.unavailableActors = new Set();
    this.refreshTimer = null;
    this.restHook = globalThis.Hooks?.on?.("nasSpellbookPreparationRestCompleted", (actor, { bookIds = [] } = {}) => {
      if (this.destroyed) return;
      for (const bookId of bookIds) {
        const key = actorKey(actor, bookId);
        if ((this.isActor && key === actorKey(this.actor, this.bookId)) || this.contexts.has(key)) {
          this.restRefreshes.set(key, { actor, bookId });
        }
      }
      this._flushRestRefreshes();
      this._renderRestRequests();
    });
    this.panels = createSpellPanels({ onError: (error) => this._error(error) });
    this.previews = new PrototypeSpellPreviews({
      getSpell: id => {
        const spell = this.app.fixture.spells.find(entry => entry.id === id);
        return spell ? this._panelSpell(spell) : null;
      },
      canShow: () => !this.destroyed && !this.busy && this.refreshSuspensions === 0
        && this.app.coverOpen && !this.app.closeConfirmationOpen && !this.app.dismissing && !this.panels.active
        && (!this.app.controller?.phase || this.app.controller.phase === "idle")
    });
    const hook = (name, callback) => {
      const id = globalThis.Hooks?.on?.(name, callback);
      if (id !== undefined) this.liveHooks.push([name, id]);
    };
    hook("nasSpellbookRandomPreparationStarted", (actor, { bookId } = {}) => {
      if (!this._trackedContexts(actor).some(([, context]) => context.bookId === bookId)) return;
      this.flushPendingEdits();
      const key = actorKey(actor, bookId);
      this.randomRestOperations.set(key, (this.randomRestOperations.get(key) ?? 0) + 1);
      this.suspendRefresh();
      this.previews.hide();
      this.refresh();
    });
    hook("nasSpellbookRandomPreparationFinished", (actor, { bookId } = {}) => {
      const key = actorKey(actor, bookId), count = this.randomRestOperations.get(key) ?? 0;
      if (!count) return;
      if (count === 1) this.randomRestOperations.delete(key);
      else this.randomRestOperations.set(key, count - 1);
      this.refreshSuspensions = Math.max(0, this.refreshSuspensions - 1);
      this._scheduleDocumentRefresh();
      this.refresh();
    });
    for (const name of ["createItem", "updateItem", "deleteItem"]) hook(name, item => this._onItemChanged(item));
    hook("updateActor", actor => this._queueActorRefresh(actor));
    hook("deleteActor", actor => { this.unavailableActors.add(actor?.uuid || actor?.id); this._queueActorRefresh(actor); });
    hook("createActor", actor => { this.unavailableActors.delete(actor?.uuid || actor?.id); this._queueActorRefresh(actor); });
    hook("updateToken", (token, changes = {}) => {
      if (Object.keys(changes).some(key => /^(delta|actorData|actorId|actorLink)(\.|$)/.test(key))) this._onTokenChanged(token);
    });
    hook("deleteToken", token => this._onTokenChanged(token, true));
    if (options.actor) {
      try { this._activate(options.actor, options.bookId || getActorSpellbookChoices(options.actor)[0]?.id, false); }
      catch (error) { this._error(error); }
    }
    if (Array.isArray(options.restBookIds)) this.requestPreparationAfterRest(options.actor, options.restBookIds);
  }

  requestPreparationAfterRest(actor, bookIds) {
    if (this.destroyed || !actor || !Array.isArray(bookIds)) return;
    for (const bookId of bookIds.map(text).filter(Boolean)) {
      this.restRequests.set(actorKey(actor, bookId), { actor, bookId });
    }

    this._renderRestRequests();
  }

  _restRequestChoices() {
    const requests = [];
    for (const [key, request] of this.restRequests) {
      const { actor, bookId } = request;
      const book = getActorSpellbookChoices(actor).find(choice => choice.id === bookId);
      if (!book || actor.isOwner !== true || this.unavailableActors.has(actor.uuid || actor.id)
        || !isSpellbookManagementEnabled(actor, bookId) || !getPendingSpellbookIds(actor).includes(bookId)) {
        this.restRequests.delete(key);
        continue;
      }
      const actorLabel = `${tokenKey(actor) ? "[Token] " : ""}${actor.name}`;
      requests.push({ key, label: `${actorLabel} — ${book.label}`, current: sameActor(actor, this.actor) && bookId === this.bookId });
    }
    return requests;
  }

  _renderRestRequests() {
    const tray = this.root?.querySelector?.("[data-proto-rest-requests]");
    const owner = tray?.ownerDocument;
    if (!tray || !owner?.createElement) return;
    const requests = this._restRequestChoices();
    const blocked = this.busy || this.destroyed || this.refreshSuspensions > 0 || this.app.closeConfirmationOpen || this.app.dismissing;
    const signature = JSON.stringify([requests, blocked]);
    if (tray.dataset.requests === signature) return;
    tray.dataset.requests = signature;
    tray.hidden = requests.length === 0;
    tray.replaceChildren();
    if (!requests.length) return;
    const label = owner.createElement("span");
    label.textContent = t("Prepare after resting:");
    tray.append(label);
    const list = owner.createElement("div");
    list.className = "nas-proto-rest-request-list";
    for (const request of requests) {
      const button = owner.createElement("button");
      button.type = "button";
      button.dataset.protoRestKey = request.key;
      button.textContent = request.label;
      button.title = t("Prepare {name}", {name: request.label});
      button.disabled = blocked || request.current;
      if (request.current) button.setAttribute("aria-current", "true");
      list.append(button);
    }
    tray.append(list);
  }

  openRestPreparation(key) {
    if (this.busy || this.destroyed || this.refreshSuspensions > 0 || this.app.closeConfirmationOpen || this.app.dismissing) return false;
    if (!this._restRequestChoices().some(request => request.key === key)) return false;
    const request = this.restRequests.get(key);
    this.flushPendingEdits();
    return this.connectActor(request.actor, request.bookId);
  }

  get isActor() { return Boolean(this.actor && this.bookId); }
  get canEditActor() { return this.isActor && this.actor.isOwner === true && !this.app.fixture.unavailableReason; }
  get canPrepare() { return this.canEditActor && isSpellbookPreparationFullModeEnabled() && this.refreshSuspensions === 0 && this.managementEnabled && isSpellbookManagementEnabled(this.actor, this.bookId); }

  hasOptionsDirty() {
    if (!this.isActor) return false;
    const saved = this.app.fixture.preferences ?? { enabled: true, restMode: "inherit" };
    return this.managementEnabled !== saved.enabled || this.restMode !== saved.restMode;
  }

  _baseline(fixture) {
    this.savedCounts = new Map(fixture.spells.map((spell) => [spell.id, Number(spell.prepared) || 0]));
    this.savedMetadata = metadata(fixture);
  }

  hasDirty() {
    if (!this.isActor) return false;
    return contextHasDirtyPreparation({ fixture: this.app.fixture, draft: this.app.draft, savedCounts: this.savedCounts, savedMetadata: this.savedMetadata });
  }

  hasUnsavedWork() {
    if (this.isActor && (this.hasDirty() || this.hasOptionsDirty() || this.panels.hasPendingChanges?.())) return true;
    const current = this.isActor ? actorKey(this.actor, this.bookId) : null;
    return [...this.contexts].some(([key, context]) => key !== current && (contextHasDirtyPreparation(context) || contextHasDirtyOptions(context)));
  }

  flushPendingEdits() {
    if (this.isActor && this.root) {
      for (const input of this.root.querySelectorAll?.(".nas-proto-canonical .nas-proto-prepared-count[data-spell-id]") ?? []) {
        const id = input.dataset.spellId;
        if (!input.disabled && this.app.draft.has(id)) this.app.draft.set(id, this.normalizeCount(id, input.value));
      }
      const managed = this.root.querySelector("[data-proto-control='managed']");
      const rest = this.root.querySelector("[data-proto-control='rest-mode']");
      if (managed && !managed.disabled) this.managementEnabled = managed.checked;
      if (rest && !rest.disabled) this.restMode = rest.value;
    }
    this.panels.flushPendingChanges?.();
    this._saveContext();
  }

  suspendRefresh() { this.refreshSuspensions += 1; }
  resumeRefresh() {
    this.refreshSuspensions = Math.max(0, this.refreshSuspensions - 1);
    this._flushRestRefreshes();
  }

  _allContexts() {
    const contexts = new Map(this.contexts);
    if (this.isActor) contexts.set(actorKey(this.actor, this.bookId), { actor: this.actor, bookId: this.bookId, fixture: this.app.fixture });
    return contexts;
  }

  _trackedContexts(actor) {
    return [...this._allContexts()].flatMap(([key, context]) => {
      const refreshed = actorForRefresh(context.actor, actor);
      return refreshed ? [[key, { ...context, actor: refreshed }]] : [];
    });
  }

  _onTokenChanged(token, deleted = false) {
    if (this.destroyed) return;
    for (const request of this.restRequests.values()) {
      if (tokenKey(request.actor) !== token.uuid && request.actor.token !== token && request.actor.parent !== token) continue;
      if (deleted || !sameActor(request.actor, token.actor)) this.unavailableActors.add(request.actor.uuid || request.actor.id);
      else request.actor = token.actor;
    }
    this._renderRestRequests();
    for (const [key, context] of this._allContexts()) {
      const actor = context.actor;
      if (!tokenKey(actor)) continue;
      const matchesToken = (token.uuid && tokenKey(actor) === token.uuid) || actor.token === token || actor.parent === token
        || (deleted && sameActor(actor, token.actor));
      if (!matchesToken) continue;
      if (deleted || !sameActor(actor, token.actor)) this.unavailableActors.add(actor.uuid || actor.id);
      else this.unavailableActors.delete(actor.uuid || actor.id);
      this.documentRefreshes.set(key, { actor: !deleted && sameActor(actor, token.actor) ? token.actor : actor, bookId: context.bookId });
    }
    if (!deleted && token.actor) this._queueActorRefresh(token.actor);
    this._scheduleDocumentRefresh();
  }

  _onItemChanged(item) {
    if (this.destroyed) return;
    const actor = item?.parent ?? item?.actor;
    if (!actor) return;
    for (const [key, context] of this._trackedContexts(actor)) {
      const flag = getGeneratedPreparedSpellItemFlag(item);
      if (item.type === "spell" && item.system?.spellbook !== context.bookId && flag?.spellbookId !== context.bookId
        && !context.fixture.spells.some(spell => spell.sourceItemId === item.id)) continue;
      this.documentRefreshes.set(key, { actor: context.actor, bookId: context.bookId });
    }
    this._scheduleDocumentRefresh();
  }

  _queueActorRefresh(actor) {
    if (this.destroyed) return;
    for (const request of this.restRequests.values()) {
      const refreshed = actorForRefresh(request.actor, actor);
      if (refreshed) request.actor = refreshed;
    }
    this._renderRestRequests();
    for (const [key, context] of this._trackedContexts(actor)) this.documentRefreshes.set(key, { actor: context.actor, bookId: context.bookId });
    this._scheduleDocumentRefresh();
  }

  _scheduleDocumentRefresh(delay = 40) {
    if (this.destroyed || this.refreshTimer !== null || (!this.documentRefreshes.size && !this.restRefreshes.size)) return;
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      this._flushRestRefreshes();
    }, delay);
    this.refreshTimer?.unref?.();
  }

  _refreshBlocked() {
    const active = this.root?.ownerDocument?.activeElement;
    const editable = active && this.root?.contains?.(active) && active.matches?.("input, select, textarea, [contenteditable='true']");
    const phase = this.app.controller?.phase;
    return this.busy || this.destroyed || this.refreshSuspensions > 0 || this.app.closeConfirmationOpen || this.app.dismissing
      || this.panels.active || editable || (phase && !["idle", "peeling", "inspecting"].includes(phase));
  }

  _saveContext() {
    if (!this.isActor) return;
    const context = {
      actor: this.actor, bookId: this.bookId,
      fixture: clonePlainData(this.app.fixture), draft: new Map(this.app.draft), cursor: this.app.cursor, coverOpen: this.app.coverOpen,
      search: this.search, searchDismissed: this.searchDismissed, selectedSpellId: this.selectedSpellId, managementEnabled: this.managementEnabled, restMode: this.restMode,
      savedCounts: new Map(this.savedCounts), savedMetadata: this.savedMetadata, notice: this.notice, lastSaveError: this.lastSaveError
    };
    this.contexts.set(actorKey(this.actor, this.bookId), context);
    return context;
  }

  _flushRestRefreshes({ force = false, renderCurrent = true } = {}) {
    if (this.destroyed) return;
    if (this.busy || this.refreshSuspensions > 0 || this.app.closeConfirmationOpen || this.app.dismissing || (!force && this._refreshBlocked())) {
      this._scheduleDocumentRefresh(100); return;
    }
    const pending = new Map([...this.documentRefreshes, ...this.restRefreshes].map(([key, value]) => [key, { ...value, rest: this.restRefreshes.has(key) }]));
    this.documentRefreshes.clear();
    for (const [key, { actor, bookId, rest }] of pending) {
      this.restRefreshes.delete(key);
      const current = this.isActor && key === actorKey(this.actor, this.bookId);
      const context = current ? this._saveContext() : this.contexts.get(key);
      if (!context) continue;
      try {
        if (this.unavailableActors.has(actor?.uuid || actor?.id)) throw new Error(t("This actor is no longer available. Your unsaved changes are still here."));
        const fresh = loadActorSpellbook(actor, bookId);
        context.actor = actor;
        const rebased = rebasePreparation(context, fresh);
        rebased.notice = context.lastSaveError ? context.lastSaveError
          : fresh.refreshConflicts?.length ? t("The spellbook changed. Your unsaved changes are still here. Restore the missing spell or choose Discard changes.")
          : rest ? t("Preparation refreshed after rest.")
            : "";
        this.contexts.set(key, rebased);
        if (current) {
          this.actor = actor;
          this.app.fixture = rebased.fixture;
          this.app.draft = rebased.draft;
          this.savedCounts = rebased.savedCounts;
          this.savedMetadata = rebased.savedMetadata;
          this.managementEnabled = rebased.managementEnabled;
          this.restMode = rebased.restMode;
          this.notice = rebased.notice;
          if (renderCurrent) this._recompile(null);
          else this._saveContext();
        }
      } catch (error) {
        context.fixture.unavailableReason = text(error?.message) || t("This spellbook is no longer available. Your unsaved changes are still here.");
        context.notice = context.fixture.unavailableReason;
        this.contexts.set(key, context);
        if (current) {
          this.app.fixture = context.fixture;
          this.notice = context.notice;
          if (renderCurrent) this._recompile(null);
          else this._saveContext();
        }
      }
    }
  }

  _activate(actor, bookId, render = true) {
    if (this.app.closeConfirmationOpen || this.refreshSuspensions > 0) return false;
    const choices = getActorSpellbookChoices(actor);
    const existing = this.contexts.get(actorKey(actor, bookId));
    const choice = choices.find((entry) => entry.id === bookId) ?? (existing ? { id: bookId } : choices[0]);
    if (!choice) throw new Error(t("This actor has no active prepared or hybrid spellbook."));
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this.app.controller?.cancelActiveTurn({ restore: true });
    this._saveContext();
    this._flushRestRefreshes({ force: true, renderCurrent: false });
    this.actor = actor;
    this.bookId = choice.id;
    this.contextToken += 1;
    const context = this.contexts.get(actorKey(actor, this.bookId));
    if (context) {
      this.app.fixture = clonePlainData(context.fixture);
      this.app.draft = new Map(context.draft);
      this.app.cursor = context.cursor;
      this.app.coverOpen = context.coverOpen;
      this.search = context.search;
      this.searchDismissed = context.searchDismissed ?? false;
      this.selectedSpellId = context.selectedSpellId;
      this.managementEnabled = context.managementEnabled;
      this.restMode = context.restMode;
      this.savedCounts = new Map(context.savedCounts);
      this.savedMetadata = context.savedMetadata;
      this.notice = context.notice;
      this.lastSaveError = context.lastSaveError || "";
    } else {
      this.app.fixture = loadActorSpellbook(actor, this.bookId);
      this.app.draft = createPrototypeDraft({ spells: this.app.fixture.spells });
      this.app.cursor = 0;
      this.app.coverOpen = false;
      this.search = "";
      this.searchDismissed = false;
      this.selectedSpellId = this.app.fixture.spells[0]?.id ?? "";
      this.managementEnabled = this.app.fixture.preferences.enabled;
      this.restMode = this.app.fixture.preferences.restMode;
      this.notice = "";
      this.lastSaveError = "";
      this._baseline(this.app.fixture);
    }
    this.app.fixtureKey = "actor";
    this.app.book = compilePrototypeBook(this.app.fixture);
    this.app.cursor = normalizePrototypeCursor(this.app.book, this.app.cursor, this.app.displayMode);
    if (render) this.app.render(false);
  }

  connectActor(actor, bookId) {
    if (this.busy || this.destroyed || this.app.closeConfirmationOpen || this.refreshSuspensions > 0) return false;
    try { return this._activate(actor, bookId) !== false; }
    catch (error) { this._error(error); return false; }
  }

  leaveActorContext() {
    if (this.busy || this.app.closeConfirmationOpen || this.refreshSuspensions > 0) return false;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this._saveContext();
    if (this.isActor) { this.lastActor = this.actor; this.lastBookId = this.bookId; }
    this.actor = null;
    this.bookId = "";
    this.search = "";
    this.selectedSpellId = "";
    this.notice = "";
    this.contextToken += 1;
    return true;
  }

  _validation() { return this.isActor ? getActorPreparationValidation(this.app.fixture, this.app.draft) : null; }

  levelCap(level) {
    return this.isActor ? (this.app.fixture.levels.find((entry) => entry.level === level)?.normalCap ?? null) : null;
  }

  totalsByLevel() {
    return this.isActor ? new Map([...this._validation().totals].map(([level, totals]) => [level, totals.normal])) : null;
  }

  normalizeCount(entryId, value) {
    const count = Math.max(0, Math.trunc(Number(value) || 0));
    const normalized = this.isActor && this.app.fixture.mode === "hybrid" ? Math.min(1, count) : count;
    const spell = this.app.fixture.spells.find(entry => entry.id === entryId);
    if (spell && getPrototypeSlotInformation(this.app.fixture, spell).slotUnavailable) {

      return Math.min(normalized, Math.max(0, Number(this.app.draft.get(entryId)) || 0));
    }
    return normalized;
  }

  _spellUi(spell) {
    const count = this.app.draft.get(spell.id) ?? spell.prepared ?? 0;
    const info = getPrototypeSlotInformation(this.app.fixture, spell, { count });
    const disabled = this.isActor && (!this.canPrepare || this.busy || spell.missing || spell.atWill);
    let max = this.isActor && this.app.fixture.mode === "hybrid" ? 1 : null;
    if (info.slotUnavailable) max = Math.min(max ?? Infinity, Math.max(0, Number(count) || 0));
    return { ...info, displayName: displayName(spell),
      spellClickTitle: this.isActor ? t("Open {spell} on {actor}'s sheet", {spell: spell.name, actor: this.actor.name}) : t("View {name}", {name: displayName(spell)}),
      canInscribe: this.isActor && this.canPrepare && !this.busy && !spell.missing && !spell.atWill,
      countDisabled: disabled, increaseDisabled: disabled || info.slotUnavailable,
      countMax: max, hasCountMax: max !== null };
  }

  _canApply(validation = this._validation()) {
    return this.canPrepare && !this.busy && validation?.valid === true && (this.hasDirty() || this.app.fixture.pending === true);
  }

  _draftNotice(validation = this._validation()) {
    if (!this.isActor) return this.notice || t("Choose a prepared or hybrid spellbook.");
    const parts = [];
    if (this.notice) parts.push(this.notice);
    if (!this.canEditActor) parts.push(t("Read only: you do not own this actor."));
    if (!isSpellbookPreparationFullModeEnabled()) parts.push(t("Full spellbook preparation is off in module settings. Your unsaved changes are still here."));
    if (!isSpellbookManagementEnabled(this.actor, this.bookId)) parts.push(t("Prepare spells on the actor sheet."));
    if (this.hasOptionsDirty()) parts.push(t("Unsaved spellbook options; use Save options."));
    if (validation?.errors.length) parts.push(validation.errors.slice(0, 3).join(" "));
    if (this.hasDirty()) parts.push(t("Unsaved preparation changes."));
    return parts.join(" ");
  }

  _setupUi() {
    const initialized = this.isActor ? this.app.fixture.initialized : true;

    const knownCount = this.isActor
      ? this.app.fixture.knownSpellCount ?? getKnownSpells(this.actor, this.bookId).length : 0;
    const empty = this.isActor && initialized && knownCount === 0;
    const available = this.isActor ? Math.max(0, Number(this.app.fixture.importableSpellCount) || 0) : 0;
    const disabled = this.busy || !this.canPrepare;
    return { showFirstTimeSetup: this.isActor && !initialized, showEmptyBook: empty,
      importButtonLabel: initialized && !empty ? t("Add missing spells") : t("Copy spells from sheet"),
      importDisabled: disabled || available === 0, startEmptyDisabled: disabled || initialized,
      emptyBookNotice: empty && !available ? t("Add spells to the sheet, then copy them here.") : "" };
  }

  data(data) {
    const owned = Array.from(globalThis.game?.actors ?? []).filter((actor) => actor.isOwner === true && getActorSpellbookChoices(actor).length);
    if (this.actor && !owned.some((actor) => actor.uuid === this.actor.uuid && actor.id === this.actor.id)) owned.unshift(this.actor);
    const validation = this._validation();
    const bookOptions = this.isActor ? getActorSpellbookChoices(this.actor).map(book => ({ ...book, selected: book.id === this.bookId })) : [];
    if (this.isActor && !bookOptions.some(book => book.id === this.bookId)) {
      bookOptions.unshift({ id: this.bookId, label: t("{name} (unavailable)", {name: this.app.fixture.bookName || this.bookId}), selected: true });
    }
    const byLevel = new Map((validation?.levels ?? []).map((level) => [level.level, level]));
    data.faces = data.faces.map((face) => {
      const level = byLevel.get(face.level);
      return { ...face,
        ...getPrototypeSlotCounterLabels(this.app.fixture),
        ...(level ? { preparedTotal: level.normalUsed, preparedCap: level.normalCap ?? "?", overLimit: level.overLimit,
          domainUsed: level.domainUsed, domainCap: level.domainCap ?? "?", hasDomainCounter: level.domainCap > 0 || face.spells.some((spell) => spell.domain) } : {}),
        spells: face.spells.map((spell) => ({ ...spell, ...this._spellUi(spell) }))
      };
    });
    return { ...data, isActor: this.isActor, isMock: !this.isActor,
      ...this._setupUi(),
      actorOptions: owned.map((actor) => ({ id: actor.uuid || actor.id, name: `${tokenKey(actor) ? "[Token] " : ""}${actor.name}`, selected: actor === this.actor || (actor.uuid && actor.uuid === this.actor?.uuid) })),
      bookOptions,
      canEditActor: this.canEditActor, initialized: this.isActor ? this.app.fixture.initialized : true,
      importableSpellCount: this.isActor ? this.app.fixture.importableSpellCount : 0,
      actorStatus: this.isActor ? `${this.app.fixture.castingMode} · ${this.app.fixture.preferences.enabled ? (this.app.fixture.managed ? t("NAS managed") : t("NAS enabled")) : t("PF1 preparation · NAS off")}${this.app.fixture.pending ? t(" · preparation pending") : ""}` : "",
      spellOptions: this.app.fixture.spells.map((spell) => ({ id: spell.id, name: displayName(spell), selected: spell.id === this.selectedSpellId })),
      removalLabel: removalLabel(this.app.fixture.spells.find(spell => spell.id === this.selectedSpellId)),
      managementEnabled: this.managementEnabled,
      restOptions: [{ value: "inherit", label: t("Use module setting"), selected: this.restMode === "inherit" },
        { value: "retain", label: t("Prepare the same spells again"), selected: this.restMode === "retain" },
        { value: "reselect", label: t("Choose again"), selected: this.restMode === "reselect" },
        { value: "random", label: t("Prepare randomly"), selected: this.restMode === "random" }],
      randomDisabled: !this.canPrepare || this.busy || !this.app.fixture.initialized || this.refreshSuspensions > 0,
      saveOptionsDisabled: !this.canEditActor || this.busy || this.refreshSuspensions > 0 || !this.hasOptionsDirty(),
      searchValue: this.search, draftNotice: this._draftNotice(validation), applyDisabled: this.isActor ? !this._canApply(validation) : false,
      applyLabel: this.isActor ? (this.busy ? t("Working…") : t("Prepare spells")) : t("Prepare spells")
    };
  }

  bind(root) {
    this.bindAbort?.abort();
    const Abort = root.ownerDocument?.defaultView?.AbortController ?? AbortController;
    this.bindAbort = new Abort();
    const signal = this.bindAbort.signal;
    this.root = root;
    this.previews.bind(root);
    root.ownerDocument.addEventListener("focusout", () => this._scheduleDocumentRefresh(), { signal });
    const listen = (selector, eventName, callback) => root.querySelector(selector)?.addEventListener(eventName, callback, { signal });
    listen("[data-proto-control='actor']", "change", (event) => {
      const value = event.currentTarget.value;
      const actor = this.actor?.uuid === value ? this.actor : globalThis.game?.actors?.get?.(value)
        ?? Array.from(globalThis.game?.actors ?? []).find(entry => entry.uuid === value || entry.id === value);
      if (actor) this.connectActor(actor);
    });
    listen("[data-proto-control='book']", "change", (event) => this.connectActor(this.actor, event.currentTarget.value));
    listen("[data-proto-control='managed']", "change", (event) => {
      if (!this.canEditActor || this.busy) return;
      this.managementEnabled = event.currentTarget.checked;
      this.refresh();
    });
    listen("[data-proto-control='rest-mode']", "change", (event) => {
      if (!this.canEditActor || this.busy) return;
      this.restMode = event.currentTarget.value;
      this.refresh();
    });
    listen("[data-proto-control='selected-spell']", "change", (event) => this._goToSpell(event.currentTarget.value));
    listen("[data-proto-search]", "input", (event) => { this.search = event.currentTarget.value; this.searchDismissed = false; this._renderSearch(); });
    listen("[data-proto-search]", "focus", () => { this.searchDismissed = false; this._renderSearch(); });
    listen("[data-proto-search]", "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this._dismissSearch(); }
      else if (event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        const first = this._searchMatches()[0];
        if (first) this._goToSpell(first.id);
      }
    });
    listen("[data-proto-search-results]", "keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); root.querySelector("[data-proto-search]")?.focus(); this._dismissSearch(); }
    });
    root.ownerDocument.addEventListener("pointerdown", (event) => {
      const input = root.querySelector("[data-proto-search]");
      const results = root.querySelector("[data-proto-search-results]");
      if (!input?.contains(event.target) && !results?.contains(event.target)) this._dismissSearch();
    }, { signal });
    root.addEventListener("click", (event) => {
      const request = event.target.closest("[data-proto-rest-key]");
      if (request) { event.preventDefault(); this.openRestPreparation(request.dataset.protoRestKey); return; }
      const action = event.target.closest("[data-proto-action]")?.dataset.protoAction;
      if (action === "import-actor") { event.preventDefault(); void this._import(); }
      else if (action === "start-empty") { event.preventDefault(); void this._startEmpty(); }
      else if (action === "reset-draft") { event.preventDefault(); this._reset(); }
      else if (action === "random-preparation") { event.preventDefault(); this.randomPreparation(); }
      else if (action === "remove-selected") { event.preventDefault(); this._removeSelected(); }
      else if (action === "save-options") { event.preventDefault(); void this._saveOptions(); }
      else if (action === "open-current-sheet") { event.preventDefault(); this.actor?.sheet?.render?.(true); }
      const details = event.target.closest("[data-proto-details]");
      const quill = event.target.closest("[data-proto-inscribe]");
      if (details || quill) {
        event.preventDefault();
        const anchor = details || quill;
        const row = anchor.closest("[data-spell-id]");
        const spellId = anchor.dataset.protoDetails || anchor.dataset.protoInscribe || row?.dataset.spellId;
        this._openPanel(spellId, anchor, Boolean(quill));
      }
    }, { signal });
    this.refresh();
    this._renderSearch();
  }

  refresh() {
    const root = this.root;
    if (!root) return;
    this._renderRestRequests();
    const validation = this._validation();
    const status = root.querySelector("[data-proto-draft-status]");
    if (status) { status.textContent = this._draftNotice(validation); status.title = status.textContent; }
    const apply = root.querySelector("[data-proto-apply]");
    if (apply) { apply.disabled = this.isActor ? !this._canApply(validation) : false; apply.textContent = this.isActor ? (this.busy ? t("Working…") : t("Prepare spells")) : t("Prepare spells"); }
    for (const node of root.querySelectorAll("[data-proto-control='actor'], [data-proto-control='book'], [data-proto-control='selected-spell']")) node.disabled = this.busy;
    for (const node of root.querySelectorAll("[data-proto-control='managed'], [data-proto-control='rest-mode'], [data-proto-action='reset-draft']")) node.disabled = this.busy || this.refreshSuspensions > 0 || !this.canEditActor;
    for (const node of root.querySelectorAll("[data-proto-action='remove-selected']")) node.disabled = this.busy || !this.canPrepare;
    for (const node of root.querySelectorAll("[data-proto-action='random-preparation']")) node.disabled = this.busy || !this.canPrepare || !this.app.fixture.initialized || this.refreshSuspensions > 0;
    const setup = this._setupUi();
    for (const node of root.querySelectorAll("[data-proto-action='import-actor']")) node.disabled = setup.importDisabled;
    for (const node of root.querySelectorAll("[data-proto-action='start-empty']")) node.disabled = setup.startEmptyDisabled;
    const saveOptions = root.querySelector("[data-proto-action='save-options']");
    if (saveOptions) saveOptions.disabled = this.busy || this.refreshSuspensions > 0 || !this.canEditActor || !this.hasOptionsDirty();
    for (const row of root.querySelectorAll(".nas-proto-canonical .nas-proto-spell-row[data-spell-id]")) {
      const spell = this.app.fixture.spells.find((entry) => entry.id === row.dataset.spellId);
      if (!spell) continue;
      const state = this._spellUi(spell);
      for (const node of row.querySelectorAll(".nas-proto-prepared-count, [data-proto-step]")) {
        node.disabled = node.dataset.protoStep === "1" ? state.increaseDisabled : state.countDisabled;
      }
      const input = row.querySelector(".nas-proto-prepared-count");
      if (input) {
        if (state.hasCountMax) input.setAttribute("max", `${state.countMax}`);
        else input.removeAttribute("max");
        input.title = state.slotDetail;
      }
      const summary = row.querySelector("[data-proto-slot-summary]");
      if (summary) { summary.textContent = state.slotSummary; summary.title = state.slotDetail; }
      const badge = row.querySelector("[data-proto-slot-level]");
      if (badge) { badge.title = state.preparedLevelLabel; badge.setAttribute("aria-label", state.preparedLevelLabel); }
      const warning = row.querySelector("[data-proto-slot-warning]");
      if (warning) {
        warning.hidden = !state.slotWarning;
        warning.toggleAttribute("inert", !state.slotWarning);
        warning.tabIndex = state.slotWarning ? 0 : -1;
        warning.dataset.state = state.slotWarningState;
        warning.setAttribute("aria-label", state.slotWarning);
        const label = warning.querySelector("[data-proto-slot-warning-label]");
        if (label) label.textContent = state.slotWarning;
        const detail = warning.querySelector("[data-proto-slot-warning-detail]");
        if (detail) detail.textContent = state.slotWarningDetail;
      }
      const quill = row.querySelector("[data-proto-inscribe]");
      if (quill) {
        quill.disabled = !state.canInscribe;
        this.panels.setInscriptionAnchor(spell.id, quill);
      }
    }
    for (const counter of root.querySelectorAll("[data-proto-domain-counter]")) {
      const level = validation?.levels.find((entry) => entry.level === Number(counter.dataset.level));
      if (level) counter.textContent = `${level.domainUsed} / ${level.domainCap ?? "?"}`;
    }
    if (validation) for (const counter of root.querySelectorAll("[data-proto-level-counter]")) {
      const level = validation.levels.find((entry) => entry.level === Number(counter.dataset.level));
      counter.closest(".nas-proto-page-header")?.classList.toggle("nas-proto-over-limit", level?.overLimit === true);
    }
    this._saveContext();
    this.app.bookShell?.sync();
  }

  _searchMatches() {
    const query = text(this.search).toLocaleLowerCase();
    return query ? this.app.fixture.spells.filter((spell) => `${displayName(spell)} ${spell.school} ${spell.metamagic} ${spell.level}`.toLocaleLowerCase().includes(query)) : [];
  }

  _dismissSearch() {
    this.searchDismissed = true;
    const results = this.root?.querySelector("[data-proto-search-results]");
    if (results) results.hidden = true;
  }

  _renderSearch() {
    const results = this.root?.querySelector("[data-proto-search-results]");
    if (!results) return;
    results.replaceChildren();
    const query = text(this.search).toLocaleLowerCase();
    results.hidden = !query || this.searchDismissed;
    if (!query) return;
    const matches = this._searchMatches();
    const doc = results.ownerDocument;
    const summary = doc.createElement("p");
    summary.textContent = matches.length ? t("Matching spells: {count}", {count: matches.length}) : t("No matching spells.");
    results.append(summary);
    for (const spell of matches.slice(0, 20)) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = displayName(spell);
      button.addEventListener("click", () => this._goToSpell(spell.id));
      results.append(button);
    }
  }

  _selectSpell(spellId) {
    this.selectedSpellId = spellId;
    const select = this.root?.querySelector("[data-proto-control='selected-spell']");
    if (select) select.value = spellId;
    const remove = this.root?.querySelector("[data-proto-action='remove-selected']");
    if (remove) remove.textContent = removalLabel(this.app.fixture.spells.find(spell => spell.id === spellId));
  }

  _goToSpell(spellId) {
    this._selectSpell(spellId);
    const face = this.app.book.contentFaces.find((entry) => entry.spells.some((spell) => spell.id === spellId));
    if (face) {
      this.app.controller?.setCover(true, { animate: false });
      this.app.coverOpen = true;
      this.app._jumpToFace(face.index);
    }
    this._dismissSearch();
    this.app.bookShell?.hideSearch();
    this._saveContext();
  }

  _panelSpell(spell) {
    const sourceItem = this.actor?.items?.get?.(spell.sourceItemId);
    const knownSpell = this.isActor ? getKnownSpells(this.actor, this.bookId).find((entry) => entry.id === spell.knownSpellId) : null;
    return { ...spell, sourceItem, knownSpell, itemData: knownSpell?.itemData ?? { name: spell.name,
      system: { level: spell.originalLevel ?? spell.level, school: spell.school, description: { value: "" } } } };
  }

  _openPanel(spellId, anchor, inscribe) {
    this.previews.hide();
    const spell = this.app.fixture.spells.find((entry) => entry.id === spellId);
    if (!spell) return;
    this._selectSpell(spellId);
    this._saveContext();
    if (!inscribe && this.isActor) return this._openActorSpell(spell);
    const panelSpell = this._panelSpell(spell);
    if (!inscribe) { this.panels.openSpellDetails({ actor: this.actor, spell: panelSpell, anchor }); return; }
    if (!this.canPrepare || this.busy || spell.missing || spell.atWill) return;
    const token = this.contextToken;
    this.panels.openMetamagicPanel({ actor: this.actor, spell: panelSpell, anchor,
      onChange: (patch, options) => {
        if (token !== this.contextToken || this.destroyed) throw new Error(t("The selected actor changed; reopen this spell's inscription."));
        return this._changeMetamagic(spellId, patch, options);
      } });
  }

  async _openActorSpell(spell) {
    if (this.busy || this.destroyed) return false;
    try {
      if (this.panels.close({ restoreFocus: false }) === false) return false;

      const item = getSourceItemForKnownSpell(this.actor, this.bookId, spell);
      if (!item) {
        throw new Error(t("The original spell is unavailable in this spellbook. Choose Discard changes to restore the saved preparation."));
      }
      const sheet = item.sheet;
      if (typeof sheet?.render !== "function") throw new Error(t("This actor's spell item has no available sheet."));
      await sheet.render(true);
      return true;
    } catch (error) {
      this._error(error);
      return false;
    }
  }

  _changeMetamagic(sourceId, patch, { entryId, createVariant } = {}) {
    if (!this.canPrepare || this.busy) throw new Error(t("You can only view this preparation."));
    let spell = this.app.fixture.spells.find((entry) => entry.id === entryId) ?? this.app.fixture.spells.find((entry) => entry.id === sourceId);
    if (!spell) throw new Error(t("This spell is no longer in your preparation."));
    let entry = { ...clonePlainData(spell.preparedEntry), ...clonePlainData(patch) };
    if (createVariant) {
      const newId = `draft-${createNasId()}`;
      entry = { ...entry, id: newId, variant: "custom" };
      spell = { ...clonePlainData(spell), id: newId, isVariant: true, prepared: 0, count: 0 };
      this.app.fixture.spells.push(spell);
      this.app.draft.set(newId, 0);
    }
    if (spell.isVariant && !entry.metamagic?.length) {
      this._removeSpell(spell);
      this._recompile();
      return entry;
    }
    const source = this.actor.items?.get?.(spell.sourceItemId);
    const selections = normalizeMetamagicSelections(entry.metamagic, { originalLevel: spell.originalLevel, sourceItem: source });
    entry.metamagic = selections;
    entry.preparedSlotLevel = calculatePreparedSlotLevel(spell.originalLevel, selections);
    spell.preparedEntry = entry;
    spell.suffix = entry.suffix || "";
    spell.level = entry.preparedSlotLevel;
    spell.preparedSlotLevel = entry.preparedSlotLevel;
    spell.metamagicSelections = selections;
    spell.metamagic = getMetamagicSummary(selections);
    delete spell.randomPreparation;
    this.selectedSpellId = spell.id;
    this._recompile(spell.id);
    return entry;
  }

  _removeSpell(spell) {
    if (spell.isVariant) {
      if (!spell.id.startsWith("draft-")) this.app.fixture.removedEntryIds = [...new Set([...this.app.fixture.removedEntryIds, spell.id])];
      this.app.fixture.spells = this.app.fixture.spells.filter((entry) => entry.id !== spell.id);
      this.app.draft.delete(spell.id);
    } else {
      this.app.fixture.removedKnownSpellIds = [...new Set([...this.app.fixture.removedKnownSpellIds, spell.knownSpellId])];
      const removed = this.app.fixture.spells.filter((entry) => entry.knownSpellId === spell.knownSpellId);
      this.app.fixture.spells = this.app.fixture.spells.filter((entry) => entry.knownSpellId !== spell.knownSpellId);
      for (const entry of removed) this.app.draft.delete(entry.id);
    }
    this.selectedSpellId = this.app.fixture.spells.find((entry) => entry.knownSpellId === spell.knownSpellId)?.id ?? this.app.fixture.spells[0]?.id ?? "";
  }

  _removeSelected() {
    if (!this.canPrepare || this.busy) return;
    const spell = this.app.fixture.spells.find((entry) => entry.id === this.selectedSpellId);
    if (!spell) return;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this._removeSpell(spell);
    this.notice = t("Marked for removal.");
    this._recompile(this.selectedSpellId);
  }

  _recompile(anchorId = this.selectedSpellId) {
    this.previews.hide();
    this.app.controller?.cancelActiveTurn({ restore: true });
    const previousCursor = this.app.cursor;
    this.app.book = compilePrototypeBook(this.app.fixture);
    const face = this.app.book.contentFaces.find((entry) => entry.spells.some((spell) => spell.id === anchorId));
    this.app.cursor = normalizePrototypeCursor(this.app.book, face?.index ?? previousCursor, this.app.displayMode);
    this._saveContext();
    this.app.render(false);
  }

  _install(fixture, { draft = null, anchorId = this.selectedSpellId, optionsDraft = {} } = {}) {
    this.app.fixture = fixture;
    this.app.draft = draft ?? createPrototypeDraft({ spells: fixture.spells });
    this.managementEnabled = Object.hasOwn(optionsDraft, "enabled") ? optionsDraft.enabled : fixture.preferences.enabled;
    this.restMode = Object.hasOwn(optionsDraft, "restMode") ? optionsDraft.restMode : fixture.preferences.restMode;
    this._baseline(fixture);
    this._recompile(anchorId);
  }

  _reset() {
    if (!this.isActor || this.busy || this.refreshSuspensions > 0) return;
    this.panels.close({ restoreFocus: false, discardDraft: true });
    this.lastSaveError = "";
    this.notice = t("Saved preparation restored.");
    this._install(loadActorSpellbook(this.actor, this.bookId));
  }

  async _saveOptions() {
    if (!this.canEditActor || this.busy || this.refreshSuspensions > 0 || !this.hasOptionsDirty()) return false;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this._flushRestRefreshes({ force: true });
    if (!this.canEditActor || !this.hasOptionsDirty()) return false;
    const actor = this.actor, bookId = this.bookId;
    const options = { enabled: this.managementEnabled, restMode: this.restMode };
    const context = this._saveContext();
    return this._run(async () => {
      await saveSpellbookOptions(actor, bookId, options);
      return loadActorSpellbook(actor, bookId);
    }, (fresh) => {
      const rebased = rebasePreparation(context, fresh);
      this.app.fixture = rebased.fixture;
      this.app.draft = rebased.draft;
      this.savedCounts = rebased.savedCounts;
      this.savedMetadata = rebased.savedMetadata;
      this.managementEnabled = fresh.preferences.enabled;
      this.restMode = fresh.preferences.restMode;
      this.notice = t("Options saved.");
      this._recompile(null);
    });
  }

  async _run(work, complete) {
    if (this.busy || this.destroyed || this.app.closeConfirmationOpen || this.refreshSuspensions > 0) return;
    const token = this.contextToken;
    this.lastSaveError = "";
    this.busy = true;
    this.refresh();
    try {
      const result = await work();
      if (!this.destroyed && token === this.contextToken) {
        this.busy = false;
        complete?.(result);
      }
      return result;
    } catch (error) {
      if (!this.destroyed && token === this.contextToken) {
        this.lastSaveError = text(error?.message) || t("The spellbook action could not be completed.");
        this._error(error);
      }
      return null;
    } finally {
      if (token === this.contextToken) { this.busy = false; this.refresh(); this._flushRestRefreshes(); }
    }
  }

  _import() { return this._updateCatalogue(); }

  _startEmpty() { return this._updateCatalogue({ startEmpty: true }); }

  randomPreparation({ random = Math.random } = {}) {
    if (!this.canPrepare || this.busy || this.destroyed || this.refreshSuspensions > 0
      || this.app.closeConfirmationOpen || this.app.dismissing || !this.app.fixture.initialized) return false;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this.flushPendingEdits();
    this._flushRestRefreshes({ force: true });
    if (!this.canPrepare) return false;
    try {
      const result = planRandomSpellbookPreparation(this.actor, this.bookId, { fixture: this.app.fixture, random });
      this.app.fixture.spells = result.spells;
      this.app.draft = new Map(result.counts);
      this.notice = [t("Random selections: {count}.", {count: result.selectedCount}), ...(result.warnings ?? [])].join(" ");
      this._recompile(null);
      return result;
    } catch (error) { this._error(error); return false; }
  }

  async _updateCatalogue({ startEmpty = false } = {}) {
    if (!this.canPrepare || this.busy || this.destroyed || this.app.dismissing
      || this.app.closeConfirmationOpen || this.refreshSuspensions > 0) return false;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this._flushRestRefreshes({ force: true });
    if (!this.canPrepare) return false;
    if (startEmpty && this.app.fixture.initialized) return false;
    const actor = this.actor, bookId = this.bookId;
    const context = this._saveContext();
    const work = startEmpty ? startEmptyActorSpellbook : importActorSpells;
    return this._run(() => work(actor, bookId), (fresh) => {
      const rebased = rebasePreparation(context, fresh);
      this.app.fixture = rebased.fixture;
      this.app.draft = rebased.draft;
      this.savedCounts = rebased.savedCounts;
      this.savedMetadata = rebased.savedMetadata;
      this.managementEnabled = rebased.managementEnabled;
      this.restMode = rebased.restMode;
      this.notice = startEmpty
        ? fresh.knownSpellCount === 0
          ? t("Empty spellbook ready.")
          : t("Existing spellbook kept.")
        : context.fixture.initialized
          ? t("Missing spells added.")
          : t("Spells copied from sheet.");
      this._recompile();
    });
  }

  async apply() {
    if (!this.isActor) return false;
    if (this.busy || this.refreshSuspensions > 0) return false;
    if (this.panels.close({ restoreFocus: false }) === false) return false;
    this._flushRestRefreshes({ force: true });
    if (!this._canApply()) { this.refresh(); return false; }
    const actor = this.actor, bookId = this.bookId, fixture = this.app.fixture, draft = new Map(this.app.draft), selected = this.selectedSpellId;

    const optionsDraft = {};
    if (this.managementEnabled !== fixture.preferences.enabled) optionsDraft.enabled = this.managementEnabled;
    if (this.restMode !== fixture.preferences.restMode) optionsDraft.restMode = this.restMode;
    return this._run(() => applyActorPreparation(actor, bookId, fixture, draft), (result) => {
      this.notice = t("Spells prepared.");
      this.selectedSpellId = result.idMap.get(selected) ?? selected;
      this._install(result.fixture, { anchorId: this.selectedSpellId, optionsDraft });
    });
  }

  _error(error) {
    this.notice = text(error?.message) || t("The spellbook action could not be completed.");
    globalThis.ui?.notifications?.warn?.(this.notice);
    this.refresh();
  }

  destroy() {
    this.destroyed = true;
    this.bindAbort?.abort();
    if (this.restHook !== undefined) globalThis.Hooks?.off?.("nasSpellbookPreparationRestCompleted", this.restHook);
    this.restHook = undefined;
    this.restRefreshes.clear();
    this.restRequests.clear();
    this.documentRefreshes.clear();
    if (this.refreshTimer !== null) globalThis.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const [name, id] of this.liveHooks) globalThis.Hooks?.off?.(name, id);
    this.liveHooks = [];
    this.randomRestOperations.clear();
    this.panels.destroy();
    this.previews.destroy();
    this.contextToken += 1;
    this.root = null;
    this.contexts.clear();
  }
}
