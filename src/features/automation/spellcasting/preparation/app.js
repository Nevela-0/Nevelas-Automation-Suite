import { MODULE } from "../../../../common/module.js";
import { jqueryFromHtmlLike } from "../../../../common/foundryCompat.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import { completeSpellbookPreparation, isSpellbookPreparationPending } from "./flags.js";
import {
  countMissingKnownSpellImports,
  getKnownSpells,
  importMissingKnownSpells,
  initializeKnownSpellbook,
  isKnownSpellbookInitialized,
  removeKnownSpell
} from "./knownSpells.js";
import {
  addPreparedSpellVariant,
  deletePreparedSpellItemsForKnown,
  deletePreparedSpellItemForEntry,
  findGeneratedPreparedSpellItemForEntry,
  getGeneratedPreparedCount,
  getPreparedEntriesForKnownSpell,
  getPreparedEntriesForKnownSpells,
  isGeneratedPreparedSpellItem,
  isSpellbookPreparedItemsManaged,
  removePreparedSpellVariant,
  removePreparedSpellVariantsForKnown,
  syncGeneratedPreparedSpellItems,
  updatePreparedSpellVariant
} from "./preparedItems.js";
import {
  MANUAL_SUFFIX_MODE,
  buildAutoSuffixUpdate,
  calculatePreparedSlotLevel,
  getMetamagicSummary,
  getPreparedMetamagicChoices,
  normalizeMetamagicSelections,
  togglePreparedEntryMetamagic,
  updatePreparedEntryMetamagicOption
} from "./metamagicInscription.js";
import {
  getSpellbookLevelAvailability,
  getSpellbookLevelPreparationCaps
} from "./slotAvailability.js";
import { getSpellbookAnimationMode, isSpellbookPreparationFullModeEnabled } from "./settings.js";

const TEMPLATE_PATH = `modules/${MODULE.ID}/src/templates/spellbook-preparation-form.html`;
const SPELL_LEVEL_COUNT = 10;
const SPELLS_PER_PAGE = 10;

function localize(key, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.localize(fullKey);
  return value && value !== fullKey ? value : fallback;
}

function formatLocalized(key, data, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.format(fullKey, data);
  return value && value !== fullKey ? value : fallback;
}

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function coerceNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function clampIndex(value, max) {
  return Math.max(0, Math.min(value, Math.max(0, max)));
}

function getSpellLevelLabel(level) {
  if (level >= 0 && level < SPELL_LEVEL_COUNT) {
    return globalThis.pf1?.config?.spellLevels?.[level] ?? `Level ${level}`;
  }

  return game.i18n.localize("PF1.Unknown");
}

function getSpellbook(actor, bookId) {
  return actor?.system?.attributes?.spells?.spellbooks?.[bookId] ?? null;
}

function getSpellbookLabel(book, bookId) {
  return book?.name || book?.label || bookId;
}

function getModeLabel(mode) {
  const normalizedMode = normalizeId(mode);
  if (normalizedMode === "hybrid") return localize("labels.arcanistMode", "Arcanist");
  if (normalizedMode === "prepared") return localize("labels.preparedMode", "Prepared");

  const choices = globalThis.pf1?.config?.casterPreparation ?? {};
  const label = choices[normalizedMode] ?? normalizedMode;
  return label ? label.toString().replace(/\b\w/g, (letter) => letter.toUpperCase()) : normalizedMode;
}

function getActorItem(actor, itemId) {
  const id = normalizeId(itemId);
  if (!id) return null;
  return actor?.items?.get?.(id) ?? Array.from(actor?.items ?? []).find((item) => item?.id === id) ?? null;
}

function getItemActor(item) {
  return item?.parent?.documentName === "Actor" ? item.parent : item?.actor ?? null;
}

function isSameActor(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return left.id && right.id && left.id === right.id;
}

function getSpellLevel(itemOrData, fallback = 99) {
  const level = Number(itemOrData?.system?.level ?? itemOrData?.level ?? fallback);
  if (!Number.isInteger(level) || level < 0 || level >= SPELL_LEVEL_COUNT) return 99;
  return level;
}

function getSlotCost(item) {
  const cost = Number(item.slotCost ?? item.system?.slotCost ?? 1);
  return Number.isFinite(cost) ? Math.max(0, cost) : 1;
}

function isDomainSpell(item) {
  return item?.isDomain === true || item?.system?.domain === true;
}

function isAtWillSpell(item) {
  return item?.system?.atWill === true;
}

function getSlotAvailabilityReasonKey(availability) {
  if (availability?.reason === "lowAbilityScore") return "slotUnavailableLowAbility";
  if (availability?.unknown === true) return "slotUnknown";
  return "slotUnavailable";
}

function getCurrentPreparedCount(item, mode) {
  if (item?.system?.atWill) return 0;
  if (mode === "hybrid") return Number(item.system?.preparation?.value ?? 0) > 0 ? 1 : 0;
  return coerceNonNegativeInteger(item.system?.preparation?.max ?? 0);
}

function getLevelCaps(book, level) {
  return getSpellbookLevelPreparationCaps(book, level);
}

function formatCapLabel(value) {
  return value === null ? localize("labels.unknownCap", "?") : `${value}`;
}

function getLevelBookmarkLabel(level) {
  if (level >= 0 && level < SPELL_LEVEL_COUNT) return `${level}`;
  return "?";
}

