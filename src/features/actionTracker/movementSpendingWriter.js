import { captureTurn, copy, fail, normalizeUse, projectState } from "./model.js";
import { normalizePF1Details, resolvePF1Costs } from "./pf1Costs.js";
import { trackerSettings } from "./settings.js";
import { MOVEMENT_FLAG, samePosition } from "./movementModel.js";
import { terrainCost } from "./movementTerrain.js";
import { ACTIVITY_REQUESTS, activeActivity, closeActivity, createActivityWriter } from "./movementActivities.js";
import { activeDeclaration, captureStepEligibility, classifySteps, normalizeAssessment, registerStepGroup, stepData, waiveStep } from "./movementSteps.js";
import { MOVEMENT_MODES, capturePF1Movement, endSequence, isMovementBoundary, linkPayment, normalizeMode, openSequence,
  reconcileSequence, snapshotSpeed, spendingData, unlinkPayment, waivePayment } from "./movementSpending.js";

export function createMovementSpendingWriter({ moduleId, getGame, createId, now, turnEvidence }) {
  const activities = createActivityWriter({ createId, now, turnEvidence });
  function capture(combatant, record, ledger = combatant.getFlag(moduleId, MOVEMENT_FLAG) ?? {}) {
    const settings = trackerSettings(getGame());
    const mode = record.mode ?? (record.generation >= 13 ? "walk" : ledger.spending?.mode ?? "walk");
    const prepared = capturePF1Movement(combatant.actor, normalizeMode(mode));
    const snapshot = snapshotSpeed(combatant.actor, mode, record.config.units, settings.economy, prepared);
    const activity = activeActivity(ledger);
    const listed = prepared.diagnostic.preparedSpeed;
    return { ...snapshot, ...(activity ? { activityCapability: activity.kind === "run" ? prepared.run !== false : activity.kind === "withdraw" ? Number.isFinite(listed) && listed > 0 : snapshot.speed > 0 } : {}), ...(record.terrain?.warning ? { warning: record.terrain.warning } : {}),
      stepEligibility: captureStepEligibility(combatant.actor, snapshot.mode, prepared),
      automaticStep: settings.movement && settings.automaticMovement ? 1 : 0, enabled: settings.movement && settings.automaticMovement };
  }
  function spend(context, sequence, { operationId = createId(), label = "Movement", origin = "movement" } = {}) {
    const { actions, timeline, combatant, userId, events } = context;
    const details = normalizePF1Details({ economy: sequence.economy, activationSource: "pf1",
      activation: { type: sequence.economy === "unchained" ? "action" : "move", cost: 1 } });
    const resolved = resolvePF1Costs(details, { used: projectState(timeline, actions, combatant.uuid, sequence.checkpointId).used, onTurn: true });
    const operation = { ...normalizeUse({ operationId, label, ...resolved }), origin,
      checkpointId: sequence.checkpointId, userId, createdAt: now(), undone: false };
    if (actions.operations.some((a) => a.operationId === operationId)) fail("operationConflict", "This operation ID already identifies another action.");
    actions.operations.push(operation);
    events.push({ kind: "spend", use: operation });
    return operation;
  }
  function refund(context, action) {
        if (action.undone) return;
        Object.assign(action, { undone: true, undoneAt: now(), undoneBy: context.userId });
        context.events.push({ kind: "undo", use: action });
  }
  function reconcile(context, sequences = context.movement.spending?.sequences ?? []) {
    classifySteps(context, { refund: (action) => refund(context, action), spendAct: (group) => {
      const action = { ...normalizeUse({ operationId: createId(), label: "Step", costs: { action: 1 }, metadata: { economy: "unchained" } }),
        checkpointId: group.checkpointId, origin: "movement", userId: context.userId, createdAt: now(), undone: false,
        step: { groupId: group.id, status: "linked" } };
      context.actions.operations.push(action); context.events.push({ kind: "spend", use: action }); return action;
    } });
    for (const sequence of sequences) reconcileSequence(context.movement, sequence, context.actions, {
      spend: (s) => spend(context, s), refund: (action) => refund(context, action)
    });
    activities.reconcile(context);
  }
  function observed(context, operation, snapshot, gap = false) {
    const { movement } = context;
    spendingData(movement);
    if (operation.kind === "undo") {
      if (!operation.targets.length) endSequence(movement, operation.checkpointId, operation.operationId, "unmatchedUndo");
      return;
    }
    const id = operation.operationId, checkpointId = operation.checkpointId;
    const cost = terrainCost(operation, movement);
    if (operation.terrain) {
      operation.terrain.cost = cost;
      if (cost === null) {
        operation.terrain.warning ??= "Region movement cost could not be verified; this portion did not spend actions.";
        snapshot = { ...snapshot, warning: operation.terrain.warning };
      }
    }
    operation.spending = { ...copy(snapshot), dialogPrefix: 1, consumption: 0, ordinaryConsumption: 0 };
    if (snapshot.enabled && !snapshot.warning && !operation.teleport && operation.distance > 0) operation.spending.ordinaryConsumption = (cost ?? operation.distance) * snapshot.feetPerUnit / snapshot.speed;
    if (activities.observed(context, operation, snapshot, gap)) return;
    if (gap || operation.teleport || !snapshot.enabled || snapshot.warning) endSequence(movement, checkpointId, id, gap ? "trackingGap" : operation.teleport ? "displacement" : snapshot.enabled ? "unavailableSpeed" : "disabled");
    if (operation.teleport || !snapshot.enabled || snapshot.warning || operation.distance <= 0) return;
    const sequence = openSequence(movement, checkpointId, snapshot.economy, id);
    operation.spending.sequenceId = sequence.id;
    operation.spending.consumption = operation.spending.ordinaryConsumption = (cost ?? operation.distance) * snapshot.feetPerUnit / snapshot.speed;
  }
  function actionChanged(context, operation, kind) {
    if (kind === "undo") {
      if (activities.undo(context, operation)) { reconcile(context); return; }
      if (waiveStep(context, operation)) { reconcile(context); return; }
      const sequence = waivePayment(context.movement, operation);
      if (sequence) reconcile(context, [sequence]);
    } else if (isMovementBoundary(operation)) { activities.boundary(context, operation); endSequence(context.movement, operation.checkpointId, operation.operationId, "action"); }
  }
  function request(context, input) {
    const { movement, actions, combatant } = context;
    const data = spendingData(movement);
    const old = data.requests.find((r) => r.request.operationId === input.operationId);
    if (old) {
      if (old.userId !== context.userId || JSON.stringify(old.request) !== JSON.stringify(input)) fail("operationConflict", "This movement request ID already identifies a different change.");
      return false;
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId ?? "")) fail("invalidRequest", "A valid movement request ID is required.");
    const turn = captureTurn(combatant.parent);
    if (["payMovement", "endMovement", "movementBoundary", "armStep", "armActivity", "beginSpringAttack", "reserveSpringAttack", "completeActivityUse"].includes(input.kind)) {
      if (input.expectedCheckpointId !== turn.id) fail("staleTurn", "The combat turn changed before this movement action could be recorded.");
      if (turn.round < 1 || turn.combatantUuid !== combatant.uuid) fail("inactiveCombat", "Movement actions require this combatant's active turn.");
    }
    if (ACTIVITY_REQUESTS.includes(input.kind)) {
      if (["armActivity", "beginSpringAttack"].includes(input.kind)) {
        if (input.expectedMovementRevision !== undefined && input.expectedMovementRevision !== movement.revision) fail("staleMovement", "Movement accounting changed while the activity was being selected. Try the route again.");
        if (input.expectedTokenUuid !== undefined && (combatant.token?.uuid !== input.expectedTokenUuid || !samePosition(combatant.token, input.expectedOrigin))) fail("staleMovement", "The token moved or was replaced while the activity was being selected.");
        if (!trackerSettings(getGame()).movement || !combatant.parent.active || !combatant.token || combatant.token.parent?.tokens?.get(combatant.token.id) !== combatant.token) fail("invalidActivity", "Enable movement tracking in an active encounter with a token.");
        if (input.economy !== trackerSettings(getGame()).economy) fail("invalidActivity", "The action economy changed; refresh before declaring an activity.");
      }
      activities.request(context, input);
      reconcile(context);
      data.requests.push({ request: copy(input), userId: context.userId });
      return true;
    }
    switch (input.kind) {
      case "armStep": {
        if (movement.activities?.entries.some((a) => a.status === "preparing")) fail("springAttackPending", "A Spring Attack roll is unresolved. Complete or cancel it first.");
        if (activeActivity(movement)) fail("activityActive", "Finish or cancel the current movement activity first.");
        if (!trackerSettings(getGame()).movement || !combatant.parent.active || !combatant.token || combatant.token.parent?.tokens?.get(combatant.token.id) !== combatant.token) fail("invalidStep", "Enable movement tracking and select an active encounter combatant with a token.");
        if (activeDeclaration(movement)) fail("stepArmed", "This combatant’s next move already counts as a Step.");
        stepData(movement).declarations.push({ id: input.operationId, userId: context.userId, checkpointId: turn.id,
          tokenUuid: combatant.token.uuid, assessment: normalizeAssessment(input.assessment), status: "armed", createdAt: now() });
        break;
      }
      case "cancelStep": {
        const declaration = movement.steps?.declarations.find((d) => d.id === input.declarationId);
        if (!declaration) fail("missingStep", "This step declaration no longer exists.");
        if (declaration.status === "armed") Object.assign(declaration, { status: "canceled", endedAt: now() });
        break;
      }
      case "classifyMovement": {
        const group = movement.steps?.groups.find((g) => g.id === input.groupId);
        if (!group || !group.recordIds.every((id) => movement.operations.some((op) => op.operationId === id && op.spending?.stepEligibility))) fail("missingStepContext", "This movement has insufficient saved context for step conversion.");
        if (movement.activities?.entries.some((a) => a.status !== "converted" && a.recordIds.some((id) => group.recordIds.includes(id)))) fail("activityActive", "Count this activity as normal movement before changing how its Step is recorded.");
        if (!["step", "ordinary"].includes(input.classification)) fail("invalidStep", "Choose Step or Ordinary movement.");
        group.requested = input.classification;
        group.assessment = normalizeAssessment(input.assessment);
        group.assessedBy = context.userId;
        group.correctedAt = now();
        reconcile(context);
        break;
      }
      case "movementMode": {
        const mode = normalizeMode(input.mode);
        if (!Object.hasOwn(MOVEMENT_MODES, mode)) fail("invalidMovement", "Choose a supported movement mode.");
        data.mode = mode;
        break;
      }
      case "movementBoundary": {
        const details = normalizePF1Details(input.details);
        const resolved = resolvePF1Costs(details, { used: {}, onTurn: true });
        activities.boundary(context, { ...resolved, checkpointId: turn.id });
        if (isMovementBoundary(resolved)) endSequence(movement, turn.id, input.operationId, "completedPF1");
        break;
      }
      case "endMovement":
        if (input.reason !== "automationDisabled") closeActivity(movement, activeActivity(movement), "manual", now());
        endSequence(movement, turn.id, input.operationId, input.reason === "automationDisabled" ? "automationDisabled" : "manual"); break;
      case "payMovement": {
        if (activeActivity(movement)) fail("activityActive", "Finish or cancel the current activity before paying for ordinary movement.");
        const sequence = openSequence(movement, turn.id, trackerSettings(getGame()).economy, input.operationId);
        linkPayment(movement, sequence, spend(context, sequence, { operationId: input.operationId, label: "Pay for movement", origin: "manual" }));
        reconcile(context, [sequence]);
        break;
      }
      case "linkMovementPayment": {
        const sequence = data.sequences.find((s) => s.id === input.sequenceId);
        const action = actions.operations.find((a) => a.operationId === input.actionId);
        if (!sequence) fail("missingSequence", "This movement sequence no longer exists.");
        if (action?.origin === "movement") fail("ineligiblePayment", "Choose a separately recorded action for payment.");
        linkPayment(movement, sequence, action);
        reconcile(context, [sequence]);
        break;
      }
      case "unlinkMovementPayment": {
        const action = actions.operations.find((a) => a.operationId === input.actionId);
        if (!action) fail("missingOperation", "This action no longer exists.");
        const sequence = unlinkPayment(movement, action);
        if (sequence) reconcile(context, [sequence]);
        break;
      }
      default: fail("invalidRequest", "Unknown movement spending request.");
    }
    data.requests.push({ request: copy(input), userId: context.userId });
    return true;
  }
  return { capture, observed, reconcile, actionChanged, request, group: (context, records) => registerStepGroup(context, records, now()) };
}
