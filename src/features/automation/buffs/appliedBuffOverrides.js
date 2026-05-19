import { MODULE } from "../../../common/module.js";
import { createNasId } from "../utils/nasIds.js";

export const REACTIVE_FLAG_KEY = "itemReactiveEffects";
export const APPLIED_BUFF_OVERRIDES_KEY = "appliedBuffOverrides";
export const APPLIED_BUFF_RUNTIME_KEY = "appliedBuffRuntime";
export const APPLIED_BUFF_LOCKOUTS_KEY = "appliedBuffLockouts";
export const APPLIED_BUFF_OVERRIDE_OPTION = "appliedBuffOverride";
export const APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION = "appliedBuffSourceItemUuid";
export const APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION = "appliedBuffSourceItemName";
export const APPLIED_BUFF_TARGET_UUID_OPTION = "appliedBuffTargetUuid";

const DEFAULT_LOCKOUT = { enabled: false, value: "24", units: "hour" };
const DEFAULT_UPKEEP = { enabled: false, costFormula: "1", intervalValue: "1", intervalUnits: "minute" };

function escapeKey(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : Array.from(values ?? []))
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

async function evaluateFormulaForItem(item, formula, fallback = 0) {
  const text = String(formula ?? "").trim();
  if (!text) return numberOrZero(fallback);
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numberOrZero(numeric);
  try {
    const actorData = item?.actor?.getRollData?.() ?? {};
    const itemData = item?.getRollData?.() ?? {};
    const roll = await new Roll(text, { ...actorData, item: itemData }).evaluate();
    return numberOrZero(roll?.total);
  } catch (_err) {
    return numberOrZero(fallback);
  }
}

function normalizeTimePeriod(value, fallback = "hour") {
  const units = String(value ?? fallback).trim();
  const periods = globalThis.CONFIG?.PF1?.timePeriods ?? {};
  if (periods[units]) return units;
  return ["round", "minute", "hour", "day"].includes(units) ? units : fallback;
}

function normalizeAppliedTemporaryHp(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    formula: String(value.formula ?? value.amountFormula ?? value.maxFormula ?? value.max ?? "").trim(),
    regeneration: {
      enabled: value.regeneration?.enabled === true,
      formula: String(value.regeneration?.formula ?? value.regenFormula ?? "").trim()
    },
    deactivateAtZero: value.deactivateAtZero === true,
    lockout: {
      enabled: value.lockout?.enabled === true,
      value: String(value.lockout?.value ?? DEFAULT_LOCKOUT.value),
      units: normalizeTimePeriod(value.lockout?.units, DEFAULT_LOCKOUT.units)
    }
  };
}

function normalizeAppliedGrantedDefenses(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    criticalImmunity: value.criticalImmunity === true
  };
}

function normalizeChargeUpkeep(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    costFormula: String(value.costFormula ?? value.cost ?? DEFAULT_UPKEEP.costFormula),
    intervalValue: String(value.intervalValue ?? DEFAULT_UPKEEP.intervalValue),
    intervalUnits: normalizeTimePeriod(value.intervalUnits, DEFAULT_UPKEEP.intervalUnits)
  };
}

export function normalizeAppliedBuffOverrideEntry(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(value.id ?? createNasId()),
    enabled: value.enabled !== false,
    buffUuid: String(value.buffUuid ?? value.targetBuffUuid ?? "").trim(),
    temporaryHp: normalizeAppliedTemporaryHp(value.temporaryHp),
    grantedDefenses: normalizeAppliedGrantedDefenses(value.grantedDefenses),
    chargeUpkeep: normalizeChargeUpkeep(value.chargeUpkeep)
  };
}

export function normalizeAppliedBuffOverrides(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const entries = Array.isArray(value.entries)
    ? value.entries
    : Array.isArray(value)
      ? value
      : [];
  const normalizedEntries = entries.map(normalizeAppliedBuffOverrideEntry).filter((entry) => entry.buffUuid || entry.enabled);
  return {
    enabled: normalizedEntries.some((entry) => entry.enabled && (
      entry.buffUuid
      || entry.temporaryHp.enabled
      || entry.temporaryHp.formula
      || entry.temporaryHp.regeneration.enabled
      || entry.temporaryHp.regeneration.formula
      || entry.temporaryHp.deactivateAtZero
      || entry.temporaryHp.lockout.enabled
      || entry.grantedDefenses.criticalImmunity
      || entry.chargeUpkeep.enabled
    )),
    entries: normalizedEntries
  };
}

export function appliedBuffUuidCandidates(buff) {
  const doc = buff?.document ?? buff;
  const sourceIds = [
    doc?.uuid,
    buff?.uuid,
    buff?.document?.uuid,
    doc?.flags?.[MODULE.ID]?.sourceId,
    doc?.flags?.core?.sourceId,
    doc?._stats?.compendiumSource
  ];
  if (buff?.pack && buff?.id) sourceIds.push(`Compendium.${buff.pack}.Item.${buff.id}`);
  if (doc?.pack && doc?.id) sourceIds.push(`Compendium.${doc.pack}.Item.${doc.id}`);
  return uniqueStrings(sourceIds);
}

