import { captureTurn, copy, fail, normalizeUse, projectState } from "./model.js";
import { normalizePF1Details, resolvePF1Costs } from "./pf1Costs.js";
import { endSequence, isMovementBoundary, reconcileSequence, spendingData } from "./movementSpending.js";
import { activeDeclaration, normalizeAssessment } from "./movementSteps.js";
import { declareSpring, requireSpringFeats, SPRING_VARIANTS, springNextSlot, springPenalty, springWarnings, springAdjacency } from "./springAttack.js";

export const ACTIVITY_REQUESTS = ["armActivity", "beginSpringAttack", "finishActivity", "convertActivity", "linkActivityAttack", "unlinkActivityAttack", "reserveSpringAttack", "releaseSpringAttack", "completeActivityUse"];
export const activeActivity = (ledger) => ledger.activities?.entries.findLast((a) => ["armed", "active"].includes(a.status)) ?? null;
export const activityLabel = (a) => a.kind === "spring" ? `${a.spring?.mythic ? "Mythic " : ""}${SPRING_VARIANTS[a.spring?.variant]?.label ?? "Spring Attack"}` : `${a.restricted ? "Restricted " : ""}${{ run: "Run", charge: "Charge", withdraw: "Withdraw" }[a.kind] ?? "Activity"}`;
const activeMove = (op) => op?.kind === "move" && !op.excluded && !op.reversed && !op.teleport;
export function activityData(ledger) {
  ledger.activities ??= { version: 1, entries: [], uses: [] };
  const data = ledger.activities;
  if (data.version !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.uses)) fail("invalidState", "Invalid movement activity history.");
  return data;
}
export function activityCosts(a) {
  return a.economy === "unchained" ? { action: a.kind === "charge" ? 2 : 3 }
    : a.restricted ? { standard: 1 } : { standard: 1, move: 1 };
}
export function closeActivity(ledger, a, reason, time) {
  if (!a || !["preparing", "armed", "active"].includes(a.status)) return false;
  const preparing = a.status === "preparing";
  a.status = a.status !== "active" ? "canceled" : "finished";
  a.remaining = 0;
  a.endedAt = time; a.endedReason = reason;
  for (const r of a.spring?.reservations ?? []) if (r.status === "pending") r.status = "expired";
  for (const op of ledger.operations) if (op.activity?.id === a.id) op.activity.status = a.status;
  if (!preparing) endSequence(ledger, a.checkpointId, a.id, `activity:${reason}`);
  return true;
}
export function expireActivities(ledger, { checkpointId, tokenUuid, enabled, permitted, now }) {
  const a = activeActivity(ledger) ?? ledger.activities?.entries.findLast((a) => a.status === "preparing");
  if (!a || (enabled && a.checkpointId === checkpointId && a.tokenUuid === tokenUuid && permitted(a.userId))) return false;
  return closeActivity(ledger, a, "expired", now);
}

