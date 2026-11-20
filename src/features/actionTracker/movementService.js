import { captureTurn, copy, fail, includeCheckpoint, readTimeline, TRACKER_FLAG } from "./model.js";
import { spendingView } from "./movementSpending.js";
import { activeDeclaration, expireDeclarations } from "./movementSteps.js";
import { activeActivity, expireActivities } from "./movementActivities.js";
import { trackerSettings } from "./settings.js";
import { terrainSummary } from "./movementTerrain.js";
import { foundryGeneration, isFoundryV13Plus } from "../../common/foundryCompat.js";
import { MOVEMENT_FLAG, appendMovement, configKey, movementHistory, movementState, normalizeMovement, readMovement, samePosition } from "./movementModel.js";

export function createMovementService({ moduleId, getGame, resolveCombatant, requireAuthority, authorize,
  enqueue, commitTimeline, dispatch, failure, now, measure, spending, spendingContext, emitChanges }) {
  const gaps = new Map();
  const pendingCombats = new Map();
  const frame = (combat) => includeCheckpoint(readTimeline(combat.getFlag(moduleId, TRACKER_FLAG)), captureTurn(combat)).timeline;
  function markMovementIncomplete(uuid, turn, message = "Some movement could not be tracked.") {
    const key = `${uuid}|${turn.id}`;
    gaps.set(key, { checkpointId: turn.id, message, identity: `${now()}_${Math.random()}` });
  }
  function ledgerFor(combatant) {
    const ledger = readMovement(combatant.getFlag(moduleId, MOVEMENT_FLAG));
    for (const [key, gap] of gaps) {
      if (key.startsWith(`${combatant.uuid}|`) && !ledger.gaps.some((g) => g.checkpointId === gap.checkpointId)) ledger.gaps.push(copy(gap));
    }
    return ledger;
  }
  function movementStateFor(combat, combatant, ledger, checkpointId) {
    const state = movementState(frame(combat), ledger, combatant.uuid, checkpointId ?? captureTurn(combat).id, measure);
    if (!getGame()?.users?.activeGM?.active) state.incomplete = true;
    return state;
  }
  async function getMovementState(uuid, { checkpointId } = {}) {
    const { combat, combatant } = await resolveCombatant(uuid);
    return movementStateFor(combat, combatant, ledgerFor(combatant), checkpointId);
  }
  async function getMovementHistory(uuid) {
    const { combat, combatant } = await resolveCombatant(uuid);
    return movementHistory(frame(combat), ledgerFor(combatant));
  }
  async function getMovementDetails(uuid, { checkpointId, all = false } = {}) {
    const { combat, combatant } = await resolveCombatant(uuid);
    const ledger = ledgerFor(combatant);
    const state = movementStateFor(combat, combatant, ledger, checkpointId);
    const spendingTurn = state.ownCheckpointId ?? captureTurn(combat).id;
    const view = spendingView(ledger, spendingTurn);
    view.terrain = terrainSummary(ledger.operations, state.ownCheckpointId);
    view.prepared = spending.capture(combatant, { generation: foundryGeneration(getGame()) ?? 12,
      mode: isFoundryV13Plus(getGame()) ? combatant.token?.movementAction ?? "walk" : view.mode,
      config: { units: combatant.token?.parent?.grid?.units ?? "ft" } }, ledger);
    if (all) view.sequences = copy(ledger.spending?.sequences ?? []);
    view.armedStep = copy(activeDeclaration(ledger));
    view.activeActivity = copy(activeActivity(ledger));
    view.activities = copy((ledger.activities?.entries ?? []).filter((a) => all || a.checkpointId === spendingTurn));
    view.activityUses = copy((ledger.activities?.uses ?? []).filter((a) => all || a.checkpointId === spendingTurn));
    view.steps = copy((ledger.steps?.groups ?? []).filter((g) => all || g.checkpointId === spendingTurn));
    return { movement: state, spending: view };
  }
  async function getMovementSpending(uuid, options) {
    return (await getMovementDetails(uuid, options)).spending;
  }
  async function save(combatant, ledger, userId, tokenUuid, context) {
    const current = await resolveCombatant(combatant.uuid);
    if (current.combatant !== combatant) fail("missingCombatant", "The combatant was replaced.");
    requireAuthority();
    if (tokenUuid && (combatant.token?.uuid !== tokenUuid || combatant.token.parent?.tokens?.get(combatant.token.id) !== combatant.token)) fail("missingToken", "The movement token was deleted or replaced.");
    authorize(combatant, userId);
    ledger.revision += 1;
    if (context && JSON.stringify(context.actions) !== JSON.stringify(combatant.getFlag(moduleId, TRACKER_FLAG) ?? { version: 1, revision: 0, operations: [] })) {
      context.actions.revision++;
      await combatant.update({ [`flags.${moduleId}.${MOVEMENT_FLAG}`]: ledger, [`flags.${moduleId}.${TRACKER_FLAG}`]: context.actions });
    } else await combatant.setFlag(moduleId, MOVEMENT_FLAG, ledger);
    if (context) emitChanges(combatant.parent, combatant, context.events);
  }
  async function exclude(request, userId) {
    requireAuthority();
    const { combatant } = await resolveCombatant(request.combatantUuid);
    authorize(combatant, userId);
    const ledger = ledgerFor(combatant);
    const op = ledger.operations.find((entry) => entry.operationId === request.operationId && entry.kind === "move");
    if (!op) fail("missingOperation", "The recorded movement no longer exists.");
    const changed = !op.excluded && !op.reversed;
    if (changed) {
      Object.assign(op, { excluded: true, exclusionReason: "manual", excludedBy: userId, excludedAt: now() });
      const context = spendingContext(combatant.parent, combatant, userId, ledger);
      spending.reconcile(context);
      await save(combatant, ledger, userId, undefined, context);
    }
    return { ok: true, changed, operationId: op.operationId, state: await getMovementState(combatant.uuid) };
  }

  function observeMovement(combatant, input, userId, acceptedSnapshots) {
    let record, records, snapshots, acceptedGap;
    try {
      requireAuthority();
      records = (Array.isArray(input) ? input : [input]).map(normalizeMovement);
      if (!records.length || records.length > 10000) fail("invalidMovement", "Invalid committed movement group.");
      record = records[0];
      if (records.some((r) => r.turn.id !== record.turn.id || r.tokenUuid !== record.tokenUuid || r.sceneUuid !== record.sceneUuid || r.undo !== record.undo || r.activityId !== record.activityId || r.declarationId !== record.declarationId || r.groupId !== record.groupId)
        || new Set(records.map((r) => r.operationId)).size !== records.length) fail("invalidMovement", "Movement group context does not match.");
      const combat = combatant.parent;
      if (getGame().combats.get(combat.id) !== combat || combat.combatants.get(combatant.id) !== combatant) fail("missingCombatant", "The combatant no longer exists.");
      authorize(combatant, userId);
      if (combatant.token?.uuid !== record.tokenUuid) fail("missingToken", "The combatant's token changed.");
      const duplicate = readMovement(combatant.getFlag(moduleId, MOVEMENT_FLAG)).operations.some((op) => op.operationId === record.operationId);
      if (!record.undo && !duplicate && (record.turn.id !== captureTurn(combat).id || record.turn.combatantUuid !== combatant.uuid || record.turn.round < 1)) {
        fail("staleTurn", "Movement finished after the combat turn changed; its distance was not recorded.");
      }
      snapshots = acceptedSnapshots ? copy(acceptedSnapshots) : records.map((r) => spending.capture(combatant, r));
      if (snapshots.length !== records.length) fail("invalidMovement", "Movement snapshots do not match the committed path.");
      acceptedGap = [gaps.get(`${combatant.uuid}|${record.turn.id}`)?.identity, record.continuityGap].filter(Boolean).join("|") || null;
      pendingCombats.set(combat.uuid, (pendingCombats.get(combat.uuid) ?? 0) + 1);
      return enqueue(combat.uuid, async () => {
        try {
          requireAuthority();
          const current = await resolveCombatant(combatant.uuid);
          if (current.combatant !== combatant || combatant.token?.uuid !== record.tokenUuid) fail("missingToken", "The movement token no longer belongs to this combatant.");
          authorize(combatant, userId);
          const ledger = ledgerFor(combatant);
          const duplicates = records.map((r) => ledger.operations.find((op) => op.operationId === r.operationId));
          if (duplicates.some(Boolean)) {
            if (!duplicates.every((op, i) => op && op.userId === userId && JSON.stringify(op.request) === JSON.stringify(records[i]))) fail("operationConflict", "This movement ID already identifies another update.");
            return { ok: true, changed: false, operationId: record.operationId, state: await getMovementState(combatant.uuid) };
          }
          if (ledger.steps?.groups.some((g) => g.id === (record.groupId ?? record.operationId))) fail("operationConflict", "This movement group was already finalized with a different path.");
          const timeline = await commitTimeline(combat, record.turn);
          const context = spendingContext(combat, combatant, userId, ledger, undefined, timeline);
          const priorSteps = new Set(ledger.steps?.groups.filter((g) => g.effective === "step").map((g) => g.id));
          expire(context, record.turn.id);
          let warning;
          let operation;
          const appended = [];
          for (const [index, currentRecord] of records.entries()) {
            const record = currentRecord, snapshot = snapshots[index];
            if (record.continuityGap && !ledger.gaps.some((g) => g.checkpointId === record.turn.id && g.sourceGap === record.continuityGap)) {
              ledger.gaps.push({ checkpointId: record.turn.id, sourceGap: record.continuityGap,
                message: "The initiating client reported an earlier movement tracking gap; no distance was inferred." });
            }
            if (record.undo) {
              const candidates = ledger.operations.filter((op) => op.kind === "move" && !op.reversed && op.tokenUuid === record.tokenUuid);
              let targets = [];
              if (record.undoIds?.length) targets = candidates.filter((op) => record.undoIds.includes(op.nativeId));
              else if (record.generation === 12) {

                const last = ledger.operations.filter((op) => op.tokenUuid === record.tokenUuid && op.kind === "move" && !op.reversed).at(-1);
                if (last?.kind === "move" && !last.reversed && samePosition(last.points.at(-1), record.points[0])
                  && samePosition(last.points[0], record.points.at(-1))) targets = [last];
              }
              if (!targets.length) {
                warning = "Foundry undid movement that NAS could not match. Check movement history for a manual correction.";
                ledger.gaps.push({ checkpointId: record.turn.id, message: warning });
              }
              for (const op of targets) Object.assign(op, { reversed: true, reversedBy: userId, reversedAt: now() });
              operation = { ...record, request: copy(record), kind: "undo", checkpointId: record.turn.id,
                userId, createdAt: now(), distance: 0, reversed: false, excluded: true, targets: targets.map((op) => op.operationId) };
              ledger.operations.push(operation);
              spending.observed(context, operation, snapshot);
            } else {
              const previous = ledger.operations.filter((op) => op.checkpointId === record.turn.id).at(-1);
              const positionGap = previous && configKey(previous.config) === configKey(record.config) && !samePosition(previous.points.at(-1), record.points[0]);
              if (positionGap) {
                ledger.gaps.push({ checkpointId: record.turn.id, message: "A position change was not tracked; no distance was inferred across the gap." });
              }
              operation = appendMovement(ledger, record, { userId, now: now(), measure });
              const gap = !!positionGap || (!!previous && (previous.tokenUuid !== record.tokenUuid || previous.sceneUuid !== record.sceneUuid)) || (!!acceptedGap && previous?.spending?.gapIdentity !== acceptedGap);
              spending.observed(context, operation, snapshot, gap);
              operation.spending.gapIdentity = acceptedGap ?? null;
              if ((snapshot.enabled || record.activityId || operation.terrain?.warning) && operation.spending.warning && !record.teleport) {
                warning = operation.spending.warning;
                ledger.gaps.push({ checkpointId: record.turn.id, message: warning });
              }
            }
            appended.push(operation);
          }
          spending.group(context, appended);
          spending.reconcile(context);
          const group = ledger.steps?.groups.at(-1);
          let notice;
          if (group?.recordIds.includes(appended[0].operationId) && group.requested === "step") notice = [...group.reasons, ...group.notices].join(" ") || undefined;
          else if (ledger.steps?.groups.some((g) => priorSteps.has(g.id) && g.status === "converted")) notice = "Other movement in this round caused an earlier step to count as ordinary movement. Its linked action costs were recalculated.";
          await save(combatant, ledger, userId, record.tokenUuid, context);
          return { ok: true, changed: true, operationId: record.operationId, warning, notice, state: await getMovementState(combatant.uuid) };
        } catch (error) {
          markMovementIncomplete(combatant.uuid, record.turn, error.message);
          return failure(error, record.operationId);
        }
      }).finally(() => {
        const remaining = pendingCombats.get(combat.uuid) - 1;
        if (remaining) pendingCombats.set(combat.uuid, remaining);
        else pendingCombats.delete(combat.uuid);
      });
    } catch (error) {
      if (record?.turn) markMovementIncomplete(combatant.uuid, record.turn, error.message);
      return Promise.resolve(failure(error, record?.operationId));
    }
  }
  async function mutateSpending(request, userId) {
    requireAuthority();
    const { combat, combatant } = await resolveCombatant(request.combatantUuid);
    authorize(combatant, userId);
    const ledger = ledgerFor(combatant);
    const context = spendingContext(combat, combatant, userId, ledger);
    const tokenUuid = ["armActivity", "beginSpringAttack", "reserveSpringAttack", "completeActivityUse"].includes(request.kind) ? combatant.token?.uuid : undefined;
    expire(context, captureTurn(combat).id);
    const changed = spending.request(context, request);
    if (changed) {
      if (["payMovement", "endMovement", "movementBoundary", "armStep", "armActivity", "beginSpringAttack", "reserveSpringAttack", "completeActivityUse"].includes(request.kind)) {
        await commitTimeline(combat, captureTurn(combat));
        if (captureTurn(combat).id !== request.expectedCheckpointId) fail("staleTurn", "The combat turn changed before this movement action could be recorded.");
      }
      await save(combatant, ledger, userId, tokenUuid, context);
    }
    return { ok: true, changed, operationId: request.operationId, state: await getMovementState(combatant.uuid),
      ...(request.kind === "completeActivityUse" ? { notice: ledger.activities?.uses.find((r) => r.operationId === request.operationId)?.notice } : {}),
      ...(["beginSpringAttack", "reserveSpringAttack"].includes(request.kind) ? {
        activity: copy(ledger.activities?.entries.find((a) => a.id === (request.kind === "beginSpringAttack" ? request.operationId : request.activityId))),
        reservation: copy(ledger.activities?.entries.find((a) => a.id === (request.kind === "beginSpringAttack" ? request.operationId : request.activityId))?.spring?.reservations.find((r) => r.attackId === request.attackId)) } : {}) };
  }
  function expire(context, checkpointId) {
    const { combatant } = context;
    const options = { checkpointId, tokenUuid: combatant.token && combatant.token.parent?.tokens?.get(combatant.token.id) === combatant.token ? combatant.token.uuid : null,
      enabled: trackerSettings(getGame()).movement && combatant.parent.active, now: now(), permitted: (id) => {
        try { authorize(combatant, id); return true; } catch { return false; }
      } };
    const steps = expireDeclarations(context.movement, options);
    const activities = expireActivities(context.movement, options);
    return steps || activities;
  }
  async function expireForCombat(combat, checkpointId) {
    let firstError;
    for (const combatant of combat.combatants) {
      try {
        const ledger = ledgerFor(combatant);
        if (!activeDeclaration(ledger) && !activeActivity(ledger) && !ledger.activities?.entries.some((a) => a.status === "preparing")) continue;
        const userId = getGame().user.id;
        const context = spendingContext(combat, combatant, userId, ledger);
        if (expire(context, checkpointId)) await save(combatant, ledger, userId, undefined, context);
      } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }
  return { getMovementState, getMovementHistory, getMovementSpending, getMovementDetails, mutateSpending, observeMovement, markMovementIncomplete, exclude,
    getMovementGap: (uuid, checkpointId) => gaps.get(`${uuid}|${checkpointId}`)?.identity ?? null,
    hasPending: (combat) => pendingCombats.has(combat.uuid), expireForCombat,
    captureSnapshot: (combatant, record) => { requireAuthority(); return spending.capture(combatant, record); },
    excludeMovement: (combatantUuid, operationId) => dispatch({ kind: "excludeMovement", combatantUuid, operationId }) };
}