function buildLevelPages(level) {
  const pageCount = Math.max(1, Math.ceil(level.spells.length / SPELLS_PER_PAGE));
  const pages = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const start = pageIndex * SPELLS_PER_PAGE;
    pages.push({
      ...level,
      spells: level.spells.slice(start, start + SPELLS_PER_PAGE),
      pageNumber: pageIndex + 1,
      pageCount,
      hasMultiplePages: pageCount > 1
    });
  }

  return pages;
}

function buildPreparedEntryState(actor, bookId, knownSpell, preparedEntry, mode, managed, desiredById = null, options = {}) {
  const candidateItem = getActorItem(actor, knownSpell.sourceItemId);
  const liveItem = candidateItem?.type === "spell"
    && normalizeId(candidateItem.system?.spellbook) === normalizeId(bookId)
    && !isGeneratedPreparedSpellItem(candidateItem)
    ? candidateItem
    : null;
  const generatedItem = findGeneratedPreparedSpellItemForEntry(actor, bookId, preparedEntry);
  const source = liveItem ?? knownSpell.itemData ?? knownSpell;
  const missing = !liveItem;
  const originalSpellLevel = getSpellLevel(source, knownSpell.level);
  const isVariant = preparedEntry.variant === "custom";
  const normalizedMetamagic = isVariant
    ? normalizeMetamagicSelections(preparedEntry.metamagic, { originalLevel: originalSpellLevel, sourceItem: source })
    : [];
  const preparedSlotLevel = isVariant
    ? calculatePreparedSlotLevel(originalSpellLevel, normalizedMetamagic)
    : getSpellLevel({ level: preparedEntry.preparedSlotLevel }, originalSpellLevel);
  const level = preparedSlotLevel;
  const atWill = isAtWillSpell(source);
  let count = 0;
  if (desiredById?.has(preparedEntry.id)) {
    count = coerceNonNegativeInteger(desiredById.get(preparedEntry.id));
  } else if (!missing && !atWill && generatedItem) {
    count = getGeneratedPreparedCount(generatedItem, mode);
  } else if (!missing && !atWill && !managed && !isVariant && liveItem) {
    count = getCurrentPreparedCount(liveItem, mode);
  }

  const slotCost = getSlotCost(source);
  const domain = isDomainSpell(source);
  const slotAvailability = getSpellbookLevelAvailability(getSpellbook(actor, bookId), preparedSlotLevel, { domain });
  const slotUnavailable = isVariant && !missing && !atWill && slotAvailability.unavailable === true;
  const slotAvailabilityReasonKey = slotUnavailable ? getSlotAvailabilityReasonKey(slotAvailability) : "";
  const name = liveItem?.name || source?.name || knownSpell.name || localize("labels.unknownSpell", "Unknown spell");
  const preparedEntryForDisplay = isVariant
    ? { ...preparedEntry, metamagic: normalizedMetamagic, preparedSlotLevel }
    : preparedEntry;
  const metamagicChoices = isVariant && !missing && !atWill
    ? getPreparedMetamagicChoices(actor, source, preparedEntryForDisplay).map((choice) => ({
      ...choice,
      disabledReason: choice.disabledReasonKey
        ? localize(`labels.${choice.disabledReasonKey}`, choice.disabledReasonKey)
        : "",
      hasVariableOptions: choice.hasHeightenOptions || choice.hasReachOptions,
      slotIncreaseLabel: formatLocalized(
        "labels.slotIncrease",
        { value: choice.slotIncrease },
        `+${choice.slotIncrease} slot`
      )
    }))
    : [];
  const metamagicSummary = getMetamagicSummary(normalizedMetamagic);
  const canConfigureMetamagic = isVariant && !missing && !atWill;

  return {
    id: preparedEntry.id,
    knownSpellId: knownSpell.id,
    sourceItemId: liveItem?.id ?? knownSpell.sourceItemId,
    name,
    img: liveItem?.img || source?.img || knownSpell.img || "icons/svg/book.svg",
    level,
    count,
    checked: count > 0,
    suffix: preparedEntry.suffix ?? "",
    suffixMode: preparedEntry.suffixMode ?? "auto",
    isBase: !isVariant,
    isVariant,
    canAddVariant: !isVariant && !missing && !atWill,
    canEditSuffix: isVariant && !missing && !atWill,
    canRemoveVariant: isVariant,
    canConfigureMetamagic,
    slotCost,
    domain,
    atWill,
    missing,
    slotUnavailable,
    slotAvailabilityReasonKey,
    slotUnavailableReason: slotAvailabilityReasonKey
      ? localize(`labels.${slotAvailabilityReasonKey}`, slotAvailabilityReasonKey)
      : "",
    originalSpellLevel,
    preparedSlotLevel,
    originalLevelLabel: getSpellLevelLabel(originalSpellLevel),
    preparedSlotLevelLabel: getSpellLevelLabel(preparedSlotLevel),
    isSlotLevelModified: preparedSlotLevel !== originalSpellLevel,
    metamagicChoices,
    hasMetamagicChoices: metamagicChoices.length > 0,
    metamagicSummary,
    hasMetamagic: metamagicSummary.length > 0,
    inscriptionOpen: canConfigureMetamagic && options.openEntryId === preparedEntry.id,
    sort: Number(preparedEntry.sort ?? 0),
    searchText: `${name} ${preparedEntry.suffix ?? ""} ${metamagicSummary} ${getSpellLevelLabel(level)} ${missing ? localize("labels.missingSource", "Missing source") : ""}`.toLocaleLowerCase(),
    useCountInput: !missing && !atWill && mode !== "hybrid",
    usePreparedToggle: !missing && !atWill && mode === "hybrid"
  };
}

