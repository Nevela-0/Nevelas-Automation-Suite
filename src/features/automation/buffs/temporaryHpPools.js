import { MODULE } from "../../../common/module.js";
import { socket } from "../../../integration/moduleSockets.js";
import { applyBuffToTargets } from "./buffs.js";
import { refreshTokenEffectBadgesForActor } from "../utils/tokenEffectBadges.js";
import { showTemporaryHpCombatText, showTemporaryHpGainCombatText } from "../utils/healthDeltaText.js";
import { createNasId, ensureNasId } from "../utils/nasIds.js";
import { getStoredBuffCasterLevel } from "../utils/spellLevels.js";
import {
  APPLIED_BUFF_LOCKOUTS_KEY,
  APPLIED_BUFF_RUNTIME_KEY,
  appliedBuffLockoutKey
} from "./appliedBuffOverrides.js";

const REACTIVE_FLAG_KEY = "itemReactiveEffects";
const TEMP_HP_FLAG_KEY = "temporaryHp";
const TEMP_HP_STACKING_MODES = new Set(["replaceSameSource", "keepHigherSameSource", "stackSeparate"]);
const TEMP_HP_COMPATIBILITY_MODES = new Set(["stacksWithAll", "noNative", "noNas", "noAny"]);

function flagPath(path) {
  return `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${TEMP_HP_FLAG_KEY}.${path}`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function formulaOrEmpty(raw = {}) {
  const explicit = raw?.formula ?? raw?.amountFormula ?? raw?.maxFormula;
  if (explicit != null) return String(explicit).trim();
  const legacy = raw?.max ?? raw?.amount ?? raw?.value;
  return legacy != null && legacy !== "" ? String(legacy).trim() : "";
}

function positiveIntegerCandidate(value) {
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
      positiveIntegerCandidate(spellRollData?.cl),
      positiveIntegerCandidate(spell?.casterLevel),
      positiveIntegerCandidate(spell?.system?.cl)
    );
    const bookId = spell?.system?.spellbook;
    if (bookId) {
      const book = actor?.system?.attributes?.spells?.spellbooks?.[bookId];
      candidates.push(positiveIntegerCandidate(book?.cl?.total), positiveIntegerCandidate(book?.cl?.autoSpellLevelTotal));
    }
  }

  return Math.max(0, ...candidates.filter((value) => value != null));
}

function strongestActorSpellbookCasterLevel(actor) {
  const candidates = [];
  for (const book of Object.values(actor?.system?.attributes?.spells?.spellbooks ?? {})) {
    if (book?.inUse === false) continue;
    candidates.push(positiveIntegerCandidate(book?.cl?.total), positiveIntegerCandidate(book?.cl?.autoSpellLevelTotal));
  }
  return Math.max(0, ...candidates.filter((value) => value != null));
}

function temporaryHpFormulaRollData(actor, item) {
  const actorData = actor?.getRollData?.() ?? {};
  const itemRollData = item?.getRollData?.() ?? {};
  const storedBuffCl = positiveIntegerCandidate(getStoredBuffCasterLevel(item, actor));
  const itemLevel = positiveIntegerCandidate(item?.system?.level);
  const itemRollDataCl = positiveIntegerCandidate(itemRollData?.cl);
  const matchingSpellCl = matchingSpellCasterLevel(actor, item);
  const actorSpellbookCl = strongestActorSpellbookCasterLevel(actor);
  const actorDataCl = positiveIntegerCandidate(actorData?.cl);
  const cl = storedBuffCl || itemLevel || itemRollDataCl || matchingSpellCl || actorSpellbookCl || actorDataCl || 0;
  return {
    ...actorData,
    cl,
    item: {
      ...itemRollData,
      level: itemRollData?.level ?? item?.system?.level ?? itemLevel ?? 0,
      cl: itemRollData?.cl ?? cl
    }
  };
}

async function evaluateTemporaryHpFormula(item, formula, fallback = 0) {
  const text = String(formula ?? "").trim();
  if (!text) return numberOrZero(fallback);
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numberOrZero(numeric);
  try {
    const rollData = temporaryHpFormulaRollData(item?.actor, item);
    const roll = await new Roll(text, rollData).evaluate();
    return numberOrZero(roll?.total);
  } catch (_err) {
    return numberOrZero(fallback);
  }
}

function normalizeTemporaryHpStackingMode(value) {
  const mode = String(value ?? "replaceSameSource");
  return TEMP_HP_STACKING_MODES.has(mode) ? mode : "replaceSameSource";
}

function normalizeTemporaryHpCompatibilityMode(value) {
  const mode = String(value ?? "stacksWithAll");
  return TEMP_HP_COMPATIBILITY_MODES.has(mode) ? mode : "stacksWithAll";
}

function normalizeTimePeriod(value, fallback = "hour") {
  const units = String(value ?? fallback).trim();
  const periods = globalThis.CONFIG?.PF1?.timePeriods ?? {};
  if (periods[units]) return units;
  return ["round", "minute", "hour", "day"].includes(units) ? units : fallback;
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

function normalizeTemporaryHpRegeneration(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    formula: String(value.formula ?? value.amountFormula ?? "").trim(),
    timing: String(value.timing ?? "turnStart") === "turnStart" ? "turnStart" : "turnStart",
    lastCombatKey: String(value.lastCombatKey ?? "")
  };
}

function normalizeTemporaryHpDepletion(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    mode: String(value.mode ?? "none") === "deactivateSource" ? "deactivateSource" : "none",
    lockout: {
      enabled: value.lockout?.enabled === true,
      value: String(value.lockout?.value ?? "24"),
      units: normalizeTimePeriod(value.lockout?.units, "hour")
    }
  };
}

function now() {
  return Date.now();
}

function isSourceItemActive(item) {
  if (!item) return false;
  if (item.type === "buff") return item.system?.active === true;
  if (item.type === "equipment") {
    const equipped = item.system?.equipped === true;
    const quantity = Number(item.system?.quantity ?? 1);
    return equipped && quantity > 0 && item.isBroken !== true;
  }
  return true;
}

function tempHpConfig(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[TEMP_HP_FLAG_KEY] ?? {};
  return {
    enabled: isTemporaryHpRawConfigured(raw),
    poolId: String(raw?.poolId ?? `legacy-${item?.id ?? createNasId()}`),
    sourceKey: deriveTempHpSourceKey({
      sourceKey: raw?.sourceKey,
      sourceItemUuid: raw?.sourceItemUuid,
      sourceBuffUuid: raw?.sourceBuffUuid,
      item
    }),
    remaining: numberOrZero(raw?.remaining),
    max: numberOrZero(raw?.max),
    formula: formulaOrEmpty(raw),
    sourceItemUuid: String(raw?.sourceItemUuid ?? ""),
    sourceBuffUuid: String(raw?.sourceBuffUuid ?? ""),
    label: String(raw?.label ?? item?.name ?? ""),
    duration: foundry.utils.deepClone(raw?.duration ?? null),
    stackingMode: normalizeTemporaryHpStackingMode(raw?.stackingMode),
    compatibilityMode: normalizeTemporaryHpCompatibilityMode(raw?.compatibilityMode),
    regeneration: normalizeTemporaryHpRegeneration(raw?.regeneration),
    depletion: normalizeTemporaryHpDepletion(raw?.depletion),
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : 0,
    showBadge: raw?.showBadge !== false
  };
}

