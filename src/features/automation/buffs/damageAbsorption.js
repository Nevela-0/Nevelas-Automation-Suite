import { MODULE } from "../../../common/module.js";
import { chatMessageStyle } from "../../../common/foundryCompat.js";
import {
  canUserSeeTokenEffectBadge,
  refreshTokenEffectBadgesForActor,
  refreshTokenEffectBadgesForScene,
  registerTokenEffectBadgeProvider
} from "../utils/tokenEffectBadges.js";
import { getPriorityTypesForOptions, isWeaponAttack, normalizePriorityType } from "../damage/priorityTypes.js";
import { getStoredBuffCasterLevel } from "../utils/spellLevels.js";
import {
  absorptionPresetDefaults,
  absorptionPresetRules,
  normalizeAbsorptionPresetEnergyType,
  normalizeAbsorptionPresetId
} from "./damageAbsorptionPresets.js";
import { getNasTemporaryHpTotal, hpBarDataWithNasTemporaryHp } from "./temporaryHpPools.js";

const REACTIVE_FLAG_KEY = "itemReactiveEffects";
const GRANTED_DEFENSE_FLAG = "grantedDefenses";

function addNormalizedType(set, value) {
  const normalized = normalizePriorityType(value);
  if (normalized) set.add(normalized);
}

function collectNestedTypeValues(value, set) {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectNestedTypeValues(entry, set);
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) collectNestedTypeValues(entry, set);
    return;
  }
  if (typeof value === "object") {
    for (const key of ["id", "slug", "name", "value"]) {
      const entry = value?.[key];
      if (entry != null && typeof entry !== "object") addNormalizedType(set, entry);
    }
    for (const key of ["base", "normal", "addon", "addons", "material", "materials", "types", "bypass", "bypasses"]) {
      collectNestedTypeValues(value?.[key], set);
    }
    return;
  }
  addNormalizedType(set, value);
}

function materialTypesFromItem(item) {
  const types = new Set();
  collectNestedTypeValues(item?.system?.material, types);
  collectNestedTypeValues(item?.system?.materials, types);
  collectNestedTypeValues(item?.material, types);
  collectNestedTypeValues(item?.materials, types);
  return [...types];
}

function sourceMaterialTypes(sourceOptions = {}, applyDamageOptions = {}) {
  const types = new Set();
  for (const options of [sourceOptions, applyDamageOptions]) {
    const action = options?.action;
    const item = options?.item ?? action?.item ?? options?.message?.itemSource;
    for (const source of [item, action?.item, options?.ammo, action?.ammo, options?.message?.ammoItem]) {
      for (const type of materialTypesFromItem(source)) types.add(type);
    }
    collectNestedTypeValues(action?.material, types);
    collectNestedTypeValues(action?.materials, types);
    collectNestedTypeValues(options?.material, types);
    collectNestedTypeValues(options?.materials, types);
  }
  return [...types];
}

function explicitBypassTypesFromOptions(...optionSets) {
  const types = new Set();
  for (const options of optionSets) {
    for (const key of ["bypass", "bypasses", "bypassTypes", "drBypassTypes", "damageReductionBypassTypes"]) {
      collectNestedTypeValues(options?.[key], types);
    }
    for (const instance of options?.instances ?? []) {
      collectNestedTypeValues(instance?.material, types);
      collectNestedTypeValues(instance?.materials, types);
      collectNestedTypeValues(instance?.bypass, types);
      collectNestedTypeValues(instance?.bypasses, types);
      collectNestedTypeValues(instance?.bypassTypes, types);
      collectNestedTypeValues(instance?.drBypassTypes, types);
    }
  }
  return [...types];
}

function buildAbsorptionAttackBypassTypes({
  incomingDamageTypes = [],
  priorityTypes = [],
  materialTypes = [],
  explicitBypassTypes = []
} = {}) {
  return Array.from(new Set([
    ...incomingDamageTypes,
    ...priorityTypes,
    ...materialTypes,
    ...explicitBypassTypes
  ].map((type) => normalizePriorityType(type)).filter(Boolean)));
}

function absorptionBypassContext(rule, sourceOptions = {}, applyDamageOptions = {}) {
  const reductionBypassTypes = (rule?.reductionBypassTypes ?? []).map((type) => normalizePriorityType(type)).filter(Boolean);
  const incomingDamageTypes = damageTypesFromOptions(sourceOptions, applyDamageOptions);
  const instances = sourceOptions?.instances?.length ? sourceOptions.instances : applyDamageOptions?.instances ?? [];
  const priorityTypes = getPriorityTypesForOptions(sourceOptions, instances).map((type) => normalizePriorityType(type)).filter(Boolean);
  const materialTypes = sourceMaterialTypes(sourceOptions, applyDamageOptions);
  const explicitBypassTypes = explicitBypassTypesFromOptions(sourceOptions, applyDamageOptions);
  const attackTypes = new Set(buildAbsorptionAttackBypassTypes({
    incomingDamageTypes,
    priorityTypes,
    materialTypes,
    explicitBypassTypes
  }));
  if (rule?.defenseKind === "er") {
    const resistedTypes = new Set(reductionBypassTypes);
    return {
      defenseKind: "er",
      reductionBypassTypes,
      incomingDamageTypes,
      priorityTypes,
      materialTypes,
      explicitBypassTypes,
      attackTypes: [...attackTypes],
      bypassed: resistedTypes.size > 0 && !incomingDamageTypes.some((type) => resistedTypes.has(type)),
      reason: resistedTypes.size ? "energy-type-check" : "no-er-bypass-types"
    };
  }
  if (rule?.defenseKind !== "dr" || !reductionBypassTypes.length) {
    return {
      defenseKind: rule?.defenseKind ?? "",
      reductionBypassTypes,
      incomingDamageTypes,
      priorityTypes,
      materialTypes,
      explicitBypassTypes,
      attackTypes: [...attackTypes],
      bypassed: false,
      reason: "not-dr-or-no-bypass-types"
    };
  }
  const bypassed = attackTypes.has("all")
    || (reductionBypassTypes.includes("-") ? attackTypes.has("-") : reductionBypassTypes.some((type) => attackTypes.has(type)));
  return {
    defenseKind: "dr",
    reductionBypassTypes,
    incomingDamageTypes,
    priorityTypes,
    materialTypes,
    explicitBypassTypes,
    attackTypes: [...attackTypes],
    bypassed,
    reason: bypassed ? "attack-type-matched-dr-bypass" : "no-attack-type-matched-dr-bypass"
  };
}

