import { getKnownSpells } from "./knownSpells.js";
import {
  getGeneratedPreparedSpellItemFlag,
  isGeneratedPreparedSpellItem,
  isSpellbookPreparedItemsManaged
} from "./preparedItems.js";
import { isSpellbookPreparedVariantSupportEnabled } from "./settings.js";

const ITEM_HINTS_MODULE_ID = "mkah-pf1-item-hints";
const SPELL_LEVEL_COUNT = 10;

let readyHookRegistered = false;
let handlerRegistered = false;

function formatLocalized(key, data, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.format(fullKey, data);
  if (value && value !== fullKey) return value;
  return fallback.replace(/\{(\w+)\}/g, (_match, field) => data?.[field] ?? "");
}

function localize(key, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.localize(fullKey);
  return value && value !== fullKey ? value : fallback;
}

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getSpellLevelLabel(level) {
  if (level >= 0 && level < SPELL_LEVEL_COUNT) {
    return globalThis.pf1?.config?.spellLevels?.[level] ?? `Level ${level}`;
  }

  return game.i18n.localize("PF1.Unknown");
}

function getSpellLevel(value, fallback = 0) {
  const level = Number(value);
  if (!Number.isInteger(level)) return Math.max(0, Math.min(SPELL_LEVEL_COUNT - 1, Number(fallback) || 0));
  return Math.max(0, Math.min(SPELL_LEVEL_COUNT - 1, level));
}

function getItemHintsApi() {
  const itemHints = game.modules.get(ITEM_HINTS_MODULE_ID);
  return itemHints?.active === true ? itemHints.api : null;
}

export function isItemHintsIntegrationActive() {
  const api = getItemHintsApi();
  return typeof api?.addHandler === "function"
    && typeof api?.HintClass?.create === "function";
}

export function getPreparedSlotMarkerLabels(originalLevel, preparedSlotLevel) {
  const preparedLabel = getSpellLevelLabel(preparedSlotLevel);
  const originalLabel = getSpellLevelLabel(originalLevel);

  return {
    label: formatLocalized(
      "labels.sheetPreparedSlotBadge",
      { level: preparedLabel },
      "Slot {level}"
    ),
    tooltip: formatLocalized(
      "tooltips.preparedSlotRelocated",
      { prepared: preparedLabel, original: originalLabel },
      "Prepared as {prepared}; original spell level {original}"
    )
  };
}

export function getGeneratedPreparedSlotMarker(item) {
  if (!isSpellbookPreparedVariantSupportEnabled()) return null;

  const flag = getGeneratedPreparedSpellItemFlag(item);
  if (item?.type !== "spell" || flag?.generated !== true) return null;

  const preparedSlotLevel = getSpellLevel(flag.preparedSlotLevel, item.system?.level ?? flag.originalSpellLevel ?? 0);
  const originalLevel = getSpellLevel(item.system?.level, flag.originalSpellLevel ?? preparedSlotLevel);
  if (preparedSlotLevel === originalLevel) return null;

  return {
    ...getPreparedSlotMarkerLabels(originalLevel, preparedSlotLevel),
    preparedSlotLevel,
    originalLevel
  };
}

export function getUntrackedKnownSpellMarker(actor, item) {
  if (!isSpellbookPreparedVariantSupportEnabled()) return null;
  if (item?.type !== "spell" || isGeneratedPreparedSpellItem(item)) return null;
  if (item?.system?.atWill === true) return null;

  const bookId = normalizeId(item.system?.spellbook);
  if (!bookId || !isSpellbookPreparedItemsManaged(actor, bookId)) return null;

  const knownSourceIds = new Set(getKnownSpells(actor, bookId)
    .map((entry) => normalizeId(entry.sourceItemId))
    .filter(Boolean));
  if (knownSourceIds.has(normalizeId(item.id))) return null;

  return {
    label: localize("labels.sheetUntrackedKnownSpellBadge", "Untracked"),
    tooltip: localize(
      "tooltips.untrackedKnownSpell",
      "This spell is not in the NAS known spellbook yet. Use Prepare to import it before managing preparation or variants."
    ),
    bookId
  };
}

function itemHintsHandler(_actor, item) {
  const api = getItemHintsApi();
  if (typeof api?.HintClass?.create !== "function") return [];

  const hints = [];
  const preparedSlotMarker = getGeneratedPreparedSlotMarker(item);
  if (preparedSlotMarker) {
    hints.push(api.HintClass.create(preparedSlotMarker.label, ["nas-prepared-slot"], {
      hint: preparedSlotMarker.tooltip
    }));
  }

  const untrackedMarker = getUntrackedKnownSpellMarker(_actor, item);
  if (untrackedMarker) {
    hints.push(api.HintClass.create(untrackedMarker.label, ["nas-known-spell-missing"], {
      hint: untrackedMarker.tooltip
    }));
  }

  return hints;
}

function registerItemHintsHandler() {
  const api = getItemHintsApi();
  if (
    handlerRegistered
    || typeof api?.addHandler !== "function"
    || typeof api?.HintClass?.create !== "function"
  ) {
    return;
  }

  api.addHandler(itemHintsHandler);
  handlerRegistered = true;
}

export function registerSpellbookPreparationItemHintsCompatibility() {
  if (readyHookRegistered) return;
  readyHookRegistered = true;

  if (game.ready) {
    registerItemHintsHandler();
  } else {
    Hooks.once("ready", registerItemHintsHandler);
  }
}
