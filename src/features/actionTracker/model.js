

export const TRACKER_VERSION = 1;
export const TRACKER_FLAG = "actionTracker";

export class ActionTrackerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActionTrackerError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ActionTrackerError(code, message);
}

export function copy(value) {
  return structuredClone(value);
}

function readVersioned(value, field) {
  if (value == null) return { version: TRACKER_VERSION, revision: 0, [field]: [] };
  if (value.version !== TRACKER_VERSION) fail("unsupportedVersion", "Unsupported action tracker data version.");
  if (!Array.isArray(value[field]) || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail("invalidState", "Invalid saved action tracker state.");
  }
  return copy(value);
}

export const readTimeline = (value) => readVersioned(value, "checkpoints");
export const readLedger = (value) => readVersioned(value, "operations");

export function checkpointId(round, combatantUuid = null) {
  return `${round}:${combatantUuid ?? "-"}`;
}

export function captureTurn(combat) {
  const round = Number(combat.round ?? 0);
  if (!Number.isSafeInteger(round) || round < 0) fail("invalidTurn", "Invalid combat round.");
  const activeUuid = round > 0 ? combat.combatant?.uuid ?? null : null;
  return {
    id: checkpointId(round, activeUuid),
    round,
    combatantUuid: activeUuid,
    order: (combat.turns ?? []).map((entry) => entry.uuid)
  };
}

export function includeCheckpoint(timeline, turn) {
  const next = readTimeline(timeline);
  if (next.checkpoints.some((entry) => entry.id === turn.id)) return { timeline: next, changed: false };
  const entries = next.checkpoints;
  let index = entries.findIndex((entry) => entry.round > turn.round);
  if (index < 0) index = entries.length;
  const position = turn.order.indexOf(turn.combatantUuid);
  if (position >= 0) {
    const following = turn.order.slice(position + 1);
    const preceding = turn.order.slice(0, position).reverse();
    const successor = following.map((uuid) => entries.findIndex((e) => e.round === turn.round && e.combatantUuid === uuid)).find((i) => i >= 0);
    const predecessor = preceding.map((uuid) => entries.findIndex((e) => e.round === turn.round && e.combatantUuid === uuid)).find((i) => i >= 0);
    if (successor !== undefined) index = successor;
    else if (predecessor !== undefined) index = predecessor + 1;
  }
  entries.splice(index, 0, { id: turn.id, round: turn.round, combatantUuid: turn.combatantUuid });
  next.revision += 1;
  return { timeline: next, changed: true };
}

export function normalizeCosts(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalidCosts", "Action costs must be a pool-to-number object.");
  const result = {};
  for (const [pool, amount] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(pool) || ["constructor", "prototype"].includes(pool)) {
      fail("invalidCosts", "Invalid action pool name.");
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      fail("invalidCosts", "Action costs must be finite, non-negative numbers.");
    }
    result[pool] = amount;
  }
  return result;
}

function optionalText(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1024) fail("invalidUse", `Invalid ${name}.`);
  return value;
}

export function normalizeActivation(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalidActivation", "Invalid action activation.");
  const type = optionalText(value.type, "activation type") ?? "";
  const cost = value.cost ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) fail("invalidActivation", "Invalid activation cost.");
  return { type, cost };
}

export function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalidUse", "Invalid action metadata.");
  const result = {};
  if (value.activation !== undefined) result.activation = normalizeActivation(value.activation);
  if (value.economy !== undefined) {
    if (!["normal", "unchained"].includes(value.economy)) fail("invalidUse", "Unknown action economy.");
    result.economy = value.economy;
  }
  if (value.activationSource !== undefined) {
    if (!["pf1", "nas"].includes(value.activationSource)) fail("invalidUse", "Unknown activation source.");
    result.activationSource = value.activationSource;
  }
  if (value.inference !== undefined) {
    if (!Array.isArray(value.inference) || value.inference.length > 16) fail("invalidUse", "Invalid action inference.");
    result.inference = value.inference.map((entry) => {
      if (typeof entry !== "string") fail("invalidUse", "Invalid action inference.");
      return optionalText(entry, "inference");
    });
  }
  if (value.continuation !== undefined) {
    const continuation = value.continuation;
    if (!continuation || typeof continuation !== "object" || Array.isArray(continuation) || typeof continuation.extraFullRound !== "boolean") {
      fail("invalidUse", "Invalid continuation metadata.");
    }
    result.continuation = { activation: normalizeActivation(continuation.activation), extraFullRound: continuation.extraFullRound };
  }
  return result;
}