function normalizeBypassTypes(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
  return Array.from(new Set(raw.map((type) => normalizePriorityType(type)).filter(Boolean)));
}

function normalizeAbsorptionRule(raw = {}, perAttackFormula = "5") {
  const rawAction = String(raw?.action ?? "reduce");
  const action = ["", "convertToNonlethal", "convertToDamage", "reduce"].includes(rawAction) ? rawAction : "reduce";
  const damageKind = ["any", "lethal", "nonlethal"].includes(String(raw?.damageKind)) ? String(raw.damageKind) : "any";
  const sourceKind = ["anyAttack", "weapon", "rangedWeapon", "meleeWeapon", "naturalWeapon", "nonWeapon"].includes(String(raw?.sourceKind)) ? String(raw.sourceKind) : "anyAttack";
  const defenseKind = action === "reduce" && String(raw?.defenseKind ?? "") === "er" ? "er" : action === "reduce" ? "dr" : "";
  return {
    damageKind,
    sourceKind,
    damageTypeIds: normalizeBypassTypes(raw?.damageTypeIds ?? raw?.damageTypes ?? []),
    includeUntyped: raw?.includeUntyped === true,
    weaponType: String(raw?.weaponType ?? "").trim(),
    action,
    convertToDamageType: action === "convertToDamage" ? normalizePriorityType(raw?.convertToDamageType ?? raw?.convertTo ?? "nonlethal") : "",
    amountFormula: String(raw?.amountFormula ?? raw?.perAttackFormula ?? perAttackFormula ?? "5"),
    defenseKind,
    reductionBypassTypes: defenseKind ? normalizeBypassTypes(raw?.reductionBypassTypes ?? raw?.bypassTypes ?? raw?.bypass ?? (defenseKind === "dr" ? "-" : "")) : [],
    spendPool: raw?.spendPool === true,
    requiresNoOtherDr: raw?.requiresNoOtherDr === true,
    showAsGrantedDefense: raw?.showAsGrantedDefense === true
  };
}

function defaultAbsorptionRules(preset, perAttackFormula, raw = {}) {
  return absorptionPresetRules(preset, perAttackFormula, raw).map((rule) => normalizeAbsorptionRule(rule, perAttackFormula));
}

function absorptionConfig(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.absorption ?? {};
  const preset = normalizeAbsorptionPresetId(raw?.preset);
  const defaults = absorptionPresetDefaults(preset, raw);
  const energyType = normalizeAbsorptionPresetEnergyType(preset, raw?.energyType ?? defaults.energyType);
  const totalFormula = String(raw?.totalFormula ?? defaults.totalFormula);
  const perAttackFormula = String(raw?.perAttackFormula ?? defaults.perAttackFormula);
  const rules = preset === "custom" && Array.isArray(raw?.rules) && raw.rules.length
    ? raw.rules.map((rule) => normalizeAbsorptionRule({ ...rule, amountFormula: perAttackFormula }, perAttackFormula))
    : defaultAbsorptionRules(preset, perAttackFormula, { energyType });
  return {
    enabled: isAbsorptionRawConfigured(raw),
    preset,
    energyType,
    totalFormula,
    perAttackFormula,
    lethalMode: String(raw?.lethalMode ?? "convertToNonlethal"),
    nonlethalMode: String(raw?.nonlethalMode ?? "dr"),
    rules,
    dischargeAtZero: raw?.dischargeAtZero !== false,
    showBadge: raw?.showBadge !== false,
    showHpBar: raw?.showHpBar === true,
    message: raw?.message !== false,
    remaining: Number.isFinite(Number(raw?.remaining)) ? Math.max(0, Math.floor(Number(raw.remaining))) : null,
    capacity: Number.isFinite(Number(raw?.capacity)) ? Math.max(0, Math.floor(Number(raw.capacity))) : null
  };
}

function absorptionUsesDischargeTotal(config) {
  return config?.preset !== "custom" || (config?.rules ?? []).some((rule) => rule?.spendPool === true);
}

function isNonlethalDamageType(type) {
  return normalizePriorityType(type) === "nonlethal";
}

function isActiveBuff(item) {
  return item?.type === "buff" && item.system?.active === true;
}

export function hasDamageAbsorptionConfig(item) {
  const active = isActiveBuff(item);
  const config = absorptionConfig(item);
  return active && config.enabled;
}

export function hasDamageAbsorptionData(item) {
  return item?.type === "buff" && Boolean(item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.absorption);
}

function getAbsorptionBuffs(actor) {
  if (!actor?.items) return [];
  return actor.items.filter((item) => hasDamageAbsorptionConfig(item));
}

function getHpBarAbsorptionBuffs(actor) {
  return getAbsorptionBuffs(actor).filter((item) => {
    const config = absorptionConfig(item);
    return absorptionUsesDischargeTotal(config) && config.showHpBar && Number.isFinite(Number(config.remaining)) && config.remaining > 0;
  });
}

function refreshTokenBarsForActor(actor) {
  const tokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
  for (const token of tokens) token?.drawBars?.();
}

