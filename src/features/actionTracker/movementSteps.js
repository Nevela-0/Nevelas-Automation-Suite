import { copy, fail } from "./model.js";
import { measureMovement, samePosition } from "./movementModel.js";
import { capturePF1Movement } from "./movementSpending.js";

const EPSILON = 1e-8;
const MODES = { walk: "land", fly: "fly", swim: "swim", climb: "climb", burrow: "burrow" };
export const STEP_REQUESTS = ["armStep", "cancelStep", "classifyMovement"];
export const normalizeAssessment = (value = "unverified") => {
  if (!["unverified", "clear", "hampered"].includes(value)) fail("invalidStep", "Choose Unverified, Clear, or Hampered.");
  return value;
};
export function stepData(ledger) {
  ledger.steps ??= { version: 1, declarations: [], groups: [] };
  const data = ledger.steps;
  if (data.version !== 1 || !Array.isArray(data.declarations) || !Array.isArray(data.groups)) fail("invalidState", "Invalid saved step history.");
  return data;
}
export function captureStepEligibility(actor, mode, prepared = capturePF1Movement(actor, mode)) {
  const listed = actor?.system?.attributes?.speed?.[MODES[mode]]?.total;
  return { supported: Object.hasOwn(MODES, mode), listed: Number.isFinite(listed) ? listed : null,
    permitted: prepared.step !== false, usable: Number.isFinite(prepared.speed) && prepared.speed > 0 };
}
export function activeDeclaration(ledger) {
  return ledger.steps?.declarations.findLast((entry) => entry.status === "armed") ?? null;
}
export function expireDeclarations(ledger, { checkpointId, tokenUuid, enabled, permitted, now }) {
  let changed = false;
  for (const entry of ledger.steps?.declarations ?? []) {
    if (entry.status !== "armed") continue;
    if (enabled && entry.checkpointId === checkpointId && entry.tokenUuid === tokenUuid && permitted(entry.userId)) continue;
    Object.assign(entry, { status: "expired", endedAt: now }); changed = true;
  }
  return changed;
}
export function registerStepGroup(context, records, now) {
  const moves = records.filter((op) => op.kind === "move");
  if (!moves.length) return;
  const data = stepData(context.movement), first = moves[0];
  const declaration = data.declarations.find((d) => d.id === first.declarationId && d.status === "armed"
    && d.checkpointId === first.checkpointId && d.tokenUuid === first.tokenUuid);
  const group = { id: first.groupId ?? first.operationId, recordIds: moves.map((op) => op.operationId),
    checkpointId: first.checkpointId, round: first.turn.round, economy: first.spending.economy,
    requested: declaration ? "step" : moves.every((op) => op.spending?.automaticStep === 1 && !op.activityId && !op.teleport) ? "automatic" : "ordinary", assessment: declaration?.assessment ?? "unverified",
    assessedBy: declaration?.userId ?? context.userId, createdAt: now, actionIds: [], waivedIds: [] };
  group.boundarySequenceId = context.movement.spending?.sequences.findLast((s) => s.checkpointId === group.checkpointId && !s.closed)?.id ?? null;

  if (group.requested === "automatic") group.candidateId = JSON.stringify([first.tokenUuid, group.checkpointId,
    group.economy, group.economy === "unchained" ? first.spending.sequenceId ?? group.id : null]);
  if (declaration) {
    group.declarationId = declaration.id;
    Object.assign(declaration, { status: moves.some((op) => op.teleport) ? "canceled" : "consumed", groupId: group.id, endedAt: now });
    if (moves.some((op) => op.teleport)) group.requested = "ordinary";
  }
  for (const op of moves) op.stepGroupId = group.id;
  data.groups.push(group);
}
const active = (op) => op.kind === "move" && !op.excluded && !op.reversed && !op.teleport;

function candidateGroups(ledger, group) {
  return group.candidateId && group.requested !== "ordinary"
    ? ledger.steps.groups.filter((g) => g.requested !== "ordinary" && g.candidateId === group.candidateId) : [group];
}

