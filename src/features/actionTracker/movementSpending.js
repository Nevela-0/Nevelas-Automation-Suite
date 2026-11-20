import { copy, fail } from "./model.js";

const EPSILON = 1e-9;
export const MOVEMENT_MODES = { walk: "Land", fly: "Fly", climb: "Climb", swim: "Swim", burrow: "Burrow", crawl: "Crawl", jump: "Jump" };
export const normalizeMode = (mode) => mode === "land" ? "walk" : mode === "prone" ? "crawl" : mode;
const CONVERSIONS = new Map([["ft", 1], ["feet", 1], ["foot", 1], ...["m", "meter", "meters", "metre", "metres"].map((unit) => [unit, 1 / 0.3])]);
const unitsToFeet = (unit) => CONVERSIONS.get(typeof unit === "string" ? unit.trim().toLowerCase() : "");
export const actionCount = (fraction) => fraction <= 0 ? 0 : Math.max(1, Math.ceil(fraction - EPSILON * Math.max(1, fraction)));

export function capturePF1Movement(actor, mode) {
  mode = normalizeMode(mode);
  const diagnostic = { actorUuid: actor?.uuid ?? null, actorType: actor?.type ?? null, mode,
    provider: "actor.getMovement", status: "actorMissing", preparedSpeed: null, returnedSpeed: null };
  const captured = { speed: null, run: null, step: null, diagnostic };
  if (!actor) return captured;
  try {
    const listed = actor.system?.attributes?.speed?.[mode === "walk" ? "land" : mode]?.total;
    diagnostic.preparedSpeed = Number.isFinite(listed) ? listed : null;
    const hasHelper = typeof actor.getMovement === "function";
    let result = hasHelper ? actor.getMovement(mode) : undefined;

    if (result == null && actor.type === "npc" && Number.isFinite(actor.system?.attributes?.speed?.land?.total)) {
      const characterMovement = globalThis.CONFIG?.Actor?.documentClasses?.character?.prototype?.getMovement;
      if (typeof characterMovement === "function" && characterMovement !== actor.getMovement) {
        diagnostic.fallbackFrom = hasHelper ? "helperReturnedNothing" : "helperMissing";
        diagnostic.provider = "ActorCharacterPF.getMovement";
        result = characterMovement.call(actor, mode);
      }
    }
    if (!hasHelper && diagnostic.provider === "actor.getMovement") { diagnostic.status = "helperMissing"; return captured; }
    const speed = result?.speed;
    diagnostic.returnedSpeed = Number.isFinite(speed) ? speed : typeof speed === "string" ? speed.slice(0, 80) : null;
    diagnostic.returnedType = typeof speed;
    captured.run = typeof result?.run === "boolean" ? result.run : null;
    captured.step = typeof result?.step === "boolean" ? result.step : null;
    diagnostic.status = speed == null ? "speedMissing" : !Number.isFinite(speed) ? "speedInvalid" : speed <= 0 ? "speedNonpositive" : "ok";
    if (diagnostic.status === "ok") captured.speed = speed;
  } catch (error) {
    diagnostic.status = "helperError";
    diagnostic.error = String(error?.message ?? error).slice(0, 200);
  }
  return captured;
}

export function snapshotSpeed(actor, mode, units, economy, prepared) {
  mode = normalizeMode(typeof mode === "string" ? mode : "");
  const snapshot = { mode, economy, units, feetPerUnit: unitsToFeet(units) ?? null, speed: null };
  if (!Object.hasOwn(MOVEMENT_MODES, mode)) return { ...snapshot, warning: "This movement mode is not supported for automatic spending." };
  prepared ??= capturePF1Movement(actor, mode);
  snapshot.speedDiagnostic = copy(prepared.diagnostic);
  if (!snapshot.feetPerUnit) return { ...snapshot, warning: "Scene units cannot be converted to PF1 movement speed." };
  snapshot.speed = prepared.speed;
  if (snapshot.speed === null) {
    const reason = { actorMissing: "The combatant's actor is unavailable", helperMissing: "PF1's movement helper is unavailable for this actor",
      helperError: "PF1's movement helper failed", speedMissing: "PF1 did not return a movement speed",
      speedInvalid: "PF1 returned an invalid movement speed", speedNonpositive: `PF1 reports no positive ${MOVEMENT_MODES[mode]} speed` }[prepared.diagnostic.status];
    return { ...snapshot, warning: `${reason}; distance was saved without spending an action.` };
  }
  return snapshot;
}