function numericCandidate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function matchingSpellCasterLevel(actor, item) {
  const itemName = String(item?.name ?? "").trim().toLowerCase();
  const itemImg = String(item?.img ?? "");
  const matches = (actor?.items ?? []).filter((candidate) => {
    if (candidate?.type !== "spell") return false;
    const sameName = itemName && String(candidate.name ?? "").trim().toLowerCase() === itemName;
    const sameImg = itemImg && String(candidate.img ?? "") === itemImg;
    return sameName || sameImg;
  });

  const candidates = [];
  for (const spell of matches) {
    const spellRollData = spell.getRollData?.() ?? {};
    candidates.push(
      numericCandidate(spellRollData?.cl),
      numericCandidate(spell?.casterLevel),
      numericCandidate(spell?.system?.cl)
    );
    const bookId = spell?.system?.spellbook;
    if (bookId) {
      const book = actor?.system?.attributes?.spells?.spellbooks?.[bookId];
      candidates.push(numericCandidate(book?.cl?.total), numericCandidate(book?.cl?.autoSpellLevelTotal));
    }
  }

  return Math.max(0, ...candidates.filter((value) => value != null));
}

function strongestActorSpellbookCasterLevel(actor) {
  const candidates = [];
  for (const book of Object.values(actor?.system?.attributes?.spells?.spellbooks ?? {})) {
    if (book?.inUse === false) continue;
    candidates.push(numericCandidate(book?.cl?.total), numericCandidate(book?.cl?.autoSpellLevelTotal));
  }
  return Math.max(0, ...candidates.filter((value) => value != null));
}

function resolveAbsorptionCasterLevel(actor, item, actorData = {}) {
  const itemRollData = item?.getRollData?.() ?? {};
  const storedBuffCl = numericCandidate(getStoredBuffCasterLevel(item, actor));
  const matchingSpellCl = matchingSpellCasterLevel(actor, item);
  const actorSpellbookCl = strongestActorSpellbookCasterLevel(actor);
  const actorDataCl = numericCandidate(actorData?.cl);
  const itemRollDataCl = numericCandidate(itemRollData?.cl);
  const itemLevel = numericCandidate(item?.system?.level);
  const selected = storedBuffCl || itemLevel || itemRollDataCl || matchingSpellCl || actorSpellbookCl || actorDataCl || 0;
  return {
    selected,
    itemRollData,
    candidates: {
      storedBuffCl,
      itemLevel,
      itemRollDataCl,
      matchingSpellCl,
      actorSpellbookCl,
      actorDataCl
    }
  };
}

function rollDataForAbsorption(actor, item, context = {}) {
  const actorData = actor?.getRollData?.() ?? {};
  const clResolution = resolveAbsorptionCasterLevel(actor, item, actorData);
  const cl = clResolution.selected;
  const rollData = {
    ...actorData,
    cl,
    item: clResolution.itemRollData,
    nas: {
      ...(actorData?.nas ?? {}),
      incomingDamage: Math.max(0, Number(context.incomingDamage) || 0),
      finalDamage: Math.max(0, Number(context.finalDamage) || 0)
    }
  };
  return rollData;
}

async function evaluateFormula(formula, actor, item, context = {}) {
  const text = String(formula ?? "").trim();
  if (!text) return 0;
  try {
    const rollData = rollDataForAbsorption(actor, item, context);
    const roll = await new Roll(text, rollData).evaluate();
    return Math.max(0, Math.floor(Number(roll?.total) || 0));
  } catch (_err) {
    return 0;
  }
}

function typeValuesFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(typeValuesFrom);
  if (value instanceof Set) return Array.from(value).flatMap(typeValuesFrom);
  if (value?.values) return typeValuesFrom(value.values);
  if (value?.value) return typeValuesFrom(value.value);
  if (value?.id) return [String(value.id)];
  return [String(value)];
}

function damageTypesFromOptions(sourceOptions = {}, applyDamageOptions = {}) {
  const ids = new Set();
  for (const instance of sourceOptions?.instances ?? applyDamageOptions?.instances ?? []) {
    for (const key of ["typeIds", "types", "type", "damageType", "damageTypes"]) {
      for (const id of typeValuesFrom(instance?.[key])) {
        const normalized = normalizePriorityType(id);
        if (normalized) ids.add(normalized);
      }
    }
  }
  return [...ids];
}

function damageTypesMatchAbsorptionRule(rule, sourceOptions = {}, applyDamageOptions = {}) {
  const incomingTypes = damageTypesFromOptions(sourceOptions, applyDamageOptions);
  const hasTyped = incomingTypes.some((type) => type && type !== "untyped");
  const filterTypes = new Set((rule.damageTypeIds ?? []).map((type) => normalizePriorityType(type)).filter(Boolean));
  const includesUntyped = filterTypes.has("untyped");
  if (!filterTypes.size) return hasTyped || rule.includeUntyped === true;
  if (!hasTyped && (includesUntyped || rule.includeUntyped === true)) return true;
  return incomingTypes.some((type) => filterTypes.has(type));
}

function isAbsorptionRawConfigured(raw = {}) {
  const preset = normalizeAbsorptionPresetId(raw?.preset);
  const defaults = absorptionPresetDefaults(preset, raw);
  const energyType = normalizeAbsorptionPresetEnergyType(preset, raw?.energyType ?? defaults.energyType);
  return Boolean(
    raw && typeof raw === "object" && (
      raw.enabled === true
      || preset !== "ablativeBarrier"
      || energyType !== normalizeAbsorptionPresetEnergyType(preset, defaults.energyType)
      || (String(raw.totalFormula ?? "").trim() && String(raw.totalFormula).trim() !== String(defaults.totalFormula))
      || (String(raw.perAttackFormula ?? "").trim() && String(raw.perAttackFormula).trim() !== String(defaults.perAttackFormula))
      || (raw.remaining != null && Number.isFinite(Number(raw.remaining)))
      || (raw.capacity != null && Number.isFinite(Number(raw.capacity)))
      || (preset === "custom" && Array.isArray(raw.rules) && raw.rules.length > 0)
    )
  );
}

