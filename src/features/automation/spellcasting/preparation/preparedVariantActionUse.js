import { clonePlainData } from "../../../../common/foundryCompat.js";
import { resolveMetamagicNameFromDatabase } from "../../metamagic/metamagic.js";
import {
  HEIGHTEN_SPELL_KEY,
  buildMetamagicOptionsFromSelections,
  calculatePreparedSlotIncrease,
  normalizeMetamagicOptions,
  normalizeMetamagicSelections
} from "./metamagicInscription.js";
import {
  getGeneratedPreparedSpellItemFlag,
  isGeneratedPreparedSpellItem
} from "./preparedItems.js";
import { isSpellbookPreparedVariantSupportEnabled } from "./settings.js";

const MAX_SPELL_LEVEL = 9;

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getSpellLevel(value, fallback = 0) {
  const level = Number(value ?? fallback);
  if (!Number.isInteger(level)) return Math.max(0, Math.min(MAX_SPELL_LEVEL, Number(fallback) || 0));
  return Math.max(0, Math.min(MAX_SPELL_LEVEL, level));
}

function getCanonicalMetamagicName(name) {
  const raw = normalizeId(name);
  if (!raw) return "";
  return resolveMetamagicNameFromDatabase(raw) ?? raw;
}

function getMetamagicNameKey(name) {
  return getCanonicalMetamagicName(name).toLowerCase();
}

function mergeMetamagicNames(preparedNames, dialogNames) {
  const merged = [];
  const seen = new Set();

  for (const name of [...preparedNames, ...dialogNames]) {
    const canonical = getCanonicalMetamagicName(name);
    const key = getMetamagicNameKey(canonical);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(canonical);
  }

  return merged;
}

