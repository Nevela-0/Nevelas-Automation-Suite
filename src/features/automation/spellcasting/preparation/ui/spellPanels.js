import { spellbookText as t } from "../i18n.js";
import {
  AUTO_SUFFIX_MODE,
  MANUAL_SUFFIX_MODE,
  buildAutoSuffixUpdate,
  buildMetamagicAutoSuffix,
  calculatePreparedSlotLevel,
  getPreparedMetamagicChoices,
  normalizeMetamagicSelections,
  togglePreparedEntryMetamagic,
  updatePreparedEntryMetamagicOption
} from "../metamagicInscription.js";

const STYLE_ID = "nas-prototype-spell-panels-styles";
let panelSequence = 0;

function text(value) {
  return `${value ?? ""}`.trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function domFor(doc) {
  const element = (tag, className, content) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  return { element, button: (label, callback, className = "") => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", callback);
    return node;
  } };
}

function sourceFor(spell) {
  return spell?.sourceItem ?? spell?.itemData ?? spell?.knownSpell?.itemData ?? spell;
}

function sourceName(spell) {
  return text(sourceFor(spell)?.name || spell?.name) || t("Spell");
}

function originalLevel(spell, entry) {
  const value = Number(entry?.originalSpellLevel ?? sourceFor(spell)?.system?.level ?? spell?.originalSpellLevel ?? spell?.level ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(9, Math.trunc(value))) : 0;
}

function localize(key, fallback) {
  const value = globalThis.game?.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}

function choiceReason(key) {
  const fallbacks = {
    notApplicable: t("Not applicable to this spell"),
    slotTooHigh: t("The resulting spell slot is above 9th level"),
    slotUnavailableLowAbility: t("Casting ability is too low for this slot"),
    slotUnavailable: t("This spell slot is unavailable"),
    slotUnknown: t("Spell slot availability is unknown")
  };
  return localize(`NAS.spellbookPreparation.labels.${key}`, fallbacks[key] || t("Unavailable"));
}

export function buildPrototypeSpellName(baseName, entry = {}) {
  const base = text(baseName) || t("Spell");
  if (entry.suffixMode === MANUAL_SUFFIX_MODE && text(entry.suffix)) return `${base} (${text(entry.suffix)})`;
  const prefix = buildMetamagicAutoSuffix(entry.metamagic, "");
  if (!prefix) return base;
  return base.toLocaleLowerCase().startsWith(`${prefix} `.toLocaleLowerCase()) ? base : `${prefix} ${base}`;
}

function firstAction(source) {
  const actions = source?.actions ?? source?.system?.actions;
  if (Array.isArray(actions)) return actions[0] ?? {};
  if (actions?.contents) return actions.contents[0] ?? {};
  if (typeof actions?.values === "function") return actions.values().next().value ?? {};
  return {};
}

function configLabel(mapName, key, fallback = key) {
  const config = globalThis.pf1?.config ?? globalThis.CONFIG?.PF1 ?? {};
  const configured = config[mapName]?.[key];
  const label = typeof configured === "object" ? configured?.label : configured;
  return label ? localize(label, label.startsWith?.("PF1.") ? fallback : label) : fallback;
}