function normalizedDamageAbsorptionTypesForInstance(instance) {
  const typeIds = new Set();
  for (const key of ["typeIds", "types", "type", "damageType", "damageTypes"]) {
    for (const id of typeValuesFrom(instance?.[key])) {
      const normalized = normalizePriorityType(id);
      if (normalized) typeIds.add(normalized);
    }
  }
  return [...typeIds];
}

function absorptionRuleMatchesDamageTypeSet(rule, typeIds = []) {
  const incomingTypes = Array.from(typeIds).map((type) => normalizePriorityType(type)).filter(Boolean);
  const hasTyped = incomingTypes.some((type) => type && type !== "untyped");
  const filterTypes = new Set((rule?.damageTypeIds ?? []).map((type) => normalizePriorityType(type)).filter(Boolean));
  const includesUntyped = filterTypes.has("untyped");
  if (!filterTypes.size) return hasTyped || rule?.includeUntyped === true;
  if (!hasTyped && (includesUntyped || rule?.includeUntyped === true)) return true;
  return incomingTypes.some((type) => filterTypes.has(type));
}

function damageAbsorptionInstanceValue(instance) {
  const value = instance?.value ?? instance?.amount ?? instance?.damage ?? instance?.total;
  return Math.max(0, Number(value) || 0);
}

function preferredDamageAbsorptionInstances(sourceOptions = {}, applyDamageOptions = {}) {
  const sourceInstances = Array.from(sourceOptions?.instances ?? []);
  const applyInstances = Array.from(applyDamageOptions?.instances ?? []);
  const sourceTotal = sourceInstances.reduce((total, instance) => total + damageAbsorptionInstanceValue(instance), 0);
  if (sourceTotal > 0) return sourceInstances;
  return applyInstances;
}

function buildDamageAbsorptionBuckets(sourceOptions = {}, applyDamageOptions = {}, incoming = 0) {
  const instances = preferredDamageAbsorptionInstances(sourceOptions, applyDamageOptions)
    .map((instance, index) => ({
      index,
      value: damageAbsorptionInstanceValue(instance),
      typeIds: normalizedDamageAbsorptionTypesForInstance(instance)
    }))
    .filter((instance) => instance.value > 0);
  const total = instances.reduce((sum, instance) => sum + instance.value, 0);
  if (total <= 0) return [];
  const scale = incoming > 0 && total !== incoming ? incoming / total : 1;
  return instances.map((instance) => ({
    ...instance,
    originalValue: instance.value,
    value: Math.max(0, Math.floor(instance.value * scale))
  })).filter((instance) => instance.value > 0);
}

function matchingDamageRemainingForRule(rule, damageBuckets = []) {
  if (!damageBuckets.length) return null;
  return damageBuckets.reduce((total, bucket) => {
    if (!absorptionRuleMatchesDamageTypeSet(rule, bucket.typeIds)) return total;
    return total + Math.max(0, Number(bucket.value) || 0);
  }, 0);
}

function spendMatchingDamageForRule(rule, damageBuckets = [], amount = 0) {
  let remaining = Math.max(0, Number(amount) || 0);
  let spent = 0;
  if (!damageBuckets.length || remaining <= 0) return spent;
  for (const bucket of damageBuckets) {
    if (remaining <= 0) break;
    if (!absorptionRuleMatchesDamageTypeSet(rule, bucket.typeIds)) continue;
    const spend = Math.min(Math.max(0, Number(bucket.value) || 0), remaining);
    bucket.value = Math.max(0, Number(bucket.value) || 0) - spend;
    remaining -= spend;
    spent += spend;
  }
  return spent;
}

function sourceWeaponTypes(sourceOptions = {}) {
  const action = sourceOptions?.action;
  const item = sourceOptions?.item ?? action?.item ?? sourceOptions?.message?.itemSource;
  return [
    action?.weaponType,
    action?.weaponSubtype,
    item?.system?.weaponType,
    item?.system?.weaponSubtype,
    item?.subType,
    item?.system?.subType
  ].map((value) => String(value ?? "").toLowerCase()).filter(Boolean);
}

function sourceMatchesAbsorptionRule(rule, sourceOptions = {}) {
  const isWeapon = isWeaponAttack(sourceOptions);
  if (rule.sourceKind === "nonWeapon") return !isWeapon;
  if (rule.sourceKind !== "anyAttack" && !isWeapon) return false;
  const action = sourceOptions?.action;
  const item = sourceOptions?.item ?? action?.item ?? sourceOptions?.message?.itemSource;
  const candidates = [
    action?.isRanged,
    action?.ranged,
    action?.rangeType,
    action?.attackType,
    action?.type,
    item?.system?.weaponType,
    item?.system?.weaponSubtype,
    item?.system?.range?.type,
    item?.system?.rangeType
  ].map((value) => String(value ?? "").toLowerCase());
  const ranged = candidates.some((value) => value === "true" || value.includes("ranged") || value.includes("projectile") || value.includes("thrown"));
  const weaponTypes = sourceWeaponTypes(sourceOptions);
  if (rule.weaponType && !weaponTypes.includes(String(rule.weaponType).toLowerCase())) return false;
  if (rule.sourceKind === "anyAttack") return true;
  if (rule.sourceKind === "weapon") return isWeapon;
  if (rule.sourceKind === "rangedWeapon") return ranged;
  if (rule.sourceKind === "meleeWeapon") return isWeapon && !ranged;
  if (rule.sourceKind === "naturalWeapon") return weaponTypes.some((value) => value.includes("natural"));
  return true;
}