function groupDistance(operations) {
  let feet = 0, points = [], key, prior;
  const flush = () => { if (prior && points.length > 1) feet += measureMovement(points, prior.config) * prior.spending.feetPerUnit; points = []; };
  for (const op of operations) {
    const nextKey = JSON.stringify(op.config);
    if (!active(op)) { flush(); prior = null; continue; }
    if (!op.spending.feetPerUnit) return null;
    if (!prior || key !== nextKey || !samePosition(points.at(-1), op.points[0])) flush();
    points.push(...(points.length ? op.points.slice(1) : op.points));
    key = nextKey; prior = op;
  }
  flush(); return feet;
}

export function classifySteps(context, { spendAct, refund }) {
  const { movement, actions } = context;
  const belongsToActivity = (op) => op.activityId && movement.activities?.entries.some((a) => a.id === op.activityId && a.status !== "converted");
  for (const group of movement.steps?.groups ?? []) {
    const all = group.recordIds.map((id) => movement.operations.find((op) => op.operationId === id)).filter(Boolean);
    if (!all.length || all.some((op) => !op.spending?.stepEligibility)) continue;
    const members = candidateGroups(movement, group);
    const recordIds = new Set(members.flatMap((g) => g.recordIds));
    const candidate = movement.operations.filter((op) => recordIds.has(op.operationId));
    const moves = candidate.filter(active);
    const wantsStep = group.requested === "step" || group.requested === "automatic";
    const reasons = [], notices = [];
    group.terrainOverride = false;
    const feet = groupDistance(candidate);
    if (wantsStep && moves.length) {
      if (feet === null) reasons.push("Scene units could not be verified for the five-foot limit.");
      else if (feet <= 0 || feet > 5 + EPSILON) reasons.push("The committed path exceeds the five-foot step allowance or has no measured distance.");
      if (candidate.some((op) => op.teleport)) reasons.push("This movement includes a teleport or displacement.");
      if (moves.some(belongsToActivity)) reasons.push("This movement belongs to a declared activity.");
      const assessmentFor = (op) => members.find((g) => g.recordIds.includes(op.operationId))?.assessment ?? "unverified";
      if (moves.some((op) => assessmentFor(op) === "hampered")) reasons.push("The path was marked hampered by terrain or darkness.");
      const regionHampered = moves.some((op) => op.distance > 0 && op.terrain?.multiplier > 1);
      group.terrainOverride = all.some((op) => active(op) && op.distance > 0 && op.terrain?.multiplier > 1 && group.assessment === "clear");
      if (regionHampered && moves.some((op) => op.distance > 0 && op.terrain?.multiplier > 1 && assessmentFor(op) !== "clear")) reasons.push("A Region increased movement cost along this path; its terrain is hampered.");
      if (group.terrainOverride) notices.push("Clear assessment manually overrides the recorded Region terrain penalty for this step only.");
      if (moves.some((op) => op.terrain?.warning)) notices.push("Region terrain could not be fully verified for this movement.");
      if (group.assessment === "unverified") notices.push(group.requested === "automatic"
        ? "Terrain and darkness are not fully verified. Correct this automatic step in History when needed."
        : "Terrain and darkness were not verified; the declaration records the user's judgment.");
      if (group.requested === "automatic") notices.push("Detected automatically from accumulated movement; later movement may change its action cost.");
      for (const op of moves) {
        const eligibility = op.spending?.stepEligibility;
        if (!eligibility?.supported) reasons.push("This movement mode is not supported for steps.");
        if (group.economy === "normal") {
          if (eligibility?.listed === null || !Number.isFinite(op.spending.speed)) reasons.push("The historical listed or effective speed could not be verified.");
          else if (eligibility.listed <= 0 || op.spending.speed <= 5 || !eligibility.permitted) reasons.push("A normal step requires an eligible listed movement speed greater than five feet.");
        } else if (!eligibility?.usable) reasons.push("This movement mode has no usable speed.");
      }
      if (group.economy === "normal" && movement.operations.some((op) => active(op)
        && op.turn?.round === group.round && !recordIds.has(op.operationId)
        && op.points.some((p, i) => i && !samePosition(p, op.points[i - 1])))) reasons.push("Other movement was recorded in this round.");
      if (movement.gaps.some((gap) => gap.checkpointId === group.checkpointId)) notices.push("Earlier movement in this round may be missing.");
    }
    group.effective = wantsStep && moves.length && !reasons.length ? "step" : "ordinary";
    group.status = !all.some(active) ? "inactive" : wantsStep && reasons.length ? "converted" : group.effective;
    group.reasons = [...new Set(reasons)]; group.notices = [...new Set(notices)]; group.feet = groupDistance(all);
    if (group.candidateId && group.requested !== "ordinary") group.candidateFeet = feet;
    if (group.effective === "step" && group.economy === "unchained" && !group.candidateId && !group.boundaryRecorded) {
      const sequence = movement.spending?.sequences.find((s) => s.id === group.boundarySequenceId);
      if (sequence && !sequence.closed) {
        sequence.closed = true; sequence.remaining = 0; sequence.closedBy = group.id;
        movement.spending.boundaries.push({ operationId: group.id, checkpointId: group.checkpointId, sequenceId: sequence.id, reason: "step" });
      }
      group.boundaryRecorded = true;
    }
    for (const op of all) {
      op.spending.consumption = group.effective === "step" || belongsToActivity(op) ? 0 : op.spending.ordinaryConsumption;

      if (group.waivedIds.includes(op.operationId) && op.spending.sequenceId) {
        const sequence = movement.spending?.sequences.find((s) => s.id === op.spending.sequenceId);
        const actionId = `step:${group.id}`;
        if (sequence && !sequence.waivers.some((w) => w.actionId === actionId && w.coverage.some((c) => c.movementId === op.operationId))) {
          sequence.waivers.push({ actionId, coverage: [{ movementId: op.operationId, from: 0, to: op.spending.ordinaryConsumption }] });
        }
      }
    }
    const stepAction = group.actionIds.map((id) => actions.operations.find((a) => a.operationId === id)).find((a) => a && !a.undone);
    const waived = (op) => members.some((g) => g.waivedIds.includes(op.operationId)) || (op.spending.ordinaryConsumption > 0
      && (movement.spending?.sequences ?? []).some((s) => s.waivers.some((w) => w.coverage.some((c) => c.movementId === op.operationId && c.from <= 0 && c.to >= op.spending.ordinaryConsumption))));
    const needsAct = members[0] === group && group.effective === "step" && group.economy === "unchained" && moves.some((op) => !waived(op));
    if (stepAction && !needsAct) { stepAction.step.status = "refunded"; refund(stepAction); }
    if (!stepAction && needsAct) group.actionIds.push(spendAct(group).operationId);
    for (const op of all) op.step = copy({ groupId: group.id, requested: group.requested, effective: group.effective,
      status: group.status, assessment: group.assessment, assessedBy: group.assessedBy, terrainOverride: !!group.terrainOverride, reasons: group.reasons, notices: group.notices,
      ...(group.candidateId && group.requested !== "ordinary" ? { candidateId: group.candidateId, candidateFeet: feet, candidateGroups: members.length } : {}) });
  }
}

export function waiveStep(context, action) {
  const group = context.movement.steps?.groups.find((g) => g.id === action.step?.groupId);
  if (!group) return false;
  for (const member of candidateGroups(context.movement, group)) {
    for (const op of context.movement.operations) if (member.recordIds.includes(op.operationId) && active(op) && !member.waivedIds.includes(op.operationId)) member.waivedIds.push(op.operationId);
  }
  action.step.status = "waived";
  return true;
}