function readableQuantity(value, kind) {
  if (!value || typeof value !== "object") return text(value);
  const amount = text(value.value ?? value.cost);
  const unit = text(value.units ?? value.type);
  const singular = Number(amount) === 1;
  const rangeLabels = { none: t("None"), personal: t("Personal"), touch: t("Touch"), melee: t("Melee"), reach: t("Reach"), close: localize("PF1.Distance.close", "Close"), medium: t("Medium"), long: t("Long"), unlimited: t("Unlimited"), spec: t("Special"), seeText: t("See text") };
  const fixedDurations = { inst: t("Instantaneous"), perm: t("Permanent"), seeText: t("See text"), spec: t("Special") };
  if (kind === "range" && rangeLabels[unit]) return configLabel("distanceUnits", unit, rangeLabels[unit]);
  if (kind === "duration" && fixedDurations[unit]) {
    if (unit === "spec" && amount && amount !== "0") return amount;
    return configLabel("timePeriods", unit, fixedDurations[unit]);
  }
  if (kind === "activation") {
    const actions = { standard: t("standard action"), full: t("full-round action"), move: t("move action"), free: t("free action"), swift: t("swift action"), immediate: t("immediate action"), attack: t("attack action"), aoo: t("attack of opportunity"), reaction: t("reaction") };
    if (actions[unit]) {
      const singleLabel = configLabel("abilityActivationTypes", unit, actions[unit]);
      const actionLabel = localize("PF1.Activation.action.Single", t("action")).toLocaleLowerCase();
      const single = /\baction\b|aktion|opportunity|reaction/i.test(singleLabel) ? singleLabel : `${singleLabel} ${actionLabel}`;
      const plurals = { standard: t("standard actions"), full: t("full-round actions"), move: t("move actions"), free: t("free actions"), swift: t("swift actions"), immediate: t("immediate actions"), attack: t("attack actions"), aoo: t("attacks of opportunity"), reaction: t("reactions") };
      const plural = configLabel("abilityActivationTypesPlurals", unit, plurals[unit]);
      return `${amount || "1"} ${(singular || !amount ? single : plural).toLocaleLowerCase()}`;
    }
    if (["nonaction", "passive", "special"].includes(unit)) {
      return configLabel("abilityActivationTypes", unit, { nonaction: t("No action"), passive: t("Passive"), special: t("Special") }[unit]);
    }
  }
  const units = { second: [t("second"), t("seconds")], turn: [t("turn"), t("turns")], round: [t("round"), t("rounds")], minute: [t("minute"), t("minutes")], hour: [t("hour"), t("hours")], day: [t("day"), t("days")], month: [t("month"), t("months")], year: [t("year"), t("years")], ft: [t("foot"), t("feet")], mi: [t("mile"), t("miles")], m: [t("meter"), t("meters")], km: [t("kilometer"), t("kilometers")] };
  const forms = units[unit];
  if (forms) {
    const fallback = forms[singular ? 0 : 1];
    const mapName = kind === "range" ? "distanceUnits" : kind === "activation"
      ? (singular ? "abilityActivationTypes" : "abilityActivationTypesPlurals") : "timePeriods";

    const label = kind === "duration" && singular
      ? configLabel("abilityActivationTypes", unit, fallback)
      : configLabel(mapName, unit, fallback);
    const normalizedLabel = text(label).toLocaleLowerCase();
    const agreedLabel = normalizedLabel === forms[singular ? 1 : 0] ? fallback : normalizedLabel;
    return [amount, agreedLabel].filter(Boolean).join(" ");
  }
  return [amount, unit].filter(Boolean).join(" ");
}

export function getPrototypeSpellStats(spell) {
  const source = sourceFor(spell);
  const system = source?.system ?? {};
  const action = firstAction(source);
  const schoolKey = text(system.school);
  const school = configLabel("spellSchools", schoolKey, schoolKey);
  const saveData = action.save ?? system.save;
  const save = saveData ?? {};
  const saveType = configLabel("savingThrows", save.type, { fort: t("Fortitude"), ref: t("Reflex"), will: t("Will"), none: t("None") }[save.type] ?? save.type);
  const saveLabel = [saveType, save.description].map(text).filter(Boolean).join(" · ")
    || (saveData ? localize("PF1.None", t("None")) : "");
  const components = Object.entries(system.components ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => ({ verbal: "V", somatic: "S", material: "M", focus: "F", divineFocus: "DF" }[key] ?? key))
    .join(", ");
  return [
    [t("Level"), `${originalLevel(spell, spell?.preparedEntry)}${spell?.domain || system.domain ? t(" · Domain") : ""}`],
    [t("School"), [school, system.subSchool].map(text).filter(Boolean).join(" · ")],
    [t("Casting time"), readableQuantity(action.activation ?? system.activation, "activation")],
    [t("Components"), components],
    [t("Range"), readableQuantity(action.range ?? system.range, "range")],
    [t("Duration"), readableQuantity(action.duration ?? system.duration, "duration")],
    [t("Saving throw"), saveLabel],
    [t("Spell resistance"), action.sr === true || system.sr === true ? t("Yes") : action.sr === false || system.sr === false ? t("No") : ""]
  ].filter(([, value]) => value);
}