function damageKindMatchesAbsorptionRule(rule, isNonlethal) {
  if (rule.damageKind === "any") return true;
  return rule.damageKind === (isNonlethal ? "nonlethal" : "lethal");
}

function absorptionRuleBypassed(rule, sourceOptions = {}, applyDamageOptions = {}) {
  return absorptionBypassContext(rule, sourceOptions, applyDamageOptions).bypassed;
}

function traitDrEntriesFromSource(actor) {
  const sourceEntries = actor?._source?.system?.traits?.dr?.value;
  const entries = Array.isArray(sourceEntries) ? sourceEntries : actor?.system?.traits?.dr?.value;
  return Array.isArray(entries) ? entries.filter((entry) => Number(entry?.amount ?? entry?.value) > 0) : [];
}

function activeGrantedDefenseDrEntries(item) {
  if (!item || item.type !== "buff" && item.type !== "equipment") return [];
  const active = item.type === "buff"
    ? item.system?.active === true
    : item.system?.equipped === true && (item.system?.quantity ?? 1) > 0 && item.isBroken !== true;
  if (!active) return [];
  const config = item.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[GRANTED_DEFENSE_FLAG];
  return Array.isArray(config?.dr?.value) ? config.dr.value.filter((entry) => Number(entry?.amount ?? entry?.value) > 0) : [];
}

function absorptionDrEntriesForStrictCheck(item) {
  const config = absorptionConfig(item);
  if (!config.enabled || !isActiveBuff(item)) return [];
  return absorptionRulesToGrantedDefense(config).dr.value;
}

function actorHasOtherDr(actor, sourceItem) {
  if (traitDrEntriesFromSource(actor).length > 0) return true;
  for (const item of actor?.items ?? []) {
    if (item === sourceItem) continue;
    if (activeGrantedDefenseDrEntries(item).length > 0) return true;
    if (absorptionDrEntriesForStrictCheck(item).length > 0) return true;
  }
  return false;
}

function absorptionRuleCanAppearAsGrantedDr(rule) {
  if (rule?.action !== "reduce" || rule?.defenseKind !== "dr") return false;
  if (rule?.showAsGrantedDefense !== true) return false;
  if (rule?.damageKind !== "any") return false;
  if (!["anyAttack", "weapon"].includes(String(rule?.sourceKind ?? ""))) return false;
  if (String(rule?.weaponType ?? "")) return false;
  return Array.isArray(rule?.reductionBypassTypes) && rule.reductionBypassTypes.length > 0;
}

function absorptionRuleCanAppearAsGrantedEr(rule) {
  if (rule?.action !== "reduce" || rule?.defenseKind !== "er") return false;
  if (rule?.showAsGrantedDefense !== true) return false;
  if (rule?.damageKind !== "any") return false;
  if (String(rule?.sourceKind ?? "") !== "anyAttack") return false;
  if (String(rule?.weaponType ?? "")) return false;
  return Array.isArray(rule?.reductionBypassTypes) && rule.reductionBypassTypes.length > 0;
}

function absorptionRulesToGrantedDefense(config) {
  const dr = [];
  const eres = [];
  for (const rule of config?.rules ?? []) {
    if (absorptionRuleCanAppearAsGrantedDr(rule)) {
      dr.push({
        amount: Number(rule.amountFormula),
        types: [...rule.reductionBypassTypes],
        operator: true,
        stackable: false,
        nas: {
          source: "damageAbsorption",
          preset: config.preset,
          poolTracked: rule.spendPool === true,
          defenseKind: "dr"
        }
      });
    }
    if (absorptionRuleCanAppearAsGrantedEr(rule)) {
      eres.push({
        amount: Number(rule.amountFormula),
        types: [...rule.reductionBypassTypes],
        operator: true,
        stackable: false,
        nas: {
          source: "damageAbsorption",
          preset: config.preset,
          poolTracked: rule.spendPool === true,
          defenseKind: "er"
        }
      });
    }
  }
  const result = {
    enabled: dr.length > 0 || eres.length > 0,
    dr: { value: dr.filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0), custom: "" },
    eres: { value: eres, custom: "" },
    di: [],
    ci: [],
    dv: []
  };
  return result;
}

export function absorptionGrantedDefenseContributionsForItem(item, actor) {
  if (!hasDamageAbsorptionConfig(item)) {
    return { enabled: false, dr: { value: [], custom: "" }, eres: { value: [], custom: "" }, di: [], ci: [], dv: [] };
  }
  const config = absorptionConfig(item);
  if (config.preset === "defendingBone" && actorHasOtherDr(actor ?? item.actor, item)) {
    return { enabled: false, dr: { value: [], custom: "" }, eres: { value: [], custom: "" }, di: [], ci: [], dv: [] };
  }
  return absorptionRulesToGrantedDefense(config);
}

async function remainingFor(item, config, actor, incomingDamage) {
  if (Number.isFinite(Number(config.remaining))) {
    const remaining = Math.max(0, Math.floor(Number(config.remaining)));
    const capacity = Number.isFinite(Number(config.capacity)) ? Math.max(0, Math.floor(Number(config.capacity))) : null;
    if (capacity != null && (remaining > 0 || config.dischargeAtZero === false)) return remaining;
  }
  const total = await evaluateFormula(config.totalFormula, actor, item, { incomingDamage, finalDamage: incomingDamage });
  const shouldKeepZero = Number(config.remaining) === 0 && config.dischargeAtZero === false;
  await item.update({
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.remaining`]: shouldKeepZero ? 0 : total,
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.capacity`]: total
  }, { render: false });
  return shouldKeepZero ? 0 : total;
}

