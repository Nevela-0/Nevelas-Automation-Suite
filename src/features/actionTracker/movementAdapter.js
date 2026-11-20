import { captureTurn, copy } from "./model.js";
import { MOVEMENT_FLAG, samePosition } from "./movementModel.js";
import { trackerSettings } from "./settings.js";
import { activeDeclaration } from "./movementSteps.js";
import { activeActivity } from "./movementActivities.js";
import { MODULE } from "../../common/module.js";
import { terrainMovementParts, terrainRecord } from "./movementTerrain.js";
import { foundryGeneration, isFoundryV13Plus, tokenDocumentPosition as position } from "../../common/foundryCompat.js";

const CONTEXT = "nasActionTrackerMovement";
const values = (collection) => Array.from(collection ?? []);

export function snapshotGrid(scene, diagonalDefault = 0) {
  const grid = scene.grid;
  return { type: grid.type, size: grid.size, distance: grid.distance, units: grid.units ?? "",
    diagonals: grid.diagonals ?? diagonalDefault,
    ...(grid.type > 1 ? { columns: grid.columns, even: grid.even, sizeX: grid.sizeX, sizeY: grid.sizeY } : {}) };
}

function point(token, raw) {
  const grid = token.parent.grid;

  const p = token.getCenterPoint?.(raw) ?? {
    x: raw.x + raw.width * (grid.sizeX ?? grid.size) / 2,
    y: raw.y + raw.height * (grid.sizeY ?? grid.size) / 2, elevation: raw.elevation
  };
  const result = { x: p.x, y: p.y, elevation: raw.elevation };
  if (grid.type > 1) {
    const cube = grid.pointToCube(result);
    result.cube = { q: cube.q, r: cube.r, s: cube.s };
  }
  return result;
}

