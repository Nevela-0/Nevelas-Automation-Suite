import {
  TRACKER_FLAG, captureTurn, copy, fail, historyAt, includeCheckpoint,
  lastUseAt, normalizeUse, projectState, readLedger, readTimeline, sameUse
} from "./model.js";
import { normalizePF1Details, resolvePF1Costs } from "./pf1Costs.js";
import { createMovementService } from "./movementService.js";
import { MOVEMENT_FLAG, readMovement } from "./movementModel.js";
import { createMovementSpendingWriter } from "./movementSpendingWriter.js";
import { STEP_REQUESTS } from "./movementSteps.js";
import { ACTIVITY_REQUESTS } from "./movementActivities.js";
import { captureSpringPositions } from "./springAttack.js";
import { previewMovement } from "./movementPreview.js";

export const TRACKER_SOCKET = "actionTrackerMutate";

export function createActionTrackerService({ moduleId, getGame, resolveUuid, getSocket, createId, now = Date.now, onCommitted = () => {} }) {
  const queues = new Map();

  function enqueue(combatUuid, task) {
    const next = (queues.get(combatUuid) ?? Promise.resolve()).then(task);
    const tail = next.catch(() => {});
    queues.set(combatUuid, tail);
    void tail.then(() => {
      if (queues.get(combatUuid) === tail) queues.delete(combatUuid);
    });
    return next;
  }

  function authority() {
    const gm = getGame()?.users?.activeGM;
    if (!gm?.active || !gm.isGM) fail("noGM", "Action tracking changes require a connected GM.");
    return gm;
  }

  function requireAuthority() {
    if (authority().id !== getGame()?.user?.id) fail("authorityChanged", "The active GM changed. Reload the saved tracker state before retrying.");
  }

  function requireCombat(combat) {
    if (!combat?.uuid || getGame()?.combats?.get(combat.id) !== combat) {
      fail("missingCombat", "The combat no longer exists.");
    }
    return combat;
  }

  async function resolveCombatant(uuid) {
    if (typeof uuid !== "string") fail("missingCombatant", "A combatant UUID is required.");
    const combatant = await resolveUuid(uuid);
    const combat = combatant?.parent ?? combatant?.combat;
    if (!combatant || combatant.uuid !== uuid || !combat?.combatants || combat.combatants.get(combatant.id) !== combatant) {
      fail("missingCombatant", "The combatant no longer exists.");
    }
    requireCombat(combat);
    return { combat, combatant };
  }

  function authorize(combatant, userId) {
    const user = getGame()?.users?.get(userId);
    if (!user || (!user.isGM && !combatant.actor?.testUserPermission?.(user, "OWNER"))) {
      fail("forbidden", "Only this combatant's owners or a GM can change its action tracker.");
    }
  }

  function read(combat, combatant, selectedId, options) {
    const turn = captureTurn(combat);

    const { timeline } = includeCheckpoint(readTimeline(combat.getFlag(moduleId, TRACKER_FLAG)), turn);
    const ledger = readLedger(combatant.getFlag(moduleId, TRACKER_FLAG));
    const id = selectedId ?? turn.id;
    return { timeline, ledger, turn, id, state: projectState(timeline, ledger, combatant.uuid, id, options) };
  }

  async function getState(combatantUuid, { checkpointId, includeUndoTarget = false } = {}) {
    const { combat, combatant } = await resolveCombatant(combatantUuid);
    return read(combat, combatant, checkpointId, { includeUndoTarget }).state;
  }

  async function getHistory(combatantUuid) {
    const { combat, combatant } = await resolveCombatant(combatantUuid);
    const { timeline, ledger } = read(combat, combatant);
    return historyAt(timeline, ledger);
  }

  function failure(error, operationId = null) {
    return {
      ok: false,
      code: error.code ?? "persistenceFailed",
      message: error.code ? error.message : "The action tracker change could not be confirmed. Read the saved state before retrying with the same operation ID.",
      operationId
    };
  }

  async function dispatch(request) {
    try {
      const gm = authority();
      const socket = getSocket();
      if (!socket) fail("socketUnavailable", "The action tracker socket is not ready.");

      return await socket.executeAsUser(TRACKER_SOCKET, gm.id, request);
    } catch (error) {
      return failure(error, request.use?.operationId ?? request.operationId);
    }
  }

  async function submitUse(combatantUuid, input = {}, details, origin = "api") {
    let use;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalidUse", "An action use object is required.");

      use = normalizeUse({ ...input, operationId: input.operationId ?? createId() });
      const automatic = details === undefined ? undefined : normalizePF1Details(details);
      const expectedCheckpointId = input.expectedCheckpointId;
      const { combat } = await resolveCombatant(combatantUuid);
      const turn = captureTurn(combat);
      return dispatch({
        kind: automatic ? "recordPF1" : "record", combatantUuid, use, origin,
        ...(automatic ? { details: automatic } : {}),
        expectedCheckpointId: expectedCheckpointId ?? turn.id
      });
    } catch (error) {
      return failure(error, use?.operationId ?? input?.operationId);
    }
  }

  const recordUse = (combatantUuid, input, origin = "api") => submitUse(combatantUuid, input, undefined, origin);
  const recordPF1Use = (combatantUuid, input, details, origin = "pf1") => submitUse(combatantUuid, input, details, origin);

  async function undoUse(combatantUuid, operationId) {
    return dispatch({ kind: "undo", combatantUuid, operationId });
  }

  async function undoLastUse(combatantUuid) {
    try {
      authority();
      const { combat, combatant } = await resolveCombatant(combatantUuid);
      const { timeline, ledger, id } = read(combat, combatant);

      const target = lastUseAt(timeline, ledger, id);
      return dispatch({ kind: "undo", combatantUuid, operationId: target?.operationId ?? null });
    } catch (error) {
      return failure(error);
    }
  }

  async function commitTimeline(combat, turn) {
    const { timeline, changed } = includeCheckpoint(readTimeline(combat.getFlag(moduleId, TRACKER_FLAG)), turn);
    if (changed) {
      requireAuthority();
      requireCombat(combat);
      await combat.setFlag(moduleId, TRACKER_FLAG, timeline);
    }
    return timeline;
  }

  const springTurns = new Map();
  const spending = createMovementSpendingWriter({ moduleId, getGame, createId, now,
    turnEvidence: (combatant) => springTurns.get(`${combatant.parent.uuid}|${captureTurn(combatant.parent).id}`) });
  function captureTurnStart(combat) {
    if (getGame()?.users?.activeGM?.id !== getGame()?.user?.id || !combat?.combatant) return;
    const turn = captureTurn(combat), key = `${combat.uuid}|${turn.id}`;
    if (springTurns.has(key) || combat.getFlag(moduleId, TRACKER_FLAG)?.checkpoints?.some((p) => p.id === turn.id)) return;
    springTurns.set(key, captureSpringPositions(combat.combatant));
  }
  const movementKinds = ["payMovement", "endMovement", "movementBoundary", "movementMode", "linkMovementPayment", "unlinkMovementPayment", ...STEP_REQUESTS, ...ACTIVITY_REQUESTS];

  function spendingContext(combat, combatant, userId, movementLedger, actionLedger, timeline) {
    return { combatant, userId, movement: movementLedger ?? readMovement(combatant.getFlag(moduleId, MOVEMENT_FLAG)),
      actions: actionLedger ?? readLedger(combatant.getFlag(moduleId, TRACKER_FLAG)),
      timeline: timeline ?? includeCheckpoint(readTimeline(combat.getFlag(moduleId, TRACKER_FLAG)), captureTurn(combat)).timeline,
      events: [] };
  }
  function emitChanges(combat, combatant, events) {
    const state = read(combat, combatant).state;
    for (const event of events) {
      try {
        const pending = onCommitted(copy({ operationId: event.use.operationId, combatUuid: combat.uuid,
          combatantUuid: combatant.uuid, ...event, state }));
        Promise.resolve(pending).catch((error) => console.warn("NAS action tracker committed listener failed", error));
      } catch (error) { console.warn("NAS action tracker committed listener failed", error); }
    }
  }
  async function submitMovement(combatantUuid, input) {

    const request = { kind: input.kind, combatantUuid, operationId: input.operationId ?? createId() };
    for (const key of ["expectedMovementRevision", "expectedTokenUuid", "expectedOrigin", "expectedCheckpointId", "mode", "sequenceId", "actionId", "details", "reason", "assessment", "declarationId", "groupId", "classification", "activityId", "activityKind", "economy", "restricted", "multiplier", "attackId", "use", "tracking", "eligible", "charge", "optOut", "override", "targets", "springVariant", "featOverride", "mythic", "mythicPower", "springSelected", "appliedPenalty"]) {
      if (input[key] !== undefined) request[key] = copy(input[key]);
    }
    return dispatch(request);
  }

  async function mutate(request, userId) {
    requireAuthority();
    const { combat, combatant } = await resolveCombatant(request.combatantUuid);
    authorize(combatant, userId);
    let { timeline, ledger, turn } = read(combat, combatant);
    const context = spendingContext(combat, combatant, userId, undefined, ledger, timeline);
    const movementBefore = JSON.stringify(context.movement);
    let operation;
    let changed = false;
    const isRecord = ["record", "recordPF1"].includes(request.kind);

    if (isRecord) {
      let use = normalizeUse(request.use);
      const automaticRequest = request.kind === "recordPF1" ? { use, details: normalizePF1Details(request.details) } : undefined;
      operation = ledger.operations.find((entry) => entry.operationId === use.operationId);
      if (operation) {
        const matches = automaticRequest
          ? operation.userId === userId && JSON.stringify(operation.automaticRequest) === JSON.stringify(automaticRequest)
          : !operation.automaticRequest && sameUse(operation, use, userId);
        if (!matches) fail("operationConflict", "This operation ID already identifies a different action use.");

      } else {
        if (request.expectedCheckpointId !== turn.id) fail("staleTurn", "The combat turn changed before this action could be recorded.");
        if (turn.round < 1 || !turn.combatantUuid) fail("inactiveCombat", "Record actions only while the combat has an active turn.");
        if (automaticRequest) {
          const state = projectState(timeline, ledger, combatant.uuid, turn.id);
          use = normalizeUse({ ...use, ...resolvePF1Costs(automaticRequest.details, {
            used: state.used, onTurn: turn.combatantUuid === combatant.uuid
          }) });
        }

        const origin = ["manual", "pf1", "api"].includes(request.origin) ? request.origin : undefined;
        operation = { ...use, ...(origin ? { origin } : {}), ...(automaticRequest ? { automaticRequest } : {}), checkpointId: turn.id, userId, createdAt: now(), undone: false };
        ledger.operations.push(operation);
        changed = true;
      }
    } else if (request.kind === "undo") {
      if (request.operationId !== null && typeof request.operationId !== "string") fail("invalidUse", "An operation ID is required for undo.");
      operation = ledger.operations.find((entry) => entry.operationId === request.operationId);
      if (!operation && request.operationId !== null) fail("missingOperation", "The recorded action does not exist.");
      if (operation && !operation.undone) {
        operation.undone = true;
        operation.undoneBy = userId;
        operation.undoneAt = now();
        changed = true;
      }
    } else {
      fail("invalidRequest", "Unknown action tracker operation.");
    }

    if (changed) {
      context.events.push({ kind: isRecord ? "spend" : "undo", use: operation });
      spending.actionChanged(context, operation, isRecord ? "spend" : "undo");
      ledger.revision += 1;

      projectState(timeline, ledger, combatant.uuid, timeline.checkpoints.at(-1).id);
      if (isRecord) timeline = await commitTimeline(combat, turn);

      const current = await resolveCombatant(request.combatantUuid);
      if (current.combatant !== combatant) fail("missingCombatant", "The combatant was replaced while the request was pending.");
      requireAuthority();
      authorize(combatant, userId);
      if (isRecord && captureTurn(combat).id !== turn.id) {
        fail("staleTurn", "The combat turn changed before this action could be recorded.");
      }
      if (JSON.stringify(context.movement) !== movementBefore) {
        context.movement.revision++;
        await combatant.update({ [`flags.${moduleId}.${TRACKER_FLAG}`]: ledger, [`flags.${moduleId}.${MOVEMENT_FLAG}`]: context.movement });
      } else await combatant.setFlag(moduleId, TRACKER_FLAG, ledger);
    }

    const result = {
      ok: true, changed, operationId: operation?.operationId ?? null,
      state: read(combat, combatant).state
    };
    if (changed) emitChanges(combat, combatant, context.events);
    return result;
  }

  async function handleRequest(request, userId) {
    try {
      requireAuthority();
      if (!request || !["previewMovement", "movementReceipt", "record", "recordPF1", "undo", "excludeMovement", ...movementKinds].includes(request.kind)) fail("invalidRequest", "Unknown action tracker operation.");
      const frozen = copy(request);
      const { combat } = await resolveCombatant(frozen.combatantUuid);
      return await enqueue(combat.uuid, async () => {
        if (["previewMovement", "movementReceipt"].includes(frozen.kind)) {
          requireAuthority();
          const { combatant } = await resolveCombatant(frozen.combatantUuid);
          authorize(combatant, userId);
          if (frozen.kind === "movementReceipt") return { ok: true, saved: (combatant.getFlag(moduleId, MOVEMENT_FLAG)?.operations ?? []).some((op) => op.groupId === frozen.groupId) };
          return { ok: true, preview: previewMovement(combatant, frozen, getGame()) };
        }
        return frozen.kind === "excludeMovement" ? movement.exclude(frozen, userId) : movementKinds.includes(frozen.kind) ? movement.mutateSpending(frozen, userId) : mutate(frozen, userId);
      });
    } catch (error) {
      return failure(error, request?.use?.operationId ?? request?.operationId);
    }
  }

  function observeCombat(combat) {
    if (getGame()?.users?.activeGM?.id !== getGame()?.user?.id || (combat.getFlag(moduleId, TRACKER_FLAG) == null && !movement.hasPending(combat))) {
      return Promise.resolve({ ok: true, changed: false });
    }
    let turn;
    try {
      turn = captureTurn(combat);
    } catch (error) {
      return Promise.resolve(failure(error));
    }
    return enqueue(combat.uuid, async () => {
      try {
        requireAuthority();
        requireCombat(combat);
        const before = readTimeline(combat.getFlag(moduleId, TRACKER_FLAG));
        const next = await commitTimeline(combat, turn);
        await movement.expireForCombat(combat, turn.id);
        return { ok: true, changed: next.revision !== before.revision };
      } catch (error) {
        return failure(error);
      }
    });
  }

  const movement = createMovementService({ moduleId, getGame, resolveCombatant, requireAuthority, authorize,
    enqueue, commitTimeline, dispatch, failure, now, spending, spendingContext, emitChanges });
  return { getState, getHistory, recordUse, recordPF1Use, undoUse, undoLastUse, handleRequest, observeCombat, captureTurnStart,
    getMovementState: movement.getMovementState, getMovementHistory: movement.getMovementHistory, getMovementDetails: movement.getMovementDetails,
    observeMovement: movement.observeMovement, excludeMovement: movement.excludeMovement,
    captureMovementSnapshot: movement.captureSnapshot,
    getMovementGap: movement.getMovementGap, markMovementIncomplete: movement.markMovementIncomplete, getMovementSpending: movement.getMovementSpending,
    movementRequest: submitMovement,
    previewMovement: (combatantUuid, input) => dispatch({ ...copy(input), kind: "previewMovement", combatantUuid }),
    movementReceipt: (combatantUuid, groupId) => dispatch({ kind: "movementReceipt", combatantUuid, groupId }) };
}