export function primaryAppliedBuffUuid(buff) {
  return appliedBuffUuidCandidates(buff)[0] ?? "";
}

export function getAppliedBuffOverrideForBuff(sourceItem, buff) {
  const config = normalizeAppliedBuffOverrides(
    sourceItem?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_OVERRIDES_KEY]
  );
  if (!config.enabled) return null;
  const candidates = new Set(appliedBuffUuidCandidates(buff));
  return config.entries.find((entry) => entry.enabled && candidates.has(entry.buffUuid)) ?? null;
}

export function appliedBuffLockoutKey(buffUuid) {
  return escapeKey(buffUuid);
}

export function getAppliedBuffLockout(sourceItem, buffUuid) {
  const key = appliedBuffLockoutKey(buffUuid);
  return sourceItem?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_LOCKOUTS_KEY]?.[key] ?? null;
}

export function getAppliedBuffLockoutState(sourceItem, buffUuid, now = globalThis.game?.time?.worldTime ?? 0) {
  const lockout = getAppliedBuffLockout(sourceItem, buffUuid);
  const expiresAt = Number(lockout?.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { locked: false, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, lockout };
  }
  return { locked: true, expiresAt, lockout };
}

export function appliedBuffOverrideOptionsFor(sourceItem, buff) {
  const override = getAppliedBuffOverrideForBuff(sourceItem, buff);
  if (!override) return {};
  const targetUuid = override.buffUuid || primaryAppliedBuffUuid(buff);
  return {
    [APPLIED_BUFF_OVERRIDE_OPTION]: override,
    [APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION]: String(sourceItem?.uuid ?? ""),
    [APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION]: String(sourceItem?.name ?? ""),
    [APPLIED_BUFF_TARGET_UUID_OPTION]: targetUuid
  };
}

function timePeriodSeconds(value, units) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = normalizeTimePeriod(units, "hour");
  const roundSeconds = Number(globalThis.CONFIG?.time?.roundTime ?? 6) || 6;
  if (unit === "round") return amount * roundSeconds;
  if (unit === "minute") return amount * 60;
  if (unit === "hour") return amount * 3600;
  if (unit === "day") return amount * 86400;
  return amount;
}

export function appliedBuffOverrideRuntime({ override, sourceItemUuid, sourceItemName, appliedBuffUuid } = {}) {
  const now = Number(globalThis.game?.time?.worldTime ?? 0) || 0;
  const normalized = normalizeAppliedBuffOverrideEntry(override);
  const intervalSeconds = timePeriodSeconds(
    normalized.chargeUpkeep.intervalValue,
    normalized.chargeUpkeep.intervalUnits
  );
  return {
    sourceItemUuid: String(sourceItemUuid ?? ""),
    sourceItemName: String(sourceItemName ?? ""),
    appliedBuffUuid: String(appliedBuffUuid ?? normalized.buffUuid ?? ""),
    startedAtWorldTime: now,
    lastUpkeepWorldTime: now,
    chargeUpkeep: {
      ...normalized.chargeUpkeep,
      intervalSeconds: Math.max(1, Math.floor(intervalSeconds || 60))
    }
  };
}

export async function appliedBuffOverrideUpdates({
  targetBuff,
  sourceItemUuid = "",
  sourceItemName = "",
  appliedBuffUuid = "",
  override = {}
} = {}) {
  const normalized = normalizeAppliedBuffOverrideEntry(override);
  const updates = {};
  const runtime = appliedBuffOverrideRuntime({
    override: normalized,
    sourceItemUuid,
    sourceItemName,
    appliedBuffUuid: appliedBuffUuid || normalized.buffUuid
  });
  updates[`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${APPLIED_BUFF_RUNTIME_KEY}`] = runtime;

  if (normalized.temporaryHp.enabled) {
    const formula = normalized.temporaryHp.formula;
    const numericMax = numberOrZero(formula);
    const resolvedMax = await evaluateFormulaForItem(targetBuff, formula, numericMax);
    updates[`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.temporaryHp`] = {
      enabled: true,
      max: resolvedMax,
      formula,
      remaining: resolvedMax,
      capacity: resolvedMax,
      label: String(targetBuff?.name ?? ""),
      sourceItemUuid: String(sourceItemUuid ?? ""),
      sourceBuffUuid: "",
      stackingMode: "replaceSameSource",
      compatibilityMode: "stacksWithAll",
      createdAt: Date.now(),
      showBadge: false,
      regeneration: {
        enabled: normalized.temporaryHp.regeneration.enabled,
        formula: normalized.temporaryHp.regeneration.formula,
        timing: "turnStart"
      },
      depletion: {
        mode: normalized.temporaryHp.deactivateAtZero ? "deactivateSource" : "none",
        lockout: normalized.temporaryHp.lockout
      }
    };
  }

  if (normalized.grantedDefenses.criticalImmunity) {
    const previous = targetBuff?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.grantedDefenses ?? {};
    updates[`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.grantedDefenses`] = {
      ...foundry.utils.deepClone(previous),
      enabled: true,
      criticalImmunity: true
    };
  }

  return updates;
}