function isTemporaryHpRawConfigured(raw = {}) {
  return Boolean(
    raw && typeof raw === "object" && (
      String(raw.formula ?? raw.amountFormula ?? raw.maxFormula ?? "").trim()
      || Number(raw.max ?? raw.amount ?? raw.value) > 0
      || Number(raw.remaining) > 0
      || raw.regeneration?.enabled === true
      || String(raw.regeneration?.formula ?? "").trim()
      || String(raw.depletion?.mode ?? "none") !== "none"
      || raw.depletion?.lockout?.enabled === true
      || (Array.isArray(raw.pools) && raw.pools.some((pool) => pool?.enabled !== false && isTemporaryHpRawConfigured(pool)))
    )
  );
}

function deriveTempHpSourceKey({ sourceKey = "", sourceItemUuid = "", sourceBuffUuid = "", item = null } = {}) {
  const explicit = String(sourceKey ?? "").trim();
  if (explicit) return explicit;
  const itemUuid = String(sourceItemUuid ?? "").trim();
  if (itemUuid) return `item:${itemUuid}`;
  const buffUuid = String(sourceBuffUuid ?? "").trim();
  if (buffUuid) return `buff:${buffUuid}`;
  if (item?.uuid) return `buff:${item.uuid}`;
  return `pool:${createNasId()}`;
}

function normalizeTempHpPoolEntry(entry = {}, item = null) {
  return {
    enabled: entry?.enabled !== false,
    poolId: ensureNasId(entry?.poolId ?? `legacy-${item?.id ?? ""}`),
    sourceKey: deriveTempHpSourceKey({
      sourceKey: entry?.sourceKey,
      sourceItemUuid: entry?.sourceItemUuid,
      sourceBuffUuid: entry?.sourceBuffUuid,
      item
    }),
    remaining: numberOrZero(entry?.remaining),
    max: numberOrZero(entry?.max),
    formula: formulaOrEmpty(entry),
    sourceItemUuid: String(entry?.sourceItemUuid ?? ""),
    sourceBuffUuid: String(entry?.sourceBuffUuid ?? ""),
    label: String(entry?.label ?? item?.name ?? ""),
    duration: foundry.utils.deepClone(entry?.duration ?? null),
    stackingMode: normalizeTemporaryHpStackingMode(entry?.stackingMode),
    compatibilityMode: normalizeTemporaryHpCompatibilityMode(entry?.compatibilityMode),
    regeneration: normalizeTemporaryHpRegeneration(entry?.regeneration),
    depletion: normalizeTemporaryHpDepletion(entry?.depletion),
    createdAt: Number.isFinite(Number(entry?.createdAt)) ? Number(entry.createdAt) : 0,
    showBadge: entry?.showBadge !== false
  };
}

function tempHpPoolEntries(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[TEMP_HP_FLAG_KEY] ?? {};
  if (Array.isArray(raw?.pools)) {
    return raw.pools.map((pool) => normalizeTempHpPoolEntry({ ...raw, ...pool }, item));
  }
  if (!hasTemporaryHpData(item)) return [];
  return [normalizeTempHpPoolEntry(tempHpConfig(item), item)];
}

function serializeTempHpPool(pool) {
  return {
    enabled: pool?.enabled !== false,
    poolId: ensureNasId(pool?.poolId),
    sourceKey: String(pool?.sourceKey ?? ""),
    remaining: numberOrZero(pool?.remaining),
    max: numberOrZero(pool?.max),
    formula: String(pool?.formula ?? "").trim(),
    sourceItemUuid: String(pool?.sourceItemUuid ?? ""),
    sourceBuffUuid: String(pool?.sourceBuffUuid ?? ""),
    label: String(pool?.label ?? ""),
    duration: foundry.utils.deepClone(pool?.duration ?? null),
    stackingMode: normalizeTemporaryHpStackingMode(pool?.stackingMode),
    compatibilityMode: normalizeTemporaryHpCompatibilityMode(pool?.compatibilityMode),
    regeneration: normalizeTemporaryHpRegeneration(pool?.regeneration),
    depletion: normalizeTemporaryHpDepletion(pool?.depletion),
    createdAt: Number.isFinite(Number(pool?.createdAt)) ? Number(pool.createdAt) : now(),
    showBadge: pool?.showBadge !== false
  };
}

function aggregateTempHpPools(pools = []) {
  const active = pools.filter((pool) => pool?.enabled !== false);
  return {
    enabled: active.length > 0,
    remaining: active.reduce((sum, pool) => sum + numberOrZero(pool.remaining), 0),
    max: active.reduce((sum, pool) => sum + numberOrZero(pool.max), 0)
  };
}

function tempHpPoolUpdate(pools = []) {
  const serialized = pools.map((pool) => serializeTempHpPool(pool));
  const aggregate = aggregateTempHpPools(serialized);
  return {
    [flagPath("remaining")]: aggregate.remaining,
    [flagPath("max")]: aggregate.max,
    [flagPath("pools")]: serialized
  };
}

async function resolveTemporaryHpPoolEntry(item, entry = {}) {
  const normalized = normalizeTempHpPoolEntry(entry, item);
  const topLevelConfig = tempHpConfig(item);
  const effectiveFormula = topLevelConfig.formula || normalized.formula;
  const max = await evaluateTemporaryHpFormula(item, effectiveFormula, normalized.max);
  return {
    ...normalized,
    enabled: true,
    max,
    remaining: max,
    formula: effectiveFormula
  };
}

function hasTemporaryHpData(item) {
  return Boolean(item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[TEMP_HP_FLAG_KEY]);
}

function actorSourceItemByUuid(actor, uuid) {
  const target = String(uuid ?? "").trim();
  if (!actor || !target) return null;
  return actor.items?.find?.((item) => item.uuid === target || item.id === target) ?? null;
}

function actorSourceItemBySourceId(actor, sourceUuid) {
  const target = String(sourceUuid ?? "").trim();
  if (!actor || !target) return null;
  return actor.items?.find?.((item) => {
    const source =
      item.flags?.[MODULE.ID]?.sourceId
      ?? item.flags?.core?.sourceId
      ?? item._stats?.compendiumSource
      ?? "";
    return String(source) === target;
  }) ?? null;
}

async function resolveItemDocumentByUuid(uuid) {
  if (!uuid) return null;
  try {
    return await fromUuid(uuid);
  } catch (_err) {
    return null;
  }
}

