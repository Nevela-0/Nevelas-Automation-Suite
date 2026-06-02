import { METAMAGIC_DEFINITIONS, resolveMetamagicNameFromDatabase } from "../../metamagic/metamagic.js";
import {
  buildMetamagicEligibilityContextFromItem,
  canApplyMetamagicToSpellContext,
  getMetamagicSpellRangeUnits
} from "../../metamagic/metamagicEligibility.js";
import { getSpellbookLevelAvailability } from "./slotAvailability.js";

export const AUTO_SUFFIX_MODE = "auto";
export const MANUAL_SUFFIX_MODE = "manual";
export const HEIGHTEN_SPELL_KEY = "heightenSpell";
export const REACH_SPELL_KEY = "reachSpell";

const MAX_SPELL_LEVEL = 9;
const RANGE_ORDER = ["touch", "close", "medium", "long"];
const STATIC_SLOT_INCREASES = {
  stillSpell: 1,
  silentSpell: 1,
  enlargeSpell: 1,
  extendSpell: 1,
  quickenSpell: 4,
  selectiveSpell: 1,
  dazingSpell: 3,
  persistentSpell: 2,
  intensifiedSpell: 1,
  maximizeSpell: 3,
  empowerSpell: 2
};

const DEFINITIONS_BY_KEY = new Map(METAMAGIC_DEFINITIONS.map((definition) => [definition.key, definition]));
const DEFINITIONS_BY_NAME = new Map(METAMAGIC_DEFINITIONS.map((definition) => [definition.name, definition]));

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getActorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function getSpellLevel(itemOrData, fallback = 0) {
  const level = Number(itemOrData?.system?.level ?? itemOrData?.level ?? fallback);
  if (!Number.isInteger(level)) return Math.max(0, Math.min(MAX_SPELL_LEVEL, Number(fallback) || 0));
  return Math.max(0, Math.min(MAX_SPELL_LEVEL, level));
}

function coerceInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function isMetamagicFeat(item) {
  if (item?.type !== "feat" || item?.subType !== "feat") return false;
  const tags = item?.system?.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => tag?.toString?.().toLowerCase().includes("metamagic"));
}

function getMetamagicDefinitionForName(name) {
  const resolvedName = resolveMetamagicNameFromDatabase(name) ?? normalizeId(name);
  return DEFINITIONS_BY_NAME.get(resolvedName) ?? null;
}

function getMetamagicDefinitionForKey(key) {
  return DEFINITIONS_BY_KEY.get(normalizeId(key)) ?? null;
}

function getMetamagicDefinitionForItem(item) {
  const candidates = [
    item?.flags?.babele?.originalName,
    item?.system?.identifiedName,
    item?.name
  ];

  for (const candidate of candidates) {
    const definition = getMetamagicDefinitionForName(candidate);
    if (definition) return definition;
  }

  return null;
}

function getSpellRangeUnits(sourceItem) {
  return getMetamagicSpellRangeUnits({ item: sourceItem });
}

function getSpellbook(actor, sourceItem) {
  const bookId = normalizeId(sourceItem?.system?.spellbook);
  if (!bookId) return null;
  return actor?.system?.attributes?.spells?.spellbooks?.[bookId] ?? null;
}

function isDomainSpell(sourceItem) {
  return sourceItem?.isDomain === true || sourceItem?.system?.domain === true;
}

