import { MODULE } from "../../../common/module.js";
import { getDamageTypes } from "../../../common/settings/damageSettingsForms.js";
import { absorptionGrantedDefenseContributionsForItem, hasDamageAbsorptionData } from "../buffs/damageAbsorption.js";
import { createNasId } from "../utils/nasIds.js";

export const GRANTED_DEFENSE_FLAG = "grantedDefenses";
export const ITEM_REACTIVE_FLAG_KEY = "itemReactiveEffects";
export const FORTIFICATION_TIERS = {
  none: { id: "none", rank: 0, chance: 0, labelKey: "NAS.common.labels.none" },
  light: { id: "light", rank: 1, chance: 25, labelKey: "NAS.reactive.fortificationLight" },
  moderate: { id: "moderate", rank: 2, chance: 50, labelKey: "NAS.reactive.fortificationModerate" },
  heavy: { id: "heavy", rank: 3, chance: 75, labelKey: "NAS.reactive.fortificationHeavy" },
  immune: { id: "immune", rank: 4, chance: 100, labelKey: "NAS.reactive.fortificationImmune" }
};

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : Array.from(values ?? []))
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )];
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function normalizeFortificationTier(value) {
  const key = String(value ?? "none").trim().toLowerCase();
  return FORTIFICATION_TIERS[key]?.id ?? "none";
}

export function getFortificationTierData(value) {
  return FORTIFICATION_TIERS[normalizeFortificationTier(value)] ?? FORTIFICATION_TIERS.none;
}

function normalizeResistanceEntry(entry = {}) {
  return {
    id: String(entry?.id ?? createNasId()),
    amount: numberOrZero(entry?.amount ?? entry?.value),
    types: uniqueStrings(entry?.types),
    operator: String(entry?.operator ?? "true").toLowerCase() !== "false",
    stackable: entry?.stackable === true
  };
}

function actorResistanceEntry(entry = {}) {
  const out = {
    amount: numberOrZero(entry?.amount ?? entry?.value),
    types: uniqueStrings(entry?.types),
    operator: String(entry?.operator ?? "true").toLowerCase() !== "false"
  };
  if (entry?.nas) out.nas = foundry.utils.deepClone(entry.nas);
  return out;
}

function normalizeResistanceGrant(raw = {}) {
  if (Array.isArray(raw)) {
    return {
      value: raw.map(normalizeResistanceEntry).filter((entry) => entry.amount > 0),
      custom: raw.map((entry) => String(entry?.custom ?? "").trim()).filter(Boolean).join("; ")
    };
  }
  const value = Array.isArray(raw?.value) ? raw.value : [];
  return {
    value: value.map(normalizeResistanceEntry).filter((entry) => entry.amount > 0),
    custom: Array.isArray(raw?.custom) ? uniqueStrings(raw.custom).join("; ") : String(raw?.custom ?? "").trim()
  };
}

export function normalizeGrantedDefenses(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    dr: normalizeResistanceGrant(raw?.dr),
    eres: normalizeResistanceGrant(raw?.eres),
    di: uniqueStrings(raw?.di),
    ci: uniqueStrings(raw?.ci),
    dv: uniqueStrings(raw?.dv),
    fortification: normalizeFortificationTier(raw?.fortification)
  };
}

export function hasGrantedDefenseData(item) {
  return Boolean(item?.flags?.[MODULE.ID]?.[ITEM_REACTIVE_FLAG_KEY]?.[GRANTED_DEFENSE_FLAG]);
}

function grantedDefenseSourceStatus(item) {
  if (!item) return { active: false, reason: "missing-item" };
  if (!["buff", "equipment"].includes(item.type)) {
    return {
      active: false,
      reason: "unsupported-item-type",
      type: item.type
    };
  }
  if (item.type === "buff") {
    const active = item.isActive ?? item.system?.active === true;
    return {
      active,
      reason: active ? "active-buff" : "inactive-buff",
      isActive: item.isActive,
      systemActive: item.system?.active
    };
  }
  const active = item.system?.equipped === true && (item.system?.quantity ?? 1) > 0;
  const notBroken = item.isBroken !== true;
  return {
    active: active && notBroken,
    reason: active && notBroken ? "active-equipment" : "inactive-equipment",
    isActive: item.isActive,
    equipped: item.system?.equipped,
    quantity: item.system?.quantity,
    isBroken: item.isBroken
  };
}

export function isGrantedDefenseSourceActive(item) {
  return grantedDefenseSourceStatus(item).active === true;
}