function buffApplicationFromDocument(doc) {
  if (!doc) return null;
  const pack = doc.pack ?? String(doc.uuid ?? "").match(/^Compendium\.([^.]+(?:\.[^.]+)*)\.Item\./)?.[1] ?? null;
  return {
    name: doc.name,
    id: doc.id,
    pack,
    document: doc
  };
}

function actorTargetForBuffApplication(actor) {
  const token = actor?.getActiveTokens?.(true, true)?.[0] ?? actor?.getActiveTokens?.()?.[0] ?? null;
  return token ?? { actor, id: actor?.id, document: actor };
}

function temporaryHpBuffName(baseName, sourceName = "") {
  const base = String(baseName || game.i18n.localize("PF1.TempHP") || "Temporary HP").trim();
  const source = String(sourceName ?? "").trim();
  if (!source) return base;
  return `${base} (${source})`;
}

function actorSourceItemByNameAndSourceId(actor, name, sourceUuid) {
  const targetName = String(name ?? "").trim();
  const targetSource = String(sourceUuid ?? "").trim();
  if (!actor || !targetName || !targetSource) return null;
  return actor.items?.find?.((item) => {
    if (item.name !== targetName) return false;
    const source =
      item.flags?.[MODULE.ID]?.sourceId
      ?? item.flags?.core?.sourceId
      ?? item._stats?.compendiumSource
      ?? "";
    return String(source) === targetSource;
  }) ?? null;
}

async function ensureSourceItem(actor, { sourceBuffUuid = "", sourceItemUuid = "", duration = null, clearDuration = false, sourceName = "" } = {}) {
  const sourceUuid = String(sourceBuffUuid || sourceItemUuid || "").trim();
  if (!actor || !sourceUuid) return null;
  const doc = await resolveItemDocumentByUuid(sourceUuid);
  const buff = buffApplicationFromDocument(doc);
  const appliedBuffName = buff ? temporaryHpBuffName(buff.name, sourceName) : "";
  if (buff) {
    const durationForBuff = duration ?? (clearDuration ? null : undefined);
    await applyBuffToTargets({ ...buff, name: appliedBuffName }, [actorTargetForBuffApplication(actor)], durationForBuff, undefined, { silent: true });
    const applied =
      actorSourceItemByNameAndSourceId(actor, appliedBuffName, sourceUuid)
      ?? actorSourceItemByUuid(actor, sourceUuid)
      ?? actorSourceItemBySourceId(actor, sourceUuid);
    return applied;
  }

  const byUuid = actorSourceItemByUuid(actor, sourceUuid);
  if (byUuid) {
    if (byUuid.type === "buff" && byUuid.system?.active !== true) await byUuid.update({ "system.active": true }, { render: false });
    return byUuid;
  }

  const bySource = actorSourceItemBySourceId(actor, sourceUuid);
  if (bySource) {
    if (bySource.type === "buff" && bySource.system?.active !== true) await bySource.update({ "system.active": true }, { render: false });
    return bySource;
  }
  return null;
}

function poolDescriptor(item, pool = null) {
  const config = pool ? normalizeTempHpPoolEntry(pool, item) : tempHpConfig(item);
  return {
    item,
    itemUuid: item.uuid,
    itemId: item.id,
    itemName: item.name,
    poolId: config.poolId,
    sourceKey: config.sourceKey,
    remaining: config.remaining,
    max: config.max,
    formula: config.formula,
    label: config.label || item.name,
    duration: config.duration,
    stackingMode: config.stackingMode,
    compatibilityMode: config.compatibilityMode,
    regeneration: config.regeneration,
    depletion: config.depletion,
    sourceItemUuid: config.sourceItemUuid,
    sourceBuffUuid: config.sourceBuffUuid,
    createdAt: config.createdAt,
    showBadge: config.showBadge
  };
}

export function getNasTemporaryHpPools(actor) {
  const pools = [];
  for (const item of actor?.items ?? []) {
    if (!hasTemporaryHpData(item) || !isSourceItemActive(item)) continue;
    for (const config of tempHpPoolEntries(item)) {
      if (!config.enabled || config.remaining <= 0) continue;
      pools.push(poolDescriptor(item, config));
    }
  }
  return pools.sort((a, b) =>
    (a.createdAt || 0) - (b.createdAt || 0)
    || String(a.itemId).localeCompare(String(b.itemId))
    || String(a.poolId).localeCompare(String(b.poolId))
  );
}

function blocksOtherNas(pool) {
  const mode = normalizeTemporaryHpCompatibilityMode(pool?.compatibilityMode);
  return mode === "noNas" || mode === "noAny";
}

function blocksNative(pool) {
  const mode = normalizeTemporaryHpCompatibilityMode(pool?.compatibilityMode);
  return mode === "noNative" || mode === "noAny";
}

function poolsAreNasIncompatible(a, b) {
  if (!a || !b) return false;
  if (String(a.poolId) === String(b.poolId)) return false;
  return blocksOtherNas(a) || blocksOtherNas(b);
}

export function getEffectiveNasTemporaryHpPools(actor) {
  let pools = getNasTemporaryHpPools(actor);
  const native = nativeActorTempHp(actor);

  if (pools.some(blocksOtherNas)) {
    const highest = [...pools].sort((a, b) =>
      numberOrZero(b.remaining) - numberOrZero(a.remaining)
      || (a.createdAt || 0) - (b.createdAt || 0)
      || String(a.poolId).localeCompare(String(b.poolId))
    )[0];
    pools = highest ? [highest] : [];
  }

  const nativeStacking = pools.filter((pool) => !blocksNative(pool));
  const nativeBlocking = pools.filter(blocksNative);
  const nativeBlockingTotal = nativeBlocking.reduce((total, pool) => total + numberOrZero(pool.remaining), 0);
  return nativeBlockingTotal > native ? [...nativeStacking, ...nativeBlocking] : nativeStacking;
}

export function getNasTemporaryHpTotal(actor) {
  return getEffectiveNasTemporaryHpPools(actor).reduce((total, pool) => total + numberOrZero(pool.remaining), 0);
}

function getEffectiveTemporaryHpTotal(actor) {
  const native = nativeActorTempHp(actor);
  const pools = getEffectiveNasTemporaryHpPools(actor);
  const nativeStackingTotal = pools
    .filter((pool) => !blocksNative(pool))
    .reduce((total, pool) => total + numberOrZero(pool.remaining), 0);
  const nativeBlockingTotal = pools
    .filter(blocksNative)
    .reduce((total, pool) => total + numberOrZero(pool.remaining), 0);
  return native + nativeStackingTotal + Math.max(0, nativeBlockingTotal - native);
}

function getEffectiveNasTemporaryHpContribution(actor) {
  return Math.max(0, getEffectiveTemporaryHpTotal(actor) - nativeActorTempHp(actor));
}

export function actorHasNasTemporaryHp(actor) {
  return getNasTemporaryHpTotal(actor) > 0;
}