function buildSpellbookPreparationState(actor, bookId, desiredById = null, options = {}) {
  const book = getSpellbook(actor, bookId);
  const mode = normalizeId(book?.spellPreparationMode);
  const isHybrid = mode === "hybrid";
  const initialized = isKnownSpellbookInitialized(actor, bookId);
  const importableSpellCount = countMissingKnownSpellImports(actor, bookId);
  const knownSpells = initialized ? getKnownSpells(actor, bookId) : [];
  const managed = isSpellbookPreparedItemsManaged(actor, bookId);
  const spells = knownSpells
    .flatMap((knownSpell) => getPreparedEntriesForKnownSpell(actor, bookId, knownSpell)
      .map((preparedEntry) => buildPreparedEntryState(actor, bookId, knownSpell, preparedEntry, mode, managed, desiredById, options)))
    .sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      const nameSort = a.name.localeCompare(b.name, game.i18n.lang, { sensitivity: "base", numeric: true });
      if (nameSort !== 0) return nameSort;
      if (a.knownSpellId !== b.knownSpellId) return a.knownSpellId.localeCompare(b.knownSpellId);
      if (a.isVariant !== b.isVariant) return a.isVariant ? 1 : -1;
      return a.sort - b.sort;
    });
  const levelMap = new Map();

  for (const item of spells) {
    const level = item.level;
    if (!levelMap.has(level)) {
      const caps = getLevelCaps(book, level);
      levelMap.set(level, {
        level,
        label: getSpellLevelLabel(level),
        normalCap: caps.normal,
        domainCap: caps.domain,
        normalAvailability: caps.normalAvailability,
        domainAvailability: caps.domainAvailability,
        normalUsed: 0,
        domainUsed: 0,
        hasDomainCounter: caps.domain > 0,
        overLimit: false,
        spells: []
      });
    }

    const levelState = levelMap.get(level);
    const used = item.missing || item.atWill ? 0 : item.count * item.slotCost;

    if (item.domain) {
      levelState.domainUsed += used;
      levelState.hasDomainCounter = true;
    } else {
      levelState.normalUsed += used;
    }

    levelState.spells.push(item);
  }

  const levels = Array.from(levelMap.values()).sort((a, b) => a.level - b.level);
  for (const level of levels) {
    const normalOver = level.normalCap !== null && level.normalUsed > level.normalCap;
    const domainOver = level.domainCap !== null && level.domainUsed > level.domainCap;
    level.overLimit = normalOver || domainOver;
    level.normalCapValue = level.normalCap === null ? "" : level.normalCap;
    level.domainCapValue = level.domainCap === null ? "" : level.domainCap;
    level.normalCapLabel = level.normalAvailability?.unavailable
      ? localize("labels.unavailableCap", "Unavailable")
      : formatCapLabel(level.normalCap);
    level.domainCapLabel = level.domainAvailability?.unavailable
      ? localize("labels.unavailableCap", "Unavailable")
      : formatCapLabel(level.domainCap);
    level.hasSpells = level.spells.length > 0;
  }

  const overLimit = levels.some((level) => level.overLimit);
  const spreads = [];
  const bookmarks = [];
  for (const level of levels) {
    const pages = buildLevelPages(level);
    const firstSpreadIndex = spreads.length;

    bookmarks.push({
      level: level.level,
      label: level.label,
      shortLabel: getLevelBookmarkLabel(level.level),
      spreadIndex: firstSpreadIndex,
      active: firstSpreadIndex === 0
    });

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 2) {
      const spreadIndex = spreads.length;
      spreads.push({
        index: spreadIndex,
        level: level.level,
        left: pages[pageIndex] ?? null,
        right: pages[pageIndex + 1] ?? null,
        active: spreadIndex === 0
      });
    }
  }

  return {
    book,
    bookId,
    bookLabel: getSpellbookLabel(book, bookId),
    mode,
    modeLabel: getModeLabel(mode),
    isHybrid,
    isPrepared: mode === "prepared",
    initialized,
    managed,
    needsKnownSpellImport: !initialized,
    importableSpellCount,
    hasImportableSpells: importableSpellCount > 0,
    missingSourceCount: spells.filter((spell) => spell.missing).length,
    pending: isSpellbookPreparationPending(actor, bookId),
    levels,
    spreads,
    bookmarks,
    hasBookmarks: bookmarks.length > 1,
    hasMultipleSpreads: spreads.length > 1,
    spells,
    overLimit,
    hasSpells: initialized && spells.length > 0
  };
}

function readSubmittedPreparation(form, spells, mode) {
  const data = new FormData(form);
  const desired = new Map();

  for (const spell of spells) {
    if (spell.missing || spell.atWill) continue;

    const key = `entries.${spell.id}`;
    if (mode === "hybrid") {
      desired.set(spell.id, data.has(key) ? 1 : 0);
    } else {
      desired.set(spell.id, coerceNonNegativeInteger(data.get(key)));
    }
  }

  return desired;
}

