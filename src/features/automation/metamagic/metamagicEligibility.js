import { resolveMetamagicNameFromDatabase } from "./metamagic.js";
import { isDurationEligibleForExtendSpell } from "./extendSpell.js";
import { canIntensifyAnyDamagePart } from "./intensifiedSpell.js";

function normalizeString(value) {
  return (value ?? "").toString().trim();
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function getSpellComponents(source) {
  return source?.components ?? source?.action?.components ?? source?.action?.item?.system?.components ?? source?.item?.system?.components ?? {};
}

function getSpellDuration(source) {
  return source?.duration ?? source?.action?.duration ?? source?.action?.item?.system?.duration ?? source?.item?.system?.duration ?? {};
}

function getSpellActivation(source) {
  return source?.activation ?? source?.action?.activation ?? source?.action?.item?.system?.activation ?? source?.item?.system?.activation ?? {};
}

function getSpellDamageParts(source) {
  return source?.damageParts ?? source?.action?.damage?.parts ?? source?.action?.item?.system?.damage?.parts ?? source?.item?.system?.damage?.parts ?? [];
}

function getSpellRangeUnits(source) {
  const rawUnits =
    source?.rangeUnits ??
    source?.range?.units ??
    source?.action?.range?.units ??
    source?.action?.item?.system?.range?.units ??
    source?.item?.system?.range?.units ??
    "";
  const normalized = rawUnits?.toString?.().toLowerCase() ?? "";
  if (normalized) return normalized;
  if (source?.touch === true || source?.action?.touch === true || source?.item?.system?.range?.touch === true || source?.item?.system?.touch === true) return "touch";
  return "";
}

function getSpellArea(source) {
  return source?.area ?? source?.action?.area ?? source?.action?.item?.system?.area ?? source?.item?.system?.area ?? "";
}

function getSpellTemplateType(source) {
  return source?.measureTemplate?.type ?? source?.action?.measureTemplate?.type ?? source?.action?.item?.system?.measureTemplate?.type ?? source?.item?.system?.measureTemplate?.type ?? "";
}

function getSpellSaveType(source) {
  return source?.saveType ?? source?.save?.type ?? source?.action?.save?.type ?? source?.action?.item?.system?.save?.type ?? source?.item?.system?.save?.type ?? "";
}

function getSpellBaseLevel(source) {
  return numberOrZero(source?.baseLevel ?? source?.action?.item?.system?.level ?? source?.item?.system?.level);
}

function getSpellCasterLevel(source) {
  return numberOrZero(source?.casterLevel ?? source?.rollData?.cl);
}

function getSpellAbilityMod(source) {
  return numberOrZero(source?.abilityMod ?? source?.rollData?.ablMod);
}

function hasDamageFormula(source) {
  const parts = getSpellDamageParts(source);
  if (!Array.isArray(parts) || !parts.length) return false;
  return parts.some((part) => {
    const formula = part?.formula ?? part?.[0];
    return typeof formula === "string" && formula.trim().length > 0;
  });
}

function isAreaEffectSpell(source) {
  return Boolean(getSpellArea(source) || getSpellTemplateType(source));
}

function isInstantDuration(duration) {
  const units = (duration?.units ?? "").toString().toLowerCase();
  return units === "inst" || units === "instantaneous";
}

function canApplyQuickenSpell(activation) {
  const type = (activation?.type ?? "").toString().toLowerCase();
  const costValue = Number(activation?.cost ?? 1);
  const cost = Number.isFinite(costValue) ? costValue : 1;
  if (type === "swift") return false;
  if (!type) return true;
  if (["round", "full"].includes(type)) return cost <= 1;
  if (["minute", "hour", "day", "week", "month", "year"].includes(type)) return false;
  return true;
}

function canApplyEnlargeSpell(rangeUnits) {
  return ["close", "medium", "long"].includes(rangeUnits);
}

function canApplyReachSpell(rangeUnits) {
  return ["touch", "close", "medium"].includes(rangeUnits);
}

function canApplyIntensifiedSpell(source) {
  const cl = getSpellCasterLevel(source);
  if (!Number.isFinite(cl) || cl <= 0) return false;
  return canIntensifyAnyDamagePart(getSpellDamageParts(source), cl);
}

export function getMetamagicSourceCanonicalName(source) {
  const raw = typeof source === "string" ? source : source?.metaName ?? source?.name ?? source?.label ?? "";
  return resolveMetamagicNameFromDatabase(raw) ?? raw;
}

export function buildMetamagicEligibilityContextFromDialog(dialog) {
  return {
    item: dialog?.action?.item ?? dialog?.item ?? null,
    action: dialog?.action ?? null,
    rollData: dialog?.rollData ?? null
  };
}

export function buildMetamagicEligibilityContextFromItem(item, options = {}) {
  return {
    item,
    components: options.components ?? item?.system?.components ?? {},
    duration: options.duration ?? item?.system?.duration ?? {},
    activation: options.activation ?? item?.system?.activation ?? {},
    range: options.range ?? item?.system?.range ?? {},
    touch: options.touch ?? item?.system?.range?.touch ?? item?.system?.touch ?? false,
    area: options.area ?? item?.system?.area ?? "",
    measureTemplate: options.measureTemplate ?? item?.system?.measureTemplate ?? {},
    damageParts: options.damageParts ?? item?.system?.damage?.parts ?? [],
    save: options.save ?? item?.system?.save ?? {},
    baseLevel: options.baseLevel ?? item?.system?.level ?? 0,
    casterLevel: options.casterLevel ?? 0,
    abilityMod: options.abilityMod ?? 0,
    rollData: options.rollData ?? null
  };
}

export function canApplyMetamagicToSpellContext(source, spellContext) {
  const name = normalizeString(getMetamagicSourceCanonicalName(source)).toLowerCase();
  if (!name) return false;

  const components = getSpellComponents(spellContext);
  const duration = getSpellDuration(spellContext);
  const activation = getSpellActivation(spellContext);
  const rangeUnits = getSpellRangeUnits(spellContext);

  if (name === "still spell") return components?.somatic === true;
  if (name === "silent spell") return components?.verbal === true;
  if (name === "extend spell") return isDurationEligibleForExtendSpell(duration);
  if (name === "enlarge spell") return canApplyEnlargeSpell(rangeUnits);
  if (name === "reach spell") return canApplyReachSpell(rangeUnits);
  if (name === "quicken spell") return canApplyQuickenSpell(activation);
  if (name === "selective spell") {
    return isAreaEffectSpell(spellContext) && isInstantDuration(duration) && getSpellAbilityMod(spellContext) > 0;
  }
  if (name === "dazing spell") return hasDamageFormula(spellContext);
  if (name === "persistent spell") return Boolean(getSpellSaveType(spellContext));
  if (name === "heighten spell") return getSpellBaseLevel(spellContext) < 9;
  if (name === "intensified spell") return canApplyIntensifiedSpell(spellContext);
  if (name === "maximize spell") return hasDamageFormula(spellContext);
  return true;
}

export function filterMetamagicSourcesForSpellContext(sources, spellContext) {
  if (!Array.isArray(sources) || !sources.length) return [];
  return sources.filter((source) => canApplyMetamagicToSpellContext(source, spellContext));
}