async function discardLowerIncompatibleNasPools(actor, incoming = {}) {
  if (!actor) return;
  const incomingRemaining = numberOrZero(incoming.remaining);
  if (incomingRemaining <= 0) return;
  for (const item of actor.items ?? []) {
    if (!hasTemporaryHpData(item) || !isSourceItemActive(item)) continue;
    const pools = tempHpPoolEntries(item);
    let changed = false;
    const nextPools = pools.map((pool) => {
      const samePool = item.uuid === incoming.itemUuid && pool.poolId === incoming.poolId;
      if (samePool) return pool;
      if (!poolsAreNasIncompatible(pool, incoming)) return pool;
      if (numberOrZero(pool.remaining) >= incomingRemaining) return pool;
      changed = true;
      return { ...pool, enabled: false, remaining: 0 };
    });
    if (!changed) continue;
    const activeRemaining = nextPools.some((pool) => pool.enabled !== false && numberOrZero(pool.remaining) > 0);
    const updates = tempHpPoolUpdate(nextPools);
    if (!activeRemaining && item.type === "buff") updates["system.active"] = false;
    await item.update(updates, { render: false });
  }
}

function tokenObjectForDisplay(token) {
  return token?.object ?? token?.token?.object ?? token?.token ?? token ?? null;
}

function activeTokenObjectsForActor(actor) {
  if (!actor) return [];
  const candidates = [];
  try {
    candidates.push(...(actor.getActiveTokens?.(true, false) ?? []));
  } catch (_err) {
    // Some Foundry versions do not support the second argument.
  }
  try {
    candidates.push(...(actor.getActiveTokens?.(true, true) ?? []));
  } catch (_err) {
    // Some Foundry versions do not support the second argument.
  }
  try {
    candidates.push(...(actor.getActiveTokens?.() ?? []));
  } catch (_err) {
    // Some Foundry versions do not expose active token lookup.
  }

  const objects = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const object = tokenObjectForDisplay(candidate);
    if (!object) continue;
    const key = object?.document?.uuid ?? object?.uuid ?? object?.id ?? candidate?.uuid ?? candidate?.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    objects.push(object);
  }
  return objects;
}

export function refreshNasTemporaryHpDisplay(actor) {
  if (!actor) return;
  const tokens = activeTokenObjectsForActor(actor);
  actor.sheet?.render?.(false);
  refreshTokenEffectBadgesForActor(actor);
  for (const token of tokens) token?.drawBars?.();
}

export async function grantNasTemporaryHp(actor, {
  amount = 0,
  sourceItemUuid = "",
  sourceBuffUuid = "",
  sourceKey = "",
  duration = null,
  label = "",
  showBadge = true,
  showCombatText = true,
  clearDuration = false,
  stackingMode = "replaceSameSource",
  compatibilityMode = "stacksWithAll"
} = {}) {
  const total = numberOrZero(amount);
  if (!actor || total <= 0) return null;
  const normalizedStackingMode = normalizeTemporaryHpStackingMode(stackingMode);
  const normalizedCompatibilityMode = normalizeTemporaryHpCompatibilityMode(compatibilityMode);
  const beforeEffectiveTotal = getEffectiveTemporaryHpTotal(actor);
  const native = nativeActorTempHp(actor);
  const sourceName = String(label ?? "").trim();

  if ((normalizedCompatibilityMode === "noNative" || normalizedCompatibilityMode === "noAny") && native >= total) {
    refreshNasTemporaryHpDisplay(actor);
    return {
      gainedAmount: 0,
      skipped: true,
      reason: "native-temp-hp-higher"
    };
  }

  const incompatibleNasPools = getNasTemporaryHpPools(actor).filter((pool) => {
    const incoming = { poolId: "__incoming__", compatibilityMode: normalizedCompatibilityMode };
    return poolsAreNasIncompatible(pool, incoming);
  });
  const highestIncompatibleNas = Math.max(0, ...incompatibleNasPools.map((pool) => numberOrZero(pool.remaining)));
  if (highestIncompatibleNas >= total) {
    refreshNasTemporaryHpDisplay(actor);
    return {
      gainedAmount: 0,
      skipped: true,
      reason: "nas-temp-hp-higher"
    };
  }
  if (normalizedCompatibilityMode === "noNas" || normalizedCompatibilityMode === "noAny") {
    const projectedEffectiveTotal = (normalizedCompatibilityMode === "noAny" || normalizedCompatibilityMode === "noNative")
      ? Math.max(native, total)
      : native + total;
    if (projectedEffectiveTotal <= beforeEffectiveTotal) {
      refreshNasTemporaryHpDisplay(actor);
      return {
        gainedAmount: 0,
        skipped: true,
        reason: "effective-temp-hp-not-improved"
      };
    }
  }

  const canModify = game.user?.isGM || actor.isOwner;
  if (!canModify) {
    if (!socket) return null;
    const result = await socket.executeAsGM("grantNasTemporaryHpSocket", actor.uuid, {
      amount: total,
      sourceItemUuid,
      sourceBuffUuid,
      sourceKey,
      duration,
      label,
      showBadge,
      showCombatText: false,
      clearDuration,
      stackingMode: normalizedStackingMode,
      compatibilityMode: normalizedCompatibilityMode
    });
    const gained = numberOrZero(result?.gainedAmount ?? total);
    if (result && gained > 0 && showCombatText !== false) await showTemporaryHpGainCombatText(actor, gained);
    return result;
  }

  const item = await ensureSourceItem(actor, { sourceBuffUuid, sourceItemUuid, duration, clearDuration, sourceName });
  if (!item) {
    return null;
  }
  const displayLabel = String(label || item.name || game.i18n.localize("PF1.TempShort"));
  const resolvedSourceKey = deriveTempHpSourceKey({ sourceKey, sourceItemUuid, sourceBuffUuid, item });
  const currentPools = tempHpPoolEntries(item);
  const sameSourcePools = currentPools.filter((pool) => pool.sourceKey === resolvedSourceKey);
  const existingPool = sameSourcePools
    .sort((a, b) => numberOrZero(b.remaining) - numberOrZero(a.remaining) || (a.createdAt || 0) - (b.createdAt || 0))[0];
  if (normalizedStackingMode === "keepHigherSameSource" && existingPool && numberOrZero(existingPool.remaining) >= total) {
    refreshNasTemporaryHpDisplay(actor);
    return {
      ...poolDescriptor(item, existingPool),
      gainedAmount: 0
    };
  }
  const nextPool = serializeTempHpPool({
    enabled: true,
    poolId: normalizedStackingMode === "stackSeparate" ? createNasId() : existingPool?.poolId ?? createNasId(),
    sourceKey: resolvedSourceKey,
    remaining: total,
    max: total,
    sourceItemUuid: String(sourceItemUuid ?? ""),
    sourceBuffUuid: String(sourceBuffUuid ?? ""),
    label: displayLabel,
    duration: duration ? foundry.utils.deepClone(duration) : null,
    stackingMode: normalizedStackingMode,
    compatibilityMode: normalizedCompatibilityMode,
    createdAt: now(),
    showBadge: showBadge !== false
  });
  const nextPools = normalizedStackingMode === "stackSeparate"
    ? [...currentPools, nextPool]
    : [
        ...currentPools.filter((pool) => pool.sourceKey !== resolvedSourceKey),
        nextPool
      ];
  await item.update({
    ...tempHpPoolUpdate(nextPools),
    [flagPath("poolId")]: nextPool.poolId,
    [flagPath("sourceKey")]: resolvedSourceKey,
    [flagPath("sourceItemUuid")]: String(sourceItemUuid ?? ""),
    [flagPath("sourceBuffUuid")]: String(sourceBuffUuid ?? ""),
    [flagPath("label")]: displayLabel,
    [flagPath("duration")]: duration ? foundry.utils.deepClone(duration) : null,
    [flagPath("stackingMode")]: normalizedStackingMode,
    [flagPath("compatibilityMode")]: normalizedCompatibilityMode,
    [flagPath("createdAt")]: nextPool.createdAt,
    [flagPath("showBadge")]: showBadge !== false
  }, { render: false });

  await discardLowerIncompatibleNasPools(actor, {
    poolId: nextPool.poolId,
    itemUuid: item.uuid,
    remaining: nextPool.remaining,
    compatibilityMode: nextPool.compatibilityMode
  });

  refreshNasTemporaryHpDisplay(actor);
  const gainedAmount = Math.max(0, getEffectiveTemporaryHpTotal(actor) - beforeEffectiveTotal);
  if (showCombatText !== false && gainedAmount > 0) await showTemporaryHpGainCombatText(actor, gainedAmount);
  return {
    ...poolDescriptor(item, nextPool),
    gainedAmount
  };
}