function getRollData(document) {
  try {
    return document?.getRollData?.() ?? null;
  } catch (_error) {
    return null;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(candidates = [], fallback = 0) {
  for (const value of candidates) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return fallback;
}

function getAbilityModFromKey(actor, abilityKey) {
  const key = normalizeId(abilityKey).toLowerCase();
  if (!key) return null;
  const ability = actor?.system?.abilities?.[key] ?? null;
  return finiteNumber(ability?.mod ?? ability?.total ?? ability?.value);
}

function getPreparationCasterLevel(actor, sourceItem) {
  const itemRollData = getRollData(sourceItem);
  const actorRollData = getRollData(actor);
  const spellbook = getSpellbook(actor, sourceItem);
  return firstFiniteNumber([
    itemRollData?.cl,
    sourceItem?.casterLevel,
    sourceItem?.system?.cl,
    spellbook?.cl?.total,
    spellbook?.cl?.autoSpellLevelTotal,
    actorRollData?.cl,
    sourceItem?.system?.level
  ], 0);
}

function getPreparationAbilityMod(actor, sourceItem) {
  const itemRollData = getRollData(sourceItem);
  const actorRollData = getRollData(actor);
  const spellbook = getSpellbook(actor, sourceItem);
  const abilityKey = spellbook?.ability ?? spellbook?.abilityKey ?? spellbook?.castingAbility ?? sourceItem?.system?.ability;
  return firstFiniteNumber([
    itemRollData?.ablMod,
    actorRollData?.ablMod,
    getAbilityModFromKey(actor, abilityKey)
  ], 0);
}

function buildPreparedMetamagicEligibilityContext(actor, sourceItem, originalLevel) {
  return buildMetamagicEligibilityContextFromItem(sourceItem, {
    baseLevel: originalLevel,
    casterLevel: getPreparationCasterLevel(actor, sourceItem),
    abilityMod: getPreparationAbilityMod(actor, sourceItem),
    rollData: getRollData(sourceItem) ?? getRollData(actor)
  });
}

function buildHeightenChoices(originalLevel, selectedLevel = null) {
  if (originalLevel >= MAX_SPELL_LEVEL) return [];
  const selected = coerceInteger(selectedLevel, originalLevel + 1);
  return Array.from({ length: MAX_SPELL_LEVEL - originalLevel }, (_unused, index) => {
    const level = originalLevel + index + 1;
    return {
      value: level,
      label: `${level}`,
      selected: level === selected
    };
  });
}

function getMaxReachSteps(sourceItem) {
  const rangeUnits = getSpellRangeUnits(sourceItem);
  const index = RANGE_ORDER.indexOf(rangeUnits);
  if (index === -1 || index >= RANGE_ORDER.length - 1) return 0;
  return RANGE_ORDER.length - index - 1;
}

function getReachNormalizationMaxSteps(sourceItem) {
  const maxSteps = getMaxReachSteps(sourceItem);
  if (maxSteps > 0) return maxSteps;
  return sourceItem ? 1 : 3;
}

function buildReachChoices(sourceItem, selectedSteps = null) {
  const maxSteps = getMaxReachSteps(sourceItem);
  if (maxSteps <= 0) return [];
  const selected = Math.max(1, Math.min(maxSteps, coerceInteger(selectedSteps, 1)));
  return Array.from({ length: maxSteps }, (_unused, index) => {
    const steps = index + 1;
    return {
      value: steps,
      label: `+${steps}`,
      selected: steps === selected
    };
  });
}

function getOptionsForKey(options, key, originalLevel, sourceItem) {
  if (key === HEIGHTEN_SPELL_KEY) {
    if (originalLevel >= MAX_SPELL_LEVEL) return { heightenSpellLevel: MAX_SPELL_LEVEL };
    const target = Math.max(
      originalLevel + 1,
      Math.min(MAX_SPELL_LEVEL, coerceInteger(options?.heightenSpellLevel, originalLevel + 1))
    );
    return { heightenSpellLevel: target };
  }

  if (key === REACH_SPELL_KEY) {
    const maxSteps = getReachNormalizationMaxSteps(sourceItem);
    const steps = Math.max(1, Math.min(Math.max(1, maxSteps), coerceInteger(options?.reachSpellSteps, 1)));
    return { reachSpellSteps: steps };
  }

  return {};
}

function getSlotIncreaseForKey(key, originalLevel, sourceItem, options = {}) {
  if (key === HEIGHTEN_SPELL_KEY) {
    const targetLevel = coerceInteger(options.heightenSpellLevel, originalLevel + 1);
    return Math.max(0, Math.min(MAX_SPELL_LEVEL, targetLevel) - originalLevel);
  }

  if (key === REACH_SPELL_KEY) {
    const maxSteps = getReachNormalizationMaxSteps(sourceItem);
    return Math.max(0, Math.min(Math.max(1, maxSteps), coerceInteger(options.reachSpellSteps, 1)));
  }

  return STATIC_SLOT_INCREASES[key] ?? 0;
}

function getSelectionOptions(selection, key, originalLevel, sourceItem) {
  const options = {
    ...(selection?.options && typeof selection.options === "object" ? selection.options : {})
  };
  if (selection?.heightenSpellLevel !== undefined) options.heightenSpellLevel = selection.heightenSpellLevel;
  if (selection?.reachSpellSteps !== undefined) options.reachSpellSteps = selection.reachSpellSteps;
  return getOptionsForKey(options, key, originalLevel, sourceItem);
}

function makeSelection(definition, sourceItem, originalLevel, {
  item = null,
  options = {},
  existing = null
} = {}) {
  const normalizedOptions = getOptionsForKey(options, definition.key, originalLevel, sourceItem);
  const slotIncrease = getSlotIncreaseForKey(definition.key, originalLevel, sourceItem, normalizedOptions);

  return {
    key: definition.key,
    name: definition.name,
    prefix: normalizeId(definition.prefix) || definition.name,
    slotIncrease,
    sourceItemId: normalizeId(item?.id ?? existing?.sourceItemId),
    sourceUuid: normalizeId(item?.uuid ?? existing?.sourceUuid),
    options: normalizedOptions
  };
}

function selectionSortIndex(selection) {
  const index = METAMAGIC_DEFINITIONS.findIndex((definition) => definition.key === selection.key);
  return index === -1 ? 999 : index;
}

function isHeightenSelection(selection) {
  if (selection?.key === HEIGHTEN_SPELL_KEY) return true;
  const definition = getMetamagicDefinitionForName(selection?.name);
  return definition?.key === HEIGHTEN_SPELL_KEY;
}

function getHeightenTargetLevel(originalLevel, selections = []) {
  const base = Math.max(0, Math.min(MAX_SPELL_LEVEL, coerceInteger(originalLevel, 0)));
  const heighten = (Array.isArray(selections) ? selections : [])
    .find((selection) => isHeightenSelection(selection));
  if (!heighten) return base;

  const fallbackTarget = base + Math.max(0, coerceInteger(heighten?.slotIncrease, 0));
  const target = coerceInteger(
    heighten?.options?.heightenSpellLevel ?? heighten?.heightenSpellLevel,
    fallbackTarget
  );
  return Math.max(base, Math.min(MAX_SPELL_LEVEL, target));
}

function getNonHeightenSlotIncrease(selections = []) {
  return (Array.isArray(selections) ? selections : [])
    .filter((selection) => !isHeightenSelection(selection))
    .reduce((total, selection) => total + Math.max(0, coerceInteger(selection?.slotIncrease, 0)), 0);
}

function calculatePreparedSlotLevelRaw(originalLevel, selections = []) {
  const base = Math.max(0, Math.min(MAX_SPELL_LEVEL, coerceInteger(originalLevel, 0)));
  const effectiveLevel = getHeightenTargetLevel(base, selections);
  const nonHeightenSlotLevel = base + getNonHeightenSlotIncrease(selections);
  return Math.max(base, effectiveLevel, nonHeightenSlotLevel);
}

function getSlotAvailabilityReasonKey(availability) {
  if (availability?.reason === "lowAbilityScore") return "slotUnavailableLowAbility";
  if (availability?.unknown === true) return "slotUnknown";
  return "slotUnavailable";
}

function evaluatePreparedSlotChoice(actor, sourceItem, slotLevel) {
  if (slotLevel > MAX_SPELL_LEVEL) {
    return {
      ok: false,
      invalid: false,
      reasonKey: "slotTooHigh",
      slotLevel,
      availability: null
    };
  }

  const spellbook = getSpellbook(actor, sourceItem);
  const availability = getSpellbookLevelAvailability(spellbook, slotLevel, {
    domain: isDomainSpell(sourceItem)
  });
  const ok = availability.available === true;
  return {
    ok,
    invalid: availability.unavailable === true,
    reasonKey: ok ? "" : getSlotAvailabilityReasonKey(availability),
    slotLevel,
    availability
  };
}

export function normalizeSuffixMode(value) {
  return value === MANUAL_SUFFIX_MODE ? MANUAL_SUFFIX_MODE : AUTO_SUFFIX_MODE;
}

export function normalizeMetamagicOptions(options = {}, { originalLevel = 0, sourceItem = null } = {}) {
  const normalized = {};

  if (options.heightenSpellLevel !== undefined) {
    normalized.heightenSpellLevel = originalLevel >= MAX_SPELL_LEVEL
      ? MAX_SPELL_LEVEL
      : Math.max(
        originalLevel + 1,
        Math.min(MAX_SPELL_LEVEL, coerceInteger(options.heightenSpellLevel, originalLevel + 1))
      );
  }

  if (options.reachSpellSteps !== undefined) {
    const maxSteps = getReachNormalizationMaxSteps(sourceItem);
    normalized.reachSpellSteps = Math.max(1, Math.min(Math.max(1, maxSteps), coerceInteger(options.reachSpellSteps, 1)));
  }

  return normalized;
}

export function normalizeMetamagicSelections(selections = [], { originalLevel = 0, sourceItem = null } = {}) {
  const byKey = new Map();

  for (const selection of Array.isArray(selections) ? selections : []) {
    const definition = getMetamagicDefinitionForKey(selection?.key)
      ?? getMetamagicDefinitionForName(selection?.name);
    if (!definition) continue;

    byKey.set(definition.key, makeSelection(definition, sourceItem, originalLevel, {
      existing: selection,
      options: getSelectionOptions(selection, definition.key, originalLevel, sourceItem)
    }));
  }

  return Array.from(byKey.values()).sort((a, b) => selectionSortIndex(a) - selectionSortIndex(b));
}

export function calculatePreparedSlotLevel(originalLevel, selections = []) {
  return Math.max(0, Math.min(MAX_SPELL_LEVEL, calculatePreparedSlotLevelRaw(originalLevel, selections)));
}

export function calculatePreparedSlotIncrease(originalLevel, selections = []) {
  const base = Math.max(0, Math.min(MAX_SPELL_LEVEL, coerceInteger(originalLevel, 0)));
  return Math.max(0, calculatePreparedSlotLevel(originalLevel, selections) - base);
}

export function buildMetamagicOptionsFromSelections(selections = []) {
  const options = {};

  for (const selection of Array.isArray(selections) ? selections : []) {
    if (selection?.key === HEIGHTEN_SPELL_KEY && selection.options?.heightenSpellLevel !== undefined) {
      options.heightenSpellLevel = selection.options.heightenSpellLevel;
    }
    if (selection?.key === REACH_SPELL_KEY && selection.options?.reachSpellSteps !== undefined) {
      options.reachSpellSteps = selection.options.reachSpellSteps;
    }
  }

  return options;
}

export function buildMetamagicAutoSuffix(selections = [], fallback = "Metamagic copy") {
  const suffix = (Array.isArray(selections) ? selections : [])
    .map((selection) => normalizeId(selection?.prefix || selection?.name))
    .filter(Boolean)
    .join(" ");
  return suffix || fallback;
}

export function getPreparedEntryTitlePrefix(selections = []) {
  const sorted = (Array.isArray(selections) ? selections : [])
    .filter((selection) => normalizeId(selection?.prefix || selection?.name))
    .sort((a, b) => {
      const costDiff = coerceInteger(b?.slotIncrease, 0) - coerceInteger(a?.slotIncrease, 0);
      if (costDiff !== 0) return costDiff;
      return selectionSortIndex(a) - selectionSortIndex(b);
    });
  const selected = sorted[0] ?? null;
  return normalizeId(selected?.prefix || selected?.name);
}

export function buildPreparedEntryDisplayName(baseName, preparedEntry = null) {
  const base = normalizeId(baseName);
  if (!base) return "";

  const prefix = getPreparedEntryTitlePrefix(preparedEntry?.metamagic);
  if (prefix) {
    const prefixed = `${prefix} `;
    return base.startsWith(prefixed) ? base : `${prefix} ${base}`;
  }

  const suffix = normalizeId(preparedEntry?.suffix);
  return suffix ? `${base} (${suffix})` : base;
}

export function getPreparedMetamagicChoices(actor, sourceItem, preparedEntry) {
  const originalLevel = getSpellLevel({ level: preparedEntry?.originalSpellLevel }, getSpellLevel(sourceItem, 0));
  const selected = normalizeMetamagicSelections(preparedEntry?.metamagic, { originalLevel, sourceItem });
  const selectedByKey = new Map(selected.map((selection) => [selection.key, selection]));
  const actorChoicesByKey = new Map();
  for (const choice of getActorItems(actor)
    .filter((item) => isMetamagicFeat(item))
    .map((item) => {
      const definition = getMetamagicDefinitionForItem(item);
      if (!definition) return null;
      return { definition, item };
    })
    .filter(Boolean)) {
    if (!actorChoicesByKey.has(choice.definition.key)) actorChoicesByKey.set(choice.definition.key, choice);
  }
  const spellContext = buildPreparedMetamagicEligibilityContext(actor, sourceItem, originalLevel);
  const actorChoices = Array.from(actorChoicesByKey.values())
    .filter(({ definition }) => canApplyMetamagicToSpellContext({ metaName: definition.name }, spellContext));

  return actorChoices.map(({ definition, item, missingSource = false }) => {
    const currentSelection = selectedByKey.get(definition.key) ?? null;
    const options = currentSelection?.options ?? {};
    const defaultOptions = getOptionsForKey(options, definition.key, originalLevel, sourceItem);
    const slotIncrease = getSlotIncreaseForKey(definition.key, originalLevel, sourceItem, defaultOptions);
    const buildCandidateSelections = (candidateOptions = defaultOptions) => normalizeMetamagicSelections([
      ...selected.filter((selection) => selection.key !== definition.key),
      makeSelection(definition, sourceItem, originalLevel, {
        item,
        existing: currentSelection,
        options: candidateOptions
      })
    ], { originalLevel, sourceItem });
    const evaluateCandidateSelections = (candidateSelections) => evaluatePreparedSlotChoice(
      actor,
      sourceItem,
      calculatePreparedSlotLevelRaw(originalLevel, candidateSelections)
    );
    const heightenChoices = definition.key === HEIGHTEN_SPELL_KEY
      ? buildHeightenChoices(originalLevel, options.heightenSpellLevel)
        .map((option) => {
          const evaluation = evaluateCandidateSelections(buildCandidateSelections({ heightenSpellLevel: option.value }));
          return {
            ...option,
            disabled: !evaluation.ok,
            invalid: evaluation.invalid,
            disabledReasonKey: evaluation.reasonKey
          };
        })
        .filter((option) => !option.disabled || option.selected)
      : [];
    const reachChoices = definition.key === REACH_SPELL_KEY
      ? buildReachChoices(sourceItem, options.reachSpellSteps)
        .map((option) => {
          const evaluation = evaluateCandidateSelections(buildCandidateSelections({ reachSpellSteps: option.value }));
          return {
            ...option,
            disabled: !evaluation.ok,
            invalid: evaluation.invalid,
            disabledReasonKey: evaluation.reasonKey
          };
        })
        .filter((option) => !option.disabled || option.selected)
      : [];
    const nextSelections = currentSelection ? selected : buildCandidateSelections(defaultOptions);
    const nextSlotLevel = calculatePreparedSlotLevelRaw(originalLevel, nextSelections);
    const nextSlotEvaluation = evaluatePreparedSlotChoice(actor, sourceItem, nextSlotLevel);
    const lacksVariableOptions = definition.key === HEIGHTEN_SPELL_KEY
      ? originalLevel >= MAX_SPELL_LEVEL
      : definition.key === REACH_SPELL_KEY && getMaxReachSteps(sourceItem) <= 0;
    const hasEnabledVariableOption = definition.key === HEIGHTEN_SPELL_KEY
      ? heightenChoices.some((option) => !option.disabled)
      : definition.key === REACH_SPELL_KEY
        ? reachChoices.some((option) => !option.disabled)
        : true;
    const invalid = nextSlotEvaluation.invalid === true;
    const disabled = !currentSelection && (lacksVariableOptions || !hasEnabledVariableOption || !nextSlotEvaluation.ok);
    const disabledReasonKey = lacksVariableOptions
      ? "notApplicable"
      : (!hasEnabledVariableOption ? "slotUnavailable" : nextSlotEvaluation.reasonKey);

    return {
      key: definition.key,
      name: definition.name,
      label: item?.name || definition.name,
      prefix: normalizeId(definition.prefix) || definition.name,
      selected: Boolean(currentSelection),
      slotIncrease: currentSelection?.slotIncrease ?? slotIncrease,
      sourceItemId: normalizeId(item?.id ?? currentSelection?.sourceItemId),
      sourceUuid: normalizeId(item?.uuid ?? currentSelection?.sourceUuid),
      missingSource,
      disabled,
      invalid,
      disabledReasonKey,
      hasHeightenOptions: definition.key === HEIGHTEN_SPELL_KEY,
      heightenChoices,
      hasReachOptions: definition.key === REACH_SPELL_KEY,
      reachChoices
    };
  });
}

export function getMetamagicSummary(selections = []) {
  return (Array.isArray(selections) ? selections : [])
    .map((selection) => normalizeId(selection?.prefix || selection?.name))
    .filter(Boolean)
    .join(", ");
}

export function togglePreparedEntryMetamagic(actor, sourceItem, preparedEntry, key, { fallbackSuffix = "Metamagic copy" } = {}) {
  const definition = getMetamagicDefinitionForKey(key);
  if (!definition) return null;

  const originalLevel = getSpellLevel({ level: preparedEntry?.originalSpellLevel }, getSpellLevel(sourceItem, 0));
  const currentSelections = normalizeMetamagicSelections(preparedEntry?.metamagic, { originalLevel, sourceItem });
  const currentSelection = currentSelections.find((selection) => selection.key === definition.key);
  let nextSelections;

  if (currentSelection) {
    nextSelections = currentSelections.filter((selection) => selection.key !== definition.key);
  } else {
    const choice = getPreparedMetamagicChoices(actor, sourceItem, preparedEntry)
      .find((candidate) => candidate.key === definition.key);
    if (!choice || choice.disabled) return null;
    nextSelections = [
      ...currentSelections,
      makeSelection(definition, sourceItem, originalLevel, {
        item: choice.sourceItemId ? actor?.items?.get?.(choice.sourceItemId) : null,
        options: {
          heightenSpellLevel: choice.heightenChoices.find((option) => option.selected)?.value,
          reachSpellSteps: choice.reachChoices.find((option) => option.selected)?.value
        }
      })
    ];
  }

  nextSelections = normalizeMetamagicSelections(nextSelections, { originalLevel, sourceItem });
  return buildPreparedMetamagicUpdate(preparedEntry, originalLevel, nextSelections, fallbackSuffix);
}

export function updatePreparedEntryMetamagicOption(actor, sourceItem, preparedEntry, key, optionValue, { fallbackSuffix = "Metamagic copy" } = {}) {
  const definition = getMetamagicDefinitionForKey(key);
  if (!definition) return null;

  const originalLevel = getSpellLevel({ level: preparedEntry?.originalSpellLevel }, getSpellLevel(sourceItem, 0));
  const currentSelections = normalizeMetamagicSelections(preparedEntry?.metamagic, { originalLevel, sourceItem });
  const currentSelection = currentSelections.find((selection) => selection.key === definition.key);
  const choice = getPreparedMetamagicChoices(actor, sourceItem, preparedEntry)
    .find((candidate) => candidate.key === definition.key);
  if (!choice || (!currentSelection && choice.disabled)) return null;
  if (definition.key === HEIGHTEN_SPELL_KEY) {
    const selectedOption = choice.heightenChoices.find((option) => `${option.value}` === `${optionValue}`);
    if (!selectedOption || selectedOption.disabled) return null;
  }
  if (definition.key === REACH_SPELL_KEY) {
    const selectedOption = choice.reachChoices.find((option) => `${option.value}` === `${optionValue}`);
    if (!selectedOption || selectedOption.disabled) return null;
  }

  const nextSelections = currentSelections.filter((selection) => selection.key !== definition.key);
  const options = {};
  if (definition.key === HEIGHTEN_SPELL_KEY) options.heightenSpellLevel = optionValue;
  if (definition.key === REACH_SPELL_KEY) options.reachSpellSteps = optionValue;
  nextSelections.push(makeSelection(definition, sourceItem, originalLevel, {
    item: choice.sourceItemId ? actor?.items?.get?.(choice.sourceItemId) : null,
    existing: currentSelection,
    options
  }));

  const normalizedSelections = normalizeMetamagicSelections(nextSelections, { originalLevel, sourceItem });
  const rawSlotLevel = calculatePreparedSlotLevelRaw(originalLevel, normalizedSelections);
  if (rawSlotLevel > MAX_SPELL_LEVEL) return null;
  return buildPreparedMetamagicUpdate(preparedEntry, originalLevel, normalizedSelections, fallbackSuffix);
}

export function buildAutoSuffixUpdate(preparedEntry, sourceItem, { fallbackSuffix = "Metamagic copy" } = {}) {
  const originalLevel = getSpellLevel({ level: preparedEntry?.originalSpellLevel }, getSpellLevel(sourceItem, 0));
  const selections = normalizeMetamagicSelections(preparedEntry?.metamagic, { originalLevel, sourceItem });
  return {
    suffix: buildMetamagicAutoSuffix(selections, fallbackSuffix),
    suffixMode: AUTO_SUFFIX_MODE
  };
}

function buildPreparedMetamagicUpdate(preparedEntry, originalLevel, selections, fallbackSuffix) {
  const suffixMode = normalizeSuffixMode(preparedEntry?.suffixMode);
  const update = {
    metamagic: selections,
    metamagicOptions: buildMetamagicOptionsFromSelections(selections),
    preparedSlotLevel: calculatePreparedSlotLevel(originalLevel, selections),
    suffixMode
  };

  if (suffixMode === AUTO_SUFFIX_MODE) {
    update.suffix = buildMetamagicAutoSuffix(selections, fallbackSuffix);
  }

  return update;
}