export function normalizeUse(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalidUse", "An action use is required.");
  if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)) {
    fail("invalidUse", "A valid operation ID is required.");
  }
  const source = {};
  if (input.source != null && (typeof input.source !== "object" || Array.isArray(input.source))) fail("invalidUse", "Invalid action source.");
  for (const key of ["itemUuid", "actionId", "messageUuid"]) {
    const value = optionalText(input.source?.[key], key);
    if (value !== undefined) source[key] = value;
  }
  return {
    operationId: input.operationId,
    label: optionalText(input.label, "label") ?? "Action",
    costs: normalizeCosts(input.costs),
    nextTurnCosts: normalizeCosts(input.nextTurnCosts),
    source,
    ...(input.metadata === undefined ? {} : { metadata: normalizeMetadata(input.metadata) })
  };
}

export function sameUse(operation, use, userId) {
  return operation.userId === userId && JSON.stringify(normalizeUse(operation)) === JSON.stringify(use);
}

function addCosts(target, costs) {
  for (const [pool, amount] of Object.entries(costs)) {
    const total = (Object.hasOwn(target, pool) ? target[pool] : 0) + amount;
    if (!Number.isFinite(total)) fail("invalidCosts", "Accumulated action costs exceed the supported range.");
    target[pool] = total;
  }
}

export function historyAt(timeline, ledger) {
  const positions = new Map(timeline.checkpoints.map((entry, index) => [entry.id, index]));
  if (ledger.operations.some((entry) => !positions.has(entry.checkpointId))) {
    fail("invalidState", "An action references a missing turn checkpoint.");
  }

  return copy(ledger.operations).sort((a, b) => positions.get(a.checkpointId) - positions.get(b.checkpointId));
}

export function projectState(timeline, ledger, combatantUuid, selectedId, { includeUndoTarget = false } = {}) {
  const selected = timeline.checkpoints.findIndex((entry) => entry.id === selectedId);
  if (selected < 0) fail("unknownCheckpoint", "The requested turn checkpoint does not exist.");
  const operations = historyAt(timeline, ledger);
  const grouped = new Map();
  for (const operation of operations) {
    if (operation.undone) continue;
    const entries = grouped.get(operation.checkpointId) ?? [];
    entries.push(operation);
    grouped.set(operation.checkpointId, entries);
  }
  let used = {};
  let nextTurnCosts = {};
  let lastOperationId = null;
  for (const checkpoint of timeline.checkpoints.slice(0, selected + 1)) {
    if (checkpoint.round > 0 && checkpoint.combatantUuid === combatantUuid) {
      used = nextTurnCosts;
      nextTurnCosts = {};
    }
    for (const operation of grouped.get(checkpoint.id) ?? []) {
      lastOperationId = operation.operationId;
      addCosts(used, operation.costs);
      addCosts(nextTurnCosts, operation.nextTurnCosts);
    }
  }
  const state = { version: TRACKER_VERSION, combatantUuid, checkpointId: selectedId, revision: ledger.revision, used, nextTurnCosts };
  if (includeUndoTarget) state.lastOperationId = lastOperationId;
  return state;
}

export function lastUseAt(timeline, ledger, selectedId) {
  const selected = timeline.checkpoints.findIndex((entry) => entry.id === selectedId);
  if (selected < 0) fail("unknownCheckpoint", "The requested turn checkpoint does not exist.");
  const eligible = new Set(timeline.checkpoints.slice(0, selected + 1).map((entry) => entry.id));
  return historyAt(timeline, ledger).findLast((entry) => !entry.undone && eligible.has(entry.checkpointId)) ?? null;
}