function appliedBuffSourceId(item) {
  return String(
    item?.flags?.[MODULE.ID]?.sourceId
    ?? item?.flags?.core?.sourceId
    ?? item?._stats?.compendiumSource
    ?? item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_RUNTIME_KEY]?.appliedBuffUuid
    ?? item?.uuid
    ?? ""
  );
}

async function resolveItemByUuid(uuid) {
  const target = String(uuid ?? "").trim();
  if (!target) return null;
  try {
    const doc = await fromUuid(target);
    return doc?.documentName === "Item" || doc?.constructor?.documentName === "Item" ? doc : null;
  } catch (_err) {
    return null;
  }
}

async function recordTemporaryHpLockout(poolItem, pool) {
  const depletion = normalizeTemporaryHpDepletion(pool?.depletion);
  if (depletion.lockout.enabled !== true) return;
  const seconds = timePeriodSeconds(depletion.lockout.value, depletion.lockout.units);
  if (seconds <= 0) return;
  const sourceItem = await resolveItemByUuid(pool?.sourceItemUuid) ?? poolItem;
  if (!sourceItem) return;
  const buffUuid = appliedBuffSourceId(poolItem);
  if (!buffUuid) return;
  const expiresAt = Math.floor(Number(game.time?.worldTime ?? 0) + seconds);
  const key = appliedBuffLockoutKey(buffUuid);
  await sourceItem.update({
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${APPLIED_BUFF_LOCKOUTS_KEY}.${key}`]: {
      buffUuid,
      sourceBuffName: String(poolItem?.name ?? pool?.label ?? ""),
      expiresAt,
      createdAt: Number(game.time?.worldTime ?? 0) || 0
    }
  }, { render: false });
}

async function handleTemporaryHpPoolDepleted(poolItem, pool) {
  const depletion = normalizeTemporaryHpDepletion(pool?.depletion);
  if (depletion.mode !== "deactivateSource" && depletion.lockout.enabled !== true) return;
  await recordTemporaryHpLockout(poolItem, pool);
}

function temporaryHpLockoutLabel(expiresAt) {
  const remaining = Math.max(0, Math.ceil((Number(expiresAt) - Number(game.time?.worldTime ?? 0)) / 60));
  if (remaining >= 60) {
    const hours = Math.ceil(remaining / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${remaining} minute${remaining === 1 ? "" : "s"}`;
}

async function temporaryHpLockoutStateForItem(item, config = null) {
  const current = config ?? tempHpConfig(item);
  const depletion = normalizeTemporaryHpDepletion(current?.depletion);
  if (depletion.lockout.enabled !== true) return null;
  const sourceItem = await resolveItemByUuid(current?.sourceItemUuid) ?? item;
  if (!sourceItem) return null;
  const buffUuid = appliedBuffSourceId(item);
  if (!buffUuid) return null;
  const key = appliedBuffLockoutKey(buffUuid);
  const lockout = sourceItem.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_LOCKOUTS_KEY]?.[key] ?? null;
  const expiresAt = Number(lockout?.expiresAt);
  const nowSeconds = Number(game.time?.worldTime ?? 0) || 0;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSeconds) return null;
  return { sourceItem, expiresAt, lockout };
}

async function blockTemporaryHpReactivationForLockout(item, config = null) {
  const state = await temporaryHpLockoutStateForItem(item, config);
  if (!state) return false;
  const pools = tempHpPoolEntries(item).map((pool) => ({
    ...pool,
    enabled: false,
    remaining: 0
  }));
  const updates = pools.length ? tempHpPoolUpdate(pools) : {};
  if (item?.type === "buff" && item.system?.active === true) updates["system.active"] = false;
  if (Object.keys(updates).length) await item.update(updates, { render: false });
  refreshNasTemporaryHpDisplay(item?.actor);
  ui.notifications?.warn?.(game.i18n.format("NAS.reactive.appliedBuffLockoutActive", {
    item: state.sourceItem?.name ?? item?.name ?? "",
    remaining: temporaryHpLockoutLabel(state.expiresAt)
  }));
  return true;
}