export async function initializeDamageAbsorptionBuff(item) {
  if (!hasDamageAbsorptionConfig(item)) {
    return false;
  }
  const config = absorptionConfig(item);
  if (!absorptionUsesDischargeTotal(config)) {
    refreshTokenEffectBadgesForActor(item.actor);
    refreshTokenBarsForActor(item.actor);
    return false;
  }
  if (
    Number.isFinite(Number(config.remaining))
    && Number(config.remaining) > 0
    && Number.isFinite(Number(config.capacity))
  ) {
    refreshTokenEffectBadgesForActor(item.actor);
    refreshTokenBarsForActor(item.actor);
    return false;
  }
  await remainingFor(item, config, item.actor, 0);
  refreshTokenEffectBadgesForActor(item.actor);
  refreshTokenBarsForActor(item.actor);
  return true;
}

export async function resetDamageAbsorptionBuff(item) {
  if (!hasDamageAbsorptionConfig(item)) return false;
  const config = absorptionConfig(item);
  if (!absorptionUsesDischargeTotal(config)) {
    refreshTokenEffectBadgesForActor(item.actor);
    refreshTokenBarsForActor(item.actor);
    return false;
  }
  const total = await evaluateFormula(config.totalFormula, item.actor, item, { incomingDamage: 0, finalDamage: 0 });
  await item.update({
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.remaining`]: total,
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.capacity`]: total
  }, { render: false });
  refreshTokenEffectBadgesForActor(item.actor);
  refreshTokenBarsForActor(item.actor);
  return true;
}