export function spendingData(ledger) {
  ledger.spending ??= { version: 1, mode: "walk", sequences: [], boundaries: [], requests: [] };
  const data = ledger.spending;
  if (data.version !== 1 || ![data.sequences, data.boundaries, data.requests].every(Array.isArray)) fail("invalidState", "Invalid movement spending history.");
  return data;
}

export function openSequence(ledger, checkpointId, economy, id) {
  const data = spendingData(ledger);
  let sequence = data.sequences.findLast((s) => s.checkpointId === checkpointId && !s.closed);
  if (sequence && sequence.economy !== economy) {
    endSequence(ledger, checkpointId, id, "economyChanged");
    sequence = null;
  }
  if (!sequence) {
    sequence = { id, checkpointId, economy, payments: [], waivers: [], closed: false };
    data.sequences.push(sequence);
  }
  return sequence;
}

export function endSequence(ledger, checkpointId, operationId, reason) {
  const data = ledger.spending;

  if (data && reason !== "disabled") data.springBoundary = { checkpointId, afterOperationId: ledger.operations.at(-1)?.operationId ?? null };
  const sequence = data?.sequences.findLast((s) => s.checkpointId === checkpointId && !s.closed);
  if (!sequence) return false;
  sequence.closed = true;
  sequence.remaining = 0;
  sequence.closedBy = operationId;
  data.boundaries.push({ operationId, checkpointId, sequenceId: sequence.id, reason });
  return true;
}

export function isMovementBoundary(operation) {
  if (["swift", "immediate", "aoo", "free", "nonaction", "reaction"].includes(operation.metadata?.activation?.type)) return false;
  return ["move", "standard", "action"].some((pool) => (operation.costs?.[pool] ?? 0) > 0);
}

export function eligiblePayment(action, economy) {
  if (action?.step || action?.activity) return false;
  if (!action || action.undone || Object.values(action.nextTurnCosts ?? {}).some((n) => n !== 0)) return false;
  const costs = Object.entries(action.costs).filter(([, n]) => n !== 0);
  return costs.length === 1 && costs[0][1] === 1 && (economy === "unchained" ? costs[0][0] === "action" : ["move", "standard"].includes(costs[0][0]));
}

export function linkPayment(ledger, sequence, action, kind = "manual") {
  if (!eligiblePayment(action, sequence.economy) || action.checkpointId !== sequence.checkpointId) fail("ineligiblePayment", "Choose an active single Move, Standard or act from this combatant and turn, without additional or deferred costs.");
  for (const existing of spendingData(ledger).sequences) {
    const payment = existing.payments.find((p) => p.actionId === action.operationId && p.active);
    if (!payment) continue;
    if (existing.id === sequence.id) return payment;
    fail("paymentLinked", "This action already pays for another movement sequence.");
  }
  const payment = { actionId: action.operationId, kind, active: true, coverage: [] };
  sequence.payments.push(payment);
  action.movement = { sequenceId: sequence.id, payment: kind, status: "linked" };
  return payment;
}

export function unlinkPayment(ledger, action) {
  for (const sequence of ledger.spending?.sequences ?? []) {
    const payment = sequence.payments.find((p) => p.active && p.actionId === action?.operationId);
    if (!payment) continue;
    if (payment.kind !== "manual") fail("ineligiblePayment", "Automatic movement charges can be undone, not unlinked.");
    payment.active = false;
    payment.status = "unlinked";
    action.movement = { ...action.movement, status: "unlinked" };
    return sequence;
  }
  return null;
}