export async function spendNasTemporaryHp(actor, damageAmount = 0, options = {}) {
  const incoming = numberOrZero(damageAmount);
  if (!actor || incoming <= 0) {
    return { remainingDamage: incoming, spentPools: [], changed: false };
  }

  const canModify = game.user?.isGM || actor.isOwner;
  if (!canModify) {
    if (!socket) return { remainingDamage: incoming, spentPools: [], changed: false };
    const result = await socket.executeAsGM("spendNasTemporaryHpSocket", actor.uuid, incoming, options ?? {});
    const spent = (result?.spentPools ?? []).reduce((sum, pool) => sum + numberOrZero(pool?.spent), 0);
    if (spent > 0 && options?._nasTemporaryHpCombatText !== false) {
      const shown = await showTemporaryHpCombatText(actor, spent);
    }
    return result;
  }

  let remainingDamage = incoming;
  const spentPools = [];
  for (const pool of getEffectiveNasTemporaryHpPools(actor)) {
    if (remainingDamage <= 0) break;
    const spend = Math.min(remainingDamage, numberOrZero(pool.remaining));
    if (spend <= 0) continue;
    const nextRemaining = numberOrZero(pool.remaining) - spend;
    if (nextRemaining <= 0) {
      await handleTemporaryHpPoolDepleted(pool.item, pool);
    }
    const itemPools = tempHpPoolEntries(pool.item).map((entry) => entry.poolId === pool.poolId
      ? { ...entry, remaining: nextRemaining, enabled: nextRemaining > 0 }
      : entry
    );
    const activeRemaining = itemPools.some((entry) => entry.enabled !== false && numberOrZero(entry.remaining) > 0);
    const updates = tempHpPoolUpdate(itemPools);
    if (!activeRemaining && pool.item?.type === "buff") updates["system.active"] = false;
    await pool.item.update(updates, { render: false });
    spentPools.push({
      itemUuid: pool.itemUuid,
      itemName: pool.itemName,
      poolId: pool.poolId,
      sourceKey: pool.sourceKey,
      label: pool.label,
      spent: spend,
      remaining: nextRemaining
    });
    remainingDamage -= spend;
  }

  if (spentPools.length) {
    refreshNasTemporaryHpDisplay(actor);
    const spent = spentPools.reduce((sum, pool) => sum + numberOrZero(pool?.spent), 0);
    if (spent > 0 && options?._nasTemporaryHpCombatText !== false) {
      const shown = await showTemporaryHpCombatText(actor, spent);
    }
  }
  return {
    remainingDamage,
    spentPools,
    changed: spentPools.length > 0
  };
}

async function regenerateTemporaryHpForActorTurn(actor, combat) {
  if (!game.user?.isGM || !actor || !combat) return;
  const combatKey = `${combat.id ?? "combat"}:${combat.round ?? 0}:${combat.turn ?? 0}`;
  let refreshed = false;
  for (const item of actor.items ?? []) {
    if (!hasTemporaryHpData(item) || !isSourceItemActive(item)) continue;
    const pools = tempHpPoolEntries(item);
    let changed = false;
    const nextPools = [];
    for (const pool of pools) {
      const regen = normalizeTemporaryHpRegeneration(pool.regeneration);
      if (pool.enabled === false || regen.enabled !== true || regen.timing !== "turnStart") {
        nextPools.push(pool);
        continue;
      }
      if (regen.lastCombatKey === combatKey) {
        nextPools.push(pool);
        continue;
      }
      const max = numberOrZero(pool.max);
      const current = numberOrZero(pool.remaining);
      const amount = current > 0 && max > current
        ? await evaluateTemporaryHpFormula(item, regen.formula, 0)
        : 0;
      const remaining = amount > 0 ? Math.min(max, current + amount) : current;
      nextPools.push({
        ...pool,
        remaining,
        enabled: remaining > 0,
        regeneration: {
          ...regen,
          lastCombatKey: combatKey
        }
      });
      changed = true;
    }
    if (!changed) continue;
    await item.update(tempHpPoolUpdate(nextPools), { render: false });
    refreshed = true;
  }
  if (refreshed) refreshNasTemporaryHpDisplay(actor);
}

function activeBuffRuntime(item) {
  if (item?.type !== "buff" || item.system?.active !== true) return null;
  const runtime = item.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_RUNTIME_KEY];
  if (!runtime || typeof runtime !== "object") return null;
  if (runtime.chargeUpkeep?.enabled !== true) return null;
  return runtime;
}

async function deactivateBuffForUnpaidUpkeep(item, sourceItem = null) {
  await item.update({ "system.active": false }, { render: false });
  refreshNasTemporaryHpDisplay(item.actor);
  ui.notifications?.warn?.(game.i18n.format("NAS.reactive.appliedBuffUpkeepFailed", {
    buff: item.name,
    item: sourceItem?.name ?? item.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[APPLIED_BUFF_RUNTIME_KEY]?.sourceItemName ?? ""
  }));
}