export function getGrantedDefenseOptions(kind) {
  if (kind === "dr") return getDamageTypes("damageReduction").filter((option) => option.id !== "all");
  if (kind === "eres") return getDamageTypes("resistance").filter((option) => option.id !== "all");
  if (kind === "di") return getDamageTypes("immunity").filter((option) => option.id !== "all");
  if (kind === "dv") return getDamageTypes("immunity").filter((option) => option.id !== "all");
  if (kind === "fortification") {
    return Object.values(FORTIFICATION_TIERS).map((tier) => ({
      id: tier.id,
      label: game.i18n.localize(tier.labelKey),
      chance: tier.chance
    }));
  }
  if (kind === "ci") {
    const out = [];
    for (const condition of pf1?.registry?.conditions ?? []) {
      const id = String(condition?._id ?? "").trim();
      if (id) out.push({ id, label: condition?.name ?? id });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
  return [];
}

function resistanceSignature(entry) {
  return JSON.stringify({
    types: uniqueStrings(entry?.types).map((value) => value.toLowerCase()).sort(),
    operator: String(entry?.operator ?? "true").toLowerCase() !== "false"
  });
}

function canonicalResistance(entry) {
  return JSON.stringify({
    amount: numberOrZero(entry?.amount ?? entry?.value),
    types: uniqueStrings(entry?.types).map((value) => value.toLowerCase()).sort(),
    operator: String(entry?.operator ?? "true").toLowerCase() !== "false"
  });
}

function uniqueResistanceEntries(entries = []) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = canonicalResistance(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(actorResistanceEntry(entry));
  }
  return out;
}

function ensureResistanceTrait(traits, key) {
  const trait = traits[key];
  if (!trait || typeof trait !== "object" || Array.isArray(trait)) {
    traits[key] = { value: Array.isArray(trait) ? [...trait] : [], custom: "" };
  }
  traits[key].value = Array.isArray(traits[key].value) ? [...traits[key].value] : [];
  traits[key].custom = Array.isArray(traits[key].custom)
    ? traits[key].custom.join("; ")
    : String(traits[key].custom ?? "");
  return traits[key];
}

function applyResistanceGrant(trait, grant) {
  const signature = resistanceSignature(grant);
  const index = trait.value.findIndex((entry) => resistanceSignature(entry) === signature);
  const amount = numberOrZero(grant?.amount ?? grant?.value);

  if (index < 0) {
    trait.value = uniqueResistanceEntries([...trait.value, grant]);
    return;
  }

  const before = actorResistanceEntry(trait.value[index]);
  const nextAmount = grant?.stackable === true ? before.amount + amount : Math.max(before.amount, amount);
  trait.value[index] = { ...before, amount: nextAmount };
  trait.value = uniqueResistanceEntries(trait.value);
}

function appendCustomResistance(trait, custom) {
  const text = String(custom ?? "").trim();
  if (!text) return;
  const parts = [
    ...String(trait.custom ?? "").split(pf1?.config?.re?.traitSeparator ?? /[,;\n]/),
    ...text.split(pf1?.config?.re?.traitSeparator ?? /[,;\n]/)
  ].map((entry) => entry.trim()).filter(Boolean);
  trait.custom = uniqueStrings(parts).join("; ");
}

function knownTraitId(kind, id) {
  if (kind === "ci") return Boolean(pf1?.registry?.conditions?.get?.(id));
  return Boolean(pf1?.registry?.damageTypes?.get?.(id));
}

function addTraitSetValue(trait, kind, id) {
  if (!trait || !id) return;
  const value = String(id).trim();
  if (!value) return;
  if (knownTraitId(kind, value)) {
    trait.standard?.add?.(value);
    if (Array.isArray(trait.value) && !trait.value.includes(value)) trait.value.push(value);
    return;
  }
  trait.custom?.add?.(value);
  if (typeof trait.custom === "string") {
    trait.custom = uniqueStrings([...trait.custom.split(/[,;\n]/), value]).join("; ");
  }
}

function collectGrantedDefenseContributions(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!hasGrantedDefenseData(item)) continue;
    const status = grantedDefenseSourceStatus(item);
    const rawConfig = item.flags[MODULE.ID][ITEM_REACTIVE_FLAG_KEY][GRANTED_DEFENSE_FLAG];
    if (!status.active) continue;
    const config = normalizeGrantedDefenses(rawConfig);
    if (!config.enabled) continue;
    out.push({ item, config });
  }
  return out;
}

export function getActorGrantedFortification(actor) {
  let best = { ...FORTIFICATION_TIERS.none, item: null };
  for (const { item, config } of collectGrantedDefenseContributions(actor)) {
    const tier = getFortificationTierData(config.fortification);
    if (tier.rank <= best.rank) continue;
    best = { ...tier, item };
  }
  return best;
}

export function applyGrantedDefenseOverlay(actor) {
  const contributions = collectGrantedDefenseContributions(actor);

  const traits = actor.system?.traits;
  if (!traits) return false;

  const dr = ensureResistanceTrait(traits, "dr");
  const eres = ensureResistanceTrait(traits, "eres");

  for (const { config } of contributions) {
    for (const entry of config.dr.value) applyResistanceGrant(dr, entry);
    for (const entry of config.eres.value) applyResistanceGrant(eres, entry);
    appendCustomResistance(dr, config.dr.custom);
    appendCustomResistance(eres, config.eres.custom);
    for (const id of config.di) addTraitSetValue(traits.di, "di", id);
    for (const id of config.ci) addTraitSetValue(traits.ci, "ci", id);
    for (const id of config.dv) addTraitSetValue(traits.dv, "dv", id);
  }

  let applied = contributions.length > 0;
  for (const item of actor?.items ?? []) {
    if (!hasDamageAbsorptionData(item)) continue;
    const config = absorptionGrantedDefenseContributionsForItem(item, actor);
    if (!config.enabled) continue;
    for (const entry of config.dr.value) applyResistanceGrant(dr, entry);
    for (const entry of config.eres.value) applyResistanceGrant(eres, entry);
    applied = true;
  }

  return applied;
}

export function refreshGrantedDefenseActor(actor) {
  if (!actor) return;
  actor.sheet?.render?.(false);
  for (const token of actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? []) {
    token?.drawBars?.();
  }
}

export function registerGrantedDefenseOverlay() {
  Hooks.on("pf1PrepareBaseActorData", (actor) => {
    applyGrantedDefenseOverlay(actor);
  });
}