export function waivePayment(ledger, action) {
  for (const sequence of ledger.spending?.sequences ?? []) {
    const payment = sequence.payments.find((p) => p.active && p.actionId === action.operationId);
    if (!payment) continue;
    sequence.waivers.push({ actionId: action.operationId, coverage: copy(payment.coverage) });
    payment.active = false;
    payment.status = "waived";
    action.movement = { ...action.movement, status: "waived", coverage: copy(payment.coverage) };
    return sequence;
  }
  return null;
}

function portions(ledger, sequence, waived = true) {
  const result = [];
  for (const op of ledger.operations) {
    if (op.spending?.sequenceId !== sequence.id || op.excluded || op.reversed) continue;
    let parts = [{ movementId: op.operationId, from: 0, to: op.spending.consumption }];
    if (waived) for (const waiver of sequence.waivers) for (const cover of waiver.coverage) {
      if (cover.movementId !== op.operationId) continue;
      parts = parts.flatMap((p) => cover.to <= p.from || cover.from >= p.to ? [p] : [
        { ...p, to: Math.min(p.to, cover.from) }, { ...p, from: Math.max(p.from, cover.to) }
      ].filter((p) => p.to > p.from));
    }
    result.push(...parts.filter((p) => p.to > p.from));
  }
  return result;
}
const amount = (parts) => parts.reduce((sum, part) => sum + part.to - part.from, 0);
export const sequenceConsumption = (ledger, sequence) => amount(portions(ledger, sequence));

export function reconcileSequence(ledger, sequence, actions, { spend, refund }) {
  const uncovered = portions(ledger, sequence);
  const total = amount(uncovered);
  const active = sequence.payments.filter((p) => p.active && !actions.operations.find((a) => a.operationId === p.actionId)?.undone);
  const manual = active.filter((p) => p.kind === "manual");
  const automatic = active.filter((p) => p.kind === "automatic");
  const needed = Math.max(0, actionCount(total) - manual.length);
  if (!Number.isSafeInteger(needed) || needed > 10000) fail("invalidMovement", "Movement exceeds the automatic accounting range; correct it manually.");
  while (automatic.length > needed) {
    const payment = automatic.pop();
    payment.active = false;
    payment.status = "refunded";
    const action = actions.operations.find((a) => a.operationId === payment.actionId);
    action.movement = { ...action.movement, status: "refunded" };
    refund(action);
  }
  while (automatic.length < needed) automatic.push(linkPayment(ledger, sequence, spend(sequence), "automatic"));

  let index = 0, offset = uncovered[0]?.from ?? 0;
  const payments = [...manual, ...automatic];
  for (const [paymentIndex, payment] of payments.entries()) {
    payment.coverage = [];
    let remaining = 1;
    const last = paymentIndex === payments.length - 1;
    while ((remaining > EPSILON || last) && index < uncovered.length) {
      const part = uncovered[index];

      const end = last || part.to - offset <= remaining ? part.to : offset + remaining;
      const take = end - offset;
      if (take <= 0) break;
      payment.coverage.push({ movementId: part.movementId, from: offset, to: end });
      remaining -= take;
      offset = end;
      if (offset >= part.to) { index++; offset = uncovered[index]?.from ?? 0; }
    }
  }
  sequence.consumption = amount(portions(ledger, sequence, false));
  sequence.waived = Math.max(0, sequence.consumption - total);
  sequence.paid = manual.length + automatic.length;
  sequence.remaining = sequence.closed ? 0 : Math.max(0, sequence.paid - total);
  return sequence;
}

export function spendingView(ledger, checkpointId) {
  const sequences = (ledger.spending?.sequences ?? []).filter((s) => s.checkpointId === checkpointId);
  const current = sequences.findLast((s) => !s.closed);
  const last = ledger.operations.findLast((op) => op.spending?.sequenceId === current?.id && !op.excluded && !op.reversed);
  return copy({ mode: ledger.spending?.mode ?? "walk", sequences,
    current: current ? { ...current, speed: last?.spending?.speed ?? null, mode: last?.spending?.mode ?? ledger.spending?.mode ?? "walk" } : null });
}