async function processTemporaryHpChargeUpkeep(nowSeconds = Number(game.time?.worldTime ?? 0) || 0) {
  if (!game.user?.isGM) return;
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) {
      const runtime = activeBuffRuntime(item);
      if (!runtime) continue;
      const upkeep = runtime.chargeUpkeep ?? {};
      const interval = Math.max(1, Math.floor(Number(upkeep.intervalSeconds) || timePeriodSeconds(upkeep.intervalValue, upkeep.intervalUnits) || 60));
      const last = Number.isFinite(Number(runtime.lastUpkeepWorldTime))
        ? Number(runtime.lastUpkeepWorldTime)
        : Number(runtime.startedAtWorldTime ?? nowSeconds);
      const chunks = Math.floor((nowSeconds - last) / interval);
      if (chunks <= 0) continue;

      const sourceItem = await resolveItemByUuid(runtime.sourceItemUuid);
      if (!sourceItem) {
        await deactivateBuffForUnpaidUpkeep(item, null);
        continue;
      }
      const costEach = await evaluateTemporaryHpFormula(sourceItem, upkeep.costFormula, 1);
      const totalCost = Math.max(0, Math.floor(costEach)) * chunks;
      const nextLast = last + (chunks * interval);
      if (totalCost <= 0) {
        await item.update({
          [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${APPLIED_BUFF_RUNTIME_KEY}.lastUpkeepWorldTime`]: nextLast
        }, { render: false });
        continue;
      }
      const uses = sourceItem.system?.uses;
      const remaining = Number(uses?.value);
      if (!uses || !Number.isFinite(remaining) || remaining < totalCost) {
        if (uses && Number.isFinite(remaining) && remaining > 0) {
          const affordableChunks = Math.min(chunks, Math.floor(remaining / Math.max(1, Math.floor(costEach))));
          if (affordableChunks > 0) {
            await sourceItem.update({
              "system.uses.value": Math.max(0, remaining - (affordableChunks * Math.max(1, Math.floor(costEach))))
            }, { render: false });
          }
        }
        await item.update({
          [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${APPLIED_BUFF_RUNTIME_KEY}.lastUpkeepWorldTime`]: nextLast
        }, { render: false });
        await deactivateBuffForUnpaidUpkeep(item, sourceItem);
        continue;
      }
      await sourceItem.update({ "system.uses.value": Math.max(0, remaining - totalCost) }, { render: false });
      await item.update({
        [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${APPLIED_BUFF_RUNTIME_KEY}.lastUpkeepWorldTime`]: nextLast
      }, { render: false });
    }
  }
}

function actorFromCombatant(combatant) {
  return combatant?.actor ?? combatant?.token?.actor ?? combatant?.token?.object?.actor ?? null;
}

export async function initializeNasTemporaryHpItem(item) {
  if (!item || !hasTemporaryHpData(item)) {
    return false;
  }
  const config = tempHpConfig(item);
  if (!config.enabled) {
    return false;
  }
  if (!isSourceItemActive(item)) {
    refreshNasTemporaryHpDisplay(item.actor);
    return false;
  }
  if (await blockTemporaryHpReactivationForLockout(item, config)) {
    return false;
  }
  if (config.remaining > 0) {
    refreshNasTemporaryHpDisplay(item.actor);
    return false;
  }
  const resolvedMax = await evaluateTemporaryHpFormula(item, config.formula, config.max);
  if (resolvedMax <= 0) {
    return false;
  }
  const pools = tempHpPoolEntries(item);
  const nextPools = pools.length
    ? await Promise.all(pools.map((pool) => resolveTemporaryHpPoolEntry(item, pool)))
    : [{ ...config, enabled: true, max: resolvedMax, remaining: resolvedMax }];
  await item.update(tempHpPoolUpdate(nextPools), { render: false });
  refreshNasTemporaryHpDisplay(item.actor);
  return true;
}

export async function resetNasTemporaryHpItem(item) {
  if (!item || !hasTemporaryHpData(item)) return false;
  const config = tempHpConfig(item);
  if (!config.enabled || !isSourceItemActive(item)) {
    refreshNasTemporaryHpDisplay(item?.actor);
    return false;
  }
  if (await blockTemporaryHpReactivationForLockout(item, config)) {
    return false;
  }
  const resolvedMax = await evaluateTemporaryHpFormula(item, config.formula, config.max);
  if (resolvedMax <= 0) {
    refreshNasTemporaryHpDisplay(item?.actor);
    return false;
  }
  const pools = tempHpPoolEntries(item);
  const nextPools = pools.length
    ? await Promise.all(pools.map((pool) => resolveTemporaryHpPoolEntry(item, pool)))
    : [{ ...config, enabled: true, max: resolvedMax, remaining: resolvedMax }];
  await item.update(tempHpPoolUpdate(nextPools), { render: false });
  refreshNasTemporaryHpDisplay(item.actor);
  return true;
}

export function hpBarDataWithNasTemporaryHp(token, data) {
  if (data?.attribute !== "attributes.hp") return data;
  const effectiveTemp = getEffectiveTemporaryHpTotal(token?.actor);
  const nativeDataTemp = numberOrZero(data?.temp);
  if (effectiveTemp <= nativeDataTemp) return data;
  const cloned = foundry.utils.deepClone(data);
  cloned.temp = effectiveTemp;
  cloned._nasTemporaryHpIncluded = true;
  cloned.value = Number(cloned.value) || 0;
  cloned.max = Number(cloned.max) || 0;
  return cloned;
}

function htmlRootFromRenderArg(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.jquery) return html[0];
  if (Array.isArray(html)) return html[0];
  return html?.[0] ?? html ?? null;
}

function nativeActorTempHp(actor) {
  return numberOrZero(actor?.system?.attributes?.hp?.temp);
}

function nativeTempHpSheetValue(actor) {
  const native = nativeActorTempHp(actor);
  return native > 0 ? String(native) : "";
}

function totalTempHpSheetValue(actor) {
  const total = getEffectiveTemporaryHpTotal(actor);
  return total > 0 ? String(total) : "";
}

function setSheetFieldValue(input, value) {
  if (!input) return;
  const text = String(value ?? "");
  input.textContent = text;
  if ("value" in input) input.value = text;
}

function setTempHpSheetDisplay(input, actor) {
  if (!input) {
    return;
  }
  if (document.activeElement === input) {
    return;
  }
  input.dataset.nasNativeTempHp = nativeTempHpSheetValue(actor);
  input.dataset.nasTemporaryHpTotal = String(getNasTemporaryHpTotal(actor));
  input.dataset.nasTemporaryHpDisplayMode = "total";
  setSheetFieldValue(input, totalTempHpSheetValue(actor));
}

function setTempHpSheetNativeEditValue(input, actor) {
  if (!input) return;
  input.dataset.nasNativeTempHp = nativeTempHpSheetValue(actor);
  input.dataset.nasTemporaryHpTotal = String(getNasTemporaryHpTotal(actor));
  input.dataset.nasTemporaryHpDisplayMode = "native";
  setSheetFieldValue(input, nativeTempHpSheetValue(actor));
}

function renderTemporaryHpSheetDisplay(app, html, hookContext = {}) {
  const actor = app?.actor ?? app?.document;
  if (!actor) {
    return;
  }
  const root = htmlRootFromRenderArg(html);
  const input = root?.querySelector?.('.hp-temp-input[name="system.attributes.hp.temp"]');
  if (!input) {
    return;
  }
  setTempHpSheetDisplay(input, actor);
  if (input.dataset.nasTemporaryHpListeners === "true") return;
  input.dataset.nasTemporaryHpListeners = "true";
  const showNative = (event) => {
    setTempHpSheetNativeEditValue(input, actor);
  };
  const showTotal = (event) => {
    queueMicrotask(() => {
      setTempHpSheetDisplay(input, actor);
    });
  };
  input.addEventListener("pointerdown", showNative, { capture: true });
  input.addEventListener("focusin", showNative);
  input.addEventListener("blur", showTotal);
  input.addEventListener("focusout", showTotal);
}

let tempHpSheetDocumentListenersRegistered = false;

function actorFromTempHpInput(input) {
  const appId = Number(input?.closest?.("[data-appid]")?.dataset?.appid);
  const app = Number.isFinite(appId) ? ui.windows?.[appId] : null;
  const actor = app?.actor ?? app?.document ?? null;
  return actor?.documentName === "Actor" || actor?.type ? actor : null;
}

function restoreTempHpSheetDisplayFromEventTarget(target) {
  const input = target?.closest?.('.hp-temp-input[name="system.attributes.hp.temp"]');
  if (!input) return;
  const actor = actorFromTempHpInput(input);
  const appRoot = input.closest?.("[data-appid]");
  const appId = appRoot?.dataset?.appid;
  globalThis.setTimeout?.(() => {
    const root = appId ? document.querySelector(`[data-appid="${CSS.escape(appId)}"]`) : appRoot;
    const currentInput = root?.querySelector?.('.hp-temp-input[name="system.attributes.hp.temp"]') ?? input;
    if (document.activeElement !== currentInput) setTempHpSheetDisplay(currentInput, actor);
  }, 0);
}

function registerTemporaryHpSheetDocumentListeners() {
  if (tempHpSheetDocumentListenersRegistered) return;
  tempHpSheetDocumentListenersRegistered = true;
  const handler = (event) => {
    const input = event.target?.closest?.('.hp-temp-input[name="system.attributes.hp.temp"]');
    if (!input) return;
    const actor = actorFromTempHpInput(input);
    if (event.type === "pointerdown" || event.type === "focusin") {
      setTempHpSheetNativeEditValue(input, actor);
    } else if (event.type === "blur" || event.type === "focusout") {
      restoreTempHpSheetDisplayFromEventTarget(event.target);
    }
  };
  for (const eventName of ["pointerdown", "focusin", "blur", "focusout", "input", "change"]) {
    document.addEventListener(eventName, handler, true);
  }
}

let tooltipObserverRegistered = false;

function tooltipActor() {
  const element = game.tooltip?.element;
  if (!element) return null;
  const appIds = [];
  for (const node of [element, ...Array.from(element.parents?.() ?? [])]) {
    for (const value of [
      node?.dataset?.appid,
      node?.dataset?.appId,
      node?.closest?.("[data-appid]")?.dataset?.appid,
      node?.closest?.("[data-app-id]")?.dataset?.appId,
      String(node?.id ?? "").replace(/^app-/, "")
    ]) {
      const appId = Number(value);
      if (Number.isFinite(appId) && !appIds.includes(appId)) appIds.push(appId);
    }
  }
  for (const appId of appIds) {
    const app = ui.windows?.[appId];
    const actor = app?.actor ?? app?.document;
    if (actor?.type) return actor;
  }

  const actorId = element.closest?.("[data-actor-id]")?.dataset?.actorId
    ?? element.closest?.("[data-document-id]")?.dataset?.documentId;
  if (actorId) {
    const actor = game.actors?.get?.(actorId);
    if (actor) return actor;
  }

  const title = element.closest?.(".app")?.querySelector?.(".window-title")?.textContent?.trim()
    ?? element.closest?.("[data-appid]")?.querySelector?.(".window-title")?.textContent?.trim();
  if (title) {
    const actor = game.actors?.find?.((candidate) => candidate.name === title);
    if (actor) return actor;
  }

  return null;
}

function tooltipHasHpBreakdown(tooltip) {
  return Array.from(tooltip?.querySelectorAll?.(".path") ?? [])
    .some((el) => (el.textContent ?? "").trim() === "@attributes.hp.temp");
}

function insertAfter(reference, ...nodes) {
  let after = reference;
  for (const node of nodes) {
    after?.parentElement?.insertBefore(node, after.nextSibling);
    after = node;
  }
}

function appendNasTemporaryHpTooltip() {
  const tooltip = game.tooltip?.tooltip ?? document.getElementById("tooltip");
  if (!tooltip) {
    return;
  }
  const alreadyEnhanced = Array.from(tooltip.querySelectorAll(".path"))
    .some((el) => (el.textContent ?? "").trim() === "NAS temporary HP");
  if (alreadyEnhanced) {
    tooltip.dataset.nasTemporaryHpEnhanced = "true";
    return;
  }
  delete tooltip.dataset.nasTemporaryHpEnhanced;
  const paths = Array.from(tooltip.querySelectorAll(".path")).map((el) => (el.textContent ?? "").trim());
  const hasHpBreakdown = tooltipHasHpBreakdown(tooltip);
  const activeElement = game.tooltip?.element;
  if (!hasHpBreakdown) {
    return;
  }
  const actor = tooltipActor();
  const nasTotal = getNasTemporaryHpTotal(actor);
  if (nasTotal <= 0) {
    return;
  }

  const tempPath = Array.from(tooltip.querySelectorAll(".path"))
    .find((el) => (el.textContent ?? "").trim() === "@attributes.hp.temp");
  const tempValue = tempPath?.nextElementSibling;
  if (tempPath && tempValue?.classList?.contains("value")) {
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = "NAS temporary HP";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = `+${nasTotal}`;
    insertAfter(tempValue, path, value);
  }

  const fromSources = Array.from(tooltip.querySelectorAll("h4"))
    .find((el) => (el.textContent ?? "").trim().toLowerCase() === "from sources");
  if (fromSources) {
    for (const pool of getNasTemporaryHpPools(actor)) {
      const flavor = document.createElement("span");
      flavor.className = "flavor";
      flavor.textContent = pool.label || pool.itemName || "NAS Temporary HP";
      const value = document.createElement("span");
      value.className = "value untyped";
      value.textContent = `+${pool.remaining}`;
      fromSources.parentElement?.append(flavor, value);
    }
  }

  tooltip.dataset.nasTemporaryHpEnhanced = "true";
}

function registerNasTemporaryHpTooltipEnhancer() {
  if (tooltipObserverRegistered) return;
  const tooltip = game.tooltip?.tooltip ?? document.getElementById("tooltip");
  if (!tooltip) {
    return;
  }
  const observer = new MutationObserver(() => {
    queueMicrotask(appendNasTemporaryHpTooltip);
  });
  observer.observe(tooltip, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });
  tooltipObserverRegistered = true;
}

export function registerNasTemporaryHpPools() {

  registerNasTemporaryHpTooltipEnhancer();
  for (const hookName of ["renderActorSheet", "renderActorSheetPF", "renderActorSheetPFCharacter", "renderActorSheetPFNPC"]) {
    Hooks.on(hookName, (app, html, data) => renderTemporaryHpSheetDisplay(app, html, {
      hookName,
      dataKeys: data && typeof data === "object" ? Object.keys(data).sort() : []
    }));
  }
  registerTemporaryHpSheetDocumentListeners();
  Hooks.on("updateWorldTime", (worldTime, dt) => {
    if (!game.user?.isGM || Number(dt) <= 0) return;
    void processTemporaryHpChargeUpkeep(Number(worldTime) || Number(game.time?.worldTime ?? 0) || 0);
  });
  Hooks.on("updateCombat", (combat, update, options) => {
    if (!game.user?.isGM) return;
    const hasTurnOrRound = update?.turn !== undefined || update?.round !== undefined;
    if (!hasTurnOrRound || options?.direction === -1) return;
    const actor = actorFromCombatant(combat?.combatant);
    void regenerateTemporaryHpForActorTurn(actor, combat);
    void processTemporaryHpChargeUpkeep(Number(game.time?.worldTime ?? 0) || 0);
  });
  Hooks.on("updateItem", async (item, change) => {
    if (!hasTemporaryHpData(item)) {
      return;
    }
    const activeChanged = foundry.utils.hasProperty(change, "system.active");
    const equippedChanged = foundry.utils.hasProperty(change, "system.equipped");
    const tempHpFlagRoot = `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${TEMP_HP_FLAG_KEY}`;
    const tempHpFormulaChanged = foundry.utils.hasProperty(change, `${tempHpFlagRoot}.formula`);
    const tempHpEnabledChanged = foundry.utils.hasProperty(change, `${tempHpFlagRoot}.enabled`);
    if (foundry.utils.getProperty(change, "system.active") === true || foundry.utils.getProperty(change, "system.equipped") === true) {
      await resetNasTemporaryHpItem(item);
      return;
    }
    if (
      isSourceItemActive(item)
      && (
        tempHpFormulaChanged
        || (tempHpEnabledChanged && foundry.utils.getProperty(change, `${tempHpFlagRoot}.enabled`) === true && tempHpConfig(item).remaining <= 0)
      )
    ) {
      await resetNasTemporaryHpItem(item);
      return;
    }
    if (activeChanged || equippedChanged) {
      refreshNasTemporaryHpDisplay(item.actor);
      return;
    }
    refreshNasTemporaryHpDisplay(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (!hasTemporaryHpData(item)) return;
    refreshNasTemporaryHpDisplay(item.actor);
  });
}