function parseCapValue(value) {
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeHtml(value) {
  const text = `${value ?? ""}`;
  if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function warnSpellbookPreparation(message, data = {}) {
  console.warn(`[NAS SpellbookPreparation] ${message}`, data);
}

function errorSpellbookPreparation(message, error, data = {}) {
  console.error(`[NAS SpellbookPreparation] ${message}`, {
    ...data,
    error
  });
}

export class SpellbookPreparationApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "nas-spellbook-preparation",
      classes: ["nas-spellbook-preparation-app"],
      template: TEMPLATE_PATH,
      width: 760,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      resizable: true
    });
  }

  static open(actor, bookId) {
    if (!isSpellbookPreparationFullModeEnabled()) return null;

    const existing = Object.values(ui.windows ?? {}).find((app) => (
      app instanceof SpellbookPreparationApp
      && app.actor?.id === actor?.id
      && app.bookId === bookId
    ));

    if (existing) {
      existing.render(false);
      existing.bringToFront();
      return existing;
    }

    return new SpellbookPreparationApp(actor, bookId).render(true);
  }

  constructor(actor, bookId, options = {}) {
    const normalizedBookId = normalizeId(bookId);
    super(actor, {
      ...options,
      id: `nas-spellbook-preparation-${actor?.id ?? "actor"}-${normalizedBookId}`
    });
    this.actor = actor;
    this.bookId = normalizedBookId;
    this.spreadIndex = 0;
    this.inscriptionEntryId = null;
    this._liveRefreshTimeout = null;
    this._onLiveItemCreated = (item, options) => this._onLiveItemDocumentChanged(item, options);
    this._onLiveItemUpdated = (item, changes, options) => this._onLiveItemDocumentChanged(item, options);
    this._onLiveItemDeleted = (item, options) => this._onLiveItemDocumentChanged(item, options);
    Hooks.on("createItem", this._onLiveItemCreated);
    Hooks.on("updateItem", this._onLiveItemUpdated);
    Hooks.on("deleteItem", this._onLiveItemDeleted);
  }

  async close(options = {}) {
    Hooks.off("createItem", this._onLiveItemCreated);
    Hooks.off("updateItem", this._onLiveItemUpdated);
    Hooks.off("deleteItem", this._onLiveItemDeleted);
    if (this._liveRefreshTimeout) {
      globalThis.clearTimeout(this._liveRefreshTimeout);
      this._liveRefreshTimeout = null;
    }

    return super.close(options);
  }

  get title() {
    const book = getSpellbook(this.actor, this.bookId);
    return formatLocalized(
      "title",
      { actor: this.actor?.name ?? "", book: getSpellbookLabel(book, this.bookId) },
      `Prepare ${getSpellbookLabel(book, this.bookId)}`
    );
  }

  getData() {
    const data = super.getData();
    const state = buildSpellbookPreparationState(this.actor, this.bookId, null, {
      openEntryId: this.inscriptionEntryId
    });
    if (this.inscriptionEntryId) {
      const openSpread = state.spreads.find((spread) => (
        spread.left?.spells?.some((spell) => spell.id === this.inscriptionEntryId)
        || spread.right?.spells?.some((spell) => spell.id === this.inscriptionEntryId)
      ));
      if (openSpread) this.spreadIndex = openSpread.index;
    }
    this.spreadIndex = clampIndex(this.spreadIndex, state.spreads.length - 1);
    const activeLevel = state.spreads[this.spreadIndex]?.level;
    for (const spread of state.spreads) {
      spread.active = spread.index === this.spreadIndex;
    }
    for (const bookmark of state.bookmarks) {
      bookmark.active = bookmark.level === activeLevel;
    }

    return {
      ...data,
      ...state,
      animationMode: getSpellbookAnimationMode(),
      labels: {
        apply: localize("actions.apply", "Apply"),
        atWill: localize("labels.atWill", "At will"),
        bookmarks: localize("labels.bookmarks", "Spell levels"),
        domain: localize("labels.domain", "Domain"),
        firstRunIntro: localize("labels.firstRunIntro", "Choose how NAS should initialize its known spellbook for this spellbook."),
        firstRunTitle: localize("labels.firstRunTitle", "Initialize Known Spellbook"),
        importableSpells: formatLocalized("labels.importableSpells", { count: state.importableSpellCount }, `${state.importableSpellCount} current spells available to import.`),
        importCurrent: localize("actions.importCurrent", "Import current spellbook"),
        importMissing: localize("actions.importMissing", "Import missing spells"),
        importMissingSummary: formatLocalized("labels.importMissingSummary", { count: state.importableSpellCount }, `${state.importableSpellCount} current spells are not in the NAS spellbook.`),
        addVariant: localize("actions.addVariant", "Add prepared variant"),
        autoSuffix: localize("actions.autoSuffix", "Auto-title"),
        configureMetamagic: localize("actions.configureMetamagic", "Inscribe metamagic"),
        decreaseCount: localize("labels.decreaseCount", "Decrease prepared count"),
        increaseCount: localize("labels.increaseCount", "Increase prepared count"),
        missingSource: localize("labels.missingSource", "Missing source"),
        noMetamagicFeats: localize("labels.noMetamagicFeats", "No actor-owned metamagic feats are available."),
        noSpells: localize("labels.noSpells", "No spells in this spellbook."),
        noResults: localize("labels.noResults", "No matching spells."),
        normalSlots: localize("labels.normalSlots", "Prepared"),
        pending: localize("labels.pending", "Pending"),
        preparedSlot: localize("labels.preparedSlot", "Prepared slot"),
        prevPage: localize("tooltips.previousPage", "Previous spell levels"),
        reachSteps: localize("labels.reachSteps", "Reach steps"),
        removeKnown: localize("actions.removeKnown", "Remove from known spells"),
        removeVariant: localize("actions.removeVariant", "Remove prepared variant"),
        search: localize("labels.search", "Search"),
        nextPage: localize("tooltips.nextPage", "Next spell levels"),
        selected: localize("labels.selected", "Prepared"),
        startEmpty: localize("actions.startEmpty", "Start empty"),
        slotCost: localize("labels.slotCost", "Slot cost"),
        slotCostShort: localize("labels.slotCostShort", "Cost"),
        heightenTo: localize("labels.heightenTo", "Heighten to"),
        inscriptionTitle: localize("labels.inscriptionTitle", "Metamagic inscription"),
        originalLevel: localize("labels.originalLevel", "Original level"),
        preparedSlotShort: localize("labels.preparedSlotShort", "Slot"),
        slotUnavailable: localize("labels.slotUnavailable", "Unavailable slot"),
        slotUnavailableLowAbility: localize("labels.slotUnavailableLowAbility", "Unavailable: low casting ability score"),
        slotUnknown: localize("labels.slotUnknown", "Slot availability unknown"),
        unavailableCap: localize("labels.unavailableCap", "Unavailable"),
        variantSource: localize("labels.variantSource", "from"),
        variantSuffix: localize("labels.variantSuffix", "Variant suffix"),
        domainSlots: localize("labels.domainSlots", "Domain"),
        overLimit: localize("labels.overLimit", "Over limit")
      }
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = jqueryFromHtmlLike(html)?.[0] ?? html?.[0] ?? html;
    if (!root?.querySelector) return;

    root.querySelector("[data-nas-prep-action='import-current']")?.addEventListener("click", (event) => {
      event.preventDefault();
      void this._initializeKnownSpellbook({ importCurrent: true });
    });
    root.querySelector("[data-nas-prep-action='start-empty']")?.addEventListener("click", (event) => {
      event.preventDefault();
      void this._initializeKnownSpellbook({ importCurrent: false });
    });
    root.querySelector("[data-nas-prep-action='import-missing']")?.addEventListener("click", (event) => {
      event.preventDefault();
      void this._importMissingKnownSpells();
    });
    for (const button of root.querySelectorAll(".nas-prep-remove-known")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onRemoveKnownSpell(event);
      });
    }
    for (const button of root.querySelectorAll(".nas-prep-add-variant")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onAddPreparedVariant(event);
      });
    }
    for (const button of root.querySelectorAll(".nas-prep-remove-variant")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onRemovePreparedVariant(event);
      });
    }
    for (const button of root.querySelectorAll(".nas-prep-configure-metamagic")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onToggleMetamagicInscription(event);
      });
    }
    for (const button of root.querySelectorAll(".nas-prep-metamagic-seal, .nas-prep-metamagic-seal-toggle")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onToggleMetamagicSeal(event);
      });
    }
    for (const select of root.querySelectorAll(".nas-prep-heighten-level, .nas-prep-reach-steps")) {
      select.addEventListener("change", (event) => {
        void this._onMetamagicOptionChange(event);
      });
    }
    for (const button of root.querySelectorAll(".nas-prep-auto-suffix")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        void this._onResetMetamagicSuffix(event);
      });
    }
    for (const input of root.querySelectorAll(".nas-prep-variant-suffix")) {
      input.addEventListener("change", (event) => {
        void this._onVariantSuffixChange(event);
      });
    }

    root.querySelector("[name='search']")?.addEventListener("input", () => this._applySearch(root));
    for (const input of root.querySelectorAll(".nas-prep-count, .nas-prep-toggle")) {
      input.addEventListener("input", () => this._refreshValidation(root));
      input.addEventListener("change", () => this._refreshValidation(root));
    }

    for (const button of root.querySelectorAll(".nas-prep-step")) {
      button.addEventListener("click", (event) => this._onStepCount(event, root));
    }

    root.querySelector(".nas-prep-page-prev")?.addEventListener("click", (event) => {
      event.preventDefault();
      this._turnSpread(root, -1);
    });
    root.querySelector(".nas-prep-page-next")?.addEventListener("click", (event) => {
      event.preventDefault();
      this._turnSpread(root, 1);
    });
    for (const bookmark of root.querySelectorAll(".nas-prep-bookmark")) {
      bookmark.addEventListener("click", (event) => {
        event.preventDefault();
        this._turnToSpread(root, Number(event.currentTarget.dataset.spreadIndex));
      });
    }

    this._syncVisibleSpread(root);
    this._refreshValidation(root);
  }

  _canModifySpellbook() {
    if (this.actor?.isOwner === false) {
      ui.notifications.warn(localize("warnings.noPermission", "You do not have permission to prepare this spellbook."));
      return false;
    }

    if (!getEligibleSpellbookIds(this.actor).includes(this.bookId)) {
      ui.notifications.warn(localize("warnings.ineligible", "This spellbook cannot be prepared."));
      return false;
    }

    return true;
  }

  async _initializeKnownSpellbook({ importCurrent = false } = {}) {
    if (!this._canModifySpellbook()) return;

    const book = await initializeKnownSpellbook(this.actor, this.bookId, { importCurrent });
    const count = book?.knownSpells?.length ?? 0;
    const infoKey = importCurrent ? "info.knownImported" : "info.knownStartedEmpty";
    const fallback = importCurrent
      ? `${count} spells imported into the NAS spellbook.`
      : "NAS known spellbook initialized.";
    ui.notifications.info(formatLocalized(infoKey, { count }, fallback));

    await this.render(false);
  }

  async _importMissingKnownSpells() {
    if (!this._canModifySpellbook()) return;

    const result = await importMissingKnownSpells(this.actor, this.bookId);
    ui.notifications.info(formatLocalized(
      "info.knownMissingImported",
      { count: result.added },
      `${result.added} spells imported into the NAS spellbook.`
    ));

    await this.render(false);
  }

  async _onRemoveKnownSpell(event) {
    if (!this._canModifySpellbook()) return;

    const button = event.currentTarget;
    const knownSpellId = button?.dataset?.knownSpellId;
    const spellName = button?.dataset?.spellName ?? localize("labels.unknownSpell", "Unknown spell");
    const confirmed = await Dialog.confirm({
      title: localize("confirm.removeKnownTitle", "Remove Known Spell"),
      content: `<p>${formatLocalized(
        "confirm.removeKnownContent",
        { spell: escapeHtml(spellName) },
        `Remove ${escapeHtml(spellName)} from the NAS known spellbook? The actor item will not be deleted.`
      )}</p>`,
      defaultYes: false
    });
    if (!confirmed) return;

    await deletePreparedSpellItemsForKnown(this.actor, this.bookId, knownSpellId);
    await removePreparedSpellVariantsForKnown(this.actor, this.bookId, knownSpellId);
    const removed = await removeKnownSpell(this.actor, this.bookId, knownSpellId);
    if (removed) {
      ui.notifications.info(formatLocalized(
        "info.knownRemoved",
        { spell: spellName },
        `${spellName} removed from the NAS known spellbook.`
      ));
      if (this.actor.sheet?.rendered) this.actor.sheet.render(false);
      await this.render(false);
    }
  }

  async _onAddPreparedVariant(event) {
    if (!this._canModifySpellbook()) return;

    const knownSpellId = event.currentTarget?.dataset?.knownSpellId;
    const knownSpells = getKnownSpells(this.actor, this.bookId);

    const knownSpell = knownSpells
      .find((entry) => normalizeId(entry.id) === normalizeId(knownSpellId));
    if (!knownSpell) {
      warnSpellbookPreparation("Add variant could not find known spell.", {
        actorId: this.actor?.id,
        bookId: this.bookId,
        knownSpellId,
        knownSpellIds: knownSpells.map((entry) => entry.id)
      });
      return;
    }

    try {
      const entry = await addPreparedSpellVariant(this.actor, this.bookId, knownSpell, {
        suffix: localize("labels.variantDefault", "Variant")
      });

      if (entry?.id) this.inscriptionEntryId = entry.id;
      await this.render(false);
    } catch (error) {
      errorSpellbookPreparation("Add variant failed.", error, {
        actorId: this.actor?.id,
        bookId: this.bookId,
        knownSpellId,
        knownSpellName: knownSpell.name
      });
      ui.notifications.error("NAS SpellbookPreparation: failed to add prepared variant. Check the console for details.");
    }
  }

  async _onRemovePreparedVariant(event) {
    if (!this._canModifySpellbook()) return;

    const entryId = event.currentTarget?.dataset?.entryId;
    if (!entryId) return;

    await deletePreparedSpellItemForEntry(this.actor, this.bookId, entryId);
    const removed = await removePreparedSpellVariant(this.actor, this.bookId, entryId);
    if (removed) {
      if (this.inscriptionEntryId === entryId) this.inscriptionEntryId = null;
      if (this.actor.sheet?.rendered) this.actor.sheet.render(false);
      await this.render(false);
    }
  }

  _getPreparedEntryContext(entryId) {
    const normalizedEntryId = normalizeId(entryId);
    if (!normalizedEntryId) return null;

    for (const knownSpell of getKnownSpells(this.actor, this.bookId)) {
      const preparedEntry = getPreparedEntriesForKnownSpell(this.actor, this.bookId, knownSpell)
        .find((entry) => entry.id === normalizedEntryId);
      if (!preparedEntry || preparedEntry.variant !== "custom") continue;

      const sourceItem = getActorItem(this.actor, knownSpell.sourceItemId) ?? knownSpell.itemData ?? knownSpell;
      return { knownSpell, preparedEntry, sourceItem };
    }

    return null;
  }

  async _onToggleMetamagicInscription(event) {
    const entryId = event.currentTarget?.dataset?.entryId;
    if (!entryId) return;
    this.inscriptionEntryId = this.inscriptionEntryId === entryId ? null : entryId;
    await this.render(false);
  }

  async _onToggleMetamagicSeal(event) {
    if (!this._canModifySpellbook()) return;

    const button = event.currentTarget;
    const entryId = button?.dataset?.entryId;
    const key = button?.dataset?.metamagicKey;
    const context = this._getPreparedEntryContext(entryId);
    if (!context || !key) return;

    const update = togglePreparedEntryMetamagic(this.actor, context.sourceItem, context.preparedEntry, key, {
      fallbackSuffix: localize("labels.variantDefault", "Variant")
    });
    if (!update) {
      warnSpellbookPreparation("Toggle metamagic seal produced no update.", {
        actorId: this.actor?.id,
        bookId: this.bookId,
        entryId,
        key,
        preparedEntry: context.preparedEntry
      });
      ui.notifications.warn(localize("warnings.metamagicUnavailable", "This metamagic inscription is not available for this spell."));
      return;
    }

    await updatePreparedSpellVariant(this.actor, this.bookId, entryId, update);
    this.inscriptionEntryId = entryId;
    await this.render(false);
  }

  async _onMetamagicOptionChange(event) {
    if (!this._canModifySpellbook()) return;

    const input = event.currentTarget;
    const entryId = input?.dataset?.entryId;
    const key = input?.dataset?.metamagicKey;
    const context = this._getPreparedEntryContext(entryId);
    if (!context || !key) return;

    const update = updatePreparedEntryMetamagicOption(this.actor, context.sourceItem, context.preparedEntry, key, input.value, {
      fallbackSuffix: localize("labels.variantDefault", "Variant")
    });
    if (!update) {
      warnSpellbookPreparation("Metamagic option change produced no update.", {
        actorId: this.actor?.id,
        bookId: this.bookId,
        entryId,
        key,
        value: input?.value,
        preparedEntry: context.preparedEntry
      });
      ui.notifications.warn(localize("warnings.metamagicUnavailable", "This metamagic inscription is not available for this spell."));
      return;
    }

    await updatePreparedSpellVariant(this.actor, this.bookId, entryId, update);
    this.inscriptionEntryId = entryId;
    await this.render(false);
  }

  async _onResetMetamagicSuffix(event) {
    if (!this._canModifySpellbook()) return;

    const entryId = event.currentTarget?.dataset?.entryId;
    const context = this._getPreparedEntryContext(entryId);
    if (!context) return;

    await updatePreparedSpellVariant(this.actor, this.bookId, entryId, buildAutoSuffixUpdate(context.preparedEntry, context.sourceItem, {
      fallbackSuffix: localize("labels.variantDefault", "Variant")
    }));
    this.inscriptionEntryId = entryId;
    await this.render(false);
  }

  async _onVariantSuffixChange(event) {
    if (!this._canModifySpellbook()) return;

    const input = event.currentTarget;
    await updatePreparedSpellVariant(this.actor, this.bookId, input.dataset.entryId, {
      suffix: input.value,
      suffixMode: MANUAL_SUFFIX_MODE
    });
  }

  async _persistVariantSuffixesFromForm(form) {
    const inputs = Array.from(form?.querySelectorAll?.(".nas-prep-variant-suffix") ?? []);
    for (const input of inputs) {
      if (input.value === input.dataset.originalSuffix) continue;
      await updatePreparedSpellVariant(this.actor, this.bookId, input.dataset.entryId, {
        suffix: input.value,
        suffixMode: MANUAL_SUFFIX_MODE
      });
    }
  }

  _onLiveItemDocumentChanged(item, options = {}) {
    if (options?.nasSpellbookPreparation === true) return;
    if (!this.rendered || !this._isRelevantSpellItemChange(item)) return;

    if (this._liveRefreshTimeout) globalThis.clearTimeout(this._liveRefreshTimeout);
    this._liveRefreshTimeout = globalThis.setTimeout(() => {
      this._liveRefreshTimeout = null;
      if (this.rendered) this.render(false);
    }, 100);
  }

  _isRelevantSpellItemChange(item) {
    if (item?.type !== "spell") return false;
    if (!isSameActor(getItemActor(item), this.actor)) return false;

    const itemBookId = normalizeId(item.system?.spellbook);
    if (itemBookId === this.bookId) return true;

    return getKnownSpells(this.actor, this.bookId)
      .some((knownSpell) => normalizeId(knownSpell.sourceItemId) === normalizeId(item.id));
  }

  _applySearch(root) {
    const query = root.querySelector("[name='search']")?.value?.trim().toLocaleLowerCase() ?? "";
    const searching = query.length > 0;
    let visibleRows = 0;

    for (const row of root.querySelectorAll(".nas-prep-spell-row, .nas-prep-inscription-row")) {
      const visible = !searching || row.dataset.search?.includes(query);
      row.hidden = !visible;
      if (visible && row.classList.contains("nas-prep-spell-row")) visibleRows += 1;
    }

    const shell = root.querySelector(".nas-prep-book-shell");
    shell?.classList.toggle("nas-prep-searching", searching);

    if (searching) {
      const matchingSpreadIndexes = [];
      for (const page of root.querySelectorAll(".nas-prep-page")) {
        const hasVisibleSpell = Array.from(page.querySelectorAll(".nas-prep-spell-row")).some((row) => !row.hidden);
        page.hidden = !hasVisibleSpell;
      }

      for (const spread of root.querySelectorAll(".nas-prep-spread")) {
        const hasVisiblePage = Array.from(spread.querySelectorAll(".nas-prep-page")).some((page) => !page.hidden);
        spread.dataset.searchMatch = hasVisiblePage ? "true" : "false";
        if (hasVisiblePage) matchingSpreadIndexes.push(Number(spread.dataset.spreadIndex));
      }

      if (matchingSpreadIndexes.length > 0 && !matchingSpreadIndexes.includes(this.spreadIndex)) {
        this.spreadIndex = matchingSpreadIndexes[0];
      }
    } else {
      for (const page of root.querySelectorAll(".nas-prep-page")) page.hidden = false;
      for (const spread of root.querySelectorAll(".nas-prep-spread")) delete spread.dataset.searchMatch;
    }

    this._syncVisibleSpread(root);
    const noResults = root.querySelector(".nas-prep-no-results");
    if (noResults) noResults.hidden = visibleRows > 0;
    this._updatePageControls(root);
  }

  _syncVisibleSpread(root) {
    const spreads = Array.from(root.querySelectorAll(".nas-prep-spread"));
    this.spreadIndex = clampIndex(this.spreadIndex, spreads.length - 1);

    for (const spread of spreads) {
      const isActive = Number(spread.dataset.spreadIndex) === this.spreadIndex;
      spread.hidden = !isActive;
      spread.classList.toggle("nas-prep-spread-active", isActive);
    }

    this._updatePageControls(root);
    this._updateBookmarks(root);
  }

  _updatePageControls(root) {
    const shell = root.querySelector(".nas-prep-book-shell");
    const searching = shell?.classList.contains("nas-prep-searching") === true;
    const spreads = root.querySelectorAll(".nas-prep-spread");
    const prev = root.querySelector(".nas-prep-page-prev");
    const next = root.querySelector(".nas-prep-page-next");
    if (prev) prev.disabled = searching || this.spreadIndex <= 0;
    if (next) next.disabled = searching || this.spreadIndex >= spreads.length - 1;
  }

  _updateBookmarks(root) {
    const activeSpread = root.querySelector(`.nas-prep-spread[data-spread-index="${this.spreadIndex}"]`);
    const activeLevel = activeSpread?.dataset.level;

    for (const bookmark of root.querySelectorAll(".nas-prep-bookmark")) {
      bookmark.classList.toggle("nas-prep-bookmark-active", bookmark.dataset.level === activeLevel);
    }
  }

  _turnSpread(root, direction) {
    this._turnToSpread(root, this.spreadIndex + direction);
  }

  _turnToSpread(root, nextIndex) {
    const shell = root.querySelector(".nas-prep-book-shell");
    const spreads = root.querySelectorAll(".nas-prep-spread");
    if (!shell || shell.classList.contains("nas-prep-searching")) return;
    if (!Number.isFinite(nextIndex) || nextIndex === this.spreadIndex) return;
    if (nextIndex < 0 || nextIndex >= spreads.length) return;
    if (shell.classList.contains("nas-prep-turning")) return;

    const direction = nextIndex > this.spreadIndex ? 1 : -1;
    shell.classList.add("nas-prep-turning", direction > 0 ? "nas-prep-turning-next" : "nas-prep-turning-prev");
    this._updatePageControls(root);

    globalThis.setTimeout(() => {
      this.spreadIndex = nextIndex;
      this._syncVisibleSpread(root);
    }, 220);

    globalThis.setTimeout(() => {
      shell.classList.remove("nas-prep-turning", "nas-prep-turning-next", "nas-prep-turning-prev");
      this._updatePageControls(root);
    }, 620);
  }

  _onStepCount(event, root) {
    event.preventDefault();
    const button = event.currentTarget;
    const input = button.closest(".nas-prep-count-control")?.querySelector(".nas-prep-count");
    if (!input) return;

    const step = Number(button.dataset.step ?? 0);
    input.value = Math.max(0, coerceNonNegativeInteger(input.value) + step);
    this._refreshValidation(root);
  }

  _refreshValidation(root) {
    let overLimit = false;
    const totalsByLevel = new Map();

    for (const control of root.querySelectorAll("[data-counts='true']")) {
      const level = control.dataset.level ?? "";
      const totals = totalsByLevel.get(level) ?? { normalUsed: 0, domainUsed: 0, unavailablePrepared: false };
      const count = control.type === "checkbox"
        ? (control.checked ? 1 : 0)
        : coerceNonNegativeInteger(control.value);
      const slotCost = Number(control.dataset.slotCost ?? 1) || 1;
      const used = count * slotCost;
      if (count > 0 && control.dataset.slotUnavailable === "true") totals.unavailablePrepared = true;

      if (control.dataset.domain === "true") totals.domainUsed += used;
      else totals.normalUsed += used;
      totalsByLevel.set(level, totals);
    }

    for (const section of root.querySelectorAll(".nas-prep-level")) {
      const totals = totalsByLevel.get(section.dataset.level ?? "") ?? { normalUsed: 0, domainUsed: 0, unavailablePrepared: false };
      const normalCap = parseCapValue(section.dataset.normalCap ?? "");
      const domainCap = parseCapValue(section.dataset.domainCap ?? "");
      const normalOver = normalCap !== null && totals.normalUsed > normalCap;
      const domainOver = domainCap !== null && totals.domainUsed > domainCap;
      const levelOverLimit = normalOver || domainOver || totals.unavailablePrepared;

      overLimit ||= levelOverLimit;
      section.classList.toggle("nas-prep-over-limit", levelOverLimit);
      section.querySelector(".nas-prep-normal-used").textContent = `${totals.normalUsed}`;
      section.querySelector(".nas-prep-domain-used")?.replaceChildren(`${totals.domainUsed}`);
      const status = section.querySelector(".nas-prep-level-status");
      if (status) status.hidden = !levelOverLimit;
    }

    const apply = root.querySelector(".nas-prep-apply");
    if (apply) apply.disabled = overLimit;
  }

  async _updateObject(event) {
    if (!this._canModifySpellbook()) return;
    if (!isKnownSpellbookInitialized(this.actor, this.bookId)) {
      ui.notifications.warn(localize("warnings.notInitialized", "Initialize the NAS known spellbook before applying preparation."));
      return;
    }

    await this._persistVariantSuffixesFromForm(event.currentTarget);

    const state = buildSpellbookPreparationState(this.actor, this.bookId);
    const desiredById = readSubmittedPreparation(event.currentTarget, state.spells, state.mode);
    const submittedState = buildSpellbookPreparationState(this.actor, this.bookId, desiredById);

    if (submittedState.overLimit) {
      ui.notifications.warn(localize("warnings.overLimit", "Resolve over-prepared spell levels before applying preparation."));
      this.render(false);
      return;
    }

    await syncGeneratedPreparedSpellItems(
      this.actor,
      this.bookId,
      getKnownSpells(this.actor, this.bookId),
      getPreparedEntriesForKnownSpells(this.actor, this.bookId, getKnownSpells(this.actor, this.bookId)),
      desiredById,
      state.mode
    );

    await completeSpellbookPreparation(this.actor, this.bookId);
    ui.notifications.info(formatLocalized(
      "info.applied",
      { book: state.bookLabel },
      `${state.bookLabel} prepared.`
    ));

    if (this.actor.sheet?.rendered) this.actor.sheet.render(false);
    await this.render(false);
  }
}
