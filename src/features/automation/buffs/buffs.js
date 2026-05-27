
import { MODULE } from '../../../common/module.js';
import { socket } from '../../../integration/moduleSockets.js';
import { tokenCanSeeToken } from '../utils/tokenVisibility.js';
import { createNasId } from '../utils/nasIds.js';
import { getRuntimeCasterLevel, getRuntimeSpellLevel } from '../utils/spellLevels.js';
import {
  configureKnownBuffAutomation,
  getKnownBuffApplicationName,
  isKnownEnergyTypePlaceholderBuff,
  KNOWN_BUFF_AUTOMATION_OPTION,
  promptKnownBuffAutomationForAction
} from './knownBuffAutomation.js';
import {
  APPLIED_BUFF_OVERRIDE_OPTION,
  APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION,
  APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION,
  APPLIED_BUFF_TARGET_UUID_OPTION,
  appliedBuffOverrideOptionsFor,
  appliedBuffOverrideUpdates,
  getAppliedBuffLockoutState,
  primaryAppliedBuffUuid
} from './appliedBuffOverrides.js';

const BUFF_SAVE_ACTION_SHEET_KEY = "buffSaveByAction";
const PENDING_BUFF_AUTOMATION_KEY = "pendingBuffAutomation";
const SAVE_HANDLING_MODES = new Set(["ignore", "failed", "successful"]);
const SAVE_ALLY_BYPASS_MODES = new Set(["setting", "enabled", "disabled"]);
const REAL_SAVE_TYPES = new Set(["fort", "ref", "will"]);
const PROCESSING_SAVE_GATED_MESSAGES = new Set();
const REACTIVE_FLAG_KEY = "itemReactiveEffects";
const NON_CONSECUTIVE_DURATION_FLAG_KEY = "nonConsecutiveDurations";
const ACTION_BUFF_AUTOMATION_FLAG_KEY = "buffAutomationByAction";
const LEGACY_BUFF_AUTOMATION_WARNINGS = new Set();

export const NON_CONSECUTIVE_DURATION_OPTION = "_nasNonConsecutiveDuration";
const NON_CONSECUTIVE_SUPPORTED_UNITS = new Set([
  "second",
  "seconds",
  "sec",
  "round",
  "rounds",
  "turn",
  "turns",
  "minute",
  "minutes",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years"
]);

function getNonConsecutiveModuleFlags(item) {
  return item?.getFlag?.(MODULE.ID, REACTIVE_FLAG_KEY) ?? item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY] ?? {};
}

function getNonConsecutiveRoot(item) {
  const raw = getNonConsecutiveModuleFlags(item)?.[NON_CONSECUTIVE_DURATION_FLAG_KEY];
  return raw && typeof raw === "object" ? foundry.utils.deepClone(raw) : {};
}

function normalizeNonConsecutiveActionId(value) {
  return String(value ?? "").trim();
}

function normalizeNonConsecutiveUnits(value) {
  const units = String(value ?? "").trim();
  return NON_CONSECUTIVE_SUPPORTED_UNITS.has(units) ? units : "";
}

function nonConsecutiveActionIdFromAction(action) {
  return normalizeNonConsecutiveActionId(action?.action?.id ?? action?.id ?? action?._id ?? action?.action?._id);
}

function nonConsecutiveActionIdFromSheetAction(action) {
  return normalizeNonConsecutiveActionId(action?.id ?? action?._id ?? action?.action?.id ?? action?.action?._id);
}

function getNonConsecutiveActionState(root, actionId) {
  const actions = root?.actions && typeof root.actions === "object" ? root.actions : {};
  const state = actions[actionId];
  return state && typeof state === "object" ? state : null;
}

function isNonConsecutiveState(state) {
  return state?.consecutive === false;
}

function nonConsecutiveRoundTime() {
  const value = Number(CONFIG?.time?.roundTime ?? 6);
  return Number.isFinite(value) && value > 0 ? value : 6;
}

function nonConsecutiveUnitSeconds(units) {
  switch (normalizeNonConsecutiveUnits(units).toLowerCase()) {
    case "second":
    case "seconds":
    case "sec":
      return 1;
    case "round":
    case "rounds":
    case "turn":
    case "turns":
      return nonConsecutiveRoundTime();
    case "minute":
    case "minutes":
      return 60;
    case "hour":
    case "hours":
      return 3600;
    case "day":
    case "days":
      return 86400;
    case "week":
    case "weeks":
      return 604800;
    case "month":
    case "months":
      return 2592000;
    case "year":
    case "years":
      return 31536000;
    default:
      return 0;
  }
}

function nonConsecutiveNumericDurationValue(units, value) {
  const normalizedUnits = normalizeNonConsecutiveUnits(units);
  if (!normalizedUnits) return 0;
  if (normalizedUnits === "turn" || normalizedUnits === "turns") return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nonConsecutiveTimeNow() {
  const now = Number(game?.time?.worldTime ?? 0);
  return Number.isFinite(now) ? now : 0;
}

function nonConsecutiveActorName(actor) {
  return String(actor?.name ?? game.i18n.localize("NAS.common.unknownActor") ?? "actor");
}

function localizeNonConsecutiveBuff(path, data = null) {
  const key = `NAS.buffs.${path}`;
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

function normalizeNonConsecutiveDurationForOption(duration = {}) {
  const units = normalizeNonConsecutiveUnits(duration?.units ?? duration?.sourceUnits);
  const capacity = nonConsecutiveNumericDurationValue(units, duration?.value);
  return {
    units,
    capacity,
    unitSeconds: nonConsecutiveUnitSeconds(units)
  };
}

function nonConsecutiveStateMatchesDuration(state, duration) {
  if (!state) return false;
  return (
    normalizeNonConsecutiveUnits(state.units) === duration.units
    && Number(state.capacity) === duration.capacity
    && Number(state.unitSeconds) === duration.unitSeconds
  );
}

function currentNonConsecutiveRemaining(state, duration) {
  if (!nonConsecutiveStateMatchesDuration(state, duration)) return duration.capacity;
  const remaining = Number(state.remaining);
  if (!Number.isFinite(remaining)) return duration.capacity;
  return Math.max(0, Math.min(duration.capacity, remaining));
}

function nonConsecutiveOptionDuration(option) {
  const units = normalizeNonConsecutiveUnits(option?.units);
  const value = nonConsecutiveNumericDurationValue(units, option?.remaining);
  if (!units || value <= 0) return null;
  return {
    units,
    value: String(value)
  };
}

function serializeNonConsecutiveOption(option) {
  if (!option || typeof option !== "object" || option.enabled !== true) return null;
  return {
    enabled: true,
    sourceItemUuid: String(option.sourceItemUuid ?? ""),
    sourceItemName: String(option.sourceItemName ?? ""),
    actionId: normalizeNonConsecutiveActionId(option.actionId),
    actionName: String(option.actionName ?? ""),
    sessionId: String(option.sessionId ?? createNasId()),
    units: normalizeNonConsecutiveUnits(option.units),
    capacity: Number(option.capacity) || 0,
    remaining: Number(option.remaining) || 0,
    unitSeconds: Number(option.unitSeconds) || 0,
    startedAtWorldTime: Number(option.startedAtWorldTime) || nonConsecutiveTimeNow()
  };
}

function normalizeNonConsecutiveOption(options = {}) {
  const raw = options?.[NON_CONSECUTIVE_DURATION_OPTION] ?? options;
  const serialized = serializeNonConsecutiveOption(raw);
  if (!serialized?.sourceItemUuid || !serialized.actionId || !serialized.units) return null;
  if (serialized.capacity <= 0 || serialized.remaining <= 0 || serialized.unitSeconds <= 0) return null;
  return serialized;
}

async function updateNonConsecutiveSourceRoot(sourceItem, mutator) {
  if (!sourceItem?.update) return null;
  const root = getNonConsecutiveRoot(sourceItem);
  root.actions = root.actions && typeof root.actions === "object" ? root.actions : {};
  mutator(root);
  await sourceItem.update({ [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${NON_CONSECUTIVE_DURATION_FLAG_KEY}`]: root });
  return root;
}

function normalizeNonConsecutiveSession(session = {}) {
  const activeBuffs = session.activeBuffs && typeof session.activeBuffs === "object" ? session.activeBuffs : {};
  return {
    id: String(session.id ?? ""),
    startedAtWorldTime: Number(session.startedAtWorldTime) || nonConsecutiveTimeNow(),
    unitSeconds: Number(session.unitSeconds) || nonConsecutiveRoundTime(),
    activeBuffs: { ...activeBuffs }
  };
}

async function nonConsecutiveSourceItemFromOption(option) {
  if (!option?.sourceItemUuid || typeof fromUuid !== "function") return null;
  try {
    return await fromUuid(option.sourceItemUuid);
  } catch (_error) {
    return null;
  }
}

async function nonConsecutiveSourceItemFromFlag(flag) {
  if (!flag?.sourceItemUuid || typeof fromUuid !== "function") return null;
  try {
    return await fromUuid(flag.sourceItemUuid);
  } catch (_error) {
    return null;
  }
}

function nonConsecutiveTrackingFlag(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.[NON_CONSECUTIVE_DURATION_FLAG_KEY];
  return raw?.appliedBuff && typeof raw.appliedBuff === "object" ? raw.appliedBuff : null;
}

function nonConsecutiveTrackingFlagPath(path = "") {
  return `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${NON_CONSECUTIVE_DURATION_FLAG_KEY}.appliedBuff${path ? `.${path}` : ""}`;
}

function nonConsecutiveActionFlagPath(actionId, path = "") {
  return `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${NON_CONSECUTIVE_DURATION_FLAG_KEY}.actions.${actionId}${path ? `.${path}` : ""}`;
}

function updateChangedPath(changed, path) {
  if (!changed || typeof changed !== "object") return false;
  return Object.prototype.hasOwnProperty.call(changed, path)
    || foundry.utils.hasProperty(changed, path);
}

function nonConsecutiveActiveBuffKey(item) {
  return String(item?.uuid ?? item?.id ?? "").trim().replaceAll(".", "%2E");
}

function nonConsecutiveActiveBuffMeta(item) {
  return {
    actorUuid: item?.actor?.uuid ?? "",
    actorName: nonConsecutiveActorName(item?.actor),
    buffUuid: item?.uuid ?? "",
    buffId: item?.id ?? "",
    buffName: item?.name ?? ""
  };
}

export function actionCanUseNonConsecutiveDuration(action) {
  const units = normalizeNonConsecutiveUnits(action?.duration?.units);
  if (!units) return false;
  if (units === "turn" || units === "turns") return true;
  return String(action?.duration?.value ?? "").trim().length > 0;
}

export function getActionConsecutiveState(item, action) {
  const actionId = nonConsecutiveActionIdFromSheetAction(action);
  if (!item || !actionId) return { actionId, consecutive: true, enabled: false };
  const state = getNonConsecutiveActionState(getNonConsecutiveRoot(item), actionId);
  return {
    actionId,
    consecutive: !isNonConsecutiveState(state),
    enabled: isNonConsecutiveState(state),
    state
  };
}

export async function setActionConsecutiveState(item, action, consecutive) {
  const actionId = nonConsecutiveActionIdFromSheetAction(action);
  if (!item?.update || !actionId) return;
  if (consecutive !== false) {
    await item.update({ [nonConsecutiveActionFlagPath(`-=${actionId}`)]: null });
    return;
  }
  await updateNonConsecutiveSourceRoot(item, (root) => {
    root.actions[actionId] = {
      ...(root.actions[actionId] ?? {}),
      consecutive: false
    };
  });
}

export function getActionNonConsecutiveDurationState(item, action) {
  const state = getActionConsecutiveState(item, action);
  return {
    ...state,
    nonConsecutive: state.enabled === true,
    enabled: state.enabled === true
  };
}

export async function setActionNonConsecutiveDurationState(item, action, enabled) {
  await setActionConsecutiveState(item, action, enabled === true ? false : true);
}

function actionBuffAutomationFlagPath(actionId, path = "") {
  return `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${ACTION_BUFF_AUTOMATION_FLAG_KEY}.${actionId}${path ? `.${path}` : ""}`;
}

function getActionBuffAutomationRoot(item) {
  const raw = getNonConsecutiveModuleFlags(item)?.[ACTION_BUFF_AUTOMATION_FLAG_KEY];
  return raw && typeof raw === "object" ? foundry.utils.deepClone(raw) : {};
}

function normalizeActionBuffAutomationConfig(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const hasEnabled = Object.prototype.hasOwnProperty.call(raw, "enabled");
  const buffUuid = String(raw.buffUuid ?? raw.selectedBuffUuid ?? "").trim();
  if (!hasEnabled && !buffUuid) return null;
  return {
    enabled: raw.enabled === true,
    buffUuid
  };
}

function actionBuffAutomationLegacyState(item) {
  const itemType = item?.type;
  const itemSubType = item?.subType;
  const hasBuffFlag = item?.hasItemBooleanFlag?.("buff") === true;
  const hasNoBuffFlag = item?.hasItemBooleanFlag?.("nobuff") === true;

  if (itemType === "spell" || itemType === "consumable") {
    if (hasNoBuffFlag) return { enabled: false, reason: "nobuff", warning: "nobuff" };
    return { enabled: true, reason: "native", warning: hasBuffFlag ? "buff" : "" };
  }
  if (itemType === "feat" && itemSubType === "classFeat") {
    return hasBuffFlag
      ? { enabled: true, reason: "buff", warning: "buff" }
      : { enabled: false, reason: "", warning: "" };
  }
  return hasBuffFlag
    ? { enabled: true, reason: "buff", warning: "buff" }
    : { enabled: false, reason: "", warning: "" };
}

function actionBuffAutomationConfigForAction(item, action, { runtime = false } = {}) {
  const root = getActionBuffAutomationRoot(item);
  const actionIds = runtime ? getActionIdCandidates(action) : [nonConsecutiveActionIdFromSheetAction(action)];
  for (const actionId of actionIds) {
    if (!actionId || !Object.prototype.hasOwnProperty.call(root, actionId)) continue;
    return {
      actionId,
      config: normalizeActionBuffAutomationConfig(root[actionId])
    };
  }
  return {
    actionId: actionIds.find(Boolean) ?? "",
    config: null
  };
}

export function getActionBuffAutomationState(item, action) {
  const { actionId, config } = actionBuffAutomationConfigForAction(item, action);
  const legacy = actionBuffAutomationLegacyState(item);
  return {
    actionId,
    configured: config != null,
    enabled: config ? config.enabled === true : legacy.enabled === true,
    selectedBuffUuid: config?.buffUuid ?? "",
    legacyReason: legacy.reason,
    legacyFlagWarning: legacy.warning,
    legacyWarning: config ? "" : legacy.warning
  };
}

export async function setActionBuffAutomationState(item, action, state = {}) {
  const actionId = nonConsecutiveActionIdFromSheetAction(action);
  if (!item?.update || !actionId) {
    return;
  }
  const enabled = state.enabled === true;
  const buffUuid = String(state.selectedBuffUuid ?? state.buffUuid ?? "").trim();
  const legacy = actionBuffAutomationLegacyState(item);
  const rootBefore = getActionBuffAutomationRoot(item);
  const current = normalizeActionBuffAutomationConfig(rootBefore?.[actionId]);

  if (!enabled && !buffUuid && current == null && legacy.enabled !== true) {
    return;
  }
  const updatePayload = {
    [actionBuffAutomationFlagPath(actionId, "enabled")]: enabled,
    [actionBuffAutomationFlagPath(actionId, buffUuid ? "buffUuid" : "-=buffUuid")]: buffUuid || null
  };
  await item.update(updatePayload);
}

function getRuntimeActionBuffAutomationState(action) {
  const item = action?.item;
  const { actionId, config } = actionBuffAutomationConfigForAction(item, action, { runtime: true });
  const legacy = actionBuffAutomationLegacyState(item);
  return {
    actionId,
    configured: config != null,
    enabled: config ? config.enabled === true : legacy.enabled === true,
    selectedBuffUuid: config?.buffUuid ?? "",
    legacyReason: legacy.reason,
    legacyFlagWarning: legacy.warning,
    legacyWarning: config ? "" : legacy.warning
  };
}

export function shouldHandleBuffAutomation(action) {
  if (!game.settings.get(MODULE.ID, "automaticBuffs")) return false;
  const state = getRuntimeActionBuffAutomationState(action);
  if (state.legacyFlagWarning) {
    warnLegacyBuffAutomationFlag(action?.item, state.legacyFlagWarning);
  }
  return state.configured
    ? state.enabled === true
    : state.enabled === true || state.legacyReason === "nobuff";
}

function warnLegacyBuffAutomationFlag(item, flag) {
  const normalizedFlag = String(flag ?? "").trim();
  if (!item || !normalizedFlag) return;
  const key = `${normalizedFlag}:${item.uuid ?? item.id ?? item.name ?? ""}`;
  if (LEGACY_BUFF_AUTOMATION_WARNINGS.has(key)) return;
  LEGACY_BUFF_AUTOMATION_WARNINGS.add(key);
  const messageKey = normalizedFlag === "nobuff"
    ? "legacyNoBuffBooleanDeprecated"
    : "legacyBuffBooleanDeprecated";
  ui.notifications?.warn?.(localizeNonConsecutiveBuff(messageKey, { item: item.name ?? "" }));
}

function canonicalBuffUuid(uuid) {
  const value = String(uuid ?? "").trim();
  if (!value.startsWith("Compendium.") || value.includes(".Item.")) return value;
  const parts = value.split(".");
  if (parts.length < 4) return value;
  const id = parts.at(-1);
  const pack = parts.slice(1, -1).join(".");
  return pack && id ? `Compendium.${pack}.Item.${id}` : value;
}

function packIdFromBuffDocument(document) {
  const pack = String(document?.pack ?? document?.compendium?.collection ?? "").trim();
  if (pack) return pack;
  const uuid = String(document?.uuid ?? "");
  if (!uuid.startsWith("Compendium.")) return null;
  const parts = uuid.split(".");
  const itemIndex = parts.findIndex((part) => part === "Item");
  return itemIndex > 1 ? parts.slice(1, itemIndex).join(".") : null;
}

async function resolveActionBuffAutomationBuff(state) {
  const uuid = canonicalBuffUuid(state?.selectedBuffUuid);
  if (!uuid || typeof fromUuid !== "function") return null;
  try {
    const document = await fromUuid(uuid);
    if (document?.type !== "buff") return null;
    return {
      name: document.name,
      id: document.id,
      pack: packIdFromBuffDocument(document),
      document
    };
  } catch (_error) {
    return null;
  }
}

function serializeNonConsecutiveDurationOptions(options = {}) {
  const option = normalizeNonConsecutiveOption(options);
  return option ? { [NON_CONSECUTIVE_DURATION_OPTION]: option } : {};
}

function nonConsecutiveDurationForOptions(options = {}, fallbackDuration = null) {
  const option = normalizeNonConsecutiveOption(options);
  return nonConsecutiveOptionDuration(option) ?? fallbackDuration;
}

function hasNonConsecutiveDurationOption(options = {}) {
  return Boolean(normalizeNonConsecutiveOption(options));
}

async function getOrCreateNonConsecutiveDurationApplication(action, duration = {}) {
  action.shared ??= {};
  if (action.shared._nasNonConsecutiveDurationApplication) {
    return action.shared._nasNonConsecutiveDurationApplication;
  }

  const item = action?.item;
  const actionId = nonConsecutiveActionIdFromAction(action);
  if (!item || !actionId) return null;

  const root = getNonConsecutiveRoot(item);
  const state = getNonConsecutiveActionState(root, actionId);
  if (!isNonConsecutiveState(state)) return null;

  const normalizedDuration = normalizeNonConsecutiveDurationForOption(duration);
  if (!normalizedDuration.units || normalizedDuration.capacity <= 0 || normalizedDuration.unitSeconds <= 0) return null;

  const remaining = currentNonConsecutiveRemaining(state, normalizedDuration);
  if (remaining <= 0) {
    ui.notifications?.warn?.(localizeNonConsecutiveBuff("nonConsecutiveDurationExhausted", {
      item: item.name ?? "",
      action: action?.action?.name ?? action?.name ?? ""
    }));
    action.shared._nasNonConsecutiveDurationApplication = { blocked: true };
    return action.shared._nasNonConsecutiveDurationApplication;
  }

  const option = {
    enabled: true,
    sourceItemUuid: item.uuid ?? "",
    sourceItemName: item.name ?? "",
    actionId,
    actionName: action?.action?.name ?? action?.name ?? "",
    sessionId: createNasId(),
    units: normalizedDuration.units,
    capacity: normalizedDuration.capacity,
    remaining,
    unitSeconds: normalizedDuration.unitSeconds,
    startedAtWorldTime: nonConsecutiveTimeNow()
  };
  action.shared._nasNonConsecutiveDurationApplication = {
    blocked: false,
    duration: nonConsecutiveOptionDuration(option) ?? duration,
    option: serializeNonConsecutiveOption(option)
  };
  return action.shared._nasNonConsecutiveDurationApplication;
}

async function markNonConsecutiveBuffActive(buffItem, options = {}) {
  const option = normalizeNonConsecutiveOption(options);
  if (!buffItem || !option) return false;
  const sourceItem = await nonConsecutiveSourceItemFromOption(option);
  if (!sourceItem) return false;

  const buffKey = nonConsecutiveActiveBuffKey(buffItem);
  if (!buffKey) return false;
  const now = nonConsecutiveTimeNow();

  await updateNonConsecutiveSourceRoot(sourceItem, (root) => {
    const current = root.actions[option.actionId] ?? {};
    const next = nonConsecutiveStateMatchesDuration(current, option)
      ? { ...current }
      : {
        consecutive: false,
        remaining: option.capacity,
        capacity: option.capacity,
        units: option.units,
        unitSeconds: option.unitSeconds,
        sessions: {}
      };

    next.consecutive = false;
    next.remaining = Number.isFinite(Number(next.remaining)) ? Math.max(0, Number(next.remaining)) : option.capacity;
    next.capacity = option.capacity;
    next.units = option.units;
    next.unitSeconds = option.unitSeconds;
    next.sessions = next.sessions && typeof next.sessions === "object" ? next.sessions : {};
    const session = normalizeNonConsecutiveSession(next.sessions[option.sessionId]);
    session.id = option.sessionId;
    session.startedAtWorldTime = option.startedAtWorldTime || now;
    session.unitSeconds = option.unitSeconds;
    session.activeBuffs[buffKey] = nonConsecutiveActiveBuffMeta(buffItem);
    next.sessions[option.sessionId] = session;
    root.actions[option.actionId] = next;
  });

  await buffItem.update({
    [nonConsecutiveTrackingFlagPath()]: {
      sourceItemUuid: option.sourceItemUuid,
      sourceItemName: option.sourceItemName,
      actionId: option.actionId,
      actionName: option.actionName,
      sessionId: option.sessionId,
      startedAtWorldTime: option.startedAtWorldTime || now,
      units: option.units,
      capacity: option.capacity,
      remainingAtActivation: option.remaining,
      unitSeconds: option.unitSeconds
    }
  });
  return true;
}

async function finalizeTrackedNonConsecutiveBuff(item, context = {}) {
  const flag = nonConsecutiveTrackingFlag(item);
  if (!flag) return false;

  const sourceItem = await nonConsecutiveSourceItemFromFlag(flag);
  if (!sourceItem) return false;

  const actionId = normalizeNonConsecutiveActionId(flag.actionId);
  const sessionId = String(flag.sessionId ?? "");
  const buffKey = nonConsecutiveActiveBuffKey(item);
  if (!actionId || !sessionId || !buffKey) return false;

  const now = nonConsecutiveTimeNow();
  const contextStart = Number(context?.pf1?.startTime);
  const startedAt = Number.isFinite(contextStart)
    ? contextStart
    : (Number(flag.startedAtWorldTime) || now);
  const unit = Number(flag.unitSeconds) > 0 ? Number(flag.unitSeconds) : nonConsecutiveUnitSeconds(flag.units);
  const elapsed = Math.max(0, now - startedAt);
  const consumed = Math.max(1, Math.ceil(elapsed / Math.max(1, unit)));
  const state = getNonConsecutiveActionState(getNonConsecutiveRoot(sourceItem), actionId);
  const rawSession = state?.sessions?.[sessionId];
  if (!rawSession) return false;

  const session = normalizeNonConsecutiveSession(rawSession);
  if (!session.activeBuffs[buffKey]) return false;

  const otherActiveBuffKeys = Object.keys(session.activeBuffs).filter((key) => key !== buffKey);
  const update = {
    [nonConsecutiveActionFlagPath(actionId, `sessions.${sessionId}.activeBuffs.-=${buffKey}`)]: null
  };
  if (otherActiveBuffKeys.length === 0) {
    const remaining = Number.isFinite(Number(state.remaining)) ? Number(state.remaining) : Number(state.capacity);
    update[nonConsecutiveActionFlagPath(actionId, "remaining")] = Math.max(0, remaining - consumed);
    update[nonConsecutiveActionFlagPath(actionId, "lastSpent")] = consumed;
    update[nonConsecutiveActionFlagPath(actionId, "lastSpentAtWorldTime")] = now;
    update[nonConsecutiveActionFlagPath(actionId, `sessions.-=${sessionId}`)] = null;
  }
  await sourceItem.update(update);

  if (item?.update && item?.parent) {
    await item.update({ [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${NON_CONSECUTIVE_DURATION_FLAG_KEY}.-=appliedBuff`]: null });
  }
  return true;
}

function resetRestNonConsecutiveItemUpdate(itemUpdates, item) {
  const root = getNonConsecutiveRoot(item);
  const actions = root.actions && typeof root.actions === "object" ? root.actions : {};
  let changed = false;
  for (const [actionId, state] of Object.entries(actions)) {
    if (!isNonConsecutiveState(state)) continue;
    const capacity = Number(state.capacity);
    if (!Number.isFinite(capacity) || capacity <= 0) continue;

    let update = itemUpdates.find((entry) => String(entry?._id ?? "") === String(item.id));
    if (!update) {
      update = { _id: item.id };
      itemUpdates.push(update);
    }
    foundry.utils.setProperty(update, nonConsecutiveActionFlagPath(actionId, "remaining"), capacity);
    foundry.utils.setProperty(update, nonConsecutiveActionFlagPath(actionId, "lastResetAtWorldTime"), nonConsecutiveTimeNow());
    for (const sessionId of Object.keys(state.sessions ?? {})) {
      foundry.utils.setProperty(update, nonConsecutiveActionFlagPath(actionId, `sessions.-=${sessionId}`), null);
    }
    changed = true;
  }
  return changed;
}

function resetActorNonConsecutiveDurationsOnRest(actor, options, _updateData, itemUpdates) {
  if (options?.restoreDailyUses !== true) return;
  if (!Array.isArray(itemUpdates)) return;
  for (const item of actor?.items ?? []) {
    resetRestNonConsecutiveItemUpdate(itemUpdates, item);
  }
}

export function registerNonConsecutiveDurationHooks() {
  Hooks.on("updateItem", (item, changed, options) => {
    if (item?.type !== "buff") return;
    if (!updateChangedPath(changed, "system.active")) return;
    if (item.system?.active !== false) return;
    void finalizeTrackedNonConsecutiveBuff(item, options);
  });

  Hooks.on("deleteItem", (item, options) => {
    if (item?.type !== "buff") return;
    if (item.system?.active !== true) return;
    void finalizeTrackedNonConsecutiveBuff(item, options);
  });

  Hooks.on("pf1PreActorRest", resetActorNonConsecutiveDurationsOnRest);
}

function normalizeBuffSaveHandlingMode(value) {
  const mode = String(value ?? "ignore");
  return SAVE_HANDLING_MODES.has(mode) ? mode : "ignore";
}

function normalizeBuffSaveAllyBypassMode(value) {
  const mode = String(value ?? "setting");
  return SAVE_ALLY_BYPASS_MODES.has(mode) ? mode : "setting";
}

function getBuffSaveSettingMode() {
  try {
    return normalizeBuffSaveHandlingMode(game.settings.get(MODULE.ID, "buffSaveHandlingDefault"));
  } catch {
    return "ignore";
  }
}

function getBuffSaveSettingAllyBypass() {
  try {
    return game.settings.get(MODULE.ID, "buffSaveAlliesBypass") !== false;
  } catch {
    return true;
  }
}

function normalizeSaveType(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "fortitude") return "fort";
  if (raw === "reflex") return "ref";
  if (raw === "willpower") return "will";
  return REAL_SAVE_TYPES.has(raw) ? raw : "";
}

function coerceNumberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNumberOrNull(...values) {
  for (const value of values) {
    const number = coerceNumberOrNull(value);
    if (number != null) return number;
  }
  return null;
}

function getActionIdCandidates(action) {
  return [
    action?.action?.id,
    action?.action?._id,
    action?.id,
    action?._id,
    action?.actionId,
    action?.shared?.action?.id,
    action?.shared?.action?._id
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
}

function getActionId(action) {
  return getActionIdCandidates(action)[0] ?? "";
}

function getActionBuffSaveOverride(action) {
  const actionIds = getActionIdCandidates(action);
  const flags = action?.item?.getFlag?.(MODULE.ID, "itemReactiveEffects") ?? {};
  const byAction = flags?.[BUFF_SAVE_ACTION_SHEET_KEY] ?? {};
  const matchedActionId = actionIds.find((id) => byAction?.[id] != null);
  const fallbackActionId = !matchedActionId && Object.keys(byAction).length === 1 ? Object.keys(byAction)[0] : "";
  const actionId = matchedActionId || fallbackActionId;
  if (!actionId) {
        return null;
  }
  const raw = byAction?.[actionId];
    if (!raw || typeof raw !== "object" || raw.override !== true) {
        return null;
  }
  const override = {
    mode: normalizeBuffSaveHandlingMode(raw.mode),
    alliesBypass: normalizeBuffSaveAllyBypassMode(raw.alliesBypass)
  };
    return override;
}

function resolveActionSaveData(action) {
  const nasSpellSave = action?.shared?.nasSpellContext?.save ?? {};
  const sharedSave = action?.shared?.save ?? {};
  const actionSave = action?.action?.save ?? {};
  const typeCandidates = [
    { source: "shared.nasSpellContext.save.type", value: nasSpellSave.type },
    { source: "shared.save.type", value: sharedSave.type },
    { source: "action.save.type", value: actionSave.type },
    { source: "shared.saveType", value: action?.shared?.saveType },
    { source: "action.saveType", value: action?.action?.saveType }
  ];
  const type = normalizeSaveType(typeCandidates.find((candidate) => normalizeSaveType(candidate.value))?.value);
  let liveActionDc = null;
  try {
    liveActionDc = typeof action?.action?.getDC === "function" ? action.action.getDC(action.shared?.rollData ?? {}) : null;
  } catch (err) {
    liveActionDc = null;
  }
  const overrideSave = action?.shared?.chatData?.flags?.[MODULE.ID]?.actionOverrides?.save
    ?? action?.shared?.templateData?.flags?.[MODULE.ID]?.actionOverrides?.save
    ?? {};
  const dcCandidates = [
    { source: "shared.nasSpellContext.save.dc", value: nasSpellSave.dc },
    { source: "shared.nasSpellContext.save.baseDc", value: nasSpellSave.baseDc },
    { source: "shared.saveDC", value: action?.shared?.saveDC },
    { source: "actionOverrides.save.dc", value: overrideSave.dc },
    { source: "shared.templateData.save.dc", value: action?.shared?.templateData?.save?.dc },
    { source: "shared.templateData.system.save.dc", value: action?.shared?.templateData?.system?.save?.dc },
    { source: "shared.templateData.item.system.save.dc", value: action?.shared?.templateData?.item?.system?.save?.dc },
    { source: "shared.chatData.system.save.dc", value: action?.shared?.chatData?.system?.save?.dc },
    { source: "shared.save.dc", value: sharedSave.dc },
    { source: "shared.save.baseDc", value: sharedSave.baseDc },
    { source: "action.save.dc", value: actionSave.dc },
    { source: "action.save.baseDc", value: actionSave.baseDc },
    { source: "action.getDC(shared.rollData)", value: liveActionDc },
    { source: "shared.nasSpellContext.save.evaluated.total", value: nasSpellSave.evaluated?.total },
    { source: "shared.save.evaluated.total", value: sharedSave.evaluated?.total }
  ];
  const dc = firstNumberOrNull(...dcCandidates.map((candidate) => candidate.value));
  return { type, dc };
}

function resolveBuffSaveGate(action) {
  const override = getActionBuffSaveOverride(action);
  const mode = override ? override.mode : getBuffSaveSettingMode();
  const allyBypassMode = override ? override.alliesBypass : "setting";
  const alliesBypass = allyBypassMode === "setting"
    ? getBuffSaveSettingAllyBypass()
    : allyBypassMode === "enabled";
  const save = resolveActionSaveData(action);
  const gate = {
    mode,
    alliesBypass,
    saveType: save.type,
    dc: save.dc,
    deferred: mode !== "ignore" && REAL_SAVE_TYPES.has(save.type)
  };
    return gate;
}

function tokenDocumentFromTarget(target) {
  return target?.document ?? target;
}

function targetTokenUuid(target) {
  const doc = tokenDocumentFromTarget(target);
  return String(doc?.uuid ?? target?.uuid ?? "");
}

function targetTokenId(target) {
  const doc = tokenDocumentFromTarget(target);
  return String(doc?.id ?? target?.id ?? "");
}

function serializeBuffReference(buff) {
  return {
    name: buff?.name ?? "",
    id: buff?.id ?? "",
    pack: buff?.pack ?? null
  };
}

function serializeKnownBuffAutomation(options = {}) {
  const known = options?.[KNOWN_BUFF_AUTOMATION_OPTION];
  return known ? foundry.utils.deepClone(known) : null;
}

function serializeAppliedBuffOverrideOptions(options = {}) {
  const override = options?.[APPLIED_BUFF_OVERRIDE_OPTION];
  if (!override) return {};
  return {
    [APPLIED_BUFF_OVERRIDE_OPTION]: foundry.utils.deepClone(override),
    [APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION]: String(options?.[APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION] ?? ""),
    [APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION]: String(options?.[APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION] ?? ""),
    [APPLIED_BUFF_TARGET_UUID_OPTION]: String(options?.[APPLIED_BUFF_TARGET_UUID_OPTION] ?? "")
  };
}

async function resolveSourceItemFromAppliedBuffOptions(options = {}) {
  const uuid = String(options?.[APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION] ?? "").trim();
  if (!uuid) return null;
  try {
    const doc = await fromUuid(uuid);
    return doc?.documentName === "Item" || doc?.constructor?.documentName === "Item" ? doc : null;
  } catch (_err) {
    return null;
  }
}

function appliedBuffLockoutLabel(expiresAt) {
  const remaining = Math.max(0, Math.ceil((Number(expiresAt) - Number(game.time?.worldTime ?? 0)) / 60));
  if (remaining >= 60) {
    const hours = Math.ceil(remaining / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${remaining} minute${remaining === 1 ? "" : "s"}`;
}

async function shouldBlockAppliedBuffForLockout(sourceItem, buff, options = {}) {
  const override = options?.[APPLIED_BUFF_OVERRIDE_OPTION];
  if (!override) return false;
  if (override?.temporaryHp?.lockout?.enabled !== true) return false;
  const item = sourceItem ?? await resolveSourceItemFromAppliedBuffOptions(options);
  if (!item) return false;
  const buffUuid = String(options?.[APPLIED_BUFF_TARGET_UUID_OPTION] ?? override?.buffUuid ?? primaryAppliedBuffUuid(buff));
  if (!buffUuid) return false;
  const state = getAppliedBuffLockoutState(item, buffUuid);
  if (!state.locked) return false;
  ui.notifications?.warn?.(game.i18n.format("NAS.reactive.appliedBuffLockoutActive", {
    item: item.name,
    remaining: appliedBuffLockoutLabel(state.expiresAt)
  }));
  return true;
}

async function applyAppliedBuffOverrideToItem(targetBuff, options = {}) {
  const override = options?.[APPLIED_BUFF_OVERRIDE_OPTION];
  if (!targetBuff || !override || options.activate === false) return false;
  const updates = await appliedBuffOverrideUpdates({
    targetBuff,
    override,
    sourceItemUuid: options?.[APPLIED_BUFF_SOURCE_ITEM_UUID_OPTION],
    sourceItemName: options?.[APPLIED_BUFF_SOURCE_ITEM_NAME_OPTION],
    appliedBuffUuid: options?.[APPLIED_BUFF_TARGET_UUID_OPTION] ?? override?.buffUuid
  });
  if (!Object.keys(updates).length) return false;
  await targetBuff.update(updates, { render: false });
  return true;
}

function serializeDuration(duration) {
  if (!duration || typeof duration !== "object") return null;
  return {
    units: String(duration.units ?? ""),
    value: String(duration.value ?? "")
  };
}

function serializePendingTarget(target, duration, buff = null) {
  const doc = tokenDocumentFromTarget(target);
  const actor = target?.actor ?? doc?.actor ?? null;
  const entry = {
    tokenUuid: targetTokenUuid(target),
    tokenId: targetTokenId(target),
    actorUuid: actor?.uuid ?? "",
    duration: serializeDuration(duration)
  };
  if (buff) entry.buff = serializeBuffReference(buff);
  return entry;
}

function targetAppliedKey(target) {
  return targetTokenUuid(target) || targetTokenId(target) || target?.actor?.uuid || target?.actor?.id || "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function targetDispositionValue(target) {
  return tokenDocumentFromTarget(target)?.disposition ?? target?.disposition ?? null;
}

function targetIsHiddenOrUnavailable(target) {
  const doc = tokenDocumentFromTarget(target);
  return doc?.hidden === true || targetDispositionValue(target) === CONST.TOKEN_DISPOSITIONS.SECRET;
}

function targetIsInvisibleToCurrentUser(target, casterToken) {
  if (game.user?.isGM === true) return false;
  const token = target?.object ?? target;
  const doc = tokenDocumentFromTarget(target);
  const actor = token?.actor ?? doc?.actor ?? null;
  const casterActor = casterToken?.actor ?? tokenDocumentFromTarget(casterToken)?.actor ?? null;
  const casterHasSeeInvisibility = casterActor?.system?.traits?.senses?.si === true;
  if (targetIsHiddenOrUnavailable(target)) return true;
  if (actor?.statuses?.has?.("invisible") && !casterHasSeeInvisibility) return true;
  const casterObject = casterToken?.object ?? casterToken;
  const targetObject = token?.center ? token : doc?.object;
  if (casterObject && targetObject && !tokenCanSeeToken(casterObject, targetObject)) return true;
  return false;
}

function targetIsSecretForAutomation(target, casterToken) {
  return targetIsHiddenOrUnavailable(target) || targetIsInvisibleToCurrentUser(target, casterToken);
}

function targetIsAllyToCaster(target, casterToken) {
  const casterActorUuid = casterToken?.actor?.uuid ?? "";
  const targetActorUuid = target?.actor?.uuid ?? tokenDocumentFromTarget(target)?.actor?.uuid ?? "";
  if (casterActorUuid && targetActorUuid && casterActorUuid === targetActorUuid) return true;
  const casterDisposition = targetDispositionValue(casterToken);
  const disposition = targetDispositionValue(target);
  return casterDisposition != null && disposition != null && casterDisposition === disposition;
}

function targetFilterGroups(target, casterToken, extraGroups = []) {
  const groups = new Set(["all", ...extraGroups.filter(Boolean)]);
  const disposition = targetDispositionValue(target);
  if (targetIsHiddenOrUnavailable(target)) groups.add("hidden");
  if (disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) groups.add("neutral");
  else if (targetIsAllyToCaster(target, casterToken)) groups.add("allies");
  else groups.add("enemies");
  return [...groups];
}

function targetDispositionLabel(target, casterToken) {
  if (targetIsHiddenOrUnavailable(target)) return game.i18n.localize("NAS.buffs.TargetFilterHidden");
  const disposition = targetDispositionValue(target);
  if (disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) return game.i18n.localize("NAS.buffs.TargetFilterNeutral");
  return targetIsAllyToCaster(target, casterToken)
    ? game.i18n.localize("NAS.buffs.TargetFilterAllies")
    : game.i18n.localize("NAS.buffs.TargetFilterEnemies");
}

function targetEntryIsRendered(entry) {
  return entry?.rendered !== false;
}

function availableTargetFilters(targetEntries) {
  const visibleEntries = targetEntries.filter(targetEntryIsRendered);
  const filterDefs = [
    ["all", "NAS.buffs.TargetFilterAll"],
    ["allies", "NAS.buffs.TargetFilterAllies"],
    ["enemies", "NAS.buffs.TargetFilterEnemies"],
    ["neutral", "NAS.buffs.TargetFilterNeutral"],
    ...(game.user?.isGM ? [["hidden", "NAS.buffs.TargetFilterHidden"]] : []),
    ["eligible", "NAS.buffs.TargetFilterEligible"],
    ["needs", "NAS.buffs.TargetFilterNeedsSave"],
    ["failed", "NAS.buffs.TargetFilterFailed"],
    ["successful", "NAS.buffs.TargetFilterSuccessful"],
    ["bypassed", "NAS.buffs.TargetFilterBypassed"]
  ];
  return filterDefs
    .filter(([filter]) => filter === "all" || visibleEntries.some((entry) => entry.groups.includes(filter)))
    .map(([filter, labelKey]) => ({ filter, label: game.i18n.localize(labelKey) }));
}

function targetSelectionControlsHtml(targetEntries, { targetBulkMoreOpen = false } = {}) {
  const filters = availableTargetFilters(targetEntries);
  const controlButtonStyle = "flex:0 1 auto; width:auto; min-width:86px; min-height:30px; padding:4px 10px; white-space:nowrap; line-height:1.2; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--color-border-light-primary, #999); border-radius:3px; background:rgba(255,255,255,0.35); color:inherit; text-decoration:none; cursor:pointer;";
  const visibleEntries = targetEntries.filter(targetEntryIsRendered);
  const hasAllies = visibleEntries.some((entry) => entry.groups.includes("allies"));
  const hasNeutral = visibleEntries.some((entry) => entry.groups.includes("neutral"));
  const hasEnemies = visibleEntries.some((entry) => entry.groups.includes("enemies"));
  const hasSuccessfulSaves = visibleEntries.some((entry) => entry.groups.includes("successful"));
  const hasFailedSaves = visibleEntries.some((entry) => entry.groups.includes("failed"));
  const filterButtons = filters.map(({ filter, label }, index) => `
    <a href="#" role="button" data-nas-target-filter="${filter}" class="nas-dialog-control ${index === 0 ? "active" : ""}" style="${controlButtonStyle}">${escapeHtml(label)}</a>
  `).join("");
  const groupSelectButtons = `
    ${hasAllies ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="selectAllies" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectAllies"))}</a>` : ""}
    ${hasNeutral ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="selectNeutral" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectNeutral"))}</a>` : ""}
    ${hasEnemies ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="selectEnemies" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectEnemies"))}</a>` : ""}
  `;
  const selectSaveButtons = `
    ${hasSuccessfulSaves ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="selectSuccessful" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectSaved"))}</a>` : ""}
    ${hasFailedSaves ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="selectFailed" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectFailed"))}</a>` : ""}
  `;
  const deselectSaveButtons = `
    ${hasSuccessfulSaves ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselectSuccessful" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectSaved"))}</a>` : ""}
    ${hasFailedSaves ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselectFailed" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectFailed"))}</a>` : ""}
  `;
  const groupDeselectButtons = `
    ${hasAllies ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselectAllies" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectAllies"))}</a>` : ""}
    ${hasNeutral ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselectNeutral" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectNeutral"))}</a>` : ""}
    ${hasEnemies ? `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselectEnemies" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectEnemies"))}</a>` : ""}
  `;
  const moreBulkButtons = `${groupSelectButtons}${groupDeselectButtons}`.trim();
  return `
    <div class="nas-target-selection-controls" style="display:flex; flex-direction:column; gap:8px; margin:8px 0;">
      <div class="nas-target-filters" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">${filterButtons}</div>
      <div class="nas-target-bulk" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
        <strong style="min-width:56px;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkSelectLabel"))}</strong>
        <a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="select" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetSelectVisible"))}</a>
        ${selectSaveButtons}
      </div>
      <div class="nas-target-bulk" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
        <strong style="min-width:56px;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkDeselectLabel"))}</strong>
        <a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="deselect" style="${controlButtonStyle}">${escapeHtml(game.i18n.localize("NAS.buffs.TargetDeselectVisible"))}</a>
        ${deselectSaveButtons}
      </div>
      ${moreBulkButtons ? `<details class="nas-target-bulk-more" ${targetBulkMoreOpen ? "open" : ""}><summary style="cursor:pointer; width:max-content;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkMore"))}</summary><div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">${moreBulkButtons}</div></details>` : ""}
    </div>
  `;
}

function wireTargetSelectionControls(html, dialog = null) {
  const $html = typeof html.find === "function" ? html : $(html);
  const applyFilter = (filter) => {
    $html.find("[data-nas-target-filter]").removeClass("active");
    $html.find("[data-nas-target-filter]").css({
      "box-shadow": "",
      "border-color": "var(--color-border-light-primary, #999)"
    });
    $html.find(`[data-nas-target-filter="${filter}"]`).addClass("active").css({
      "box-shadow": "0 0 4px red",
      "border-color": "red"
    });
    $html.find(".nas-target-option").each((_index, el) => {
      const groups = String(el.dataset.nasTargetGroups ?? "").split(/\s+/);
      const visible = filter === "all" || groups.includes(filter);
      el.style.display = visible ? "flex" : "none";
    });
    dialog?.setPosition?.({ height: "auto" });
  };
  $html.find("[data-nas-target-filter]").on("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyFilter(event.currentTarget.dataset.nasTargetFilter);
  });
  $html.find("[data-nas-target-bulk]").on("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = event.currentTarget.dataset.nasTargetBulk;
    const selectGroups = {
      selectAllies: "allies",
      selectNeutral: "neutral",
      selectEnemies: "enemies",
      selectSuccessful: "successful",
      selectFailed: "failed"
    };
    const deselectGroups = {
      deselectAllies: "allies",
      deselectNeutral: "neutral",
      deselectEnemies: "enemies",
      deselectSuccessful: "successful",
      deselectFailed: "failed"
    };
    $html.find(".nas-target-option").each((_index, el) => {
      const visible = el.style.display !== "none";
      const checkbox = el.querySelector("input[type='checkbox']");
      if (!checkbox || checkbox.disabled) return;
      const groups = String(el.dataset.nasTargetGroups ?? "").split(/\s+/);
      if (action === "select" && visible) checkbox.checked = true;
      else if (action === "deselect" && visible) checkbox.checked = false;
      else if (selectGroups[action] && groups.includes(selectGroups[action])) checkbox.checked = true;
      else if (deselectGroups[action] && groups.includes(deselectGroups[action])) checkbox.checked = false;
    });
  });
}

function nasDialogControlStyle() {
  return "flex:0 1 auto; width:auto; min-width:86px; min-height:30px; padding:4px 10px; white-space:nowrap; line-height:1.2; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--color-border-light-primary, #999); border-radius:3px; background:rgba(255,255,255,0.35); color:inherit; text-decoration:none; cursor:pointer;";
}

function parseRollJson(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    if (typeof globalThis.Roll?.fromJSON === "function") {
      const roll = globalThis.Roll.fromJSON(value);
      if (roll) return roll;
    }
  } catch (_err) {
  }
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

function extractHtmlTotal(content) {
  if (typeof DOMParser !== "function" || typeof content !== "string" || content.length === 0) return null;
  try {
    const doc = new DOMParser().parseFromString(content, "text/html");
    for (const selector of [".dice-total", ".total", ".value"]) {
      for (const el of doc.querySelectorAll(selector)) {
        const total = coerceNumberOrNull(el.textContent);
        if (total != null) return total;
      }
    }
  } catch (_err) {
    return null;
  }
  return null;
}

function saveResultForTargetRef(targetRef, saveType) {
  return coerceNumberOrNull(targetRef?.saveResults?.[saveType]);
}

function shouldQueueBuffApplication(action, targets, buffSaveGate) {
  if (!buffSaveGate?.deferred) {
        return false;
  }
  if (!targets?.length) {
        return false;
  }
  const createsChat = action?.shared?.chatMessage !== false && action?.shared?.scriptData?.hideChat !== true;
  if (!createsChat) {
        console.warn(`${MODULE.ID} | Save-gated buff automation requested but no action chat message is expected; applying buff immediately.`);
    return false;
  }
  return true;
}

function queuePendingBuffApplication(action, buff, targets, duration, casterLevel, options = {}) {
  const buffSaveGate = options.buffSaveGate ?? resolveBuffSaveGate(action);
  if (!shouldQueueBuffApplication(action, targets, buffSaveGate)) return false;

  action.shared ??= {};
  action.shared.nasPendingBuffAutomation ??= [];
  const targetDurations = options.targetDurations instanceof Map ? options.targetDurations : null;
  const targetBuffs = options.targetBuffs instanceof Map ? options.targetBuffs : null;
  const targetSaveResults = options.targetSaveResults instanceof Map ? options.targetSaveResults : null;
  const saveResultTargets = Array.isArray(options.saveResultTargets)
    ? options.saveResultTargets.map((entry) => {
      const target = entry?.target ?? entry;
      const saveResults = entry?.saveResults ?? (target ? targetSaveResults?.get(targetAppliedKey(target)) : null);
      const ref = serializePendingTarget(target, null, null);
      if (saveResults && typeof saveResults === "object") ref.saveResults = foundry.utils.deepClone(saveResults);
      return ref;
    }).filter((entry) => (entry.tokenUuid || entry.tokenId) && entry.saveResults)
    : [];
  const plan = {
    id: createNasId(),
    buff: serializeBuffReference(buff),
    targets: targets.map((target) => {
      const key = targetAppliedKey(target);
      const entry = serializePendingTarget(target, targetDurations?.get(key) ?? duration, targetBuffs?.get(key) ?? null);
      const saveResults = targetSaveResults?.get(key);
      if (saveResults && typeof saveResults === "object") entry.saveResults = foundry.utils.deepClone(saveResults);
      return entry;
    }).filter((entry) => entry.tokenUuid || entry.tokenId),
    caster: {
      tokenUuid: targetTokenUuid(action?.token),
      tokenId: targetTokenId(action?.token),
      actorUuid: action?.actor?.uuid ?? action?.token?.actor?.uuid ?? "",
      disposition: tokenDocumentFromTarget(action?.token)?.disposition ?? null
    },
    casterLevel,
    save: {
      type: buffSaveGate.saveType,
      dc: buffSaveGate.dc,
      mode: buffSaveGate.mode,
      alliesBypass: buffSaveGate.alliesBypass === true
    },
    options: {
      activate: options.activate !== false,
      silent: options.silent === true,
      [KNOWN_BUFF_AUTOMATION_OPTION]: serializeKnownBuffAutomation(options),
      ...serializeAppliedBuffOverrideOptions(options),
      ...serializeNonConsecutiveDurationOptions(options)
    },
    manualSelection: options.manualSelection === true,
    resolvedManualSelection: options.resolvedManualSelection === true,
    publicSaveResultsOnly: options.publicSaveResultsOnly === true,
    saveResultTargets,
    skippedTargetUuids: [],
    appliedTargetUuids: []
  };
  action.shared.nasPendingBuffAutomation.push(plan);
    return true;
}

async function applyOrQueueBuffToTargets(action, buff, targets, duration, casterLevel, options = {}) {
  const buffSaveGate = options.buffSaveGate ?? resolveBuffSaveGate(action);
  const appliedBuffOptions = appliedBuffOverrideOptionsFor(action?.item, buff);
  const mergedOptions = { ...options, ...appliedBuffOptions };
  if (await shouldBlockAppliedBuffForLockout(action?.item, buff, mergedOptions)) {
    action.shared ??= {};
    action.shared.reject = true;
    return;
  }
  const nonConsecutive = await getOrCreateNonConsecutiveDurationApplication(action, duration);
  if (nonConsecutive?.blocked) {
    action.shared ??= {};
    action.shared.reject = true;
    return;
  }

  const effectiveDuration = nonConsecutive?.duration ?? duration;
  const durationOptions = nonConsecutive?.option
    ? { [NON_CONSECUTIVE_DURATION_OPTION]: nonConsecutive.option }
    : {};
  const effectiveOptions = { ...mergedOptions, ...durationOptions };
  if (queuePendingBuffApplication(action, buff, targets, effectiveDuration, casterLevel, { ...effectiveOptions, buffSaveGate })) return;
  await applyBuffToTargets(buff, targets, effectiveDuration, casterLevel, effectiveOptions);
}

export function attachPendingBuffAutomationToChatData(actionUse) {
  const pending = actionUse?.shared?.nasPendingBuffAutomation;
  if (!Array.isArray(pending) || pending.length === 0) {
        return;
  }
  actionUse.shared.chatData ??= {};
  actionUse.shared.chatData.flags ??= {};
  actionUse.shared.chatData.flags[MODULE.ID] ??= {};
  actionUse.shared.chatData.flags[MODULE.ID][PENDING_BUFF_AUTOMATION_KEY] = foundry.utils.deepClone(pending);
  }

  async function applySelectedBuffForAction({
    action,
    selectedBuff,
    isSelfTargeting,
    isCommunal,
    durationUnits,
    durationValue,
    communalIncrement,
    communalTotalDuration,
    communalDurationUnit,
    communalPromptForManual,
    isAreaOfEffect,
    casterLevel,
    buffSaveGate
  }) {
    const knownBuffAutomation = await promptKnownBuffAutomationForAction(action);
    if (knownBuffAutomation === null && action.shared?.reject !== true) {
      action.shared.reject = true;
      return;
    }
  
    const targetContext = await gatherTargetsForApplication({
      action,
      isSelfTargeting,
      isCommunal,
      durationUnits,
      durationValue,
      communalIncrement,
      communalTotalDuration,
      communalDurationUnit,
      communalPromptForManual,
      isAreaOfEffect,
      buffSaveGate
    });
    if (targetContext.rejected) {
      notifyBuffTargetingRejection(action, targetContext.reason);
      return;
    }
  
    applyMaskFocusPerTargetDurationAdjustments(action, targetContext, durationUnits);
    applyNaniteBloodlineArcanaPerTargetDurationAdjustments(action, targetContext, durationUnits);
  
    const { filteredTargets, perTargetDurations } = targetContext;
    const manualResultOptions = manualSelectionResultOptions(filteredTargets);
  
    if (perTargetDurations && perTargetDurations.length > 0) {
      if (targetContext.manualSelection === true && buffSaveGate?.deferred) {
        const targetDurations = new Map(perTargetDurations.map((entry) => [
          targetAppliedKey(entry.target),
          { units: entry.duration.units, value: String(entry.duration.value) }
        ]));
        await applyOrQueueBuffToTargets(action, selectedBuff, perTargetDurations.map((entry) => entry.target), null, casterLevel, {
          [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation,
          buffSaveGate,
          manualSelection: true,
          targetDurations,
          ...manualResultOptions
        });
        return;
      }
      for (const entry of perTargetDurations) {
        await applyOrQueueBuffToTargets(action, selectedBuff, [entry.target], {
          units: entry.duration.units,
          value: String(entry.duration.value)
        }, casterLevel, { [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation, buffSaveGate, manualSelection: targetContext.manualSelection === true, ...manualResultOptions });
      }
    } else {
      await applyOrQueueBuffToTargets(action, selectedBuff, filteredTargets, {
        units: durationUnits,
        value: String(durationValue)
      }, casterLevel, { [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation, buffSaveGate, manualSelection: targetContext.manualSelection === true, ...manualResultOptions });
    }
  }

export async function handleBuffAutomation(action) {
  const item = action?.item;
  const automationState = getRuntimeActionBuffAutomationState(action);
  if (!automationState.configured && automationState.legacyWarning) {
    warnLegacyBuffAutomationFlag(item, automationState.legacyWarning);
  }
  if (!automationState.enabled) {
    return;
  }

  let searchName = action.item.name;
  if (action.item.type === "consumable" && typeof action.item.subType === "string") {
    const subType = action.item.subType.toLowerCase();
    let prefixKey = null;
    if (subType === "wand") prefixKey = "PF1.CreateItemWandOf";
    else if (subType === "scroll") prefixKey = "PF1.CreateItemScrollOf";
    else if (subType === "potion") prefixKey = "PF1.CreateItemPotionOf";
    if (prefixKey) {
      let localized = game.i18n.localize(prefixKey); 
      let prefix = localized.replace(/\{name\}/, "").trim();
      if (searchName.toLowerCase().startsWith(prefix.toLowerCase())) {
        searchName = searchName.slice(prefix.length).trim();
      }
    }
  }
  
  const stripModifierLiteral = (name, rawModifier) => {
    const mod = (rawModifier ?? "").trim();
    if (!mod) return { value: name, matched: false };
    const n = (name ?? "").trim();
    const nLower = n.toLowerCase();
    const mLower = mod.toLowerCase();

    if (nLower.startsWith(mLower)) {
      return { value: n.slice(mod.length).trim(), matched: true };
    }
    if (nLower.endsWith(mLower)) {
      return { value: n.slice(0, Math.max(0, n.length - mod.length)).trim(), matched: true };
    }
    return { value: name, matched: false };
  };

  const modifierNames = game.settings.get(MODULE.ID, 'modifierNames') || {};
  const communalString = modifierNames.communal || 'Communal';
  let isCommunal = false;
  const communalEndRegex = new RegExp(`(?:,\\s*|\\s*\\(|\\s*\\[|\\s+)${communalString}\\s*(?:\\)|\\])?$`, 'i');
  const communalStartRegex = new RegExp(`^${communalString}[,\s]+`, 'i');

  if (communalStartRegex.test(searchName)) {
    isCommunal = true;
    searchName = searchName.replace(communalStartRegex, '').trim();
  } else if (communalEndRegex.test(searchName)) {
    isCommunal = true;
    searchName = searchName.replace(communalEndRegex, '').trim();
    searchName = searchName.replace(/[\s,]+$/, '').trim();
  }

  const massString = modifierNames.mass || "Mass";
  const strippedMass = stripModifierLiteral(searchName, massString);
  if (strippedMass.matched) {
    searchName = strippedMass.value;
  }
  
  const hasTargets = action.shared.targets && action.shared.targets.length > 0;
  
  const rangeUnits =
    action.shared?.nasSpellContext?.range?.range?.units ?? action.action?.range?.units;
  const targetValue = action.action?.target?.value;
  
  const isSelfTargeting = rangeUnits === "personal" || targetValue === "you";

  const casterLevel = getRuntimeCasterLevel(action);
  const buffSaveGate = resolveBuffSaveGate(action);

  const durationContext = action.shared?.nasSpellContext?.duration;
  const durationUnits = durationContext?.units ?? action.action?.duration?.units;

  const rawDurationValue = durationContext?.value ?? action.action?.duration?.value ?? '';

  let durationValue;
  let durationValueSource = "roll";
  if (durationContext?.evaluated?.total != null) {
    durationValue = durationContext.evaluated.total;
    durationValueSource = "context.evaluated.total";
  } else {
    try {
      durationValue = (await new Roll(rawDurationValue, action.shared.rollData).evaluate()).total;
      durationValueSource = "roll.evaluate";
    } catch (err) {
      console.warn(`${MODULE.ID} | Failed to evaluate duration formula "${rawDurationValue}". Using numeric fallback if possible.`, err);
      const numericFallback = Number(rawDurationValue);
      durationValue = Number.isNaN(numericFallback) ? 0 : numericFallback;
      durationValueSource = "numericFallback";
    }
  }

  let communalPromptForManual = false;
  let communalIncrement = null;
  let communalTotalDuration = null;
  let communalDurationUnit = null;
  let communalDurationFormula = null;

  if (isCommunal) {
    const communalHandling = game.settings.get(MODULE.ID, 'communalHandling');
    const communalParse = await parseCommunalDuration({
      action,
      durationUnits,
      rawDurationValue,
      casterLevel
    });

    if (communalParse && communalParse.totalDuration !== null) {
      communalIncrement = communalParse.increment;
      communalTotalDuration = communalParse.totalDuration;
      communalDurationUnit = communalParse.unit || durationUnits;
      communalDurationFormula = communalParse.formula;
      communalPromptForManual = communalHandling === 'prompt' || communalHandling === 'even';
    }
  }
  
  const areaString = action.action?.area;
  const measureTemplateEnabled = action.formData && action.formData["measure-template"];
  const templateSize = Number(action.action?.measureTemplate?.size || 0);
  const isAreaOfEffect = !!areaString || (measureTemplateEnabled && templateSize > 5);
      
  const configuredBuff = await resolveActionBuffAutomationBuff(automationState);
  if (automationState.selectedBuffUuid) {
    if (!configuredBuff) {
      ui.notifications?.warn?.(localizeNonConsecutiveBuff("actionBuffAutomationSelectedMissing", {
        item: item?.name ?? ""
      }));
      return;
    }
    await applySelectedBuffForAction({
      action,
      selectedBuff: configuredBuff,
      isSelfTargeting,
      isCommunal,
      durationUnits,
      durationValue,
      communalIncrement,
      communalTotalDuration,
      communalDurationUnit,
      communalPromptForManual,
      isAreaOfEffect,
      casterLevel,
      buffSaveGate
    });
    return;
  }
      
  const matchingBuffs = await findMatchingBuffs(searchName);
  
  if (matchingBuffs.length > 0) {
    if (!hasTargets && !isSelfTargeting) {
      const mode = game.settings.get(MODULE.ID, 'buffAutomationMode');
      
      if (mode === "strict") {
        console.warn(`${MODULE.ID} | Buff automation canceled: No targets selected for ${action.item.name}`);
        action.shared.reject = true;
        ui.notifications.warn(game.i18n.format('NAS.buffs.NoTargetsSelected', { name: action.item.name }));
        return;
      } else if (mode === "lenient") {
        console.warn(`${MODULE.ID} | Buff automation skipped: No targets selected for ${action.item.name}`);
        ui.notifications.info(game.i18n.format('NAS.buffs.UnableToApplyAutomaticBuffs', { name: action.item.name }));
      }
    }
    let selectedBuff = null;
    
    const categorizedMatches = categorizeBuffMatches(action.item.name, matchingBuffs, action);
    const hasActualKnownVariants = categorizedMatches.variants.some((buff) => !isKnownEnergyTypePlaceholderBuff(action, buff));
    
    if (categorizedMatches.exact.length === 1 && !hasActualKnownVariants) {
      selectedBuff = categorizedMatches.exact[0];
    } 
    else if (categorizedMatches.variants.length > 0) {
      const targetContext = await gatherTargetsForApplication({
        action,
        isSelfTargeting,
        isCommunal,
        durationUnits,
        durationValue,
        communalIncrement,
        communalTotalDuration,
        communalDurationUnit,
        communalPromptForManual,
        isAreaOfEffect,
        buffSaveGate,
        deferManualTargetSelection: true
      });
      if (targetContext.rejected) {
        notifyBuffTargetingRejection(action, targetContext.reason);
        return;
      }

      applyMaskFocusPerTargetDurationAdjustments(action, targetContext, durationUnits);
      applyNaniteBloodlineArcanaPerTargetDurationAdjustments(action, targetContext, durationUnits);

      const variantPlan = await promptBuffSelection(categorizedMatches.variants, action, {
        mode: 'variant',
        targets: targetContext.filteredTargets,
        perTargetDurations: targetContext.perTargetDurations,
        buffSaveGate
      });
      if (!variantPlan) {
        action.shared.reject = true;
        return;
      }

      const knownBuffAutomation = await promptKnownBuffAutomationForAction(action);
      if (knownBuffAutomation === null && action.shared?.reject !== true) {
        action.shared.reject = true;
        return;
      }

      await handleVariantPlanApplication({
        action,
        variants: categorizedMatches.variants,
        plan: variantPlan,
        targetContext,
        durationUnits,
        durationValue,
        casterLevel,
        knownBuffAutomation,
        buffSaveGate
      });
      return;
    }
    else if (categorizedMatches.versions.length > 0 && categorizedMatches.exact.length === 0) {
      const exactNameMatch = categorizedMatches.versions.find(
        b => b.name.toLowerCase() === action.item.name.toLowerCase()
      );
      
      if (exactNameMatch) {
        selectedBuff = exactNameMatch;
      } else {
        selectedBuff = await promptBuffSelection(categorizedMatches.versions, action);
        if (!selectedBuff) {
          action.shared.reject = true;
          return;
        }
      }
    }
    else if (matchingBuffs.length > 0) {
      selectedBuff = await promptBuffSelection(matchingBuffs, action);
      if (!selectedBuff) {
        action.shared.reject = true;
        return;
      }
    }
    
    if (selectedBuff) {
      await applySelectedBuffForAction({
        action,
        selectedBuff,
        isSelfTargeting,
        isCommunal,
        durationUnits,
        durationValue,
        communalIncrement,
        communalTotalDuration,
        communalDurationUnit,
        communalPromptForManual,
        isAreaOfEffect,
        casterLevel,
        buffSaveGate
      });
    }
  }
}

function categorizeBuffMatches(spellName, buffs, action = null) {
  const normalizedSpellName = spellName.toLowerCase();
  const result = {
    exact: [],    
    versions: [], 
    variants: []  
  };
  
  buffs.forEach(buff => {
    const buffName = buff.name.toLowerCase();
    
    if (buffName === normalizedSpellName) {
      result.exact.push(buff);
    } 
    else if (isKnownEnergyTypePlaceholderBuff(action, buff)) {
      result.exact.push(buff);
    }
    else if (buffName.includes('(') && buffName.includes(')')) {
      result.variants.push(buff);
    } 
    else if (buffName.includes(',')) {
      result.versions.push(buff);
    } 
    else {
      result.exact.push(buff);
    }
  });
  
  return result;
}

function isIntentionalPartialBuffMatch(buffName, normalizedName) {
  const candidate = String(buffName ?? "").trim().toLowerCase();
  if (!candidate || !normalizedName || candidate === normalizedName) return false;
  if (!candidate.startsWith(normalizedName)) return false;

  const suffix = candidate.slice(normalizedName.length).trimStart();
  return suffix.startsWith("(") || suffix.startsWith(",");
}

export async function findMatchingBuffs(name) {
  const normalizedName = name.toLowerCase();
  let exactMatches = [];
  let partialMatches = [];

  try {
    const customCompendia = game.settings.get(MODULE.ID, 'customBuffCompendia') || [];
    const useWorldBuffs = customCompendia.includes("__world__");
    const compendia = customCompendia.filter(packPath => packPath && packPath !== "__world__" && game.packs.get(packPath));

    for (const packKey of compendia) {
      const pack = game.packs.get(packKey);
      if (!pack) {
        console.warn(`${MODULE.ID} | Compendium ${packKey} not found`);
        continue;
      }

      const index = await pack.getIndex();

      const exactEntries = index.filter(i => i.name.toLowerCase() === normalizedName);
      const partialEntries = index.filter(i =>
        isIntentionalPartialBuffMatch(i.name, normalizedName) &&
        !exactEntries.some(em => em._id === i._id)
      );

      for (const entry of exactEntries) {
        const document = await pack.getDocument(entry._id);
        if (document.type !== "buff") continue;
        exactMatches.push({
          name: document.name,
          id: document.id,
          pack: packKey,
          document: document
        });
      }

      for (const entry of partialEntries) {
        const document = await pack.getDocument(entry._id);
        if (document.type !== "buff") continue;
        partialMatches.push({
          name: document.name,
          id: document.id,
          pack: packKey,
          document: document
        });
      }
    }

    let worldExactMatches = [];
    let worldPartialMatches = [];
    if (useWorldBuffs) {
      const worldBuffs = game.items.filter(item => item.type === "buff");
      worldExactMatches = worldBuffs.filter(item => item.name.toLowerCase() === normalizedName).map(item => ({
        name: item.name,
        id: item.id,
        pack: null,
        document: item
      }));
      worldPartialMatches = worldBuffs.filter(item =>
        isIntentionalPartialBuffMatch(item.name, normalizedName) &&
        !worldExactMatches.some(em => em.id === item.id)
      ).map(item => ({
        name: item.name,
        id: item.id,
        pack: null,
        document: item
      }));
    }

    if (exactMatches.length > 0 || worldExactMatches.length > 0) {
      return [...exactMatches, ...worldExactMatches];
    }

    if (partialMatches.length > 0 || worldPartialMatches.length > 0) {
      return [...partialMatches, ...worldPartialMatches];
    }

    function normalizeTokens(str) {
      return str
        .toLowerCase()
        .replace(/[,()]/g, '') 
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
    }

    const normalizedSpellTokens = normalizeTokens(name);

    for (const packKey of compendia) {
      const pack = game.packs.get(packKey);
      if (!pack) continue;
      const index = await pack.getIndex();
      for (const entry of index) {
        const buffTokens = normalizeTokens(entry.name);
        if (buffTokens === normalizedSpellTokens) {
          const document = await pack.getDocument(entry._id);
          if (document.type === "buff") {
            return [{
              name: document.name,
              id: document.id,
              pack: packKey,
              document: document
            }];
          }
        }
      }
    }
    if (useWorldBuffs) {
      const worldBuffs = game.items.filter(item => item.type === "buff");
      for (const item of worldBuffs) {
        const buffTokens = normalizeTokens(item.name);
        if (buffTokens === normalizedSpellTokens) {
          return [{
            name: item.name,
            id: item.id,
            pack: null,
            document: item
          }];
        }
      }
    }
  } catch (error) {
    console.error(`${MODULE.ID} | Error searching for buffs:`, error);
  }

  return [];
}

function applyMaskFocusPerTargetDurationAdjustments(action, targetContext, durationUnits) {
  const ctx = action.shared?.nasSpellContext;
  const mf = ctx?.duration?.maskFocusSelf;
  const active = ctx?.featEffects?.maskFocus?.active === true;
  if (!active || !mf || !action.token) return;

  const casterId = action.token.id;
  const unit = (mf.units ?? durationUnits ?? "").toString();
  const baseDur = { units: unit, value: String(mf.baseTotal) };
  const selfDur = { units: unit, value: String(mf.extendedSelfTotal) };

  const { filteredTargets, perTargetDurations } = targetContext;

  if (Array.isArray(perTargetDurations) && perTargetDurations.length > 0) {
    for (const entry of perTargetDurations) {
      if (entry?.target?.id === casterId && entry.duration) {
        entry.duration = {
          ...entry.duration,
          units: selfDur.units,
          value: selfDur.value
        };
      }
    }
    return;
  }

  if (!Array.isArray(filteredTargets) || filteredTargets.length === 0) return;

  if (filteredTargets.length === 1) {
    const only = filteredTargets[0];
    if (only.id === casterId) {
      targetContext.perTargetDurations = [{ target: only, duration: selfDur }];
    }
    return;
  }

  targetContext.perTargetDurations = filteredTargets.map((t) => ({
    target: t,
    duration: t.id === casterId ? selfDur : baseDur
  }));
}

function applyNaniteBloodlineArcanaPerTargetDurationAdjustments(action, targetContext, durationUnits) {
  const ctx = action.shared?.nasSpellContext;
  const nanite = ctx?.duration?.naniteBloodlineArcana;
  if (!nanite || !action.token) return;

  const casterId = action.token.id;
  const unit = (nanite.units ?? durationUnits ?? "").toString();
  const baseDur = { units: unit, value: String(nanite.baseTotal) };
  const doubledDur = { units: unit, value: String(nanite.extendedTotal) };
  const { filteredTargets, perTargetDurations } = targetContext;

  if (Array.isArray(perTargetDurations) && perTargetDurations.length > 0) {
    const onlyCaster =
      perTargetDurations.length === 1 &&
      perTargetDurations[0]?.target?.id === casterId;
    for (const entry of perTargetDurations) {
      if (!entry?.duration) continue;
      entry.duration = {
        ...entry.duration,
        units: onlyCaster ? doubledDur.units : baseDur.units,
        value: onlyCaster ? doubledDur.value : baseDur.value
      };
    }
    return;
  }

  if (!Array.isArray(filteredTargets) || filteredTargets.length === 0) return;

  const onlyCaster = filteredTargets.length === 1 && filteredTargets[0]?.id === casterId;
  targetContext.perTargetDurations = filteredTargets.map((target) => ({
    target,
    duration: onlyCaster ? doubledDur : baseDur
  }));
}

async function gatherTargetsForApplication({
  action,
  isSelfTargeting,
  isCommunal,
  durationUnits,
  durationValue,
  communalIncrement,
  communalTotalDuration,
  communalDurationUnit,
  communalPromptForManual,
  isAreaOfEffect,
  buffSaveGate = null,
  deferManualTargetSelection = false
}) {
  let filteredTargets = action.shared.targets || [];
  const filteringMode = game.settings.get(MODULE.ID, 'buffTargetFiltering');
  const personalTargeting = game.settings.get(MODULE.ID, 'personalTargeting');
  const shouldDeferManualTargetSelection = filteringMode === "manualSelection" && deferManualTargetSelection === true;
  let perTargetDurations = null;
  let rejectionReason = null;

  if (filteringMode === "byDisposition") {
    if (isSelfTargeting) {
      if (personalTargeting === 'deny') {
        filteredTargets = [action.token];
      } else {
        filteredTargets = filteredTargets.filter(target => {
          const targetDisposition = target.document ? target.document.disposition : target.disposition;
          const actionDisposition = action.token.disposition;
          return targetDisposition === actionDisposition;
        });
        if (!filteredTargets.some(t => t.id === action.token.id)) {
          filteredTargets.unshift(action.token);
        }
      }
    } else {
      const hadInitialTargets = Array.isArray(filteredTargets) && filteredTargets.length > 0;
      filteredTargets = filteredTargets.filter(target => {
        const targetDisposition = target.document ? target.document.disposition : target.disposition;
        const actionDisposition = action.token.disposition;
        return targetDisposition === actionDisposition;
      });
      if (hadInitialTargets && (!filteredTargets || filteredTargets.length === 0)) {
        rejectionReason = "dispositionFilteredAllTargets";
      }
      if (isCommunal) {
        perTargetDurations = await handleCommunalDuration({
          isCommunal,
          filteredTargets,
          durationUnits: communalDurationUnit || durationUnits,
          durationValue,
          communalIncrement,
          communalTotalDuration,
          communalDurationUnit,
          action
        });
        if (!perTargetDurations) return { rejected: true, reason: "communalDurationCancelled" };
      }
    }
  } else if (filteringMode === "manualSelection") {
    if (communalPromptForManual && communalIncrement && communalTotalDuration) {
      const communalResult = await promptTargetSelection(filteredTargets, action, {
        communal: true,
        increment: communalIncrement,
        total: communalTotalDuration,
        unit: communalDurationUnit || durationUnits
      });
      if (communalResult.length > 0 && communalResult[0].target && communalResult[0].duration !== undefined) {
        perTargetDurations = communalResult;
      } else {
        filteredTargets = communalResult;
      }
    } else {
      if (isSelfTargeting) {
        if (personalTargeting === 'deny') {
          filteredTargets = [action.token];
        } else {
          if (!filteredTargets.some(t => t.id === action.token.id)) {
            filteredTargets.unshift(action.token);
          }
          if (isCommunal) {
            filteredTargets = await promptTargetSelection(filteredTargets, action, { communal: isCommunal });
          } else if (!shouldDeferManualTargetSelection) {
            filteredTargets = await promptTargetSelection(filteredTargets, action, { buffSaveGate });
          }
        }
      } else {
        if (isCommunal) {
          perTargetDurations = await handleCommunalDuration({
            isCommunal,
            filteredTargets,
            durationUnits: communalDurationUnit || durationUnits,
            durationValue,
            communalIncrement,
            communalTotalDuration,
            communalDurationUnit,
            action
          });
          if (!perTargetDurations) return { rejected: true, reason: "communalDurationCancelled" };
        } else if (!shouldDeferManualTargetSelection) {
          filteredTargets = await promptTargetSelection(filteredTargets, action, { buffSaveGate });
          if ((!filteredTargets || filteredTargets.length === 0) && game.settings.get(MODULE.ID, 'buffAutomationMode') === "strict") {
            return { rejected: true, reason: "manualSelectionCancelled" };
          }
        }
      }
    }
  } else {
    if (isSelfTargeting) {
      if (personalTargeting === 'deny') {
        filteredTargets = [action.token];
      } else {
        if (!filteredTargets.some(t => t.id === action.token.id)) {
          filteredTargets.unshift(action.token);
        }
      }
    } else {
      if (isCommunal) {
        perTargetDurations = await handleCommunalDuration({
          isCommunal,
          filteredTargets,
          durationUnits: communalDurationUnit || durationUnits,
          durationValue,
          communalIncrement,
          communalTotalDuration,
          communalDurationUnit,
          action
        });
        if (!perTargetDurations) return { rejected: true, reason: "communalDurationCancelled" };
      }
    }
  }

  if ((!filteredTargets || filteredTargets.length === 0) && game.settings.get(MODULE.ID, 'buffAutomationMode') === "strict") {
    action.shared.reject = true;
    return { rejected: true, reason: rejectionReason || "noTargetsStrict" };
  }

  const slotInfo = checkAndConsumeSpellSlots({
    action,
    filteredTargets,
    isCommunal,
    isAreaOfEffect
  });
  if (slotInfo && slotInfo.rejected) return { rejected: true, reason: "spellSlots" };

  return { filteredTargets, perTargetDurations, slotInfo, rejected: false, manualSelection: filteringMode === "manualSelection" };
}

function notifyBuffTargetingRejection(action, reason) {
  if (!action) return;
  if (reason === "spellSlots") return; 

  const map = {
    noTargetsStrict: "NAS.buffs.TargetingRejectedNoTargetsStrict",
    dispositionFilteredAllTargets: "NAS.buffs.TargetingRejectedDisposition",
    manualSelectionCancelled: "NAS.buffs.TargetingRejectedManualSelection",
    communalDurationCancelled: "NAS.buffs.TargetingRejectedCommunalSelection",
  };

  const messageKey = map[reason] || "NAS.buffs.TargetingRejectedUnknown";
  ui.notifications.warn(game.i18n.format(messageKey, { name: action.item?.name ?? "" }));
}

export async function promptBuffSelection(buffs, action, options = {}) {
  if (!buffs || buffs.length === 0) return null;
  const mode = options.mode || 'simple';

  if (mode === 'variant') {
    const targets = options.targets || [];
    const spellKey = getSpellKey(action);
    const mappings = game.settings.get(MODULE.ID, 'pairedBuffMappings') || {};
    const remembered = mappings[spellKey] || {};
    const variantCapMode = game.settings.get(MODULE.ID, 'variantTargetCap') || 'hint';
    const casterLevel = getRuntimeCasterLevel(action);
    const parsedCap = estimateScalableTargets(
      action.action?.target?.value ||
      action.item?.system?.actions?.[0]?.target?.value ||
      action.item?.system?.target?.value,
      casterLevel
    );
    const targetCap = parsedCap && parsedCap > 0 ? parsedCap : null;

    const variantLabels = buffs.map(b => {
      const paren = b.name.match(/\(([^)]+)\)/);
      return paren ? paren[1].trim() : b.name;
    });

    const findVariantIndex = (ref) => {
      if (!ref) return null;
      const idx = buffs.findIndex(b => b.id === ref.id && (b.pack || null) === (ref.pack || null));
      return idx >= 0 ? idx : null;
    };

    const renderOptions = (selectedIdx = 0) => variantLabels.map((lbl, idx) =>
      `<option value="${idx}" ${idx === selectedIdx ? 'selected' : ''}>${lbl}</option>`
    ).join('');

    const allyDefaultIdx = findVariantIndex(remembered.allies) ?? 0;
    const foeDefaultIdx = findVariantIndex(remembered.foes) ?? 0;

    const latestBuffSaveGate = resolveBuffSaveGate(action);
    const buffSaveGate = options.buffSaveGate
      ? {
        ...latestBuffSaveGate,
        ...options.buffSaveGate,
        dc: options.buffSaveGate.dc ?? latestBuffSaveGate.dc,
        saveType: options.buffSaveGate.saveType ?? latestBuffSaveGate.saveType,
        mode: options.buffSaveGate.mode ?? latestBuffSaveGate.mode,
        alliesBypass: options.buffSaveGate.alliesBypass ?? latestBuffSaveGate.alliesBypass,
        deferred: options.buffSaveGate.deferred ?? latestBuffSaveGate.deferred
      }
      : latestBuffSaveGate;
    const saveType = normalizeSaveType(buffSaveGate?.saveType);
    const saveMode = normalizeBuffSaveHandlingMode(buffSaveGate?.mode);
    const saveDc = coerceNumberOrNull(buffSaveGate?.dc);
    const isSaveGatedVariant = buffSaveGate?.deferred === true && REAL_SAVE_TYPES.has(saveType) && saveMode !== "ignore";
    const controlStyle = nasDialogControlStyle();
    const secretColor = "#7b2cff";
    const neutralColor = "#b58900";

    const stateCanBeEnabled = (state) => !isSaveGatedVariant || state.bypassed || state.saveTotal != null;
    const defaultEnabledForSaveState = (state) => {
      if (!isSaveGatedVariant) return true;
      if (state.bypassed) return true;
      if (state.saveSucceeded == null) return false;
      return saveMode === "failed" ? state.saveSucceeded === false : state.saveSucceeded === true;
    };
    const stateGroups = (state) => {
      const groups = new Set(targetFilterGroups(state.target, action.token));
      if (state.enabled) groups.add("eligible");
      if (state.bypassed) groups.add("bypassed");
      if (state.saveSucceeded === true) groups.add("successful");
      if (state.saveSucceeded === false) groups.add("failed");
      if (isSaveGatedVariant && !state.bypassed && state.saveTotal == null) groups.add("needs");
      return [...groups];
    };
    const stateMatchesGroup = (state, group) => group === "visible"
      ? state.rendered
      : stateGroups(state).includes(group);
    const updateStateAfterSave = (state, total) => {
      state.saveTotal = coerceNumberOrNull(total);
      state.saveSucceeded = state.saveTotal == null ? null : state.saveTotal >= saveDc;
      state.enabled = defaultEnabledForSaveState(state);
    };

    const targetStates = targets.map((target, index) => {
      const isSameDisposition = targetIsAllyToCaster(target, action.token);
      const rememberedEntry = remembered?.perTarget?.find?.(pt => (pt.actorId && pt.actorId === target.actor?.id) || (pt.tokenId && pt.tokenId === target.id));
      const rememberedVariantIdx = typeof rememberedEntry?.variantIndex === "number" ? rememberedEntry.variantIndex : (isSameDisposition ? allyDefaultIdx : foeDefaultIdx);
      const rememberedApplyTiming = rememberedEntry?.applyTiming || (rememberedEntry?.applyOnTurn ? "turn" : "cast");
      const secret = targetIsSecretForAutomation(target, action.token);
      const bypassed = isSaveGatedVariant && buffSaveGate?.alliesBypass === true && isSameDisposition;
      const state = {
        target,
        index,
        key: targetAppliedKey(target),
        actorId: target.actor?.id ?? tokenDocumentFromTarget(target)?.actor?.id ?? "",
        rendered: game.user?.isGM === true || !secret,
        secret,
        bypassed,
        saveTotal: null,
        saveSucceeded: null,
        variantIndex: Number.isFinite(rememberedVariantIdx) ? rememberedVariantIdx : 0,
        applyTiming: rememberedApplyTiming === "turn" ? "turn" : "cast",
        enabled: true
      };
      state.enabled = isSaveGatedVariant ? defaultEnabledForSaveState(state) : (targetCap ? index < targetCap : true);
      return state;
    });

    const renderedStates = () => targetStates.filter((state) => state.rendered);
    const renderUnifiedFilters = () => {
      const filterDefs = [
        ["all", "NAS.buffs.TargetFilterAll"],
        ["allies", "NAS.buffs.TargetFilterAllies"],
        ["enemies", "NAS.buffs.TargetFilterEnemies"],
        ["neutral", "NAS.buffs.TargetFilterNeutral"],
        ...(game.user?.isGM ? [["hidden", "NAS.buffs.TargetFilterHidden"]] : []),
        ...(isSaveGatedVariant ? [
          ["needs", "NAS.buffs.TargetFilterNeedsSave"],
          ["failed", "NAS.buffs.TargetFilterFailed"],
          ["successful", "NAS.buffs.TargetFilterSuccessful"],
          ["bypassed", "NAS.buffs.TargetFilterBypassed"]
        ] : [])
      ];
      const visibleStates = renderedStates();
      return filterDefs
        .filter(([filter]) => filter === "all" || visibleStates.some((state) => stateGroups(state).includes(filter)))
        .map(([filter, labelKey], index) => `<a href="#" role="button" data-nas-target-filter="${filter}" class="nas-dialog-control ${index === 0 ? "active" : ""}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`)
        .join("");
    };
    let bulkVariantIndex = 0;
    let targetBulkMoreOpen = false;
    let variantBulkMoreOpen = false;
    const variantBulkButtons = () => {
      const commonDefs = [
        ["visible", "NAS.buffs.TargetSetVariantVisible"],
        ...(isSaveGatedVariant ? [
          ["failed", "NAS.buffs.TargetSetVariantFailed"],
          ["successful", "NAS.buffs.TargetSetVariantSuccessful"]
        ] : [])
      ];
      const moreDefs = [
        ["allies", "NAS.buffs.TargetSetVariantAllies"],
        ["enemies", "NAS.buffs.TargetSetVariantEnemies"],
        ["neutral", "NAS.buffs.TargetSetVariantNeutral"],
        ...(game.user?.isGM ? [["hidden", "NAS.buffs.TargetSetVariantSecret"]] : []),
        ...(isSaveGatedVariant ? [
          ["needs", "NAS.buffs.TargetSetVariantNeedsSave"],
          ["bypassed", "NAS.buffs.TargetSetVariantBypassed"]
        ] : [])
      ];
      const commonButtons = commonDefs.map(([group, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-variant-bulk="${group}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`).join("");
      const moreButtons = moreDefs.map(([group, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-variant-bulk="${group}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`).join("");
      return `
        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          <select id="ic-bulk-variant" style="min-width:130px;">${renderOptions(bulkVariantIndex)}</select>
          ${commonButtons}
        </div>
        ${moreButtons ? `<details class="nas-variant-bulk-more" ${variantBulkMoreOpen ? "open" : ""}><summary style="cursor:pointer; width:max-content;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkMore"))}</summary><div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">${moreButtons}</div></details>` : ""}
      `;
    };
    const targetBulkButtons = () => {
      const selectCommonDefs = [
        ["select", "NAS.buffs.TargetSelectVisible"],
        ...(isSaveGatedVariant ? [
          ["selectFailed", "NAS.buffs.TargetSelectFailed"],
          ["selectSuccessful", "NAS.buffs.TargetSelectSaved"]
        ] : [])
      ];
      const deselectCommonDefs = [
        ["deselect", "NAS.buffs.TargetDeselectVisible"],
        ...(isSaveGatedVariant ? [
          ["deselectFailed", "NAS.buffs.TargetDeselectFailed"],
          ["deselectSuccessful", "NAS.buffs.TargetDeselectSaved"]
        ] : [])
      ];
      const selectMoreDefs = [
        ["selectAllies", "NAS.buffs.TargetSelectAllies"],
        ["selectNeutral", "NAS.buffs.TargetSelectNeutral"],
        ["selectEnemies", "NAS.buffs.TargetSelectEnemies"]
      ];
      const deselectMoreDefs = [
        ["deselectAllies", "NAS.buffs.TargetDeselectAllies"],
        ["deselectNeutral", "NAS.buffs.TargetDeselectNeutral"],
        ["deselectEnemies", "NAS.buffs.TargetDeselectEnemies"]
      ];
      const selectCommonButtons = selectCommonDefs.map(([actionName, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="${actionName}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`).join("");
      const deselectCommonButtons = deselectCommonDefs.map(([actionName, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="${actionName}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`).join("");
      const moreButtons = [
        ...selectMoreDefs.map(([actionName, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="${actionName}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`),
        ...deselectMoreDefs.map(([actionName, labelKey]) => `<a href="#" role="button" class="nas-dialog-control" data-nas-target-bulk="${actionName}" style="${controlStyle}">${escapeHtml(game.i18n.localize(labelKey))}</a>`)
      ].join("");
      return `
        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          <strong style="min-width:56px;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkSelectLabel"))}</strong>
          ${selectCommonButtons}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          <strong style="min-width:56px;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkDeselectLabel"))}</strong>
          ${deselectCommonButtons}
        </div>
        <details class="nas-target-bulk-more" ${targetBulkMoreOpen ? "open" : ""}><summary style="cursor:pointer; width:max-content;">${escapeHtml(game.i18n.localize("NAS.buffs.TargetBulkMore"))}</summary><div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px;">${moreButtons}</div></details>
      `;
    };
    const renderUnifiedControls = () => `
      <div class="nas-target-selection-controls" style="display:flex; flex-direction:column; gap:8px; margin:8px 0;">
        <div class="nas-target-filters" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">${renderUnifiedFilters()}</div>
        <div class="nas-target-bulk" style="display:flex; flex-direction:column; gap:6px; align-items:flex-start;">
          ${targetBulkButtons()}
        </div>
        <div class="nas-target-variant-bulk" style="display:flex; flex-direction:column; gap:6px; align-items:flex-start;">
          ${variantBulkButtons()}
        </div>
        ${isSaveGatedVariant ? `<div class="nas-target-save-bulk" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          <a href="#" role="button" class="nas-dialog-control" data-nas-save-roll="visible" style="${controlStyle}"><i class="fas fa-dice-d20"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RollSavesVisible"))}</a>
          <a href="#" role="button" class="nas-dialog-control" data-nas-save-roll="all" style="${controlStyle}"><i class="fas fa-dice"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RollSavesAllPending"))}</a>
          <a href="#" role="button" class="nas-dialog-control" data-nas-save-refresh="true" style="${controlStyle}"><i class="fas fa-sync"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RefreshSaveResults"))}</a>
        </div>` : ""}
      </div>
    `;
    const renderTargetCard = (state) => {
      const target = state.target;
      const tokenName = target.name || target.actor?.name || `Target ${state.index + 1}`;
      const tokenImg = target.document?.texture?.src || target.texture?.src || target.actor?.img || "";
      const isSameDisposition = targetIsAllyToCaster(target, action.token);
      const groups = stateGroups(state);
      const statusLabel = isSaveGatedVariant ? pendingTargetStatusLabel(state) : targetDispositionLabel(target, action.token);
      const saveText = isSaveGatedVariant && state.saveTotal != null ? ` ${escapeHtml(String(state.saveTotal))}` : "";
      const checkboxDisabled = stateCanBeEnabled(state) ? "" : "disabled";
      const targetDisposition = targetDispositionValue(target);
      const dispositionColor = game.user?.isGM === true && state.secret === true
        ? secretColor
        : targetDisposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL
          ? neutralColor
          : (isSameDisposition ? "green" : "red");
      return `
        <div class="target-option nas-target-option" data-target-index="${state.index}" data-nas-target-groups="${escapeHtml(groups.join(" "))}" style="display:flex; flex-direction:column; align-items:center; width:150px; border:1px solid ${dispositionColor}; border-radius:6px; padding:6px; gap:4px;">
          <input type="checkbox" class="ic-target-enabled" id="ic-target-enabled-${state.index}" ${state.enabled ? "checked" : ""} ${checkboxDisabled} style="margin:0;"/>
          <img src="${tokenImg}" style="width:64px; height:64px; border:2px solid ${dispositionColor}; border-radius:5px; object-fit:cover;" />
          <label for="ic-target-enabled-${state.index}" style="font-weight:600; text-align:center; line-height:1.15;">${escapeHtml(tokenName)}</label>
          <select id="ic-target-variant-${state.index}" class="ic-target-variant" style="width:100%;">${renderOptions(state.variantIndex)}</select>
          <div class="ic-target-timing" style="display:${state.applyTiming && state.applyTiming.length ? "flex" : "flex"}; gap:8px; align-items:center; justify-content:center; font-size:0.85em;">
            <label style="display:flex; gap:3px; align-items:center;" title="${game.i18n.localize("NAS.buffs.ApplyOnCastTooltip") || "Apply immediately on cast"}">
              <input type="radio" name="ic-target-timing-${state.index}" value="cast" ${state.applyTiming === "turn" ? "" : "checked"}/>
              ${game.i18n.localize("NAS.buffs.ApplyOnCastShort") || "On cast"}
            </label>
            <label style="display:flex; gap:3px; align-items:center;" title="${game.i18n.localize("NAS.buffs.ApplyOnTurnTooltip") || "Apply at the start of the target's turn"}">
              <input type="radio" name="ic-target-timing-${state.index}" value="turn" ${state.applyTiming === "turn" ? "checked" : ""}/>
              ${game.i18n.localize("NAS.buffs.ApplyOnTurnShort") || "On turn"}
            </label>
          </div>
          <small style="color:${dispositionColor}; text-align:center;">${escapeHtml(targetDispositionLabel(target, action.token))}</small>
          ${isSaveGatedVariant ? `<small style="text-align:center;">${escapeHtml(statusLabel)}${saveText}</small>` : ""}
        </div>
      `;
    };
    const renderTargetCards = () => renderedStates().map(renderTargetCard).join("") || `<p>${escapeHtml(game.i18n.localize("NAS.buffs.NoVisibleTargets"))}</p>`;
    let activeUnifiedFilter = "all";
    const readRenderedTargetState = (html) => {
      const $html = typeof html.find === "function" ? html : $(html);
      for (const state of renderedStates()) {
        const enabledEl = $html.find(`#ic-target-enabled-${state.index}`);
        if (enabledEl.length && !enabledEl.prop("disabled")) state.enabled = enabledEl.prop("checked") === true;
        const variantEl = $html.find(`#ic-target-variant-${state.index}`);
        if (variantEl.length) {
          const variantIndex = Number(variantEl.val());
          if (Number.isInteger(variantIndex) && buffs[variantIndex]) state.variantIndex = variantIndex;
        }
        const timingEl = $html.find(`input[name="ic-target-timing-${state.index}"]:checked`);
        if (timingEl.length) state.applyTiming = timingEl.val() === "turn" ? "turn" : "cast";
      }
    };
    const readBulkVariantState = ($html) => {
      const variantIndex = Number($html.find("#ic-bulk-variant").val());
      if (Number.isInteger(variantIndex) && buffs[variantIndex]) bulkVariantIndex = variantIndex;
    };
    const readMoreState = ($html) => {
      const targetDetails = $html.find(".nas-target-bulk-more")?.[0];
      const variantDetails = $html.find(".nas-variant-bulk-more")?.[0];
      if (targetDetails) targetBulkMoreOpen = targetDetails.open === true;
      if (variantDetails) variantBulkMoreOpen = variantDetails.open === true;
    };
    const updateCapHint = ($html) => {
      if (!targetCap) return;
      const visibleForUser = game.user?.isGM ? targetStates : renderedStates();
      const enabledCount = visibleForUser.filter((state) => state.enabled).length;
      const remaining = Math.max(targetCap - enabledCount, 0);
      const hintEl = $html.find("#ic-cap-hint");
      if (hintEl.length) {
        hintEl.text(game.i18n.format("NAS.buffs.TargetCapHintRemaining", { cap: targetCap, remaining }));
        hintEl.css("color", enabledCount > targetCap ? "red" : "");
      }
    };
    const applyUnifiedFilter = ($html, filter = activeUnifiedFilter) => {
      activeUnifiedFilter = filter;
      $html.find("[data-nas-target-filter]").removeClass("active").css({
        "box-shadow": "",
        "border-color": "var(--color-border-light-primary, #999)"
      });
      $html.find(`[data-nas-target-filter="${filter}"]`).addClass("active").css({
        "box-shadow": "0 0 4px red",
        "border-color": "red"
      });
      $html.find(".nas-target-option").each((_index, el) => {
        const groups = String(el.dataset.nasTargetGroups ?? "").split(/\s+/);
        const visible = filter === "all" || groups.includes(filter);
        el.style.display = visible ? "flex" : "none";
      });
    };
    const refreshUnifiedDialog = ($html, dialog = null, { read = true } = {}) => {
      readBulkVariantState($html);
      readMoreState($html);
      if (read) readRenderedTargetState($html);
      $html.find("#ic-unified-target-controls").html(renderUnifiedControls());
      $html.find("#ic-target-section").html(renderTargetCards());
      wireUnifiedDialog($html, dialog);
      applyUnifiedFilter($html, activeUnifiedFilter);
      updateCapHint($html);
      const allowSwitching = $html.find("#ic-allow-switching").prop("checked") === true;
      $html.find(".ic-target-timing").css("display", allowSwitching ? "flex" : "none");
      dialog?.setPosition?.({ height: "auto" });
    };
    const visibleRenderedStatesForDialog = ($html) => renderedStates().filter((state) => {
      const el = $html.find(`.nas-target-option[data-target-index="${state.index}"]`)?.[0];
      return el && el.style.display !== "none";
    });
    const rollUnifiedSaveStates = async ($html, dialog, statesToRoll) => {
      readRenderedTargetState($html);
      if (isSaveGatedVariant && saveDc == null) {
        ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveDcMissing"));
        return;
      }
      for (const state of statesToRoll) {
        if (!state || state.bypassed || state.saveTotal != null) continue;
        const targetRef = serializePendingTarget(state.target, null);
        const total = await rollBuffSaveForTargetRef(targetRef, state.target, saveType, saveDc, {
          hiddenMessage: state.secret === true,
          privateRoll: state.secret !== true
        });
        if (total != null) updateStateAfterSave(state, total);
      }
      refreshUnifiedDialog($html, dialog);
    };
    const setStatesEnabled = (statesToUpdate, enabled) => {
      for (const state of statesToUpdate) {
        if (stateCanBeEnabled(state)) state.enabled = enabled;
      }
    };
    const validateUnifiedApply = ($html, { warn = true } = {}) => {
      readRenderedTargetState($html);
      if (isSaveGatedVariant && saveDc == null) {
        if (warn) ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveDcMissing"));
        return false;
      }
      const unresolvedSaveStates = isSaveGatedVariant
        ? targetStates.filter((state) => !state.bypassed && state.saveTotal == null)
        : [];
      if (unresolvedSaveStates.length > 0) {
        if (warn) ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveResultsRequired"));
        return false;
      }
      if (targetCap && variantCapMode === 'enforce') {
        const enabledCount = targetStates.filter((state) => state.enabled === true).length;
        if (enabledCount > targetCap) {
          if (warn) ui.notifications.warn(game.i18n.format('NAS.buffs.TargetCapExceeded', { cap: targetCap }));
          return false;
        }
      }
      return true;
    };
    const wireUnifiedApplyValidation = ($html, dialog) => {
      const button = dialog?.element?.find?.("button[data-button='apply']")?.[0]
        ?? dialog?.element?.[0]?.querySelector?.("button[data-button='apply']");
      if (!button || button.dataset.nasApplyValidationWired === "true") return;
      button.dataset.nasApplyValidationWired = "true";
      button.addEventListener("click", (event) => {
        if (validateUnifiedApply($html, { warn: true })) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    };
    const wireUnifiedDialog = (html, dialog = null) => {
      const $html = typeof html.find === "function" ? html : $(html);
      $html.find("[data-nas-target-filter]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyUnifiedFilter($html, event.currentTarget.dataset.nasTargetFilter);
        dialog?.setPosition?.({ height: "auto" });
      });
      $html.find(".ic-target-enabled, .ic-target-variant, input[name^='ic-target-timing-']").off("change").on("change", () => {
        readRenderedTargetState($html);
        updateCapHint($html);
      });
      $html.find("#ic-bulk-variant").off("change").on("change", () => {
        readBulkVariantState($html);
      });
      $html.find(".nas-target-bulk-more").off("toggle").on("toggle", (event) => {
        targetBulkMoreOpen = event.currentTarget.open === true;
      });
      $html.find(".nas-variant-bulk-more").off("toggle").on("toggle", (event) => {
        variantBulkMoreOpen = event.currentTarget.open === true;
      });
      $html.find("[data-nas-target-bulk]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        readRenderedTargetState($html);
        const actionName = event.currentTarget.dataset.nasTargetBulk;
        const selectGroups = {
          selectAllies: "allies",
          selectNeutral: "neutral",
          selectEnemies: "enemies",
          selectSuccessful: "successful",
          selectFailed: "failed"
        };
        const deselectGroups = {
          deselectAllies: "allies",
          deselectNeutral: "neutral",
          deselectEnemies: "enemies",
          deselectSuccessful: "successful",
          deselectFailed: "failed"
        };
        if (actionName === "select") setStatesEnabled(visibleRenderedStatesForDialog($html), true);
        else if (actionName === "deselect") setStatesEnabled(visibleRenderedStatesForDialog($html), false);
        else if (selectGroups[actionName]) setStatesEnabled(targetStates.filter((state) => stateGroups(state).includes(selectGroups[actionName])), true);
        else if (deselectGroups[actionName]) setStatesEnabled(targetStates.filter((state) => stateGroups(state).includes(deselectGroups[actionName])), false);
        refreshUnifiedDialog($html, dialog, { read: false });
      });
      $html.find("[data-nas-variant-bulk]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        readRenderedTargetState($html);
        const variantIndex = Number($html.find("#ic-bulk-variant").val());
        if (!Number.isInteger(variantIndex) || !buffs[variantIndex]) return;
        bulkVariantIndex = variantIndex;
        const group = event.currentTarget.dataset.nasVariantBulk;
        const statesToUpdate = group === "visible" ? visibleRenderedStatesForDialog($html) : targetStates.filter((state) => stateMatchesGroup(state, group));
        for (const state of statesToUpdate) state.variantIndex = variantIndex;
        refreshUnifiedDialog($html, dialog, { read: false });
      });
      $html.find("[data-nas-save-roll]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const mode = event.currentTarget.dataset.nasSaveRoll;
        const candidates = mode === "visible" ? visibleRenderedStatesForDialog($html) : targetStates;
        void rollUnifiedSaveStates($html, dialog, candidates.filter((state) => !state.bypassed && state.saveTotal == null));
      });
      $html.find("[data-nas-save-refresh]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshUnifiedDialog($html, dialog);
      });
    };

    const initialSwitching = !!remembered?.allowSwitching;
    let content = `<p>${game.i18n.localize('NAS.buffs.SelectBuffVariant')}: ${action.item?.name || game.i18n.localize('NAS.buffs.SpellFallback')}</p>`;
    content += `
      <div class="form-group" style="display:flex; gap:8px; align-items:center; margin-top:6px;">
        <input type="checkbox" id="ic-allow-switching" ${initialSwitching ? 'checked' : ''}/>
        <label for="ic-allow-switching">${game.i18n.localize('NAS.buffs.AllowSwitchingEachRound')}</label>
      </div>
      ${targetCap ? `<div id="ic-cap-hint" style="margin: 6px 0; color: var(--color-text);">${game.i18n.format('NAS.buffs.TargetCapHintRemaining', { cap: targetCap, remaining: targetCap })}</div>` : ''}
      <div id="ic-unified-target-controls">${renderUnifiedControls()}</div>
      <div id="ic-target-section" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(145px, 150px)); gap: 10px; justify-content:flex-start; border:1px solid #ccc; padding:8px; border-radius:6px; max-height: 430px; overflow-y:auto;">
        ${renderTargetCards()}
      </div>
      <div class="form-group" style="display: flex; align-items: center; gap: 6px; margin-top: 8px;">
        <label style="display: inline-flex; align-items: center; gap: 6px; margin: 0;">
          <input type="checkbox" id="ic-remember-mapping" style="margin: 0;"/>
          ${game.i18n.localize('NAS.buffs.RememberForSpell')}
        </label>
      </div>
    `;

    return new Promise(resolve => {
      const dlg = new Dialog({
        title: game.i18n.localize('NAS.buffs.SelectBuffVariant'),
        content,
        buttons: {
          apply: {
            icon: '<i class="fas fa-check"></i>',
            label: game.i18n.localize('NAS.buffs.ApplyBuff'),
            callback: html => {
              const getEl = (sel) => typeof html.find === 'function' ? html.find(sel) : html.querySelector(sel);
              const allowSwitchingEl = getEl('#ic-allow-switching');
              const rememberEl = getEl('#ic-remember-mapping');

              const allowSwitching = allowSwitchingEl ? (allowSwitchingEl.checked ?? allowSwitchingEl.prop?.('checked')) : false;
              const remember = rememberEl ? (rememberEl.checked ?? rememberEl.prop?.('checked')) : false;

              if (!validateUnifiedApply(typeof html.find === "function" ? html : $(html), { warn: true })) return false;
              const perTarget = [];
              if (targets.length > 0) {
                let enabledCount = 0;
                targetStates.forEach((state) => {
                  const enabled = state.enabled === true;
                  if (enabled) enabledCount += 1;
                  perTarget.push({
                    targetId: state.target.id,
                    actorId: state.target.actor?.id,
                    variantIndex: state.variantIndex,
                    applyTiming: state.applyTiming,
                    enabled
                  });
                });

                if (targetCap && enabledCount > targetCap && variantCapMode === 'enforce') {
                  ui.notifications.warn(game.i18n.format('NAS.buffs.TargetCapExceeded', { cap: targetCap }));
                  return false;
                }
              }

      const result = {
                allies: null,
                foes: null,
                allowSwitching,
                remember,
        perTarget,
                applyAllies: true,
                applyFoes: true,
                variants: buffs,
                resolvedManualSelection: isSaveGatedVariant,
                targetSaveResults: new Map(targetStates
                  .filter((state) => state.saveTotal != null)
                  .map((state) => [state.key, { [saveType]: state.saveTotal }])),
                saveResultTargets: targetStates
                  .filter((state) => state.saveTotal != null && state.secret !== true)
                  .map((state) => ({ target: state.target, saveResults: { [saveType]: state.saveTotal } })),
                publicSaveResultsOnly: isSaveGatedVariant
      };

      resolve(result);
            }
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: game.i18n.localize('NAS.common.buttons.cancel'),
            callback: () => resolve(null)
          }
        },
        default: "apply",
        close: () => resolve(null),
        render: html => {
          const $html = typeof html.find === 'function' ? html : $(html);
          const relayout = () => dlg.setPosition({ height: 'auto' });
          wireUnifiedDialog($html, dlg);
          wireUnifiedApplyValidation($html, dlg);
          applyUnifiedFilter($html, activeUnifiedFilter);
          $html.find(".ic-target-timing").css("display", initialSwitching ? "flex" : "none");
          $html.find('#ic-allow-switching').on('change', ev => {
            const checked = ev.currentTarget.checked;
            $html.find(".ic-target-timing").css("display", checked ? "flex" : "none");
            relayout();
          });
          updateCapHint($html);
          setTimeout(relayout, 0);
        }
      }, { width: (() => {
        const cols = Math.min(Math.max(renderedStates().length || 1, 1), 5);
        const card = 150;
        const gap = 10;
        const chrome = 150; 
        return Math.max(400, cols * card + (cols - 1) * gap + chrome);
      })() });
      dlg.render(true);
    });
  }

  if (buffs.length === 1) return buffs[0];

  return new Promise(resolve => {
    const baseItemName = action.item.name;
    let content = `<p>${game.i18n.format('NAS.buffs.MultipleBuffOptionsFound', { name: baseItemName })}</p>`;
    content += `<div class="form-group"><select id="buff-select" name="buff-select" style="width: 100%;">`;
    buffs.forEach((buff, index) => {
      let displayName = buff.name;
      const match = buff.name.match(/\((.*?)\)/);
      if (match) displayName = match[1];
      else if (buff.name.includes(',')) displayName = buff.name;
      const pack = game.packs.get(buff.pack);
      let packName = buff.pack;
      if (pack) {
        const label = pack.metadata.label;
        packName = label && label.includes('.') ? game.i18n.localize(label) : label;
      }
      content += `<option value="${index}">${displayName} (${packName})</option>`;
    });
    content += `</select></div>`;
    const dialog = new Dialog({
      title: game.i18n.localize('NAS.buffs.SelectBuffVariant'),
      content: content,
      buttons: {
        select: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize('NAS.common.buttons.select'),
          callback: html => {
            let selectedIndex;
            if (typeof html.find === 'function') {
              selectedIndex = Number(html.find('#buff-select').val());
            } else {
              const select = html.querySelector('#buff-select');
              selectedIndex = select ? Number(select.value) : 0;
            }
            resolve(buffs[selectedIndex]);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize('NAS.common.buttons.cancel'),
          callback: () => resolve(null)
        }
      },
      default: "select",
      close: () => resolve(null)
    });
    dialog.render(true);
  });
}

export async function promptTargetSelection(targets, action, communalOptions = null) {
  const promptOptions = communalOptions && communalOptions.communal ? {} : (communalOptions ?? {});
  const buffSaveGate = promptOptions.buffSaveGate ?? null;
  const allTargets = Array.isArray(targets) ? targets : [];
  const visibleTargets = game.user?.isGM === true
    ? allTargets
    : allTargets.filter((target) => !targetIsSecretForAutomation(target, action.token));
  let filteredTargets = visibleTargets;

  const useEnhancedCommunalDialog = communalOptions &&
    communalOptions.communal &&
    communalOptions.increment &&
    communalOptions.total &&
    communalOptions.unit;

  if (useEnhancedCommunalDialog) {
    const communalHandling = game.settings.get(MODULE.ID, 'communalHandling');
    const increment = communalOptions.increment;
    const total = communalOptions.total;
    const unit = communalOptions.unit;
    const n = filteredTargets.length;
    if (n <= 0) return [];
    const perTargetEven = Math.floor(total / n / increment) * increment;
    const isDivisible = perTargetEven > 0 && (perTargetEven * n === total);
    if (communalHandling === 'even' && isDivisible) {
      return filteredTargets.map(target => ({ target, duration: { value: perTargetEven, units: unit } }));
    }
    let perTarget = Math.floor(total / n / increment) * increment;
    let assigned = Array(n).fill(perTarget);
    let assignedTotal = perTarget * n;
    let remaining = total - assignedTotal;
    for (let i = 0; i < n && remaining >= increment; i++) {
      assigned[i] += increment;
      remaining -= increment;
      assignedTotal += increment;
    }

    return new Promise(resolve => {
      let applied = false;
      let content = `<p>${game.i18n.format('NAS.buffs.TotalAvailableDuration', { total, unit: unit || '' })}</p>`;
      content += `<div class="target-selection-container" style="max-height: 400px; overflow-y: auto; border: 1px solid #ccc; border-radius: 5px; padding: 10px; margin-top: 10px;">`;
      content += `<div style="display: flex; flex-wrap: wrap; gap: 10px;">`;
      filteredTargets.forEach((target, index) => {
        const tokenName = target.name || target.actor.name;
        const tokenImg = target.document?.texture?.src || target.texture?.src;
        content += `
          <div class="target-option" style="display: flex; flex-direction: column; align-items: center; width: 120px;">
            <div style="font-weight: bold; margin-bottom: 2px;">
              <span id="duration-${index}">${assigned[index]}</span> ${unit || ''}
            </div>
            <div style="display: flex; flex-direction: row; align-items: center; margin-bottom: 2px;">
              <button type="button" class="communal-down" data-index="${index}" style="width: 24px; height: 24px;">-</button>
              <button type="button" class="communal-up" data-index="${index}" style="width: 24px; height: 24px; margin-left: 4px;">+</button>
            </div>
            <img src="${tokenImg}" style="width: 64px; height: 64px; border: 2px solid #888; border-radius: 5px;" />
            <label style="margin-bottom: 3px;">${tokenName}</label>
          </div>
        `;
      });
      content += `</div></div>`;
      content += `<div style="margin-top: 10px;">${game.i18n.format('NAS.buffs.UnassignedDuration', { remaining: total - assigned.reduce((a, b) => a + b, 0), unit: unit || '' })}</div>`;

      const dialog = new Dialog({
        title: game.i18n.localize('NAS.buffs.SelectBuffTargets'),
        content: content,
        buttons: {
          apply: {
            icon: '<i class="fas fa-check"></i>',
            label: game.i18n.localize('NAS.buffs.ApplyBuff'),
            callback: html => {
              applied = true;
              resolve(filteredTargets.map((t, i) => ({ target: t, duration: { value: assigned[i], units: unit } })));
            }
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: game.i18n.localize('NAS.common.buttons.cancel'),
            callback: () => {
              action.shared.reject = true;
              resolve([]);
            }
          }
        },
        default: "apply",
        close: () => {
          if (!applied) {
            action.shared.reject = true;
            resolve([]);
          }
        }
      }, { width: Math.max(400, n * 140) });

      dialog.render(true);
      Hooks.once('renderDialog', (app, html) => {
        html.find('.communal-up').on('click', function() {
          const idx = Number(this.dataset.index);
          if ((assigned.reduce((a, b) => a + b, 0) + increment) <= total) {
            assigned[idx] += increment;
            html.find(`#duration-${idx}`).text(assigned[idx]);
            html.find('#unassigned').text(total - assigned.reduce((a, b) => a + b, 0));
          }
        });
        html.find('.communal-down').on('click', function() {
          const idx = Number(this.dataset.index);
          if (assigned[idx] - increment >= 0) {
            assigned[idx] -= increment;
            html.find(`#duration-${idx}`).text(assigned[idx]);
            html.find('#unassigned').text(total - assigned.reduce((a, b) => a + b, 0));
          }
        });
      });
    });
  }

  return new Promise(resolve => {
    let applied = false;
    const spellName = action.item.name;
    const saveType = normalizeSaveType(buffSaveGate?.saveType);
    const saveMode = normalizeBuffSaveHandlingMode(buffSaveGate?.mode);
    const saveDc = coerceNumberOrNull(buffSaveGate?.dc);
    const isSaveGatedManual = buffSaveGate?.deferred === true && REAL_SAVE_TYPES.has(saveType) && saveMode !== "ignore";
    const secretColor = "#7b2cff";
    const neutralColor = "#b58900";
    const defaultEnabledForState = (state) => {
      if (!isSaveGatedManual) return true;
      if (state.bypassed) return true;
      if (state.saveSucceeded == null) return false;
      return saveMode === "failed" ? state.saveSucceeded === false : state.saveSucceeded === true;
    };
    const stateCanBeEnabled = (state) => !isSaveGatedManual || state.bypassed || state.saveTotal != null;
    const updateStateAfterSave = (state, total) => {
      state.saveTotal = coerceNumberOrNull(total);
      state.saveSucceeded = state.saveTotal == null ? null : state.saveTotal >= saveDc;
      state.enabled = defaultEnabledForState(state);
    };
    const stateGroups = (state) => {
      const groups = new Set(targetFilterGroups(state.target, action.token));
      if (state.enabled) groups.add("eligible");
      if (state.bypassed) groups.add("bypassed");
      if (state.saveSucceeded === true) groups.add("successful");
      if (state.saveSucceeded === false) groups.add("failed");
      if (isSaveGatedManual && !state.bypassed && state.saveTotal == null) groups.add("needs");
      return [...groups];
    };
    const targetStates = allTargets.map((target, index) => {
      const secret = targetIsSecretForAutomation(target, action.token);
      const bypassed = isSaveGatedManual && buffSaveGate?.alliesBypass === true && targetIsAllyToCaster(target, action.token);
      const state = {
        target,
        index,
        key: targetAppliedKey(target),
        rendered: game.user?.isGM === true || !secret,
        secret,
        bypassed,
        saveTotal: null,
        saveSucceeded: null,
        enabled: true
      };
      state.enabled = defaultEnabledForState(state);
      return state;
    });
    const renderedStates = () => targetStates.filter((state) => state.rendered);
    const targetEntries = () => targetStates.map((state) => ({
      target: state.target,
      index: state.index,
      groups: stateGroups(state),
      rendered: state.rendered
    }));
    let activeFilter = "all";
    let targetBulkMoreOpen = false;
    const renderControls = () => `
      ${targetSelectionControlsHtml(targetEntries(), { targetBulkMoreOpen })}
      ${isSaveGatedManual ? `<div class="nas-target-save-bulk" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:8px 0;">
        <a href="#" role="button" class="nas-dialog-control" data-nas-save-roll="visible" style="${nasDialogControlStyle()}"><i class="fas fa-dice-d20"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RollSavesVisible"))}</a>
        <a href="#" role="button" class="nas-dialog-control" data-nas-save-roll="all" style="${nasDialogControlStyle()}"><i class="fas fa-dice"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RollSavesAllPending"))}</a>
        <a href="#" role="button" class="nas-dialog-control" data-nas-save-refresh="true" style="${nasDialogControlStyle()}"><i class="fas fa-sync"></i>&nbsp;${escapeHtml(game.i18n.localize("NAS.buffs.RefreshSaveResults"))}</a>
      </div>` : ""}
    `;
    const renderTargetCards = () => renderedStates().map((state) => {
      const target = state.target;
      const tokenName = target.name || target.actor?.name || "";
      const tokenImg = target.document?.texture?.src || target.texture?.src || target.actor?.img || "";
      const isSameDisposition = targetIsAllyToCaster(target, action.token);
      const dispositionName = targetDispositionLabel(target, action.token);
      const targetDisposition = targetDispositionValue(target);
      const dispositionColor = state.secret
        ? secretColor
        : targetDisposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL
          ? neutralColor
          : (isSameDisposition ? "green" : "red");
      const statusLabel = isSaveGatedManual ? pendingTargetStatusLabel(state) : "";
      const saveText = isSaveGatedManual && state.saveTotal != null ? ` ${escapeHtml(String(state.saveTotal))}` : "";
      const checkboxDisabled = isSaveGatedManual && !stateCanBeEnabled(state) ? "disabled" : "";
      return `
        <div class="target-option nas-target-option" data-target-index="${state.index}" data-nas-target-groups="${escapeHtml(stateGroups(state).join(" "))}" style="display: flex; flex-direction: column; align-items: center; width: 118px;">
          <img src="${tokenImg}" style="width: 64px; height: 64px; border: 2px solid ${dispositionColor}; border-radius: 5px; object-fit:cover;" />
          <input type="checkbox" id="target-${state.index}" name="target-${state.index}" ${state.enabled ? "checked" : ""} ${checkboxDisabled} style="margin: 6px 0 3px 0;" />
          <label for="target-${state.index}" style="margin-bottom: 3px;">${escapeHtml(tokenName)}</label>
          <div style="font-size: 0.8em; color: ${dispositionColor};">${escapeHtml(dispositionName)}</div>
          ${isSaveGatedManual ? `<div style="font-size: 0.8em;">${escapeHtml(statusLabel)}${saveText}</div>` : ""}
        </div>
      `;
    }).join("") || `<p>${escapeHtml(game.i18n.localize("NAS.buffs.NoVisibleTargets"))}</p>`;
    const readState = (html) => {
      const $html = typeof html.find === "function" ? html : $(html);
      const targetDetails = $html.find(".nas-target-bulk-more")?.[0];
      if (targetDetails) targetBulkMoreOpen = targetDetails.open === true;
      for (const state of renderedStates()) {
        const checkbox = $html.find(`#target-${state.index}`);
        if (checkbox.length && !checkbox.prop("disabled")) state.enabled = checkbox.prop("checked") === true;
      }
    };
    const applyFilter = ($html, filter = activeFilter) => {
      activeFilter = filter;
      $html.find("[data-nas-target-filter]").removeClass("active").css({
        "box-shadow": "",
        "border-color": "var(--color-border-light-primary, #999)"
      });
      $html.find(`[data-nas-target-filter="${filter}"]`).addClass("active").css({
        "box-shadow": "0 0 4px red",
        "border-color": "red"
      });
      $html.find(".nas-target-option").each((_index, el) => {
        const groups = String(el.dataset.nasTargetGroups ?? "").split(/\s+/);
        el.style.display = filter === "all" || groups.includes(filter) ? "flex" : "none";
      });
    };
    const visibleStatesForDialog = ($html) => renderedStates().filter((state) => {
      const el = $html.find(`.nas-target-option[data-target-index="${state.index}"]`)?.[0];
      return el && el.style.display !== "none";
    });
    const setStatesEnabled = (statesToUpdate, enabled) => {
      for (const state of statesToUpdate) {
        if (stateCanBeEnabled(state)) state.enabled = enabled;
      }
    };
    const refreshDialog = ($html, dialog = null, { read = true } = {}) => {
      if (read) readState($html);
      $html.find("#ic-manual-target-controls").html(renderControls());
      $html.find("#ic-manual-target-section").html(renderTargetCards());
      wireManualDialog($html, dialog);
      applyFilter($html, activeFilter);
      dialog?.setPosition?.({ height: "auto" });
    };
    const rollSaveStates = async ($html, dialog, statesToRoll) => {
      readState($html);
      if (isSaveGatedManual && saveDc == null) {
        ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveDcMissing"));
        return;
      }
      for (const state of statesToRoll) {
        if (!state || state.bypassed || state.saveTotal != null) continue;
        const targetRef = serializePendingTarget(state.target, null);
        const total = await rollBuffSaveForTargetRef(targetRef, state.target, saveType, saveDc, {
          hiddenMessage: state.secret === true,
          privateRoll: state.secret !== true
        });
        if (total != null) updateStateAfterSave(state, total);
      }
      refreshDialog($html, dialog, { read: false });
    };
    const validateApply = ($html, { warn = true } = {}) => {
      readState($html);
      if (isSaveGatedManual && saveDc == null) {
        if (warn) ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveDcMissing"));
        return false;
      }
      if (isSaveGatedManual && targetStates.some((state) => !state.bypassed && state.saveTotal == null)) {
        if (warn) ui.notifications.warn(game.i18n.localize("NAS.buffs.SaveResultsRequired"));
        return false;
      }
      return true;
    };
    const wireApplyValidation = ($html, dialog) => {
      const button = dialog?.element?.find?.("button[data-button='apply']")?.[0]
        ?? dialog?.element?.[0]?.querySelector?.("button[data-button='apply']");
      if (!button || button.dataset.nasApplyValidationWired === "true") return;
      button.dataset.nasApplyValidationWired = "true";
      button.addEventListener("click", (event) => {
        if (validateApply($html, { warn: true })) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    };
    const wireManualDialog = (html, dialog = null) => {
      const $html = typeof html.find === "function" ? html : $(html);
      $html.find("[data-nas-target-filter]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyFilter($html, event.currentTarget.dataset.nasTargetFilter);
        dialog?.setPosition?.({ height: "auto" });
      });
      $html.find("input[name^='target-']").off("change").on("change", () => readState($html));
      $html.find(".nas-target-bulk-more").off("toggle").on("toggle", (event) => {
        targetBulkMoreOpen = event.currentTarget.open === true;
      });
      $html.find("[data-nas-target-bulk]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        readState($html);
        const actionName = event.currentTarget.dataset.nasTargetBulk;
        const selectGroups = {
          selectAllies: "allies",
          selectNeutral: "neutral",
          selectEnemies: "enemies",
          selectSuccessful: "successful",
          selectFailed: "failed"
        };
        const deselectGroups = {
          deselectAllies: "allies",
          deselectNeutral: "neutral",
          deselectEnemies: "enemies",
          deselectSuccessful: "successful",
          deselectFailed: "failed"
        };
        if (actionName === "select") setStatesEnabled(visibleStatesForDialog($html), true);
        else if (actionName === "deselect") setStatesEnabled(visibleStatesForDialog($html), false);
        else if (selectGroups[actionName]) setStatesEnabled(targetStates.filter((state) => stateGroups(state).includes(selectGroups[actionName])), true);
        else if (deselectGroups[actionName]) setStatesEnabled(targetStates.filter((state) => stateGroups(state).includes(deselectGroups[actionName])), false);
        refreshDialog($html, dialog, { read: false });
      });
      $html.find("[data-nas-save-roll]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const mode = event.currentTarget.dataset.nasSaveRoll;
        const candidates = mode === "visible" ? visibleStatesForDialog($html) : targetStates;
        void rollSaveStates($html, dialog, candidates.filter((state) => !state.bypassed && state.saveTotal == null));
      });
      $html.find("[data-nas-save-refresh]").off("click").on("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshDialog($html, dialog);
      });
    };

    let content = `<p>${game.i18n.format(isSaveGatedManual ? 'NAS.buffs.SelectSaveGatedTargets' : 'NAS.buffs.SelectTargets', { name: spellName })}</p>`;
    content += `<div id="ic-manual-target-controls">${renderControls()}</div>`;
    content += `<div id="ic-manual-target-section" class="target-selection-container" style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-start; max-height: 430px; overflow-y: auto; border: 1px solid #ccc; border-radius: 5px; padding: 10px; margin-top: 10px;">${renderTargetCards()}</div>`;

    const dialog = new Dialog({
      title: game.i18n.localize('NAS.buffs.SelectBuffTargets'),
      content: content,
      buttons: {
        apply: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize('NAS.buffs.ApplyBuff'),
          callback: html => {
            const $html = typeof html.find === "function" ? html : $(html);
            if (!validateApply($html, { warn: true })) return false;
            applied = true;
            const selectedTargets = targetStates.filter((state) => state.enabled === true).map((state) => state.target);
            if (isSaveGatedManual) {
              selectedTargets.nasResolvedManualSelection = true;
              selectedTargets.nasTargetSaveResults = new Map(targetStates
                .filter((state) => state.saveTotal != null)
                .map((state) => [state.key, { [saveType]: state.saveTotal }]));
              selectedTargets.nasSaveResultTargets = targetStates
                .filter((state) => state.saveTotal != null && state.secret !== true)
                .map((state) => ({ target: state.target, saveResults: { [saveType]: state.saveTotal } }));
              selectedTargets.nasPublicSaveResultsOnly = true;
            }
            resolve(selectedTargets);
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize('NAS.common.buttons.cancel'),
          callback: () => {
            action.shared.reject = true;
            resolve([]);
          }
        }
      },
      default: "apply",
      close: () => {
        if (!applied) {
          action.shared.reject = true;
          resolve([]);
        }
      },
      render: html => {
        const $html = typeof html.find === "function" ? html : $(html);
        wireManualDialog($html, dialog);
        wireApplyValidation($html, dialog);
        applyFilter($html, activeFilter);
      }
    }, { width: Math.max(420, Math.min(Math.max(renderedStates().length || 1, 1), 5) * 130 + 170) });
    
    dialog.render(true);
  });
}

const variantMappingSetting = 'pairedBuffMappings';

function toVariantRef(buff) {
  if (!buff) return null;
  return { id: buff.id, pack: buff.pack || null, name: buff.name };
}

function getSpellKey(action) {
  const uuid = action?.item?.uuid;
  if (uuid) return uuid;
  const id = action?.item?.id;
  if (id) return `item:${id}`;
  const name = action?.item?.name || '';
  return `name:${name.toLowerCase()}`;
}

function splitTargetsByDisposition(casterToken, targets) {
  const casterDisposition = casterToken?.document?.disposition ?? casterToken?.disposition;
  const allies = [];
  const foes = [];
  for (const t of targets) {
    const d = t?.document?.disposition ?? t?.disposition;
    if (d === undefined || d === null) continue;
    if (d === CONST.TOKEN_DISPOSITIONS.NEUTRAL || d === CONST.TOKEN_DISPOSITIONS.SECRET) continue;
    if (d === casterDisposition) allies.push(t);
    else foes.push(t);
  }
  return { allies, foes };
}

function durationForTarget(target, perTargetDurations, fallbackDuration) {
  const entry = perTargetDurations?.find?.(d => d.target?.id === target.id);
  if (entry) {
    return {
      units: entry.duration.units,
      value: String(entry.duration.value ?? entry.duration)
    };
  }
  return fallbackDuration;
}

function manualSelectionResultOptions(targets) {
  if (!targets || targets.nasResolvedManualSelection !== true) return {};
  return {
    resolvedManualSelection: true,
    targetSaveResults: targets.nasTargetSaveResults instanceof Map ? targets.nasTargetSaveResults : undefined,
    saveResultTargets: Array.isArray(targets.nasSaveResultTargets) ? targets.nasSaveResultTargets : undefined,
    publicSaveResultsOnly: targets.nasPublicSaveResultsOnly === true
  };
}

async function storeVariantMapping(spellKey, plan, buffs) {
  const mappings = game.settings.get(MODULE.ID, variantMappingSetting) || {};
  const toStore = { ...mappings };
  const mapEntry = {
    allies: plan.allies ? toVariantRef(plan.allies) : null,
    foes: plan.foes ? toVariantRef(plan.foes) : null,
    allowSwitching: !!plan.allowSwitching,
    applyAllies: plan.applyAllies !== false,
    applyFoes: plan.applyFoes !== false,
    perTarget: (plan.perTarget || []).map(pt => ({
      actorId: pt.actorId,
      tokenId: pt.targetId,
      variantIndex: pt.variantIndex,
      applyTiming: pt.applyTiming || (pt.applyOnTurn ? 'turn' : 'cast')
    }))
  };
  toStore[spellKey] = mapEntry;
  await game.settings.set(MODULE.ID, variantMappingSetting, toStore);
}

async function handleVariantPlanApplication({ action, variants, plan, targetContext, durationUnits, durationValue, casterLevel, knownBuffAutomation = null, buffSaveGate = null }) {
  const { filteredTargets, perTargetDurations } = targetContext;
  if (!filteredTargets?.length) return;

  const defaultDuration = { units: durationUnits, value: String(durationValue) };
  const perTargetMap = new Map((plan.perTarget || []).map(pt => [pt.targetId, pt]));
  const targetSaveResults = plan.targetSaveResults instanceof Map ? plan.targetSaveResults : new Map();
  const saveResultTargets = Array.isArray(plan.saveResultTargets) ? plan.saveResultTargets : [];
  const { allies, foes } = splitTargetsByDisposition(action.token, filteredTargets);
  const applyAllies = plan.applyAllies !== false;
  const applyFoes = plan.applyFoes !== false;

  if (plan.remember) {
    await storeVariantMapping(getSpellKey(action), plan, variants);
  }

  const immediateBuckets = new Map();
  const deferredSwitchingBuckets = new Map();
  const combat = game.combat;
  const scheduled = [];

  for (const target of filteredTargets) {
    const isAlly = allies.includes(target);
    if (plan.allowSwitching) {
      if (isAlly && !applyAllies) {
        continue;
      }
      if (!isAlly && !applyFoes) {
        continue;
      }
    }
    const assignment = perTargetMap.get(target.id);
    if (assignment?.enabled === false) {
      continue;
    }
    const variant = assignment ? variants[assignment.variantIndex] : (allies.includes(target) ? plan.allies : plan.foes);
    if (!variant) {
      continue;
    }

    const duration = durationForTarget(target, perTargetDurations, defaultDuration);

    if (plan.allowSwitching) {
      if (buffSaveGate?.deferred) {
        const targetKey = targetAppliedKey(target);
        const variantIndex = variants.findIndex((entry) => entry === variant);
        const bucketKey = `${variant.pack || "world"}|${variant.id || variantIndex}|${variant.name || ""}`;
        if (!deferredSwitchingBuckets.has(bucketKey)) {
          deferredSwitchingBuckets.set(bucketKey, {
            variant,
            targets: [],
            targetBuffs: new Map(),
            targetDurations: new Map()
          });
        }
        const bucket = deferredSwitchingBuckets.get(bucketKey);
        bucket.targets.push(target);
        if (targetKey) {
          bucket.targetBuffs.set(targetKey, variant);
          bucket.targetDurations.set(targetKey, duration);
          if (targetSaveResults.has(targetKey)) {
            bucket.targetSaveResults ??= new Map();
            bucket.targetSaveResults.set(targetKey, targetSaveResults.get(targetKey));
          }
        }
        continue;
      }
      await ensureVariantsOnTarget(target, variants, duration, casterLevel, { silent: true, [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation });
      const applyTiming = assignment?.applyTiming || 'cast';
      if (applyTiming !== 'turn') {
        await activateVariantForTarget(target, variant, variants, duration, casterLevel, { silent: true, [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation });
      }
      if (combat) {
        const timing = computeApplyTiming(combat, target.id);
        if (timing) {
          scheduled.push({
            tokenId: target.id,
            actorId: target.actor?.id,
            variantIndex: variants.findIndex(v => v === variant),
            duration,
            switching: true,
            applyTiming: applyTiming || 'cast',
            turnIndex: timing.turnIndex,
            applyRound: timing.round,
            applyTurn: timing.turn
          });
        }
      }
    } else {
      const key = `${variant.id}|${variant.pack || "world"}|${duration.value}|${duration.units}`;
      if (!immediateBuckets.has(key)) {
        immediateBuckets.set(key, { variant, targets: [], duration });
      }
      immediateBuckets.get(key).targets.push(target);
    }
  }

  for (const bucket of deferredSwitchingBuckets.values()) {
    await applyOrQueueBuffToTargets(action, bucket.variant, bucket.targets, defaultDuration, casterLevel, {
      silent: true,
      [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation,
      buffSaveGate,
      manualSelection: targetContext.manualSelection === true,
      resolvedManualSelection: plan.resolvedManualSelection === true,
      targetBuffs: bucket.targetBuffs,
      targetDurations: bucket.targetDurations,
      targetSaveResults: bucket.targetSaveResults,
      saveResultTargets,
      publicSaveResultsOnly: plan.publicSaveResultsOnly === true
    });
  }

  for (const bucket of immediateBuckets.values()) {
    await applyOrQueueBuffToTargets(action, bucket.variant, bucket.targets, bucket.duration ?? defaultDuration, casterLevel, {
      [KNOWN_BUFF_AUTOMATION_OPTION]: knownBuffAutomation,
      buffSaveGate,
      manualSelection: targetContext.manualSelection === true,
      resolvedManualSelection: plan.resolvedManualSelection === true,
      targetSaveResults,
      saveResultTargets,
      publicSaveResultsOnly: plan.publicSaveResultsOnly === true
    });
  }

  if (plan.allowSwitching && scheduled.length > 0 && combat) {
    await queueVariantTracker({
      combat,
      action,
      variants,
      scheduled,
      casterLevel,
      defaultDuration
    });
  }
}

function computeApplyTiming(combat, tokenId) {
  if (!combat || !combat.turns) return null;
  const turnIndex = combat.turns.findIndex(t => t?.token?.id === tokenId);
  if (turnIndex === -1) return null;
  const currentRound = combat.round;
  const currentTurn = combat.turn;
  const applyRound = turnIndex > currentTurn ? currentRound : currentRound + 1;
  return { round: applyRound, turn: turnIndex, turnIndex };
}

async function queueVariantTracker({ combat, action, variants, scheduled, casterLevel, defaultDuration }) {
  const tracker = combat.getFlag(MODULE.ID, "variantBuffTracker") || [];
  tracker.push({
    spellKey: getSpellKey(action),
    spellName: action.item?.name,
    variants: variants.map(toVariantRef),
    caster: {
      tokenId: action.token?.id,
      actorId: action.token?.actor?.id,
      round: combat.round,
      turn: combat.turn,
      level: casterLevel
    },
    defaultDuration,
    targets: scheduled
  });
  await combat.setFlag(MODULE.ID, "variantBuffTracker", tracker);
}

export async function resolveBuffReference(ref) {
  if (!ref) return null;
  try {
    if (!ref.pack) {
      const item = game.items.get(ref.id);
      if (item && item.type === 'buff') {
        return { name: item.name, id: item.id, pack: null, document: item };
      }
      return null;
    }
    const pack = game.packs.get(ref.pack);
    if (!pack) return null;
    const doc = await pack.getDocument(ref.id);
    if (!doc || doc.type !== 'buff') return null;
    return { name: doc.name, id: doc.id, pack: ref.pack, document: doc };
  } catch (err) {
    console.error(`${MODULE.ID} | resolveBuffReference failed`, err);
    return null;
  }
}

function isActiveGmUser() {
  if (game.user?.isGM !== true) return false;
  const activeGm = game.users?.activeGM;
  return !activeGm || activeGm.isSelf === true || activeGm.id === game.user.id;
}

async function resolvePendingBuffTarget(targetRef) {
  if (targetRef?.tokenUuid) {
    try {
      const doc = await fromUuid(targetRef.tokenUuid);
      if (doc?.object) return doc.object;
      if (doc?.actor) return doc;
    } catch (_err) {
      // Fall through to canvas lookups.
    }
  }

  if (targetRef?.tokenId && canvas?.tokens?.get) {
    const token = canvas.tokens.get(targetRef.tokenId);
    if (token) return token;
  }

  if (targetRef?.actorUuid && Array.isArray(canvas?.tokens?.placeables)) {
    return canvas.tokens.placeables.find((token) => token?.actor?.uuid === targetRef.actorUuid) ?? null;
  }

  return null;
}

function pendingTargetAppliedKey(targetRef) {
  return targetRef?.tokenUuid || targetRef?.tokenId || targetRef?.actorUuid || "";
}

function isPendingBuffAlly(plan, token) {
  const actorUuid = token?.actor?.uuid ?? "";
  if (actorUuid && actorUuid === plan?.caster?.actorUuid) return true;
  const sourceDisposition = plan?.caster?.disposition;
  const targetDisposition = token?.document?.disposition ?? token?.disposition ?? null;
  return sourceDisposition != null && targetDisposition != null && sourceDisposition === targetDisposition;
}

function readTargetSaveTotal(message, targetRef, saveType) {
  const targetDefense = message.getFlag("pf1", "targetDefense") ?? {};
  const byUuid = targetRef?.tokenUuid ? targetDefense[targetRef.tokenUuid]?.save?.[saveType] : null;
  if (byUuid != null) return coerceNumberOrNull(byUuid);
  const byUuidPath = targetRef?.tokenUuid
    ? foundry.utils.getProperty(targetDefense, `${targetRef.tokenUuid}.save.${saveType}`)
    : null;
  if (byUuidPath != null) return coerceNumberOrNull(byUuidPath);
  const byId = targetRef?.tokenId ? targetDefense[targetRef.tokenId]?.save?.[saveType] : null;
  if (byId != null) return coerceNumberOrNull(byId);
  const byIdPath = targetRef?.tokenId
    ? foundry.utils.getProperty(targetDefense, `${targetRef.tokenId}.save.${saveType}`)
    : null;
  if (byIdPath != null) return coerceNumberOrNull(byIdPath);
  const matchingKey = Object.keys(targetDefense).find((key) => {
    const entry = targetDefense[key];
    return entry?.save?.[saveType] != null && (key === targetRef?.tokenUuid || key === targetRef?.tokenId);
  });
  if (matchingKey) return coerceNumberOrNull(targetDefense[matchingKey]?.save?.[saveType]);
  return null;
}

function pendingTargetStatusLabel(entry) {
  if (entry.bypassed) return game.i18n.localize("NAS.buffs.TargetStatusBypassed");
  if (entry.saveSucceeded === true) return game.i18n.localize("NAS.buffs.TargetStatusSuccessful");
  if (entry.saveSucceeded === false) return game.i18n.localize("NAS.buffs.TargetStatusFailed");
  return game.i18n.localize("NAS.buffs.TargetStatusNoSave");
}

function pendingTargetGroups(plan, token, entry) {
  const groups = new Set(["all"]);
  if (entry.defaultSelected) groups.add("eligible");
  if (entry.bypassed) groups.add("bypassed");
  if (entry.saveSucceeded === true) groups.add("successful");
  if (entry.saveSucceeded === false) groups.add("failed");
  if (!entry.bypassed && entry.saveTotal == null) groups.add("needs");
  if (targetIsHiddenOrUnavailable(token)) groups.add("hidden");
  const disposition = targetDispositionValue(token);
  if (disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) groups.add("neutral");
  else if (isPendingBuffAlly(plan, token)) groups.add("allies");
  else groups.add("enemies");
  return [...groups];
}

function pendingTargetSection(entry) {
  if (entry.bypassed) return "bypassed";
  if (entry.saveSucceeded === false) return "failed";
  if (entry.saveSucceeded === true) return "successful";
  return "needs";
}

function pendingTargetSectionLabel(section) {
  const labels = {
    needs: "NAS.buffs.TargetSectionNeedsSave",
    failed: "NAS.buffs.TargetSectionFailed",
    successful: "NAS.buffs.TargetSectionSuccessful",
    bypassed: "NAS.buffs.TargetSectionBypassed"
  };
  return game.i18n.localize(labels[section] ?? labels.needs);
}

function extractRollTotal(rollResult) {
  const rollLike = rollResult?.rolls?.[0] ?? rollResult?.roll ?? null;
  const parsedRoll = typeof rollLike === "string" ? parseRollJson(rollLike) : rollLike;
  const candidates = [
    rollResult?.total,
    rollResult?.roll?.total,
    parsedRoll?.total,
    parsedRoll?._total,
    rollResult?.rolls?.[0]?.total,
    rollResult?.terms?.[0]?.total,
    parsedRoll?.terms?.[0]?.total
  ];
  for (const value of candidates) {
    const total = coerceNumberOrNull(value);
    if (total != null) return total;
  }
  return extractHtmlTotal(rollResult?.content);
}

async function createGmOnlySaveMessageFromRollData(rollResult) {
  if (!rollResult || typeof globalThis.ChatMessage?.create !== "function") return null;
  const gmIds = game.users?.filter?.((user) => user?.isGM)?.map?.((user) => user.id)?.filter?.(Boolean) ?? [];
  if (!gmIds.length) return null;
  const messageData = foundry.utils.deepClone(rollResult);
  delete messageData.rolls;
  messageData.whisper = gmIds;
  messageData.blind = false;
  messageData.sound = globalThis.CONFIG?.sounds?.dice;
  return globalThis.ChatMessage.create(messageData);
}

async function rollBuffSaveForTargetRef(targetRef, token, saveType, dc, { hiddenMessage = false, privateRoll = false } = {}) {
  const actor = token?.actor ?? tokenDocumentFromTarget(token)?.actor ?? null;
  if (socket) {
    try {
      const result = await socket.executeAsGM("rollNasBuffSaveSocket", targetRef, saveType, dc, { hiddenMessage, privateRoll });
      return coerceNumberOrNull(result?.total);
    } catch (err) {
      console.warn(`${MODULE.ID} | GM save roll socket failed for ${token?.name ?? actor?.name ?? "target"}.`, err);
    }
  }
  if (!actor?.rollSavingThrow) return null;

  const rollResult = await actor.rollSavingThrow(saveType, {
    dc,
    skipDialog: true,
    fastForward: true,
    token: token?.object ?? token,
    chatMessage: hiddenMessage ? false : true,
    rollMode: hiddenMessage ? undefined : (privateRoll ? "gmroll" : undefined),
    noSound: hiddenMessage === true
  });
  const total = extractRollTotal(rollResult);
  if (hiddenMessage) await createGmOnlySaveMessageFromRollData(rollResult);
  return total;
}

async function waitForTargetSaveTotal(message, targetRef, saveType, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    const total = readTargetSaveTotal(message, targetRef, saveType);
    if (total != null) return total;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function writeTargetSaveTotal(message, targetRef, saveType, total) {
  if (!message || !targetRef?.tokenUuid || total == null) return;
  const targetDefense = foundry.utils.deepClone(message.getFlag("pf1", "targetDefense") ?? {});
  foundry.utils.setProperty(targetDefense, `${targetRef.tokenUuid}.save.${saveType}`, total);
  await message.setFlag("pf1", "targetDefense", targetDefense);
}

async function writePendingPlanSaveResults(message, plan, saveType) {
  if (!message || (!Array.isArray(plan?.targets) && !Array.isArray(plan?.saveResultTargets))) return false;
  const targetDefense = foundry.utils.deepClone(message.getFlag("pf1", "targetDefense") ?? {});
  let changed = false;
  const targetRefs = plan.publicSaveResultsOnly === true
    ? (plan.saveResultTargets ?? [])
    : [...(plan.saveResultTargets ?? []), ...(plan.targets ?? [])];
  for (const targetRef of targetRefs) {
    const total = saveResultForTargetRef(targetRef, saveType);
    if (total == null || !targetRef?.tokenUuid) continue;
    foundry.utils.setProperty(targetDefense, `${targetRef.tokenUuid}.save.${saveType}`, total);
    changed = true;
  }
  if (changed) await message.setFlag("pf1", "targetDefense", targetDefense);
  return changed;
}

async function rollPendingBuffSaves(message, entries, saveType, dc) {
  const rollEntries = entries.filter((entry) => !entry.bypassed && entry.saveTotal == null && entry.token?.actor);
  for (const entry of rollEntries) {
    const before = readTargetSaveTotal(message, entry.targetRef, saveType);
    if (before != null) continue;
    let rollResult = null;
    try {
      rollResult = await entry.token.actor.rollSavingThrow(saveType, {
        dc,
        skipDialog: true,
        fastForward: true,
        reference: message.uuid,
        message
      });
    } catch (err) {
      console.warn(`${MODULE.ID} | Failed to roll save for ${entry.token?.name ?? entry.token?.actor?.name ?? "target"}.`, err);
      continue;
    }
    const attachedTotal = await waitForTargetSaveTotal(message, entry.targetRef, saveType);
    if (attachedTotal != null) continue;
    const total = extractRollTotal(rollResult);
    if (total != null) await writeTargetSaveTotal(message, entry.targetRef, saveType, total);
  }
}

async function promptPendingBuffTargetSelection(message, plan, entries, saveType, dc) {
  if (!entries.length) return [];
  const buffName = plan?.buff?.name || game.i18n.localize("NAS.buffs.ApplyBuff");
  const targetEntries = entries.map((entry, index) => ({
    ...entry,
    index,
    groups: pendingTargetGroups(plan, entry.token, entry)
  }));

  return new Promise(resolve => {
    let applied = false;
    let content = `<p style="margin-bottom:8px;">${game.i18n.format("NAS.buffs.SelectSaveGatedTargets", { name: escapeHtml(buffName) })}</p>`;
    content += targetSelectionControlsHtml(targetEntries);
    content += `<div class="target-selection-container" style="max-height: 430px; overflow-y: auto; border: 1px solid #ccc; border-radius: 5px; padding: 10px; margin-top: 10px;">`;
    const sectionOrder = ["needs", "failed", "successful", "bypassed"];
    for (const section of sectionOrder) {
      const sectionEntries = targetEntries.filter((entry) => pendingTargetSection(entry) === section);
      if (!sectionEntries.length) continue;
      content += `<section style="margin-bottom: 12px;"><h3 style="margin: 0 0 8px 0;">${escapeHtml(pendingTargetSectionLabel(section))}</h3>`;
      content += `<div style="display: flex; flex-wrap: wrap; gap: 12px; align-items:flex-start;">`;
      sectionEntries.forEach((entry) => {
      const token = entry.token;
      const tokenName = token?.name || token?.actor?.name || "";
      const tokenImg = token?.document?.texture?.src || token?.texture?.src || token?.actor?.img || "";
      const isAlly = isPendingBuffAlly(plan, token);
      const statusLabel = pendingTargetStatusLabel(entry);
      const saveText = entry.saveTotal == null ? "" : ` ${escapeHtml(String(entry.saveTotal))}`;
      const canApply = entry.bypassed || entry.saveTotal != null;
      content += `
        <div class="target-option nas-target-option" data-nas-target-groups="${escapeHtml(entry.groups.join(" "))}" style="display: flex; flex-direction: column; align-items: center; width: 118px;">
          <img src="${tokenImg}" style="width: 64px; height: 64px; border: 2px solid ${isAlly ? 'green' : 'red'}; border-radius: 5px;" />
          <input type="checkbox" id="pending-target-${entry.index}" name="pending-target-${entry.index}" ${entry.defaultSelected ? "checked" : ""} ${canApply ? "" : "disabled"} style="margin: 6px 0 3px 0;" />
          <label for="pending-target-${entry.index}" style="margin-bottom: 3px;">${escapeHtml(tokenName)}</label>
          <div style="font-size: 0.8em; color: ${isAlly ? 'green' : 'red'};">${escapeHtml(targetDispositionLabel(token, { document: { disposition: plan?.caster?.disposition }, actor: { uuid: plan?.caster?.actorUuid } }))}</div>
          <div style="font-size: 0.8em;">${escapeHtml(statusLabel)}${saveText}</div>
        </div>
      `;
      });
      content += `</div></section>`;
    }

    content += `</div>`;

    const dialog = new Dialog({
      title: game.i18n.localize("NAS.buffs.SelectBuffTargets"),
      content,
      buttons: {
        rollVisible: {
          icon: '<i class="fas fa-dice-d20"></i>',
          label: game.i18n.localize("NAS.buffs.RollSavesVisible"),
          callback: async html => {
            applied = true;
            const visibleEntries = targetEntries.filter((entry) => {
              const el = (typeof html.find === "function")
                ? html.find(`#pending-target-${entry.index}`).closest(".nas-target-option")?.[0]
                : html.querySelector(`#pending-target-${entry.index}`)?.closest(".nas-target-option");
              return el && el.style.display !== "none";
            });
            await rollPendingBuffSaves(message, visibleEntries, saveType, dc);
            resolve({ action: "refresh" });
          }
        },
        rollAll: {
          icon: '<i class="fas fa-dice"></i>',
          label: game.i18n.localize("NAS.buffs.RollSavesAllPending"),
          callback: async () => {
            applied = true;
            await rollPendingBuffSaves(message, targetEntries, saveType, dc);
            resolve({ action: "refresh" });
          }
        },
        refresh: {
          icon: '<i class="fas fa-sync"></i>',
          label: game.i18n.localize("NAS.buffs.RefreshSaveResults"),
          callback: () => {
            applied = true;
            resolve({ action: "refresh" });
          }
        },
        apply: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize("NAS.buffs.ApplyBuff"),
          callback: html => {
            applied = true;
            const selected = [];
            targetEntries.forEach((entry) => {
              let isChecked;
              if (typeof html.find === "function") {
                isChecked = html.find(`#pending-target-${entry.index}`).prop("checked");
              } else {
                const checkbox = html.querySelector(`#pending-target-${entry.index}`);
                isChecked = checkbox ? checkbox.checked : false;
              }
              if (isChecked) selected.push(entry);
            });
            resolve({ action: "apply", selected });
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize("NAS.common.buttons.cancel"),
          callback: () => {
            applied = true;
            resolve({ action: "cancel" });
          }
        }
      },
      default: "apply",
      close: () => {
        if (!applied) resolve({ action: "cancel" });
      },
      render: html => {
        wireTargetSelectionControls(html, dialog);
      }
    }, { width: 640 });
    dialog.render(true);
  });
}

async function collectPendingBuffTargetEntries(message, plan, saveType, mode, dc, applied, skipped) {
  const entries = [];

  for (const targetRef of plan.targets ?? []) {
    const appliedKey = pendingTargetAppliedKey(targetRef);
    if (!appliedKey || applied.has(appliedKey) || skipped.has(appliedKey)) {
      continue;
    }

    const token = await resolvePendingBuffTarget(targetRef);
    if (!token?.actor) {
      continue;
    }

    const bypassed = plan?.save?.alliesBypass === true && isPendingBuffAlly(plan, token);
    let saveTotal = null;
    let saveSucceeded = null;
    if (!bypassed) {
      if (dc == null) {
        continue;
      }
      saveTotal = readTargetSaveTotal(message, targetRef, saveType);
      saveSucceeded = saveTotal == null ? null : saveTotal >= dc;
    }

    const defaultSelected = bypassed || (saveSucceeded != null && (mode === "failed" ? !saveSucceeded : saveSucceeded));
    entries.push({ targetRef, token, appliedKey, bypassed, saveTotal, saveSucceeded, defaultSelected });
  }

  return { entries };
}

async function resolvePendingBuffForTarget(plan, targetRef) {
  return resolveBuffReference(targetRef?.buff ?? plan?.buff);
}

async function processPendingBuffPlan(message, plan) {
  const saveType = normalizeSaveType(plan?.save?.type ?? message?.system?.save?.type);
  const mode = normalizeBuffSaveHandlingMode(plan?.save?.mode);
  if (!REAL_SAVE_TYPES.has(saveType) || mode === "ignore") {
        return false;
  }

  const dc = coerceNumberOrNull(plan?.save?.dc ?? message?.system?.save?.dc);
  const applied = new Set(Array.isArray(plan.appliedTargetUuids) ? plan.appliedTargetUuids : []);
  const skipped = new Set(Array.isArray(plan.skippedTargetUuids) ? plan.skippedTargetUuids : []);
  let changed = false;

  if (plan.resolvedManualSelection === true) {
    changed = await writePendingPlanSaveResults(message, plan, saveType) || changed;
    for (const targetRef of plan.targets ?? []) {
      const appliedKey = pendingTargetAppliedKey(targetRef);
      if (!appliedKey || applied.has(appliedKey)) continue;
      const token = await resolvePendingBuffTarget(targetRef);
      if (!token?.actor) {
        skipped.add(appliedKey);
        changed = true;
        continue;
      }
      const buff = await resolvePendingBuffForTarget(plan, targetRef);
      if (!buff) {
        skipped.add(appliedKey);
        changed = true;
        continue;
      }
      await applyBuffToTargets(buff, [token], targetRef.duration ?? null, plan.casterLevel, plan.options ?? {});
      applied.add(appliedKey);
      changed = true;
    }
    plan.appliedTargetUuids = [...applied];
    plan.skippedTargetUuids = [...skipped];
    return changed;
  }

  if (plan.manualSelection === true) {
    while (true) {
      const { entries } = await collectPendingBuffTargetEntries(message, plan, saveType, mode, dc, applied, skipped);
      if (entries.length === 0) {
        return changed;
      }

      const result = await promptPendingBuffTargetSelection(message, plan, entries, saveType, dc);
      if (result?.action === "refresh") continue;
      if (result?.action !== "apply") return changed;

      const selectedEntries = Array.isArray(result.selected) ? result.selected : [];
      const selectedKeys = new Set(selectedEntries.map((entry) => entry.appliedKey));
      for (const entry of entries) {
        if (!selectedKeys.has(entry.appliedKey)) {
          skipped.add(entry.appliedKey);
          changed = true;
        }
      }

      for (const entry of selectedEntries) {
        const buff = await resolvePendingBuffForTarget(plan, entry.targetRef);
        if (!buff) {
          skipped.add(entry.appliedKey);
          changed = true;
          continue;
        }
        await applyBuffToTargets(buff, [entry.token], entry.targetRef.duration ?? null, plan.casterLevel, plan.options ?? {});
        applied.add(entry.appliedKey);
        changed = true;
      }

      plan.appliedTargetUuids = [...applied];
      plan.skippedTargetUuids = [...skipped];
      return changed;
    }
  }
  
  for (const targetRef of plan.targets ?? []) {
    const appliedKey = pendingTargetAppliedKey(targetRef);
    if (!appliedKey || applied.has(appliedKey)) {
            continue;
    }

    const token = await resolvePendingBuffTarget(targetRef);
    if (!token?.actor) {
            continue;
    }

    let shouldApply = plan?.save?.alliesBypass === true && isPendingBuffAlly(plan, token);
    if (!shouldApply) {
      if (dc == null) {
                continue;
      }
      const saveTotal = readTargetSaveTotal(message, targetRef, saveType);
      if (saveTotal == null) {
                continue;
      }
      const saveSucceeded = saveTotal >= dc;
      shouldApply = mode === "failed" ? !saveSucceeded : saveSucceeded;
          } else {
          }

    if (!shouldApply) {
            continue;
    }

    const buff = await resolvePendingBuffForTarget(plan, targetRef);
    if (!buff) {
            continue;
    }
    const duration = targetRef.duration ?? null;
        await applyBuffToTargets(buff, [token], duration, plan.casterLevel, plan.options ?? {});
    applied.add(appliedKey);
    changed = true;
  }

  if (changed) plan.appliedTargetUuids = [...applied];
  return changed;
}

async function processPendingBuffAutomationMessage(message) {
  if (!isActiveGmUser()) {
        return;
  }
  const messageId = message?.id ?? message?._id;
  if (!messageId || PROCESSING_SAVE_GATED_MESSAGES.has(messageId)) {
        return;
  }
  const pending = message.getFlag(MODULE.ID, PENDING_BUFF_AUTOMATION_KEY);
  if (!Array.isArray(pending) || pending.length === 0) {
        return;
  }

  PROCESSING_SAVE_GATED_MESSAGES.add(messageId);
  try {
        const plans = foundry.utils.deepClone(pending);
    let changed = false;
    for (const plan of plans) {
      changed = await processPendingBuffPlan(message, plan) || changed;
    }
    if (changed) {
      await message.update({ [`flags.${MODULE.ID}.${PENDING_BUFF_AUTOMATION_KEY}`]: plans });
          } else {
          }
  } catch (err) {
    console.error(`${MODULE.ID} | Failed to process save-gated buff automation.`, err);
  } finally {
    PROCESSING_SAVE_GATED_MESSAGES.delete(messageId);
  }
}

export function registerSaveGatedBuffAutomation() {
  Hooks.on("createChatMessage", (message) => {
        void processPendingBuffAutomationMessage(message);
  });
  Hooks.on("updateChatMessage", (message) => {
        if (!message.getFlag(MODULE.ID, PENDING_BUFF_AUTOMATION_KEY)) return;
    void processPendingBuffAutomationMessage(message);
  });
}

async function ensureVariantsOnTarget(target, variants, duration, casterLevel, options = {}) {
  const ensurePromises = [];
  for (const variant of variants) {
    if (!variant) continue;
    ensurePromises.push(applyBuffToTargets(variant, [target], duration, casterLevel, {
      activate: false,
      silent: options.silent,
      [KNOWN_BUFF_AUTOMATION_OPTION]: options[KNOWN_BUFF_AUTOMATION_OPTION] ?? null
    }));
  }
  await Promise.all(ensurePromises);
}

export async function activateVariantForTarget(target, variant, variants, duration, casterLevel, options = {}) {
  if (!variant) return;
  await applyBuffToTargets(variant, [target], duration, casterLevel, {
    activate: true,
    silent: options.silent,
    [KNOWN_BUFF_AUTOMATION_OPTION]: options[KNOWN_BUFF_AUTOMATION_OPTION] ?? null
  });
  const actor = target.actor;
  if (!actor) return;
  for (const other of variants) {
    if (!other) continue;
    if (other.name === variant.name && (other.pack || null) === (variant.pack || null)) continue;
    const existing = actor.items.find(item => item.type === "buff" && item.name === other.name);
    if (existing?.system?.active) {
      await existing.update({ "system.active": false });
    }
  }
}

/**
 * Normalize action/spell duration to PF1 buff duration semantics.
 * - inst/perm => untimed permanent buff
 * - seeText => untimed buff (subtype unchanged)
 */
function normalizeDurationForBuff(duration = {}) {
  const sourceUnits = (duration?.sourceUnits ?? duration?.units ?? "").toString().trim();
  const rawValue = duration?.value;
  const value =
    rawValue === undefined || rawValue === null || rawValue === "undefined" || rawValue === "null"
      ? ""
      : rawValue;

  if (sourceUnits === "inst" || sourceUnits === "perm") {
    return {
      units: "",
      value: "",
      subType: "perm"
    };
  }

  if (sourceUnits === "seeText") {
    return {
      units: "",
      value: "",
      subType: null
    };
  }

  const longUnitHourMultipliers = {
    day: 24,
    days: 24,
    week: 168,
    weeks: 168,
    month: 720,
    months: 720,
    year: 8760,
    years: 8760
  };
  const hourMultiplier = longUnitHourMultipliers[sourceUnits.toLowerCase()];
  if (hourMultiplier) {
    const numericValue = Number(value);
    return {
      units: "hour",
      value: Number.isFinite(numericValue) ? String(numericValue * hourMultiplier) : `(${value}) * ${hourMultiplier}`,
      subType: null
    };
  }

  return {
    units: sourceUnits,
    value,
    subType: null
  };
}

function normalizeDurationToEffectSeconds(normalizedDuration = {}) {
  const units = (normalizedDuration?.units ?? "").toString().trim().toLowerCase();
  const numericValue = Number(normalizedDuration?.value ?? 0);
  if (!Number.isFinite(numericValue) || numericValue < 0) return 0;

  const roundSeconds = Number(CONFIG?.time?.roundTime ?? 6);
  switch (units) {
    case "second":
    case "seconds":
    case "sec":
      return numericValue;
    case "round":
    case "rounds":
    case "turn":
    case "turns":
      return numericValue * roundSeconds;
    case "minute":
    case "minutes":
      return numericValue * 60;
    case "hour":
    case "hours":
      return numericValue * 3600;
    case "day":
    case "days":
      return numericValue * 86400;
    case "week":
    case "weeks":
      return numericValue * 604800;
    case "month":
    case "months":
      return numericValue * 2592000;
    case "year":
    case "years":
      return numericValue * 31536000;
    case "":
      return 0;
    default:
      return 0;
  }
}

async function syncBuffEffectDuration(buffItem, normalizedDuration) {
  const effect = buffItem?.effect;
  if (!effect) return;
  const seconds = normalizeDurationToEffectSeconds(normalizedDuration);
  const startTime = Number(game?.time?.worldTime ?? effect?.duration?.startTime ?? 0);
  await effect.update({
    "duration.startTime": Number.isFinite(startTime) ? startTime : 0,
    "duration.seconds": Number.isFinite(seconds) ? seconds : 0
  });
}

/**
 * Apply a buff to appropriate targets
 * @param {Object} buff - The buff item to apply
 * @param {Array} targets - Array of target tokens
 * @param {Object} duration - The duration information for the buff
 * @param {number} casterLevel - The caster level of the spell
 * @param {Object} options - { activate?: boolean, silent?: boolean }
 * @returns {Promise<void>}
 */
export async function applyBuffToTargets(buff, targets, duration, casterLevel, options = {}) {
  const activate = options.activate !== false;
  const silent = !!options.silent;
  const buffName = getKnownBuffApplicationName(buff, options) || buff?.name || "";
  // If not GM, use socket to request GM to apply the buff
  if (!game.user.isGM) {
    return socket.executeAsGM(
      "applyBuffToTargetsSocket",
      { name: buffName || buff.name, id: buff.id, pack: buff.pack },
      targets.map(t => t.id),
      duration,
      casterLevel,
      {
        activate,
        silent,
        [KNOWN_BUFF_AUTOMATION_OPTION]: options[KNOWN_BUFF_AUTOMATION_OPTION] ?? null,
        ...serializeAppliedBuffOverrideOptions(options),
        ...serializeNonConsecutiveDurationOptions(options)
      }
    );
  }
  
  // Check for valid inputs
  if (!buff || !targets || targets.length === 0) {
    console.warn(`${MODULE.ID} | Cannot apply buff: Invalid buff or no targets`);
    return;
  }

  if (await shouldBlockAppliedBuffForLockout(null, buff, options)) return;

  const effectiveDuration = nonConsecutiveDurationForOptions(options, duration);
  const normalizedDuration = normalizeDurationForBuff(effectiveDuration);
  const durationUpdate = {
    "system.duration.units": normalizedDuration.units,
    "system.duration.value": String(normalizedDuration.value ?? "")
  };
  if (normalizedDuration.subType) {
    durationUpdate["system.subType"] = normalizedDuration.subType;
  }
  
  for (const target of targets) {
    try {
      const actor = target.actor;
      if (!actor) {
        console.warn(`${MODULE.ID} | Target has no actor, skipping buff application`);
        continue;
      }
      const nameMatches = actor.items.filter(item => item.type === "buff" && item.name === buffName);

      let existingBuff = null;
      if (buff.pack) {
        existingBuff = nameMatches.find(item => {
          const source = item.flags?.[MODULE.ID]?.sourceId || item.flags?.core?.sourceId || item._stats?.compendiumSource;
          if (!source || !source.startsWith("Compendium.")) return false;

          const parts = source.split('.');                    
          const itemIndex = parts.findIndex(part => part === "Item");
          if (itemIndex > 1) {
            const sourcePackId = parts.slice(1, itemIndex).join('.');
            return sourcePackId === buff.pack;
          }
          return false;
        });
      }

      if (!existingBuff && nameMatches.length > 0) {
        existingBuff = nameMatches[0];
      }
      
      if (existingBuff) {
        if (!existingBuff.flags?.[MODULE.ID]?.sourceId && buff.document?.uuid) {
          await existingBuff.update({ [`flags.${MODULE.ID}.sourceId`]: buff.document.uuid });
        }
        
        const isActive = existingBuff.isActive;
        if (isActive && activate && hasNonConsecutiveDurationOption(options)) {
          continue;
        }

        if (isActive && !activate) {
          await existingBuff.update({
            ...durationUpdate,
            name: buffName,
            "system.active": false,
            ...(casterLevel !== undefined ? { "system.level": casterLevel } : {})
          });
          await configureKnownBuffAutomation(existingBuff, { ...options, casterLevel });
          await applyAppliedBuffOverrideToItem(existingBuff, options);
          continue;
        }

        await existingBuff.update({
          ...durationUpdate,
          name: buffName,
          "system.active": activate,
          ...(casterLevel !== undefined ? { "system.level": casterLevel } : {})
        });
        await syncBuffEffectDuration(existingBuff, normalizedDuration);
        await configureKnownBuffAutomation(existingBuff, { ...options, casterLevel });
        await applyAppliedBuffOverrideToItem(existingBuff, options);
        if (activate) await markNonConsecutiveBuffActive(existingBuff, options);
        
        if (!silent) ui.notifications.info(game.i18n.format('NAS.buffs.UpdatedExisting', { name: buffName, actor: actor.name }));
      } else {
        let buffData;
        if (typeof Item?.implementation?.fromCompendium === "function") {
          buffData = await Item.implementation.fromCompendium(buff.document);
        } else if (typeof Item?.fromCompendium === "function") {
          buffData = await Item.fromCompendium(buff.document);
        } else {
          buffData = buff.document.toObject();
        }
        buffData.flags = buffData.flags || {};
        buffData.flags[MODULE.ID] = buffData.flags[MODULE.ID] || {};
        if (!buffData.flags[MODULE.ID].sourceId) {
          buffData.flags[MODULE.ID].sourceId = buff.document.uuid;
        }
        if (buffName && buffData.name !== buffName) {
          buffData.name = buffName;
        }
        
        if (effectiveDuration) {
          buffData.system = buffData.system || {};
          buffData.system.duration = buffData.system.duration || {};
          buffData.system.duration.units = normalizedDuration.units;
          buffData.system.duration.value = String(normalizedDuration.value ?? "");
        }
        if (normalizedDuration.subType) {
          buffData.system = buffData.system || {};
          buffData.system.subType = normalizedDuration.subType;
        }
        
        if (casterLevel !== undefined) {
          buffData.system = buffData.system || {};
          buffData.system.level = casterLevel;
        }
        
        buffData.system = buffData.system || {};
        buffData.system.active = activate;
        
        const newItems = await actor.createEmbeddedDocuments("Item", [buffData]);
        
        if (newItems && newItems.length > 0 && activate) {
          const newBuff = newItems[0];
          await newBuff.update({"system.active": true});
          await syncBuffEffectDuration(newBuff, normalizedDuration);
          await configureKnownBuffAutomation(newBuff, { ...options, casterLevel });
          await applyAppliedBuffOverrideToItem(newBuff, options);
          await markNonConsecutiveBuffActive(newBuff, options);
        } else if (newItems && newItems.length > 0) {
          await configureKnownBuffAutomation(newItems[0], { ...options, casterLevel });
          await applyAppliedBuffOverrideToItem(newItems[0], options);
        }
        
        if (!silent) ui.notifications.info(game.i18n.format('NAS.buffs.Applied', { name: buffName, actor: actor.name }));
      }
    } catch (error) {
      console.error(`${MODULE.ID} | Error applying buff to target:`, error);
      if (!silent) ui.notifications.error(game.i18n.format('NAS.buffs.FailedToApply', { name: buffName, error: error.message }));
    }
  }
}

function checkAndConsumeSpellSlots({ action, filteredTargets, isCommunal, isAreaOfEffect }) {
  const scalableInfo = (!isCommunal && !isAreaOfEffect && filteredTargets.length > 1)
    ? evaluateScalableTargetAllowance(action, filteredTargets)
    : null;
  if (scalableInfo?.allowSingleCast) {
    action.shared.rollData.chargeCost = scalableInfo.originalCost;
    return {
      spellbook: null,
      spellLevel: null,
      spellLevelKey: null,
      originalCost: scalableInfo.originalCost,
      totalCost: scalableInfo.originalCost,
      parsedTargetAllowance: scalableInfo.parsedTargetAllowance
    };
  }

  if (
    action.item.type === "spell" &&
    !isCommunal &&
    filteredTargets.length > 1 &&
    !isAreaOfEffect 
  ) {
    const numTargets = filteredTargets.length;
    const spellbook = action.item.system.spellbook;
    const baseSpellLevel = getRuntimeSpellLevel(action);
    const actor = action.token?.actor;

    const spellbookData = actor?.system?.attributes?.spells?.spellbooks?.[spellbook];
    const slotIncrease = Number(
      action.shared?.nasSpellContext?.metamagic?.consumedSlotIncrease
      ?? action.shared?.nasSpellContext?.metamagic?.effectiveSlotIncrease
      ?? action.shared?.nasSpellContext?.metamagic?.slotIncrease
      ?? 0
    );
    const preparedConsumptionSlotLevel = Number(
      action.shared?.nasSpellContext?.metamagic?.preparedSpellbookConsumption?.targetSlotLevel
      ?? action.shared?.nasSpellContext?.spellbookPreparedSpell?.consumption?.targetSlotLevel
      ?? NaN
    );
    const isSpontaneous = Boolean(spellbookData?.spontaneous);
    const targetSpellLevel = isSpontaneous && Number.isFinite(preparedConsumptionSlotLevel)
      ? preparedConsumptionSlotLevel
      : (isSpontaneous ? baseSpellLevel + slotIncrease : baseSpellLevel);
    const spellLevelKey = `spell${targetSpellLevel}`;
    const spellLevelData = spellbookData?.spells?.[spellLevelKey];

    let maxSlots, remainingSlots, usedSlots;
    if (spellbookData?.prepared && !spellbookData?.spontaneous) {
      maxSlots = action.item.system?.preparation?.max ?? 0;
      remainingSlots = action.item.system?.preparation?.value ?? 0;
      usedSlots = maxSlots - remainingSlots;
    } else if (spellbookData?.spontaneous) {
      maxSlots = spellLevelData.max ?? 0;
      remainingSlots = spellLevelData.value ?? 0;
      usedSlots = maxSlots - remainingSlots;
    } else {
      maxSlots = spellLevelData.max ?? 0;
      remainingSlots = spellLevelData.value ?? 0;
      usedSlots = maxSlots - remainingSlots;
    }
    let originalCost = 1;
    const costStr = action.item.system?.uses?.autoDeductChargesCost;
    if (typeof costStr === 'string' && costStr.trim() !== '') {
      const parsed = parseInt(costStr, 10);
      if (!isNaN(parsed) && parsed > 0) originalCost = parsed;
    }
    const totalCost = originalCost * numTargets;
    if (remainingSlots < totalCost) {
      action.shared.reject = true;
      ui.notifications.warn(
        game.i18n.format("NAS.buffs.NotEnoughSpellSlots", {
          remaining: remainingSlots,
          needed: totalCost
        })
      );
      return { rejected: true };
    }
    if (typeof action.shared.rollData.chargeCost === 'number') {
      action.shared.rollData.chargeCost = totalCost;
    } else {
      action.shared.rollData.chargeCost = totalCost;
    }
    return { spellbook, spellLevel: targetSpellLevel, spellLevelKey, originalCost, totalCost };
  }

  if (
    action.item.type === "spell" &&
    !isCommunal &&
    !isAreaOfEffect &&
    filteredTargets.length > 1
  ) {
    const targetText = action.action?.target?.value
      || action.item?.system?.actions?.[0]?.target?.value
      || action.item?.system?.target?.value;
    const casterLevel = getRuntimeCasterLevel(action);
    const parsedCount = estimateScalableTargets(targetText, casterLevel);
    if (parsedCount && parsedCount >= filteredTargets.length) {
      let originalCost = 1;
      const costStr = action.item.system?.uses?.autoDeductChargesCost;
      if (typeof costStr === 'string' && costStr.trim() !== '') {
        const parsed = parseInt(costStr, 10);
        if (!isNaN(parsed) && parsed > 0) originalCost = parsed;
      }
      action.shared.rollData.chargeCost = originalCost;
      return { spellbook: null, spellLevel: null, spellLevelKey: null, originalCost, totalCost: originalCost, parsedTargetAllowance: parsedCount };
    }
  }
  return {};
}

function evaluateScalableTargetAllowance(action, filteredTargets) {
  const forceScalable = action.item?.getFlag?.(MODULE.ID, 'scalableTargets') === true;
  const targetText = action.action?.target?.value
    || action.item?.system?.actions?.[0]?.target?.value
    || action.item?.system?.target?.value;
  const casterLevel = getRuntimeCasterLevel(action);
  const parsedCount = estimateScalableTargets(targetText, casterLevel);
  if (!forceScalable && (!parsedCount || parsedCount < filteredTargets.length)) {
    return null;
  }

  let originalCost = 1;
  const costStr = action.item.system?.uses?.autoDeductChargesCost;
  if (typeof costStr === 'string' && costStr.trim() !== '') {
    const parsed = parseInt(costStr, 10);
    if (!isNaN(parsed) && parsed > 0) originalCost = parsed;
  }
  return {
    allowSingleCast: true,
    originalCost,
    parsedTargetAllowance: parsedCount || filteredTargets.length
  };
}

function estimateScalableTargets(rawTarget, casterLevel) {
  if (!rawTarget || typeof rawTarget !== 'string') return null;
  const WORD_NUM = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
  const normalize = (s) => s
    .toLowerCase()
    .replace(/caster levels?/g, (m) => (m.endsWith('s') ? 'levels' : 'level'))
    .replace(/-/g, ' ')
    .replace(/[“”"’']/g, '')
    .replace(/[.,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (m) => String(WORD_NUM[m]))
    .trim();

  const s = normalize(rawTarget);
  if (!s) return null;

  const capMatch =
    s.match(/\bmaximum of (\d+)\b/) ||
    s.match(/\bto a maximum of (\d+)\b/) ||
    s.match(/\bmaximum (\d+)\b/) ||
    s.match(/\bmax(?:imum)?\s*(\d+)\b/);
  const cap = capMatch ? Number(capMatch[1]) : null;
  const applyCap = (n) => (Number.isFinite(cap) ? Math.min(n, cap) : n);

  const TYPE_IN_PARSE = "(?:creature|object|animal|construct|humanoid|ally|enemy|target|targets)";

  const countFormula = ({ base = 0, mult = 1, divisor = 1, mode = "floor" }) => {
    const scaled = mode === "linear" ? (casterLevel / divisor) * mult : Math.floor(casterLevel / divisor) * mult;
    return Math.max(1, applyCap(base + scaled));
  };

  let m = s.match(new RegExp(
    `^you\\s+(?:plus|and)\\s+(?:up to\\s+)?(\\d+)\\s+.*?${TYPE_IN_PARSE}.*?(?:\\/|per)\\s*level\\b`
  ));
  if (m) return countFormula({ base: 1, mult: Number(m[1]), divisor: 1, mode: "linear" });

  m = s.match(new RegExp(
    `^you\\s+(?:plus|and)\\s+(?:up to\\s+)?(\\d+)\\s+.*?${TYPE_IN_PARSE}.*?(?:\\/|per)\\s*(\\d+)\\s*levels?\\b`
  ));
  if (m) return countFormula({ base: 1, mult: Number(m[1]), divisor: Number(m[2]), mode: "floor" });

  m = s.match(/\bup to (\d+)\s*(?:\/|per)\s*level\b/);
  if (m) return countFormula({ base: 0, mult: Number(m[1]), divisor: 1, mode: "linear" });

  m = s.match(/^(?:up to\s+)?(\d+)\s+.*?(?:\/|per)\s*level\b/);
  if (m) return countFormula({ base: 0, mult: Number(m[1]), divisor: 1, mode: "linear" });

  m = s.match(/^(?:up to\s+)?(\d+)\s+.*?(?:\/|per)\s*(\d+)\s*levels?\b/);
  if (m) return countFormula({ base: 0, mult: Number(m[1]), divisor: Number(m[2]), mode: "floor" });

  m = s.match(new RegExp(`\\b(\\d+)\\s+.*?${TYPE_IN_PARSE}.*?(?:\\/|per)\\s*level\\b`));
  if (m) return countFormula({ base: 0, mult: Number(m[1]), divisor: 1, mode: "linear" });

  return null;
}

async function handleCommunalDuration({
  isCommunal,
  filteredTargets,
  durationUnits,
  durationValue,
  communalIncrement,
  communalTotalDuration,
  communalDurationUnit,
  action
}) {
  if (isCommunal && filteredTargets && filteredTargets.length > 0) {
    const communalHandling = game.settings.get(MODULE.ID, 'communalHandling');
    const n = filteredTargets.length;
    if ((durationUnits === 'hour' || durationUnits === 'hours') && Number(durationValue) === 24) {
      const increment = 1;
      const total = 24;
      if (communalHandling === 'prompt') {
        const communalResult = await promptTargetSelection(filteredTargets, action, {
          communal: true,
          increment,
          total,
          unit: durationUnits
        });
        if (communalResult.length > 0 && communalResult[0].target && communalResult[0].duration !== undefined) {
          return communalResult;
        } else {
          return null;
        }
      } else if (communalHandling === 'even') {
        const perTarget = Math.floor(total / n);
        const assignedTotal = perTarget * n;
        if (assignedTotal === total && perTarget > 0) {
          return filteredTargets.map(target => ({ target, duration: { value: perTarget, units: durationUnits } }));
        } else {
          const communalResult = await promptTargetSelection(filteredTargets, action, {
            communal: true,
            increment,
            total,
            unit: durationUnits
          });
          if (communalResult.length > 0 && communalResult[0].target && communalResult[0].duration !== undefined) {
            return communalResult;
          } else {
            return null;
          }
        }
      }
    } else if (communalIncrement && communalTotalDuration) {
      if (communalHandling === 'prompt') {
        const communalResult = await promptTargetSelection(filteredTargets, action, {
          communal: true,
          increment: communalIncrement,
          total: communalTotalDuration,
          unit: communalDurationUnit || durationUnits
        });
        if (communalResult.length > 0 && communalResult[0].target && communalResult[0].duration !== undefined) {
          return communalResult;
        } else {
          return null;
        }
      } else if (communalHandling === 'even') {
        const perTarget = Math.floor(communalTotalDuration / n / communalIncrement) * communalIncrement;
        const assignedTotal = perTarget * n;
        if (assignedTotal === communalTotalDuration && perTarget > 0) {
          return filteredTargets.map(target => ({ target, duration: { value: perTarget, units: communalDurationUnit || durationUnits } }));
        } else {
          const communalResult = await promptTargetSelection(filteredTargets, action, {
            communal: true,
            increment: communalIncrement,
            total: communalTotalDuration,
            unit: communalDurationUnit || durationUnits
          });
          if (communalResult.length > 0 && communalResult[0].target && communalResult[0].duration !== undefined) {
            return communalResult;
          } else {
            return null;
          }
        }
      }
    }
  }
  return null;
}

async function parseCommunalDuration({ action, durationUnits, rawDurationValue, casterLevel }) {
  const normalizeUnit = (unit) => {
    if (!unit) return null;
    const lower = unit.toString().toLowerCase();
    if (lower.startsWith('hour')) return 'hour';
    if (lower.startsWith('min')) return 'minute';
    if (lower.startsWith('day')) return 'day';
    if (lower.startsWith('round')) return 'round';
    return unit;
  };

  const setUnitFromText = (text, currentUnit) => {
    if (currentUnit) return currentUnit;
    if (/min/i.test(text)) return 'minute';
    if (/hour|hr/i.test(text)) return 'hour';
    if (/day/i.test(text)) return 'day';
    if (/round/i.test(text)) return 'round';
    return null;
  };

  const unit = normalizeUnit(durationUnits);
  const formulaStr = typeof rawDurationValue === 'string' ? rawDurationValue.trim() : '';
  const rollData = action.shared?.rollData ?? {};

  let increment = null;
  let totalDuration = null;
  let derivedUnit = unit;

  const numericValue = Number(rawDurationValue);
  if (!Number.isNaN(numericValue) && numericValue > 0) {
    increment = 1;
    totalDuration = numericValue;
    return { increment, totalDuration, unit: derivedUnit, formula: rawDurationValue };
  }

  if (formulaStr) {
    const perLevelMatch = formulaStr.match(/(\d+)\s*(min\.?|minute|hr|hour|day|round)s?\.?\s*\/\s*level/i);
    if (perLevelMatch) {
      increment = parseInt(perLevelMatch[1], 10);
      derivedUnit = setUnitFromText(perLevelMatch[0], derivedUnit) || derivedUnit;
      totalDuration = increment * (casterLevel || 0);
      return { increment, totalDuration, unit: derivedUnit, formula: rawDurationValue };
    }

    const multiplierMatch = formulaStr.match(/(\d+)\s*\*\s*@cl/i);
    if (multiplierMatch) {
      increment = parseInt(multiplierMatch[1], 10);
      totalDuration = increment * (casterLevel || 0);
    }

    if (increment === null && /@cl/i.test(formulaStr)) {
      increment = 1;
      totalDuration = (casterLevel || 0);
    }

    const formulaLooksRollable = !/\/level/i.test(formulaStr) && !/until discharged/i.test(formulaStr);
    if (formulaLooksRollable) {
      try {
        const evaluated = await new Roll(formulaStr, rollData).evaluate();
        if (evaluated?.total !== undefined) {
          totalDuration = evaluated.total;
        }
      } catch (err) {
        console.warn(`${MODULE.ID} | parseCommunalDuration: Failed to evaluate formula "${formulaStr}"`, err);
      }
    }

    if (increment === null) {
      const fallbackMultiplier = formulaStr.match(/(\d+)\s*\*\s*@cl/i);
      if (fallbackMultiplier) {
        increment = parseInt(fallbackMultiplier[1], 10);
      } else if (/@cl/i.test(formulaStr)) {
        increment = 1;
      }
    }

    if (increment === null && totalDuration !== null) {
      increment = 1;
    }

    if (increment !== null || totalDuration !== null) {
      return {
        increment,
        totalDuration,
        unit: derivedUnit,
        formula: rawDurationValue
      };
    }
  }

  return null;
}