function getDynamicMetamagicNames(preparedNames, dialogNames) {
  const preparedKeys = new Set(preparedNames.map((name) => getMetamagicNameKey(name)).filter(Boolean));
  const dynamicNames = [];
  const seen = new Set();

  for (const name of dialogNames) {
    const canonical = getCanonicalMetamagicName(name);
    const key = getMetamagicNameKey(canonical);
    if (!key || preparedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    dynamicNames.push(canonical);
  }

  return dynamicNames;
}

function getPreparedSlotIncrease(originalSpellLevel, preparedSlotLevel, selections) {
  const levelDelta = Math.max(0, getSpellLevel(preparedSlotLevel, originalSpellLevel) - getSpellLevel(originalSpellLevel, 0));
  if (!(Array.isArray(selections) && selections.length)) return levelDelta;
  return calculatePreparedSlotIncrease(originalSpellLevel, selections);
}

function buildPreparedMetamagicOptions(selections, flagOptions, originalSpellLevel, sourceItem) {
  return {
    ...buildMetamagicOptionsFromSelections(selections),
    ...normalizeMetamagicOptions(flagOptions, {
      originalLevel: originalSpellLevel,
      sourceItem
    })
  };
}

function buildPreparedSpellContextFlag(flag, selections, metamagicOptions, originalSpellLevel) {
  const preparedSlotLevel = getSpellLevel(flag?.preparedSlotLevel, originalSpellLevel);
  return {
    ...clonePlainData(flag),
    originalSpellLevel,
    preparedSlotLevel,
    preparedSlotIncrease: getPreparedSlotIncrease(originalSpellLevel, preparedSlotLevel, selections),
    metamagic: selections,
    metamagicOptions
  };
}

export function normalizePreparedVariantRollData(actionUse) {
  if (!actionUse || typeof actionUse !== "object") return;
  const item = actionUse.item;
  if (!isGeneratedPreparedSpellItem(item)) return;
  const flag = getGeneratedPreparedSpellItemFlag(item);
  if (flag?.generated !== true) return;

  const originalSpellLevel = getSpellLevel(flag.originalSpellLevel, item?.system?.level ?? 0);
  const offset = Number.parseInt(actionUse.formData?.["sl-offset"] ?? actionUse.shared?.formData?.["sl-offset"] ?? 0);
  actionUse.shared ??= {};
  actionUse.shared.rollData ??= {};
  actionUse.shared.rollData.sl = originalSpellLevel + (Number.isFinite(offset) ? offset : 0);
}

export function getPreparedVariantDialogState(item) {
  if (!isSpellbookPreparedVariantSupportEnabled()) {
    return {
      active: false,
      generated: false,
      preparedMetamagicNames: [],
      preparedMetamagicKeys: [],
      metamagicOptions: {},
      originalSpellLevel: null,
      preparedSlotLevel: null,
      preparedSlotIncrease: 0
    };
  }

  if (!isGeneratedPreparedSpellItem(item)) {
    return {
      active: false,
      generated: false,
      preparedMetamagicNames: [],
      preparedMetamagicKeys: [],
      metamagicOptions: {},
      originalSpellLevel: null,
      preparedSlotLevel: null,
      preparedSlotIncrease: 0
    };
  }

  const flag = getGeneratedPreparedSpellItemFlag(item);
  if (flag?.generated !== true) {
    return {
      active: false,
      generated: false,
      preparedMetamagicNames: [],
      preparedMetamagicKeys: [],
      metamagicOptions: {},
      originalSpellLevel: null,
      preparedSlotLevel: null,
      preparedSlotIncrease: 0
    };
  }

  const originalSpellLevel = getSpellLevel(flag.originalSpellLevel, item?.system?.level ?? 0);
  const preparedSlotLevel = getSpellLevel(flag.preparedSlotLevel, originalSpellLevel);
  const preparedSelections = normalizeMetamagicSelections(flag.metamagic, {
    originalLevel: originalSpellLevel,
    sourceItem: item
  });
  const metamagicOptions = buildPreparedMetamagicOptions(
    preparedSelections,
    flag.metamagicOptions,
    originalSpellLevel,
    item
  );
  const preparedMetamagicNames = preparedSelections
    .map((selection) => getCanonicalMetamagicName(selection?.name))
    .filter(Boolean);
  const preparedMetamagicKeys = Array.from(
    new Set(preparedMetamagicNames.map((name) => getMetamagicNameKey(name)).filter(Boolean))
  );

  return {
    active: true,
    generated: true,
    flag: clonePlainData(flag),
    originalSpellLevel,
    preparedSlotLevel,
    preparedSlotIncrease: getPreparedSlotIncrease(originalSpellLevel, preparedSlotLevel, preparedSelections),
    metamagic: preparedSelections,
    metamagicOptions,
    preparedMetamagicNames,
    preparedMetamagicKeys
  };
}

export function getPreparedVariantPreviewSpellLevel(item) {
  const state = getPreparedVariantDialogState(item);
  if (!state.active) return null;
  const heightened = state.metamagic.some((selection) => selection.key === HEIGHTEN_SPELL_KEY);
  return heightened
    ? getSpellLevel(state.metamagicOptions.heightenSpellLevel, state.originalSpellLevel)
    : state.originalSpellLevel;
}

export function mergePreparedVariantMetamagicIntoContext(actionUse, context) {
  if (!context || typeof context !== "object") return context;

  const item = actionUse?.item ?? context.item ?? null;
  if (!isGeneratedPreparedSpellItem(item)) return context;

  const flag = getGeneratedPreparedSpellItemFlag(item);
  if (flag?.generated !== true) return context;

  const originalSpellLevel = getSpellLevel(
    flag.originalSpellLevel,
    context.spellLevel?.original ?? item?.system?.level ?? 0
  );
  const preparedSlotLevel = getSpellLevel(flag.preparedSlotLevel, originalSpellLevel);
  const preparedSelections = normalizeMetamagicSelections(flag.metamagic, {
    originalLevel: originalSpellLevel,
    sourceItem: item
  });
  const preparedOptions = buildPreparedMetamagicOptions(
    preparedSelections,
    flag.metamagicOptions,
    originalSpellLevel,
    item
  );

  context.spellbookPreparedSpell = buildPreparedSpellContextFlag(
    flag,
    preparedSelections,
    preparedOptions,
    originalSpellLevel
  );
  context.spellLevel ??= {};
  context.spellLevel.original = originalSpellLevel;
  context.spellLevel.effective = originalSpellLevel;
  context.spellLevel.preparedSlotLevel = preparedSlotLevel;

  if (!preparedSelections.length) {
    const dialogNames = Array.isArray(context.metamagicNames)
      ? context.metamagicNames.map((name) => getCanonicalMetamagicName(name)).filter(Boolean)
      : [];
    context.spellbookPreparedSpell.preparedMetamagicNames = [];
    context.spellbookPreparedSpell.dynamicMetamagicNames = dialogNames;
    context.spellbookPreparedSpell.mergedMetamagicNames = dialogNames;
    return context;
  }

  const preparedNames = preparedSelections.map((selection) => selection.name).filter(Boolean);
  const dialogNames = Array.isArray(context.metamagicNames) ? context.metamagicNames : [];
  const dynamicNames = getDynamicMetamagicNames(preparedNames, dialogNames);
  const mergedNames = mergeMetamagicNames(preparedNames, dialogNames);
  context.metamagicNames = mergedNames;
  context.metamagicOptions = {
    ...(context.metamagicOptions && typeof context.metamagicOptions === "object" ? context.metamagicOptions : {}),
    ...preparedOptions
  };
  context.spellbookPreparedSpell.preparedMetamagicNames = preparedNames.map((name) => getCanonicalMetamagicName(name)).filter(Boolean);
  context.spellbookPreparedSpell.dynamicMetamagicNames = dynamicNames;
  context.spellbookPreparedSpell.mergedMetamagicNames = mergedNames;

  return context;
}