async function updateAbsorptionBuff(item, remaining, { dischargeAtZero = true } = {}) {
  const updates = {
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.remaining`]: Math.max(0, Math.floor(Number(remaining) || 0))
  };
  if (dischargeAtZero && updates[`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.absorption.remaining`] <= 0) {
    updates["system.active"] = false;
  }
  await item.update(updates, { render: false });
  refreshTokenEffectBadgesForActor(item.actor);
  refreshTokenBarsForActor(item.actor);
}

function activeHpBarAbsorption(actor) {
  return getHpBarAbsorptionBuffs(actor).reduce((total, item) => total + absorptionConfig(item).remaining, 0);
}

function hpBarAbsorptionValue(token, data) {
  if (data?.attribute !== "attributes.hp") return;
  const absorption = activeHpBarAbsorption(token?.actor);
  return absorption > 0 ? absorption : null;
}

function drawHpBarWithAbsorption(token, number, bar, data, absorption = 0) {
  const absorptionValue = Math.max(0, Number(absorption) || 0);
  const dataTemp = Math.max(0, Number(data?.temp) || 0);
  if (absorptionValue <= 0 && dataTemp <= 0 && getNasTemporaryHpTotal(token?.actor) <= 0) return;
  const w = Number(token.w) || Number(token.document?.width) || Number(data.max) || 0;
  if (w <= 0) return;

  const boost = token._getBarBoost?.(data);
  const underline = token._getBarUnderline?.(data);
  const boostlessMax = Math.max(0, Number(data.max) || 0);
  const value = Number(data.value);
  const nasTempHp = getNasTemporaryHpTotal(token?.actor);
  const boostValue = Math.max(0, Number(boost?.value) || 0, dataTemp, nasTempHp);
  const protectedValue = value + absorptionValue;
  const visualMax = Math.max(boostlessMax, value + boostValue + absorptionValue);
  if (visualMax <= 0) return;

  const h = Math.max(canvas.dimensions.size / 12, 8) * (token.document?.height >= 2 ? 1.6 : 1);
  const bs = Math.clamp(h / 8, 1, 2);
  const blk = 0x000000;
  const pct = Math.clamp(value, 0, visualMax) / visualMax;
  const boostlessPct = boostlessMax > 0 ? Math.clamp(protectedValue, 0, boostlessMax) / boostlessMax : 0;
  const color = number === 0
    ? Color.fromRGBvalues(1 - boostlessPct / 2, boostlessPct, 0)
    : Color.fromRGBvalues(0.5 * boostlessPct, 0.7 * boostlessPct, 0.5 + boostlessPct / 2);

  bar.clear();
  bar.beginFill(blk, 0.5).lineStyle(bs, blk, 1.0).drawRoundedRect(0, 0, w, h, 3);

  if (boostValue > 0) {
    const boostPct = Math.clamp(value + boostValue, 0, visualMax) / visualMax;
    bar
      .beginFill(boost?.color ?? 0x66ccff, 1.0)
      .lineStyle(bs, blk, 1.0)
      .drawRoundedRect(0, 0, boostPct * w, h, 2);
  }

  bar
    .beginFill(color, 1.0)
    .lineStyle(bs, blk, 1.0)
    .drawRoundedRect(0, 0, pct * w, h, 2);

  if (underline?.value > 0) {
    const underlinePct = Math.clamp(underline.value, 0, visualMax) / visualMax;
    bar
      .beginFill(underline.color, 1.0)
      .lineStyle(bs, blk, 1.0)
      .drawRoundedRect(0, h / 2, underlinePct * w, h / 2, 2);
  }

  if (absorptionValue > 0) {
    const absorptionStart = Math.clamp(value + boostValue, 0, visualMax) / visualMax;
    const absorptionEnd = Math.clamp(value + boostValue + absorptionValue, 0, visualMax) / visualMax;
    const x = absorptionStart * w;
    const width = Math.max(0, (absorptionEnd - absorptionStart) * w);

    bar
      .beginFill(0x8b5cf6, 1.0)
      .lineStyle(bs, 0x000000, 1.0)
      .drawRoundedRect(x, 0, width, h, 2);
  }

  const posY = number === 0 ? token.h - h : 0;
  bar.position.set(0, posY);
}

export function registerDamageAbsorptionHpBarOverlay() {
  if (!globalThis.libWrapper) return;
  const target = globalThis.CONFIG?.Token?.objectClass ? "CONFIG.Token.objectClass.prototype._drawBar" : "Token.prototype._drawBar";
  if (globalThis.nasDamageAbsorptionHpBarOverlayRegistered) return;
  globalThis.nasDamageAbsorptionHpBarOverlayRegistered = true;
  libWrapper.register(
    MODULE.ID,
    target,
    function (wrapped, number, bar, data) {
      const adjustedData = hpBarDataWithNasTemporaryHp(this, data);
      const absorption = hpBarAbsorptionValue(this, adjustedData);
      const result = wrapped.call(this, number, bar, adjustedData);
      if (absorption != null || adjustedData?._nasTemporaryHpIncluded === true) {
        drawHpBarWithAbsorption(this, number, bar, adjustedData, absorption ?? 0);
      }
      return result;
    },
    "WRAPPER"
  );
}

export async function applyDamageAbsorption({
  actor,
  value = 0,
  applyDamageOptions = {},
  sourceOptions = {}
} = {}) {
  const incoming = Math.max(0, Math.floor(Number(value) || 0));
  if (!actor || incoming <= 0) {
    return { value: incoming, convertedNonlethal: 0, nonlethalReduction: 0, damageReduction: 0, drReduction: 0, erReduction: 0, convertedDamage: [], changed: false };
  }

  const buffs = getAbsorptionBuffs(actor);
  const isNonlethal = Boolean(sourceOptions?.asNonlethal || applyDamageOptions?.asNonlethal);
  if (!buffs.length) {
    return { value: incoming, convertedNonlethal: 0, nonlethalReduction: 0, damageReduction: 0, drReduction: 0, erReduction: 0, convertedDamage: [], changed: false };
  }

  let valueOut = incoming;
  let convertedNonlethal = 0;
  let nonlethalReduction = 0;
  let damageReduction = 0;
  let drReduction = 0;
  let erReduction = 0;
  let dischargeSpent = 0;
  const convertedDamage = [];
  const events = [];
  const damageBuckets = buildDamageAbsorptionBuckets(sourceOptions, applyDamageOptions, incoming);

  for (const buff of buffs) {
    const config = absorptionConfig(buff);
    if (valueOut <= 0) break;
    if (config.preset === "defendingBone" && actorHasOtherDr(actor, buff)) {
      continue;
    }

    for (const rule of config.rules) {
      if (valueOut <= 0) break;
      if (!rule.action) continue;
      const damageKindMatches = damageKindMatchesAbsorptionRule(rule, isNonlethal);
      const typeMatches = damageTypesMatchAbsorptionRule(rule, sourceOptions, applyDamageOptions);
      const sourceMatches = sourceMatchesAbsorptionRule(rule, sourceOptions);
      const bypassed = rule.action === "reduce" && absorptionRuleBypassed(rule, sourceOptions, applyDamageOptions);
      if (!damageKindMatches) {
        continue;
      }
      if (!typeMatches) {
        continue;
      }
      if (!sourceMatches) {
        continue;
      }
      if (bypassed) {
        continue;
      }


      const amount = await evaluateFormula(rule.amountFormula, actor, buff, {
        incomingDamage: valueOut,
        finalDamage: valueOut
      });
      if (amount <= 0) continue;

      let remaining = null;
      if (rule.spendPool) {
        remaining = await remainingFor(buff, config, actor, valueOut);
        if (remaining <= 0) continue;
      }
      const matchingDamageRemaining = matchingDamageRemainingForRule(rule, damageBuckets);
      const eligibleDamage = matchingDamageRemaining == null ? valueOut : Math.min(valueOut, matchingDamageRemaining);
      if (eligibleDamage <= 0) continue;

      if (rule.action === "reduce") {
        const reduced = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (reduced <= 0) continue;
        valueOut -= reduced;
        spendMatchingDamageForRule(rule, damageBuckets, reduced);
        nonlethalReduction += isNonlethal ? reduced : 0;
        const reductionKind = rule.defenseKind === "er" ? "er" : "dr";
        damageReduction += reduced;
        if (reductionKind === "er") erReduction += reduced;
        else drReduction += reduced;
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - reduced, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "damageReduction",
            itemName: buff.name,
            amount: reduced,
            defenseKind: reductionKind,
            remaining: rule.spendPool ? Math.max(0, remaining - reduced) : null
          });
        }
        continue;
      }

      if (rule.action === "convertToNonlethal" && !isNonlethal) {
        const converted = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (converted <= 0) continue;
        valueOut -= converted;
        spendMatchingDamageForRule(rule, damageBuckets, converted);
        convertedNonlethal += converted;
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - converted, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "convertedNonlethal",
            itemName: buff.name,
            amount: converted,
            remaining: rule.spendPool ? Math.max(0, remaining - converted) : null
          });
        }
      }

      if (rule.action === "convertToNonlethal" && isNonlethal) {
        const spent = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (spent <= 0) continue;
        dischargeSpent += rule.spendPool ? spent : 0;
        spendMatchingDamageForRule(rule, damageBuckets, spent);
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - spent, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "dischargeSpent",
            itemName: buff.name,
            amount: spent,
            remaining: rule.spendPool ? Math.max(0, remaining - spent) : null
          });
        }
        continue;
      }

      if (rule.action === "convertToDamage" && isNonlethalDamageType(rule.convertToDamageType) && !isNonlethal) {
        const converted = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (converted <= 0) continue;
        valueOut -= converted;
        spendMatchingDamageForRule(rule, damageBuckets, converted);
        convertedNonlethal += converted;
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - converted, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "convertedNonlethal",
            itemName: buff.name,
            amount: converted,
            remaining: rule.spendPool ? Math.max(0, remaining - converted) : null
          });
        }
      }

      if (rule.action === "convertToDamage" && isNonlethalDamageType(rule.convertToDamageType) && isNonlethal) {
        const spent = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (spent <= 0) continue;
        dischargeSpent += rule.spendPool ? spent : 0;
        spendMatchingDamageForRule(rule, damageBuckets, spent);
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - spent, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "dischargeSpent",
            itemName: buff.name,
            amount: spent,
            remaining: rule.spendPool ? Math.max(0, remaining - spent) : null
          });
        }
        continue;
      }

      if (rule.action === "convertToDamage" && rule.convertToDamageType && !isNonlethalDamageType(rule.convertToDamageType)) {
        const converted = Math.min(valueOut, eligibleDamage, amount, rule.spendPool ? remaining : valueOut);
        if (converted <= 0) continue;
        valueOut -= converted;
        spendMatchingDamageForRule(rule, damageBuckets, converted);
        convertedDamage.push({ amount: converted, damageType: rule.convertToDamageType });
        if (rule.spendPool) {
          await updateAbsorptionBuff(buff, remaining - converted, { dischargeAtZero: config.dischargeAtZero });
        }
        if (config.message) {
          events.push({
            type: "convertedDamage",
            itemName: buff.name,
            amount: converted,
            damageType: rule.convertToDamageType,
            remaining: rule.spendPool ? Math.max(0, remaining - converted) : null
          });
        }
      }
    }
  }

  const result = {
    value: Math.max(0, valueOut),
    convertedNonlethal,
    nonlethalReduction,
    damageReduction,
    drReduction,
    erReduction,
    convertedDamage,
    events,
    changed: valueOut !== incoming || convertedNonlethal > 0 || nonlethalReduction > 0 || convertedDamage.length > 0 || dischargeSpent > 0
  };
  return result;
}

function escHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function actorChatName(actor) {
  return actor?.name ?? game.i18n.localize("NAS.common.labels.target");
}

function absorptionLineHtml(event) {
  const item = escHtml(event?.itemName ?? game.i18n.localize("NAS.reactive.chatSummary.unknownBuff"));
  const amount = Math.max(0, Math.floor(Number(event?.amount) || 0));
  if (amount <= 0) return null;
  if (event?.type === "convertedNonlethal") {
    return game.i18n.format("NAS.reactive.chatSummary.lineAbsorptionConvert", {
      item,
      amount,
      remaining: Math.max(0, Math.floor(Number(event?.remaining) || 0))
    });
  }
  if (event?.type === "convertedDamage") {
    return game.i18n.format("NAS.reactive.chatSummary.lineAbsorptionConvertDamage", {
      item,
      amount,
      type: escHtml(event?.damageType ?? "untyped")
    });
  }
  if (event?.type === "dischargeSpent") {
    return game.i18n.format("NAS.reactive.chatSummary.lineAbsorptionSpend", {
      item,
      amount,
      remaining: Math.max(0, Math.floor(Number(event?.remaining) || 0))
    });
  }
  if (event?.type === "nonlethalReduction" || event?.type === "damageReduction") {
    return game.i18n.format("NAS.reactive.chatSummary.lineAbsorptionReduce", { item, amount });
  }
  return null;
}

export function postDamageAbsorptionChatSummary({
  actor,
  otherActor,
  incomingDamage = 0,
  events = []
} = {}) {
  const lineHtmls = events.map(absorptionLineHtml).filter(Boolean);
  if (!lineHtmls.length) return false;

  const title = game.i18n.format("NAS.reactive.chatSummary.absorptionTitle", {
    actor: escHtml(actorChatName(actor))
  });
  const subtitle = game.i18n.format("NAS.reactive.chatSummary.absorptionSubtitle", {
    other: escHtml(actorChatName(otherActor)),
    incomingDamage: String(Math.max(0, Math.floor(Number(incomingDamage) || 0)))
  });
  const content = [
    `<div class="nas-reactive-chat-summary" data-nas-reactive-summary>`,
    `<div class="nas-reactive-chat-header"><strong>${title}</strong></div>`,
    `<div class="nas-reactive-chat-subtitle">${subtitle}</div>`,
    `<ul class="nas-reactive-chat-lines">`,
    lineHtmls.map((html) => `<li>${html}</li>`).join(""),
    `</ul></div>`
  ].join("");

  ChatMessage.create({
    ...chatMessageStyle("OTHER"),
    user: game.user?.id,
    speaker: ChatMessage.getSpeaker({ actor: actor ?? null }),
    content
  });
  return true;
}

export function registerDamageAbsorptionTokenEffectBadgeProvider() {
  registerTokenEffectBadgeProvider({
    id: "damageAbsorption",
    getBadgesForToken(token) {
      const badges = [];
      const buffs = getAbsorptionBuffs(token?.actor);
      for (const buff of buffs) {
        const config = absorptionConfig(buff);
        if (!absorptionUsesDischargeTotal(config) || !config.showBadge || !Number.isFinite(Number(config.remaining)) || config.remaining <= 0) {
          continue;
        }
        badges.push({
          item: buff,
          value: config.remaining,
          visible: canUserSeeTokenEffectBadge(buff),
          name: buff.id
        });
      }
      return badges;
    }
  });
}

export function refreshDamageAbsorptionSceneTokenEffects() {
  refreshTokenEffectBadgesForScene((token) => getAbsorptionBuffs(token?.actor).length > 0);
}

export async function initializeDamageAbsorptionSceneBuffs() {
  const seen = new Set();
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    for (const buff of getAbsorptionBuffs(actor)) {
      await initializeDamageAbsorptionBuff(buff);
    }
  }
}
