import { MODULE } from "../../../common/module.js";

export const METAMAGIC_DEFINITION = {
  key: "enlargeSpell",
  name: "Enlarge Spell",
  get prefix() { return globalThis.game?.i18n?.localize?.("NAS.metamagic.prefixes.enlargeSpell") ?? "Enlarge"; },
};

const ENLARGE_RANGE_UNITS = new Set(["close", "medium", "long"]);
const NUMERIC_RANGE_EXCLUDED_UNITS = new Set(["", "touch", "personal", "self", "see", "seetext", "special", "spec"]);
const HOMEBREW_NUMERIC_RANGE_SETTING = "homebrewEnlargeSpellNumericRanges";

function getRangeUnits(context) {
  return (context?.range?.range?.units ?? "").toString().trim().toLowerCase();
}

function getNumeric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isHomebrewNumericRangeEnabled() {
  try {
    return globalThis.game?.settings?.get?.(MODULE.ID, HOMEBREW_NUMERIC_RANGE_SETTING) === true;
  } catch (_err) {
    return false;
  }
}

function resolveBaseRangeFromRollData(units, action) {
  if (!units || !action) return null;
  const rollData = action?.shared?.rollData ?? null;
  try {
    const total = pf1?.utils?.calculateRangeFormula?.("", units, rollData ?? {});
    const num = Number(total);
    return Number.isFinite(num) ? num : null;
  } catch (_err) {
    return null;
  }
}

function pickPositiveRange(...values) {
  for (const value of values) {
    const num = getNumeric(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function pickPositiveNumericRange(context) {
  return pickPositiveRange(
    context?.range?.evaluated?.value?.total,
    context?.range?.range?.value
  );
}

function hasNumericCustomRange(context) {
  const units = getRangeUnits(context);
  if (!isHomebrewNumericRangeEnabled()) return false;
  if (ENLARGE_RANGE_UNITS.has(units) || NUMERIC_RANGE_EXCLUDED_UNITS.has(units)) return false;
  if (context?.range?.touch === true) return false;
  const range = pickPositiveNumericRange(context);
  return Number.isFinite(range) && range > 0;
}

export function canApplyEnlargeSpell(context) {
  const units = getRangeUnits(context);
  if (ENLARGE_RANGE_UNITS.has(units)) return true;
  return hasNumericCustomRange(context);
}

export function applyEnlargeSpell(context, action = null) {
  const units = getRangeUnits(context);
  const evaluatedTotalRaw = context?.range?.evaluated?.value?.total ?? null;
  const rangeValueRaw = context?.range?.range?.value ?? null;
  const useStandardRange = ENLARGE_RANGE_UNITS.has(units);
  const computedFromRollData = useStandardRange ? resolveBaseRangeFromRollData(units, action) : null;
  const baseRange = useStandardRange
    ? pickPositiveRange(evaluatedTotalRaw, rangeValueRaw, computedFromRollData)
    : pickPositiveRange(evaluatedTotalRaw, rangeValueRaw);
  const canApply = canApplyEnlargeSpell(context);
  if (!context?.range?.range) return false;
  if (!canApply) return false;

  if (!Number.isFinite(baseRange) || baseRange <= 0) return false;

  const nextRange = baseRange * 2;
  if (useStandardRange) context.range.range.units = "ft";
  context.range.range.value = String(nextRange);
  context.range.hasRange = true;
  context.range.isRanged = true;
  context.range.touch = false;

  const baseMin =
    getNumeric(context?.range?.evaluated?.minValue?.total)
    ?? getNumeric(context?.range?.range?.minValue);
  const hasRawMinValue = context?.range?.range?.minValue !== undefined && context?.range?.range?.minValue !== "";
  const hasNumericMin = useStandardRange || hasRawMinValue;
  if (hasNumericMin && Number.isFinite(baseMin) && baseMin >= 0) {
    if (useStandardRange) context.range.range.minUnits = "ft";
    else if (!context.range.range.minUnits && context.range.range.units) context.range.range.minUnits = context.range.range.units;
    context.range.range.minValue = String(baseMin * 2);
  }

  context.metamagic ??= { applied: [], slotIncrease: 0 };
  if (!context.metamagic.applied.includes(METAMAGIC_DEFINITION.name)) {
    context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
    context.metamagic.slotIncrease = Number(context.metamagic.slotIncrease ?? 0) + 1;
  }

  return true;
}