export function ensureSpellPanelStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const link = doc.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = new URL("../../../../../templates/spellbook/spellPanels.css", import.meta.url).href;
  doc.head.append(link);
}

export class PrototypeSpellPanels {
  constructor({ onError } = {}) {
    this.onError = onError;
    this.active = null;
    this.dismissalSuspensions = 0;
  }

  hasPendingChanges() {
    const state = this.active;
    return Boolean(state?.pending || (state?.entry?.metamagic?.length && state.unsavedLabel !== undefined
      && text(state.unsavedLabel) !== text(state.entry.suffix)));
  }

  suspendDismissal() {
    this.dismissalSuspensions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dismissalSuspensions = Math.max(0, this.dismissalSuspensions - 1);
    };
  }

  flushPendingChanges() {
    const state = this.active;
    if (this.dismissalSuspensions || !state || state.pending || state.unsavedLabel === undefined || !state.entry?.metamagic?.length) return false;
    if (text(state.unsavedLabel) === text(state.entry.suffix)) {
      state.unsavedLabel = undefined;
      return false;
    }
    const label = state.unsavedLabel;
    const patch = { suffix: text(label), suffixMode: MANUAL_SUFFIX_MODE };
    const accept = result => {
      const returned = result?.preparedEntry ?? (result?.id ? result : null);
      state.entry = { ...state.entry, ...patch, ...(returned ? clone(returned) : {}) };
      if (state.unsavedLabel === label) state.unsavedLabel = undefined;
    };
    const fail = error => {
      state.error = text(error?.message) || t("Could not update your preparation.");
      this.onError?.(error);
    };
    try {
      const result = state.onChange?.(patch, { entryId: state.entry.id, createVariant: false });
      if (typeof result?.then === "function") {
        state.pending = true;
        Promise.resolve(result).then(accept, fail).finally(() => { state.pending = false; });
      } else accept(result);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  _open({ title, label, anchor, onClose }) {
    if (!this.close({ restoreFocus: false })) return null;
    const doc = anchor?.ownerDocument ?? globalThis.document;
    const win = doc.defaultView ?? globalThis.window;
    const { element, button } = domFor(doc);
    ensureSpellPanelStyles(doc);
    const root = element("section", "nas-proto-spell-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.tabIndex = -1;

    Object.assign(root.style, { position: "fixed", zIndex: "11000", width: "560px", maxWidth: "calc(100vw - 24px)" });
    const header = element("header", "nas-proto-spell-panel-header");
    const headingGroup = element("div");
    headingGroup.append(element("small", "", label));
    const heading = element("h2", "", title);
    heading.id = `nas-proto-spell-panel-title-${++panelSequence}`;
    root.setAttribute("aria-labelledby", heading.id);
    headingGroup.append(heading);
    const close = button(t("Close"), () => this.close(), "nas-proto-spell-panel-close");
    close.setAttribute("aria-label", t("Close {name}", {name: label.toLocaleLowerCase()}));
    header.append(headingGroup, close);
    const body = element("div", "nas-proto-spell-panel-body");
    root.append(header, body);
    const state = { root, body, anchor, onClose, document: doc, window: win, pending: false };
    this.active = state;
    doc.body.append(root);
    this._bindOwner(state);
    this._position(state);
    root.focus({ preventScroll: true });
    return state;
  }

  _bindOwner(state) {
    state.abort?.abort();
    const { document: doc, window: win, root } = state;
    const abort = new (win.AbortController ?? AbortController)();
    state.abort = abort;
    const position = () => this._position(state);
    doc.addEventListener("keydown", (event) => {
      if (this.dismissalSuspensions) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }, { capture: true, signal: abort.signal });
    doc.addEventListener("pointerdown", (event) => {
      if (this.dismissalSuspensions) return;
      if (event.target?.closest?.("[data-proto-action='dismiss-book']")) return;
      if (root.contains(event.target) || state.anchor?.contains?.(event.target)) return;
      this.close({ restoreFocus: false });
    }, { capture: true, signal: abort.signal });
    win.addEventListener("resize", position, { signal: abort.signal });
    doc.addEventListener("scroll", position, { capture: true, passive: true, signal: abort.signal });
    doc.getElementById(STYLE_ID)?.addEventListener("load", position, { once: true, signal: abort.signal });
  }

  moveToDocument(doc) {
    const state = this.active;
    if (!state || state.document === doc) return state?.root ?? null;
    if (!doc?.body?.append || !doc.defaultView) return null;
    const resume = this.suspendDismissal();
    try {
      ensureSpellPanelStyles(doc);
      doc.body.append(doc.adoptNode ? doc.adoptNode(state.root) : state.root);
      state.document = doc;
      state.window = doc.defaultView;
      this._bindOwner(state);
      this._position(state);
      return state.root;
    } finally { resume(); }
  }

  setInscriptionAnchor(entryId, quill) {
    const state = this.active;
    if (!state?.entry || state.entry.id !== entryId || state.anchor === quill) return;
    state.anchor = quill;
    if (quill.isConnected) this._position(state);
    else state.window.requestAnimationFrame(() => this._position(state));
  }

  _position(state) {
    if (this.active !== state) return;
    const win = state.window;
    const margin = 12;
    const width = Math.min(560, Math.max(0, win.innerWidth - margin * 2));
    const anchorRect = state.anchor?.isConnected && state.anchor.ownerDocument === state.document
      ? state.anchor.getBoundingClientRect() : null;
    const gap = 8;
    const above = anchorRect ? anchorRect.top - gap - margin : 0;
    const below = anchorRect ? win.innerHeight - margin - anchorRect.bottom - gap : 0;
    const besideLeft = anchorRect && anchorRect.left - gap - width >= margin;
    const besideRight = anchorRect && anchorRect.right + gap + width <= win.innerWidth - margin;

    state.root.style.maxHeight = state.entry && anchorRect && !besideLeft && !besideRight
      ? `${Math.max(0, Math.min(win.innerHeight - margin * 2, Math.max(above, below)))}px` : "";
    const height = state.root.getBoundingClientRect().height;
    let left = anchorRect?.left ?? (win.innerWidth - width) / 2;
    let top = (win.innerHeight - height) / 2;
    if (anchorRect) {
      if (height <= below) top = anchorRect.bottom + gap;
      else if (state.entry && height > above && (besideLeft || besideRight)) {
        left = besideLeft ? anchorRect.left - gap - width : anchorRect.right + gap;
        top = anchorRect.top;
      } else top = anchorRect.top - gap - height;
    }
    left = Math.max(margin, Math.min(win.innerWidth - width - margin, left));
    top = Math.max(margin, Math.min(win.innerHeight - height - margin, top));
    state.root.style.left = `${left}px`;
    state.root.style.top = `${top}px`;
  }

  openSpellDetails({ actor, spell, anchor, onClose } = {}) {
    const source = sourceFor(spell);
    const state = this._open({ title: buildPrototypeSpellName(sourceName(spell), spell?.preparedEntry), label: t("Spell details"), anchor, onClose });
    if (!state) return null;
    const { element } = domFor(state.document);
    const stats = element("dl", "nas-proto-spell-panel-stats");
    for (const [label, value] of getPrototypeSpellStats(spell)) {
      stats.append(element("dt", "", label), element("dd", "", value));
    }
    const description = element("div", "nas-proto-spell-panel-description", "Loading spell description…");
    state.body.append(stats, description);
    this._position(state);
    const raw = text(source?.system?.description?.value ?? source?.system?.description ?? spell?.description);
    const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    Promise.resolve().then(async () => {
      if (!raw) return { plain: t("No description is available for this spell.") };
      if (typeof editor?.enrichHTML !== "function") return { plain: raw };
      const rollData = source?.getRollData?.() ?? actor?.getRollData?.() ?? {};
      return { html: await editor.enrichHTML(raw, { async: true, secrets: actor?.isOwner === true, rollData, relativeTo: source }) };
    }).then((result) => {
      if (this.active !== state) return;
      if (result.html !== undefined) description.innerHTML = result.html;
      else description.textContent = result.plain;
      this._position(state);
    }).catch((error) => {
      if (this.active !== state) return;
      description.textContent = t("The spell description could not be loaded.");
      this.onError?.(error);
    });
    return state.root;
  }

  openMetamagicPanel({ actor, spell, anchor, onChange, onClose } = {}) {
    if (anchor && this.active?.entry && this.active.anchor === anchor) {
      this.close();
      return null;
    }
    const source = sourceFor(spell);
    const entry = clone(spell?.preparedEntry ?? spell?.entry ?? {});
    entry.id ||= text(spell?.id);
    entry.originalSpellLevel = originalLevel(spell, entry);
    entry.suffixMode ||= AUTO_SUFFIX_MODE;
    entry.metamagic = normalizeMetamagicSelections(entry.metamagic, { originalLevel: entry.originalSpellLevel, sourceItem: source });
    const state = this._open({ title: sourceName(spell), label: t("Metamagic inscription"), anchor, onClose });
    if (!state) return null;
    state.actor = actor;
    state.spell = spell;
    state.source = source;
    state.entry = entry;
    state.onChange = onChange;
    state.isBaseDraft = entry.variant !== "custom" && !spell?.isVariant;
    this._renderMetamagic(state);
    return state.root;
  }

  _renderMetamagic(state, focusKey = "") {
    if (this.active !== state) return;
    const { actor, source, entry, body } = state;
    const { element, button } = domFor(state.document);
    body.replaceChildren();
    const preview = element("div", "nas-proto-spell-panel-preview");
    const previewEntry = state.unsavedLabel === undefined ? entry
      : { ...entry, suffix: text(state.unsavedLabel), suffixMode: MANUAL_SUFFIX_MODE };
    preview.append(element("strong", "", buildPrototypeSpellName(sourceName(state.spell), previewEntry)));
    preview.append(element("span", "", t("Prepared slot: {level}", {level: calculatePreparedSlotLevel(entry.originalSpellLevel, entry.metamagic)})));
    body.append(preview);
    const choices = getPreparedMetamagicChoices(actor, source, entry);
    const offeredKeys = new Set(choices.map((choice) => choice.key));
    for (const selection of entry.metamagic) {
      if (!offeredKeys.has(selection.key)) choices.push({ ...selection, label: selection.prefix || selection.name, selected: true, missingSource: true });
    }
    const grid = element("div", "nas-proto-spell-panel-seals");
    for (const choice of choices) {
      const row = element("div", `nas-proto-spell-panel-seal${choice.selected ? " is-selected" : ""}`);
      const toggle = button(`${choice.label} · +${choice.slotIncrease}`, () => {
        const patch = togglePreparedEntryMetamagic(actor, source, state.entry, choice.key);
        return this._commit(state, patch, choice.key);
      });
      toggle.dataset.metaKey = choice.key;
      toggle.setAttribute("aria-pressed", `${choice.selected === true}`);
      toggle.disabled = state.pending || choice.disabled === true;
      if (choice.disabledReasonKey) toggle.title = choiceReason(choice.disabledReasonKey);
      row.append(toggle);
      if (choice.missingSource) row.append(element("small", "", t("Feat no longer on actor; remove this selection to clear it.")));
      if (choice.disabled && choice.disabledReasonKey) row.append(element("small", "", choiceReason(choice.disabledReasonKey)));
      const options = choice.hasHeightenOptions ? choice.heightenChoices : choice.hasReachOptions ? choice.reachChoices : [];
      if (choice.selected && options?.length) {
        const label = element("label", "", choice.hasHeightenOptions ? t("Heightened spell level") : t("Reach increase"));
        const select = element("select");
        select.setAttribute("aria-label", choice.hasHeightenOptions ? t("Heightened spell level") : t("Reach increase"));
        select.disabled = state.pending;
        for (const option of options) {
          const node = element("option", "", `${option.label}${option.disabled ? t(" · Unavailable") : ""}`);
          node.value = `${option.value}`;
          node.selected = option.selected === true;
          node.disabled = option.disabled === true;
          select.append(node);
        }
        select.addEventListener("change", () => this._commit(state,
          updatePreparedEntryMetamagicOption(actor, source, state.entry, choice.key, select.value), choice.key));
        label.append(select);
        row.append(label);
      }
      grid.append(row);
    }
    if (!choices.length) grid.append(element("p", "", t("This actor has no eligible metamagic feats for this spell.")));
    body.append(grid);
    if (entry.metamagic.length) {
      const labels = element("div", "nas-proto-spell-panel-labels");
      const label = element("label", "", t("Inscription name"));
      const input = element("input");
      input.type = "text";
      input.value = state.unsavedLabel ?? entry.suffix ?? "";
      input.setAttribute("aria-label", t("Inscription name"));
      input.disabled = state.pending;
      input.addEventListener("input", () => {
        state.unsavedLabel = input.value;
        preview.querySelector("strong").textContent = buildPrototypeSpellName(sourceName(state.spell), {
          ...state.entry, suffix: text(input.value), suffixMode: MANUAL_SUFFIX_MODE
        });
      });
      input.addEventListener("change", () => this._changeLabel(state, input.value));
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        input.blur();
      });
      label.append(input);
      labels.append(label, button(t("Use metamagic name"), () => this._commit(state, buildAutoSuffixUpdate(state.entry, source))));
      body.append(labels);
    }
    if (state.error) {
      const error = element("p", "nas-proto-spell-panel-error", state.error);
      error.setAttribute("role", "alert");
      body.append(error);
    }
    this._position(state);
    if (focusKey) [...grid.querySelectorAll("[data-meta-key]")].find((node) => node.dataset.metaKey === focusKey)?.focus({ preventScroll: true });
  }

  async _commit(state, patch, focusKey = "") {
    if (this.active !== state || state.pending) return;
    if (!patch) {
      state.error = t("This metamagic selection is unavailable for the spell or its current slots.");
      this._renderMetamagic(state, focusKey);
      return;
    }
    const next = { ...clone(state.entry), ...clone(patch) };
    if (patch.suffix !== undefined) state.unsavedLabel = undefined;
    const createVariant = state.isBaseDraft && next.metamagic?.length > 0;
    state.pending = true;
    state.error = "";
    this._renderMetamagic(state);
    try {
      const result = await state.onChange?.(clone(patch), { entryId: state.entry.id, createVariant });
      if (this.active !== state) return;
      const returned = result?.preparedEntry ?? (result?.id ? result : null);
      state.entry = { ...next, ...(returned ? clone(returned) : {}) };
      if (createVariant) {
        state.isBaseDraft = false;
        state.entry.variant = "custom";
      }
      if (!state.isBaseDraft && !state.entry.metamagic?.length) {
        this.close({ discardDraft: true });
        return;
      }
    } catch (error) {
      if (this.active !== state) return;
      if (patch.suffix !== undefined) state.unsavedLabel = patch.suffix;
      state.error = text(error?.message) || t("Could not update your preparation.");
      this.onError?.(error);
    } finally {
      state.pending = false;
      this._renderMetamagic(state, focusKey);
    }
  }

  _changeLabel(state, value) {
    if (this.active !== state) return;
    state.unsavedLabel = value;
    if (this.dismissalSuspensions) return;
    return this._commit(state, { suffix: text(value), suffixMode: MANUAL_SUFFIX_MODE });
  }

  close({ restoreFocus = true, discardDraft = false } = {}) {
    const state = this.active;
    if (!state) return true;

    if (!discardDraft) {
      this.flushPendingChanges();
      if (this.hasPendingChanges()) return false;
    }
    this.active = null;
    state.abort.abort();
    state.root.remove();
    if (restoreFocus && state.anchor?.isConnected) state.anchor.focus({ preventScroll: true });
    state.onClose?.();
    return true;
  }

  destroy() {
    this.close({ restoreFocus: false, discardDraft: true });
  }
}

export function createSpellPanels(options) {
  return new PrototypeSpellPanels(options);
}
