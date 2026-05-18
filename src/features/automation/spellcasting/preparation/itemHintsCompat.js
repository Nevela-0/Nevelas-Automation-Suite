import { getGeneratedPreparedSpellItemFlag } from "./preparedItems.js";
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

function itemHintsHandler(_actor, item) {
  const api = getItemHintsApi();
  const marker = getGeneratedPreparedSlotMarker(item);
  if (!marker || typeof api?.HintClass?.create !== "function") return [];

  return [
    api.HintClass.create(marker.label, ["nas-prepared-slot"], {
      hint: marker.tooltip
    })
  ];
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