export function createMovementAdapter({ getGame, service, createId, report = () => {}, changed = () => {}, interceptRuler }) {
  const enabled = () => trackerSettings(getGame()).movement;
  const generation = () => foundryGeneration(getGame()) ?? 12;
  const isV13 = () => isFoundryV13Plus(getGame());
  const isWriter = () => getGame()?.users?.activeGM?.id === getGame()?.user?.id;
  const writerId = () => getGame()?.users?.activeGM?.active ? getGame().users.activeGM.id : null;
  let lastWriterId = writerId();
  const warningKeys = new Set();
  let lastSettings = trackerSettings(getGame());
  const rulerContexts = new Map();
  const rulerReceipts = new Map();
  let rulerRegistered = false;
  function warn(message, userId, key) {
    if (key && warningKeys.has(key)) return;
    if (key) warningKeys.add(key);
    report(message, userId);
  }
  function matches(token, ownTurn = true) {
    return values(getGame().combats).filter((combat) => (!ownTurn || (combat.active && combat.round > 0))
      && (!combat.scene?.id || combat.scene.id === token.parent.id))
      .flatMap((combat) => values(combat.combatants).filter((c) => c.token?.uuid === token.uuid
        && (ownTurn ? combat.combatant === c : !!c.getFlag(MODULE.ID, MOVEMENT_FLAG)?.operations?.length)));
  }
  function capture(token, change, options, userId) {
    lastSettings = trackerSettings(getGame());
    if (!enabled() || token.isPreview || token.parent?.tokens?.get(token.id) !== token) return;
    const native = options._movement?.[token.id];
    if (!native && !["x", "y", "elevation", "width", "height", "shape"].some((key) => Object.hasOwn(change, key))) return;
    const undo = !!options.isUndo || native?.method === "undo";
    const candidates = matches(token, !undo);
    if (candidates.length !== 1) {
      if (candidates.length > 1) warn("Movement tracking skipped: this token matches multiple active encounters.", userId, `ambiguous:${token.uuid}`);
      return;
    }
    const combatant = candidates[0];
    const ruler = !isV13() ? rulerContexts.get(token.uuid) : null;
    const intent = options.nasMovementIntent?.[token.id];
    options[CONTEXT] ??= {};
    options[CONTEXT][token.id] = {
      operationId: intent?.observationId ?? createId(), combatantUuid: combatant.uuid, turn: intent?.turn ?? captureTurn(combatant.parent),
      declarationId: ruler?.declarationId ?? activeDeclaration(combatant.getFlag(MODULE.ID, MOVEMENT_FLAG) ?? {})?.id ?? null,
      activityId: intent ? intent.activityId : ruler ? ruler.activityId : activeActivity(combatant.getFlag(MODULE.ID, MOVEMENT_FLAG) ?? {})?.id ?? null,
      rulerId: ruler?.id ?? null,
      tokenUuid: token.uuid, sceneUuid: token.parent.uuid, origin: position(token),
      continuityGap: service.getMovementGap?.(combatant.uuid, captureTurn(combatant.parent).id) ?? null,
      mode: !isV13() ? combatant.getFlag(MODULE.ID, MOVEMENT_FLAG)?.spending?.mode ?? "walk" : token.movementAction ?? "walk",
      config: { ...snapshotGrid(token.parent, getGame().settings?.get("core", "gridDiagonals") ?? 0),
        tokenWidth: token.width, tokenHeight: token.height, tokenShape: token.shape ?? 0 }, undo,
      previousIds: [...new Set((token.movementHistory ?? []).map((p) => p.movementId).filter(Boolean))],
      appearance: { src: token.texture?.src ?? "", width: token.width, height: token.height,
        scaleX: token.texture?.scaleX ?? 1, scaleY: token.texture?.scaleY ?? 1,
        rotation: token.rotation ?? 0, sizeX: token.parent.grid.sizeX ?? token.parent.grid.size,
        sizeY: token.parent.grid.sizeY ?? token.parent.grid.size }
    };
  }
  async function complete(token, options, userId, native) {
    if (!enabled() || token.isPreview || token.parent?.tokens?.get(token.id) !== token) return;
    const context = options[CONTEXT]?.[token.id];

    if (!context) {
      if (isWriter()) for (const c of matches(token)) {
        const turn = captureTurn(c.parent);
        const message = "Movement arrived without its starting-turn context.";
        service.markMovementIncomplete(c.uuid, turn, message);
        changed(c.parent, c.uuid, { turn, message });
        warn("Some movement could not be tracked because its starting-turn context was missing.", userId, `context:${c.uuid}`);
      }
      return;
    }
    const candidates = values(getGame().combats).flatMap((c) => values(c.combatants));
    const combatant = candidates.find((c) => c.uuid === context.combatantUuid);
    if (!combatant || combatant.token?.uuid !== token.uuid) return;
    if (context.rulerId && !samePosition(context.origin, position(token))) {
      const local = rulerContexts.get(token.uuid);
      if (local?.id === context.rulerId) { local.committed = true; local.operationIds.add(`${context.operationId}_0`); }
    }
    if (!getGame().users.activeGM?.active) {
      service.markMovementIncomplete(combatant.uuid, context.turn, "Movement occurred without a connected GM.");
      changed(combatant.parent, combatant.uuid);
      if (getGame().user.id === userId) warn("Movement completed, but tracking requires a connected GM.", userId, `noGM:${combatant.uuid}`);
      return;
    }
    if (!isWriter()) return;
    const raw = native ? [native.origin, ...native.passed.waypoints] : [context.origin, position(token)];
    if (raw.length < 2) return;

    if (isV13() && native?.id && !context.undo) {
      const saved = combatant.getFlag(MODULE.ID, MOVEMENT_FLAG)?.operations ?? [];
      if (saved.some((op) => op.groupId === context.operationId && op.nativeId === native.id && op.userId === userId)) return;
    }
    const remainingIds = new Set((token.movementHistory ?? []).map((p) => p.movementId));
    const undoIds = context.previousIds.filter((id) => !remainingIds.has(id));

    const pairs = context.undo ? [[raw[0], raw.at(-1)]] : raw.slice(1).map((p, i) => [raw[i], p]);
    const segments = pairs.flatMap(([from, to]) => {
      if (!isV13() || context.undo) return [{ from, to }];
      if (["x", "y", "elevation"].every((key) => from[key] === to[key])) return [{ from, to }];
      to = { ...to, action: to.action ?? from.action ?? context.mode };
      const config = globalThis.CONFIG?.Token?.movement?.actions?.[to.action];
      return terrainMovementParts(token, from, to, { confirmed: !!native,
        teleport: to.action === "displace" || !!config?.teleport || config?.measure === false });
    });
    const observations = [];
    for (const [i, segment] of segments.entries()) {
      const pair = [segment.from, segment.to];
      const points = pair.map((p) => point(token, p));
      if (samePosition(points[0], points[1]) && !context.undo) continue;
      const resize = ["width", "height", "shape"].some((key) => pair[0][key] !== pair[1][key]);
      if (resize && !context.undo && ["x", "y", "elevation"].every((key) => pair[0][key] === pair[1][key])) continue;
      const action = pair[1].action;
      const actionConfig = globalThis.CONFIG?.Token?.movement?.actions?.[action];
      const teleport = (!isV13() && !!options.teleport) || action === "displace" || !!actionConfig?.teleport || actionConfig?.measure === false;
      observations.push({
        operationId: `${context.operationId}_${i}`, turn: context.turn, tokenUuid: context.tokenUuid, sceneUuid: context.sceneUuid,
        points, config: context.config, appearance: context.appearance, teleport, undo: context.undo,
        ...(context.continuityGap ? { continuityGap: context.continuityGap } : {}),
        mode: action ?? context.mode, generation: generation(), nativeId: native?.id ?? null, undoIds,
        ...(segment.terrain ? { terrain: terrainRecord(segment, token) } : {}),
        groupId: context.rulerId ?? context.operationId, declarationId: context.declarationId, activityId: context.activityId
      });
    }
    if (!observations.length) return;
    if (context.rulerId) {
      let receipt = rulerReceipts.get(context.rulerId);
      if (!receipt) { receipt = { combatant, userId, records: [], snapshots: [], turn: context.turn }; rulerReceipts.set(context.rulerId, receipt); }
      if (receipt.userId !== userId || receipt.combatant !== combatant) return;
      for (const record of observations) if (!receipt.records.some((r) => r.operationId === record.operationId)) {
        receipt.records.push(record); receipt.snapshots.push(service.captureMovementSnapshot(combatant, record));
      }
      return;
    }
    for (const result of [await service.observeMovement(combatant, observations, userId)]) {
      if (!result.ok || result.warning || result.notice) warn(result.warning ?? result.notice ?? result.message, userId, `failure:${context.operationId}`);
      changed(combatant.parent, combatant.uuid, !result.ok || result.warning ? { turn: context.turn, message: result.warning ?? result.message } : undefined);
    }
  }
  async function finishRuler({ id, combatantUuid, operationIds }, userId) {
    if (!isWriter() || !getGame().users.activeGM?.active) return { ok: false, message: "The movement writer changed." };
    const combatant = values(getGame().combats).flatMap((c) => values(c.combatants)).find((c) => c.uuid === combatantUuid);
    const user = getGame().users.get(userId);
    if (!combatant || !user || (!user.isGM && !combatant.actor?.testUserPermission?.(user, "OWNER"))) return { ok: false, message: "This ruler movement is no longer accessible." };
    const receipt = rulerReceipts.get(id);
    if (!receipt || receipt.combatant.uuid !== combatantUuid || receipt.userId !== userId) {

      const ledger = combatant?.getFlag(MODULE.ID, MOVEMENT_FLAG);
      const group = ledger?.steps?.groups.find((g) => g.id === id);
      if (group && group.recordIds.every((key) => ledger.operations.some((op) => op.operationId === key && op.userId === userId))) return { ok: true, changed: false };
      return { ok: false, message: "The committed ruler path could not be confirmed. Check movement history." };
    }
    if (!Array.isArray(operationIds) || operationIds.length !== receipt.records.length
      || new Set(operationIds).size !== operationIds.length || operationIds.some((key) => !receipt.records.some((r) => r.operationId === key))) {
      const message = "Some ruler updates have not reached the GM; the path was not finalized. Check movement history.";
      service.markMovementIncomplete(combatantUuid, receipt.turn, message);
      changed(receipt.combatant.parent, combatantUuid, { turn: receipt.turn, message });
      return { ok: false, message };
    }
    const result = await service.observeMovement(receipt.combatant, receipt.records, userId, receipt.snapshots);
    if (result.ok) rulerReceipts.delete(id);
    else service.markMovementIncomplete(combatantUuid, receipt.turn, result.message);
    changed(receipt.combatant.parent, combatantUuid, !result.ok || result.warning ? { turn: receipt.turn, message: result.warning ?? result.message } : undefined);
    return result;
  }
  async function trackedRulerMovement(wrapped, token, ...args) {
    const doc = token.document ?? token;
    const candidates = enabled() ? matches(doc) : [];
    if (candidates.length !== 1) return wrapped(token, ...args);
    const combatant = candidates[0];
    const entry = { id: createId(), declarationId: activeDeclaration(combatant.getFlag(MODULE.ID, MOVEMENT_FLAG) ?? {})?.id ?? null,
      activityId: activeActivity(combatant.getFlag(MODULE.ID, MOVEMENT_FLAG) ?? {})?.id ?? null,
      operationIds: new Set(), turn: captureTurn(combatant.parent) };
    rulerContexts.set(doc.uuid, entry);
    const start = position(doc);
    try { return await wrapped(token, ...args); }
    finally {
      rulerContexts.delete(doc.uuid);
      if (!samePosition(start, position(doc)) || entry.committed) {
        try {
          const result = await service.finishRulerMovement({ id: entry.id, combatantUuid: combatant.uuid, operationIds: [...entry.operationIds] });
          if (result?.ok && (result.warning || result.notice)) warn(result.warning ?? result.notice, getGame().user.id);
          if (!result?.ok) {
            service.markMovementIncomplete(combatant.uuid, entry.turn, result?.message);
            warn(result?.message ?? "Ruler tracking could not be confirmed.", getGame().user.id);
          }
        } catch (error) { warn(error.message, getGame().user.id); }
      }
    }
  }
  async function rulerMovement(wrapped, token, ...args) {
    const run = () => trackedRulerMovement(wrapped, token, ...args);
    return interceptRuler ? interceptRuler(this, run, token) : run();
  }
  function reconcile() {
    lastSettings = trackerSettings(getGame());
    lastWriterId = writerId();
    if (!enabled() || !isWriter()) return;
    for (const combat of getGame().combats ?? []) {
      const combatant = combat.combatant;
      const token = combatant?.token;
      if (!combat.active || combat.round < 1 || !token) continue;
      const turn = captureTurn(combat);
      const last = combatant.getFlag(MODULE.ID, MOVEMENT_FLAG)?.operations?.filter((op) => op.checkpointId === turn.id).at(-1);
      if (!last || !samePosition(last.points.at(-1), point(token, position(token)))) {
        service.markMovementIncomplete(combatant.uuid, turn, "Tracking resumed during this turn; earlier movement may be missing.");
        changed(combat, combatant.uuid);
      }
    }
  }
  async function settingsChanged() {
    const next = trackerSettings(getGame());
    const interrupted = (lastSettings.movement && !next.movement) || (lastSettings.automaticMovement && !next.automaticMovement);
    lastSettings = next;
    if (isWriter()) for (const combat of getGame().combats ?? []) await service.observeCombat(combat);
    if (interrupted && isWriter()) {
      for (const combat of getGame().combats ?? []) {
        const combatant = combat.combatant;
        if (!combat.active || combat.round < 1 || !combatant) continue;
        const turn = captureTurn(combat);
        const open = combatant.getFlag(MODULE.ID, MOVEMENT_FLAG)?.spending?.sequences?.some((s) => s.checkpointId === turn.id && !s.closed);
        if (!open) continue;
        const result = await service.movementRequest(combatant.uuid, {
          kind: "endMovement", operationId: createId(), expectedCheckpointId: turn.id, reason: "automationDisabled"
        });
        if (!result.ok) {
          service.markMovementIncomplete(combatant.uuid, turn, "Tracking was disabled before the movement allowance could be closed.");
          warn(result.message, getGame().user.id);
        }
        changed(combat, combatant.uuid);
      }
    }
    reconcile();
  }
  function register(hooks = globalThis.Hooks) {
    const safe = (fn) => (...args) => {
      try { return Promise.resolve(fn(...args)).catch((error) => console.warn("NAS movement tracking", error)); }
      catch (error) { console.warn("NAS movement tracking", error); }
    };

    hooks.on("preUpdateToken", (...args) => { try { capture(...args); } catch (error) { console.warn("NAS movement capture", error); } });
    hooks.on("moveToken", safe((token, native, options, user) => isV13() ? complete(token, options, user.id, native) : undefined));
    hooks.on("updateToken", safe((token, change, options, userId) => !isV13()
      && ["x", "y", "elevation", "width", "height", "shape"].some((key) => Object.hasOwn(change, key)) ? complete(token, options, userId) : undefined));
    hooks.once("ready", reconcile);
    hooks.on("userConnected", () => {
      const nextWriterId = writerId();
      if (nextWriterId === lastWriterId) return;
      lastWriterId = nextWriterId;

      reconcile();
    });
    hooks.on("nasActionTrackerSettingsChanged", safe(settingsChanged));
    const expire = safe(async () => {
      if (isWriter()) for (const combat of getGame().combats ?? []) await service.observeCombat(combat);
    });
    for (const name of ["updateActor", "updateUser", "deleteUser", "deleteToken", "updateCombatant"]) hooks.on(name, expire);
    hooks.on("updateToken", (token, change) => {
      if (["actorId", "actorLink", "delta"].some((key) => Object.hasOwn(change, key))) return expire();
    });
    hooks.on("deleteCombat", (combat) => {
      for (const [id, receipt] of rulerReceipts) if (receipt.combatant.parent === combat) rulerReceipts.delete(id);
    });
    hooks.on("deleteToken", (token) => {
      rulerContexts.delete(token.uuid);
      for (const [id, receipt] of rulerReceipts) if (receipt.records.some((r) => r.tokenUuid === token.uuid)) rulerReceipts.delete(id);
    });
    if (!isV13() && !rulerRegistered && globalThis.libWrapper) {
      globalThis.libWrapper.register(MODULE.ID, "Ruler.prototype._animateMovement", rulerMovement, interceptRuler ? "MIXED" : "WRAPPER");
      rulerRegistered = true;
    }
  }
  return { capture, complete, reconcile, settingsChanged, register, finishRuler, rulerMovement };
}