export function createActivityWriter({ createId, now, turnEvidence = () => null }) {
  function prefix(context, checkpointId) {
    const ledger = context.movement, fence = ledger.spending?.springBoundary;
    if (ledger.gaps.some((g) => g.checkpointId === checkpointId)) return [];
    const start = fence?.checkpointId === checkpointId ? ledger.operations.findIndex((op) => op.operationId === fence.afterOperationId) + 1 : 0;
    let ids = [];
    for (const op of ledger.operations.slice(start)) {
      if (op.checkpointId !== checkpointId || op.tokenUuid !== context.combatant.token.uuid) continue;
      const group = ledger.steps?.groups.find((g) => g.recordIds.includes(op.operationId));
      if (!activeMove(op) || op.spending?.dialogPrefix !== 1 || op.activity || group?.requested === "step") { ids = []; continue; }
      if (op.distance > 0) ids.push(op.operationId);
    }
    return ids;
  }
  function adoptPrefix(context, a) {
    a.recordIds = [...a.prefixIds];
    const sequences = new Set();
    for (const op of context.movement.operations.filter((op) => a.recordIds.includes(op.operationId))) {
      const s = op.spending;
      if (s.sequenceId) sequences.add(s.sequenceId);
      s.priorSequenceId = s.sequenceId ?? null;
      delete s.sequenceId;
      s.consumption = 0;
      s.activityId = a.id;
      s.activityConsumption = s.warning ? null : (op.terrain?.cost ?? op.distance) * s.feetPerUnit / s.speed;
      if (!Number.isFinite(s.activityConsumption)) s.activityConsumption = null;
      op.activityId = a.id;
    }
    a.priorWaivers = [];
    for (const sequence of context.movement.spending?.sequences ?? []) if (sequences.has(sequence.id)) {
      for (const waiver of sequence.waivers) a.priorWaivers.push({ ...copy(waiver), coverage: waiver.coverage.filter((p) => a.recordIds.includes(p.movementId)) });

      reconcileSequence(context.movement, sequence, context.actions, { refund: (action) => refund(context, action),
        spend: () => { fail("invalidActivity", "Movement changed while preparing Spring Attack; review it before retrying."); } });
    }
    endSequence(context.movement, a.checkpointId, a.id, "activityStart");
  }
  function add(context, use, checkpointId, extra = {}) {
    const action = { ...normalizeUse(use), ...extra, checkpointId, userId: context.userId, createdAt: now(), undone: false };
    if (context.actions.operations.some((a) => a.operationId === action.operationId)) fail("operationConflict", "This action identity is already in use.");
    context.actions.operations.push(action); context.events.push({ kind: "spend", use: action });
    return action;
  }
  function refund(context, action) {
    if (!action || action.undone) return;
    Object.assign(action, { undone: true, undoneBy: context.userId, undoneAt: now() });
    context.events.push({ kind: "undo", use: action });
  }
  function pay(context, a) {
    if (a.actionId) return;
    const action = add(context, { operationId: createId(), label: activityLabel(a), costs: activityCosts(a), metadata: { economy: a.economy } }, a.checkpointId,
      { origin: "manual", activity: { id: a.id, kind: a.kind, status: "linked" } });
    a.actionId = action.operationId; a.status = "active"; a.startedAt = now();
  }
  function observed(context, op, snapshot, gap) {
    const a = activeActivity(context.movement);
    if (op.teleport || (gap && a?.recordIds.length)) {
      closeActivity(context.movement, a, op.teleport ? "displacement" : "trackingGap", now());
      return false;
    }
    if (!op.activityId || !a || a.id !== op.activityId || a.checkpointId !== op.checkpointId || a.tokenUuid !== op.tokenUuid) {
      if (op.activityId) op.spending.warning = "The captured movement activity ended before this movement was accepted; review its accounting.";
      return !!op.activityId;
    }
    if (!(op.distance > 0)) return false;
    pay(context, a);
    a.recordIds.push(op.operationId);
    if (snapshot.warning) {
      op.spending.activityMeasurementWarning = snapshot.warning;
      op.spending.warning = "Activity allowance could not be verified for the recorded mode, speed, units or terrain; the fixed activity payment was retained.";
    }
    op.spending.activityId = a.id;
    op.spending.activityConsumption = snapshot.warning ? null : (op.terrain?.cost ?? op.distance) * snapshot.feetPerUnit / snapshot.speed;
    if (!Number.isFinite(op.spending.activityConsumption)) op.spending.activityConsumption = null;
    return true;
  }
  function reconcile(context) {
    for (const a of context.movement.activities?.entries ?? []) {
      const moves = a.recordIds.map((id) => context.movement.operations.find((op) => op.operationId === id)).filter(activeMove);
      a.consumption = moves.reduce((n, op) => n + (op.spending.activityConsumption ?? 0), 0);
      a.incomplete = moves.some((op) => op.spending.activityConsumption === null || op.spending.warning)
        || context.movement.gaps.some((gap) => gap.checkpointId === a.checkpointId);
      a.remaining = ["armed", "active"].includes(a.status) && !a.incomplete ? Math.max(0, a.multiplier - a.consumption) : 0;
      const warnings = [];
      if (a.incomplete) warnings.push("Some movement capacity could not be verified; the fixed activity payment is retained.");
      if (a.consumption > a.multiplier + 1e-8) warnings.push("Movement exceeds this activity's allowance; no extra action was charged.");
      if (a.restricted) warnings.push("Eligibility for the restricted variant is manually adjudicated.");
      if (a.spring) warnings.push(...springWarnings(a, context.movement));
      if (a.assessment === "unverified") warnings.push("Environmental conditions and comprehensive activity legality are unverified.");
      const terrain = moves.some((op) => op.terrain?.multiplier > 1);
      if (["run", "charge"].includes(a.kind) && (a.assessment === "hampered" || (terrain && a.assessment !== "clear"))) warnings.push("Run/Charge encountered known hampered terrain; review this activity.");
      if (terrain && a.assessment === "clear") warnings.push("Clear assessment overrides the recorded terrain restriction only; terrain costs remain applied.");
      if (moves.some((op) => op.spending.activityCapability === false)) warnings.push("The recorded movement mode does not support this activity; review manually.");
      const feet = moves.reduce((n, op) => n + op.distance * (op.spending.feetPerUnit ?? 0), 0);
      if (a.kind === "charge" && a.economy === "normal" && a.attackId && feet < 10 - 1e-8) warnings.push("Normal Charge traveled less than ten feet before its attack.");

      if (["run", "charge"].includes(a.kind)) {
        let prior, direction;
        for (const op of moves) {
          if (prior && (prior.x !== op.points[0].x || prior.y !== op.points[0].y)) direction = null;
          for (let i = 1; i < op.points.length; i++) {
            const p = op.points[i - 1], q = op.points[i], v = [q.x - p.x, q.y - p.y];
            const length = Math.hypot(...v);
            if (length > 1e-6) {
              const d = v.map((x) => x / length);
              if (direction && d[0] * direction[0] + d[1] * direction[1] < 0.99) warnings.push("The recorded route changes direction or backtracks; straight-path legality needs review.");
              direction = d;
            }
          }
          prior = op.points.at(-1);
        }
      }
      a.warnings = [...new Set(warnings)];
      for (const op of context.movement.operations) if (a.recordIds.includes(op.operationId)) {
        op.activity = { id: a.id, label: activityLabel(a), status: a.status, waived: a.waivedIds.includes(op.operationId) };
      }
    }
  }
  function undo(context, action) {
    if (!action.activity?.id) return false;
    const a = context.movement.activities?.entries.find((a) => a.id === action.activity.id);
    if (!a || a.actionId !== action.operationId) return false;
    a.waivedIds = a.recordIds.filter((id) => activeMove(context.movement.operations.find((op) => op.operationId === id)));
    if (a.attackId) a.attackWaived = true;
    for (const attack of a.spring?.attacks ?? []) if (!attack.unlinked) attack.waived = true;
    closeActivity(context.movement, a, "paymentUndone", now());
    action.activity.status = "waived";
    a.refunded = true;
    reconcile(context);
    return true;
  }
  function boundary(context, operation) {
    if (!isMovementBoundary(operation)) return;
    const a = activeActivity(context.movement);
    if (a?.checkpointId === operation.checkpointId) closeActivity(context.movement, a, "unrelatedAction", now());
  }
  function ordinaryAttack(context, receipt, operationId = receipt.operationId) {
    if (!receipt.tracking) return null;
    const resolved = receipt.override ?? resolvePF1Costs(receipt.details, {
      used: projectState(context.timeline, context.actions, context.combatant.uuid, receipt.checkpointId).used, onTurn: true
    });
    return add(context, { ...receipt.use, ...resolved, operationId }, receipt.checkpointId, { origin: "pf1", completedActivityUse: receipt.operationId });
  }
  function complete(context, input) {
    const data = activityData(context.movement), turn = captureTurn(context.combatant.parent);
    const details = normalizePF1Details(input.details), use = normalizeUse(input.use);
    const receipt = { operationId: input.operationId, checkpointId: turn.id, use, details, tracking: input.tracking === true,
      eligible: input.eligible === true && details.activation.type === "attack" && !details.fullAttack,
      charge: input.charge === true, optOut: input.optOut === true, activityId: input.activityId ?? null,
      targets: Array.isArray(input.targets) ? input.targets.filter((id) => typeof id === "string").slice(0, 100) : [],
      ...(input.override ? { override: normalizeUse({ ...input.override, operationId: input.operationId }) } : {}) };
    const a = data.entries.find((a) => a.id === receipt.activityId);
    const reservation = a?.spring?.reservations.find((r) => r.attackId === input.operationId);
    const sameTargets = reservation && JSON.stringify(reservation.targets) === JSON.stringify(receipt.targets);
    if (a?.spring) receipt.spring = { selected: input.springSelected === true, appliedPenalty: Number.isFinite(input.appliedPenalty) ? input.appliedPenalty : null,
      movementIds: [...a.recordIds], adjacent: springAdjacency(turnEvidence(context.combatant), receipt.targets),
      ...(reservation ? { slot: reservation.slot, expectedPenalty: reservation.penalty, movementIds: [...reservation.movementIds], adjacent: sameTargets ? reservation.adjacent : null } : {}) };
    let ready = !!a && ["preparing", "armed", "active"].includes(a.status);
    if (a?.dialogStarted) {
      try { requireSpringFeats(context.combatant.actor, a.spring.variant, a.spring.mythic); }
      catch { ready = false; a.endNotice = "The selected feat was removed before completion; this attack was recorded separately."; }
    }
    if (a?.status === "preparing" && context.movement.revision !== a.preparationRevision) {
      ready = false; a.endNotice = "Movement accounting changed during the attack; prior movement was left unchanged and the attack was recorded separately.";
    }
    if (!ready && a?.endNotice) receipt.notice = a.endNotice;
    if (a?.spring && ready && a.checkpointId === turn.id
      && receipt.eligible && !receipt.optOut && !receipt.override && input.springSelected === true
      && reservation?.status === "pending" && reservation.userId === context.userId
      && !a.spring.attacks.some((r) => r.slot === reservation.slot)) {
      if (a.status === "preparing") adoptPrefix(context, a);
      pay(context, a);
      a.spring.attacks.push({ operationId: receipt.operationId, slot: reservation.slot, expectedPenalty: reservation.penalty,
        appliedPenalty: receipt.spring.appliedPenalty, targets: receipt.targets, adjacent: receipt.spring.adjacent,
        movementIds: [...reservation.movementIds], linkedBy: context.userId, linkedAt: now() });
      receipt.linkedActivityId = a.id; reservation.status = "completed";
    } else if (a && ["armed", "active"].includes(a.status) && a.checkpointId === turn.id && a.kind === "charge" && a.economy === "normal"
      && !a.attackId && receipt.eligible && receipt.charge && !receipt.optOut && !receipt.override) {
      pay(context, a); a.attackId = receipt.operationId; receipt.linkedActivityId = a.id;
      closeActivity(context.movement, a, "chargeAttack", now());
    } else {
      if (reservation?.status === "pending") reservation.status = "released";
      if (a?.status === "preparing") closeActivity(context.movement, a, "separateAttack", now());
      const action = ordinaryAttack(context, receipt);
      receipt.actionId = action?.operationId ?? null;
      let resolved;
      try { resolved = resolvePF1Costs(details, { used: {}, onTurn: true }); } catch { resolved = action; }
      if (resolved) { boundary(context, { ...resolved, checkpointId: turn.id }); if (isMovementBoundary(resolved)) endSequence(context.movement, turn.id, input.operationId, "completedPF1"); }
      if (a?.endedReason === "unrelatedAction") a.endNotice = a.spring ? "A separate completed action ended Spring Attack. Its included attack limit, eligibility or per-use selection did not permit association. Any completed roll modifier was retained."
        : a.economy === "unchained" && a.kind === "charge"
        ? "Unchained Charge movement ended; its attack is a separate action."
        : "A separate completed action ended this activity. Normal Charge includes only a single eligible melee attack marked Charge, without tracking overrides.";
    }
    data.uses.push(receipt);
  }
  function request(context, input) {
    const data = activityData(context.movement), turn = captureTurn(context.combatant.parent);
    if (input.kind === "beginSpringAttack") {
      if (activeActivity(context.movement) || activeDeclaration(context.movement) || data.entries.some((a) => a.status === "preparing")) fail("springAttackPending", "Another activity or Spring Attack preparation is unresolved. Finish it or use a separate attack.");
      requireSpringFeats(context.combatant.actor, input.springVariant, input.mythic === true);
      if (input.featOverride) fail("missingFeat", "The action-use dialog requires an owned feat.");
      const a = { id: input.operationId, kind: "spring", economy: input.economy, restricted: false, multiplier: 1,
        spring: declareSpring(context.combatant.actor, input, context.userId, now()), dialogStarted: true,
        checkpointId: turn.id, tokenUuid: context.combatant.token.uuid, userId: context.userId, createdAt: now(),
        assessment: "unverified", status: "preparing", recordIds: [], waivedIds: [],
        prefixIds: prefix(context, turn.id), preparationRevision: context.movement.revision + 1 };
      data.entries.push(a);
      reserve(context, a, input, turn);
    } else if (input.kind === "armActivity") {
      if (data.entries.some((a) => a.status === "preparing")) fail("springAttackPending", "A Spring Attack roll is unresolved. Complete or cancel it first.");
      if (activeActivity(context.movement) || activeDeclaration(context.movement)) fail("activityActive", "Finish or cancel the current activity or step first.");
      if (!["run", "charge", "withdraw", "spring"].includes(input.activityKind)) fail("invalidActivity", "Choose a supported movement activity.");
      const economy = input.economy;
      if (!["normal", "unchained"].includes(economy)) fail("invalidActivity", "Unknown action economy.");
      const restricted = input.restricted === true;
      if (restricted && (economy !== "normal" || ["run", "spring"].includes(input.activityKind))) fail("invalidActivity", "This activity has no restricted variant.");
      const multiplier = input.activityKind === "run" ? input.multiplier ?? 4 : restricted || input.activityKind === "spring" ? 1 : 2;
      if (input.activityKind === "run" && ![3, 4, 5].includes(multiplier)) fail("invalidActivity", "Run uses a multiplier of 3, 4 or 5.");
      endSequence(context.movement, turn.id, input.operationId, "activityStart");
      data.entries.push({ id: input.operationId, kind: input.activityKind, economy, restricted, multiplier,
        ...(input.activityKind === "spring" ? { spring: declareSpring(context.combatant.actor, input, context.userId, now()) } : {}),
        checkpointId: turn.id, tokenUuid: context.combatant.token.uuid, userId: context.userId, createdAt: now(),
        assessment: normalizeAssessment(input.assessment), status: "armed", recordIds: [], waivedIds: [] });
    } else if (input.kind === "completeActivityUse") complete(context, input);
    else {
      const a = data.entries.find((a) => a.id === input.activityId);
      if (!a) fail("missingActivity", "The declared activity no longer exists.");
      if (input.kind === "reserveSpringAttack") {
        if (!a.spring || !["armed", "active"].includes(a.status) || a.checkpointId !== turn.id) fail("inactiveActivity", "Spring Attack is no longer active.");
        if (a.dialogStarted) requireSpringFeats(context.combatant.actor, a.spring.variant, a.spring.mythic);
        reserve(context, a, input, turn);
      } else if (input.kind === "releaseSpringAttack") {
        const reservation = a.spring?.reservations.find((r) => r.attackId === input.attackId);
        if (reservation?.status === "pending") { reservation.status = "released"; reservation.releasedBy = context.userId; }
        if (a.status === "preparing") closeActivity(context.movement, a, "attackCanceled", now());
      } else if (input.kind === "finishActivity") closeActivity(context.movement, a, "manual", now());
      else if (input.kind === "convertActivity") {
        if (a.status === "converted") return;
        closeActivity(context.movement, a, "converted", now());
        refund(context, context.actions.operations.find((op) => op.operationId === a.actionId));
        const payment = context.actions.operations.find((op) => op.operationId === a.actionId);
        if (payment?.activity && !a.refunded) payment.activity.status = "converted";
        a.status = "converted"; a.convertedBy = context.userId; a.convertedAt = now();
        const newSequence = () => {
          const result = { id: createId(), checkpointId: a.checkpointId, economy: a.economy, payments: [], waivers: [], closed: true, closedBy: input.operationId };
          spendingData(context.movement).sequences.push(result); return result;
        };
        let sequence = newSequence();

        const boundaries = new Set((a.spring?.attacks ?? []).map((attack) => a.recordIds[attack.movementIds.length]).filter(Boolean));
        for (const op of context.movement.operations) if (a.recordIds.includes(op.operationId)) {
          if (boundaries.has(op.operationId) && op.operationId !== a.recordIds[0]) sequence = newSequence();
          op.spending.sequenceId = sequence.id;
          op.spending.consumption = op.spending.ordinaryConsumption;
          for (const waiver of a.priorWaivers ?? []) {
            const coverage = waiver.coverage.filter((p) => p.movementId === op.operationId);
            if (coverage.length) sequence.waivers.push({ ...copy(waiver), coverage });
          }
          if (a.waivedIds.includes(op.operationId)) {
            sequence.waivers.push({ actionId: a.actionId, coverage: [{ movementId: op.operationId, from: 0, to: op.spending.ordinaryConsumption }] });
            const group = context.movement.steps?.groups.find((g) => g.recordIds.includes(op.operationId));
            if (group && !group.waivedIds.includes(op.operationId)) group.waivedIds.push(op.operationId);
          }
        }
        const receipt = data.uses.find((r) => r.operationId === a.attackId);
        if (receipt && !a.attackWaived) { const action = ordinaryAttack(context, receipt, createId()); receipt.convertedActionId = action?.operationId ?? null; }
        for (const attack of a.spring?.attacks ?? []) {
          if (attack.unlinked || attack.waived) continue;
          const r = data.uses.find((r) => r.operationId === attack.operationId);
          if (r) r.convertedActionId = ordinaryAttack(context, r, createId())?.operationId ?? null;
        }
      } else if (input.kind === "linkActivityAttack") {
        const receipt = data.uses.find((r) => r.operationId === input.attackId);
        if (a.spring) {
          if (a.spring.attacks.some((r) => r.operationId === input.attackId && !r.unlinked)) return;
          const slot = receipt?.spring?.slot ?? springNextSlot(a);
          if (!slot || a.spring.reservations.some((r) => r.status === "pending") || a.spring.attacks.some((r) => r.slot === slot) || a.status === "converted" || a.refunded || !receipt?.eligible
            || receipt.optOut || receipt.override || receipt.linkedActivityId || receipt.checkpointId !== a.checkpointId || receipt.activityId !== a.id || !receipt.spring)
            fail("ineligibleAttack", "Choose an eligible unlinked completed attack with saved Spring Attack context and an unused position.");
          const action = context.actions.operations.find((op) => op.operationId === receipt.actionId);
          if (action?.undone || action?.movement || action?.activity) fail("ineligibleAttack", "This attack payment was already corrected.");
          const status = a.status; pay(context, a); if (!["armed", "active"].includes(status)) a.status = status;
          refund(context, action); receipt.linkedActivityId = a.id;
          a.spring.attacks.push({ operationId: receipt.operationId, slot, expectedPenalty: springPenalty(slot),
            appliedPenalty: receipt.spring.appliedPenalty, targets: receipt.targets, adjacent: receipt.spring.adjacent,
            movementIds: [...receipt.spring.movementIds], linkedBy: context.userId, linkedAt: now() });
          reconcile(context); return;
        }
        if (a.attackId === input.attackId) return;
        if (a.kind !== "charge" || a.economy !== "normal" || a.status === "converted" || a.refunded || a.attackId || !receipt?.eligible
          || receipt.linkedActivityId || receipt.checkpointId !== a.checkpointId || receipt.override) fail("ineligibleAttack", "Choose an unlinked single melee attack from this combatant and checkpoint.");
        const action = context.actions.operations.find((op) => op.operationId === receipt.actionId);
        if (action?.undone || action?.movement || action?.activity) fail("ineligibleAttack", "This attack was already corrected or pays for other movement.");
        pay(context, a); refund(context, action); a.attackId = receipt.operationId; receipt.linkedActivityId = a.id;
        closeActivity(context.movement, a, "linkedAttack", now());
      } else if (input.kind === "unlinkActivityAttack") {
        const attack = a.spring?.attacks.find((r) => r.operationId === input.attackId);
        if (!attack || a.status === "converted") fail("ineligibleAttack", "Choose an included Spring Attack use.");
        if (attack.unlinked) return;
        const receipt = data.uses.find((r) => r.operationId === attack.operationId);
        if (!attack.waived && receipt) receipt.unlinkedActionId = ordinaryAttack(context, receipt, createId())?.operationId ?? null;
        attack.unlinked = true; attack.unlinkedBy = context.userId; attack.unlinkedAt = now();

      }
    }
    reconcile(context);
  }
  function reserve(context, a, input) {
    if (typeof input.attackId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.attackId)) fail("invalidRequest", "A stable attack identity is required.");
    if (a.spring.reservations.some((r) => r.attackId === input.attackId)) fail("operationConflict", "This attack already has a reservation; retry its original request.");
    if (a.spring.reservations.some((r) => r.status === "pending")) fail("springAttackPending", "Another Spring Attack roll is unresolved. Retry after it completes, or use a separate attack.");
    const slot = springNextSlot(a);
    if (!slot) fail("springAttackLimit", "All included attacks are used. This attack must be separate.");
    const targets = Array.isArray(input.targets) ? input.targets.filter((id) => typeof id === "string").slice(0, 100) : [];
    a.spring.reservations.push({ attackId: input.attackId, slot, penalty: springPenalty(slot), userId: context.userId, createdAt: now(), status: "pending",
      targets, movementIds: [...(a.status === "preparing" ? a.prefixIds : a.recordIds)], adjacent: springAdjacency(turnEvidence(context.combatant), targets) });
  }
  return { observed, reconcile, undo, boundary, request };
}
