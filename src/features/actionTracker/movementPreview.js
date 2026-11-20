import { MODULE } from "../../common/module.js";
import { isFoundryV13Plus, tokenDocumentPosition } from "../../common/foundryCompat.js";
import { captureTurn, copy, fail } from "./model.js";
import { appendMovement, MOVEMENT_FLAG, readMovement, samePosition } from "./movementModel.js";
import { snapshotGrid } from "./movementAdapter.js";
import { actionCount, sequenceConsumption, snapshotSpeed } from "./movementSpending.js";
import { activeActivity } from "./movementActivities.js";
import { activeDeclaration, captureStepEligibility, classifySteps, registerStepGroup } from "./movementSteps.js";
import { terrainCost, terrainMovementParts, terrainRecord } from "./movementTerrain.js";
import { trackerSettings } from "./settings.js";

export const tokenPosition = tokenDocumentPosition;

export function previewMovement(combatant, input, game) {
  const token = combatant.token, turn = captureTurn(combatant.parent), settings = trackerSettings(game);
  if (!settings.movement || !combatant.parent.active || turn.round < 1 || turn.combatantUuid !== combatant.uuid
    || turn.id !== input.expectedCheckpointId) fail("staleTurn", "This movement no longer belongs to the active turn.");
  if (!token || token.uuid !== input.tokenUuid || token.parent?.tokens?.get(token.id) !== token) fail("missingToken", "The movement token is no longer available.");
  if (!samePosition(tokenPosition(token), input.origin)) fail("staleMovement", "The token moved while this route was being considered. Try the route again.");
  const ledger = readMovement(combatant.getFlag(MODULE.ID, MOVEMENT_FLAG));
  const revision = ledger.revision;
  const sequence = ledger.spending?.sequences.findLast((s) => s.checkpointId === turn.id && !s.closed && s.economy === settings.economy);
  const activity = activeActivity(ledger), step = activeDeclaration(ledger);
  const mode = isFoundryV13Plus(game) ? token.movementAction ?? "walk" : ledger.spending?.mode ?? "walk";
  const records = [];
  const measurement = previewRoute(token, input.waypoints, { ledger, turn, game, mode, records });
  const consumed = Math.max(0, (sequence?.consumption ?? 0) - (sequence?.waived ?? 0));
  const paid = sequence?.paid ?? 0;
  let projected = consumed + measurement.consumption;
  if (settings.automaticMovement && !activity && !step && records.length) {

    const projectedLedger = copy(ledger);
    const projectedSequence = copy(sequence ?? { id: records[0].operationId, waivers: [] });
    for (const op of records) op.spending.sequenceId = projectedSequence.id;
    projectedLedger.operations.push(...records);
    const context = { movement: projectedLedger, actions: { operations: [] }, userId: game.user.id };
    registerStepGroup(context, records, 0);
    classifySteps(context, { refund() {}, spendAct: () => ({ operationId: "preview_step" }) });
    projected = sequenceConsumption(projectedLedger, projectedSequence);
  }
  return { ...measurement, revision, economy: settings.economy, automatic: settings.automaticMovement,
    activity: copy(activity), step: copy(step), consumed, paid, remaining: Math.max(0, paid - consumed),
    projected,
    priorBlindConsumption: ledger.operations.filter((op) => op.checkpointId === turn.id && !op.excluded && !op.reversed && op.spending?.speed > 0
      && (activity ? activity.recordIds.includes(op.operationId) : sequence && op.spending.sequenceId === sequence.id))
      .reduce((n, op) => n + op.distance * op.spending.feetPerUnit / op.spending.speed, 0),
    needsChoice: settings.automaticMovement && !activity && !step && !measurement.incomplete
      && actionCount(projected) > Math.max(1, paid),
    usedEarlier: ledger.operations.some((op) => op.checkpointId === turn.id && op.distance > 0 && !op.excluded && !op.reversed),
    sequenceId: sequence?.id ?? null };
}

export function previewRoute(token, waypoints, { ledger = { operations: [] }, turn = { id: "preview" }, game, mode = "walk", records = [] } = {}) {
  if (!Array.isArray(waypoints) || !waypoints.length || waypoints.length > 1000) fail("invalidMovement", "The intended movement path is unavailable.");
  ledger = copy(ledger);
  const config = { ...snapshotGrid(token.parent, game?.settings?.get("core", "gridDiagonals") ?? 0),
    tokenWidth: token.width, tokenHeight: token.height, tokenShape: token.shape ?? 0 };
  let from = { ...tokenPosition(token), action: mode }, consumption = 0, distance = 0, blindConsumption = 0;
  let cost = 0, incomplete = false, displaced = false, ordinary = false, hampered = false;
  const warnings = [], speeds = [];
  const actor = token.actor;
  for (const raw of waypoints) {
    const to = { ...from, ...raw };
    if (![to.x, to.y, to.elevation, to.width, to.height].every(Number.isFinite)) fail("invalidMovement", "The intended movement coordinates are invalid.");
    const action = globalThis.CONFIG?.Token?.movement?.actions?.[to.action];
    const teleport = !!raw.teleport || to.action === "displace" || action?.teleport || action?.measure === false;
    displaced ||= !!teleport;
    const parts = isFoundryV13Plus(game) ? terrainMovementParts(token, from, to, { teleport }) : [{ from, to }];
    for (const part of parts) {
      const points = [part.from, part.to].map((p) => {
        const center = token.getCenterPoint?.(p) ?? { x: p.x + p.width * (config.sizeX ?? config.size) / 2, y: p.y + p.height * (config.sizeY ?? config.size) / 2 };
        const point = { x: center.x, y: center.y, elevation: p.elevation };
        if (config.type > 1) { const c = token.parent.grid.pointToCube(point); point.cube = { q: c.q, r: c.r, s: c.s }; }
        return point;
      });
      if (samePosition(points[0], points[1])) continue;
      const op = appendMovement(ledger, { operationId: `preview_${ledger.operations.length}`, tokenUuid: token.uuid,
        sceneUuid: token.parent.uuid, turn, points, config, teleport: !!teleport,
        ...(part.terrain ? { terrain: terrainRecord(part, token) } : {}) }, { userId: game?.user?.id, now: 0 });
      const speed = snapshotSpeed(actor, to.action, config.units, trackerSettings(game).economy);
      if (!speeds.some((s) => s.mode === speed.mode && s.speed === speed.speed)) speeds.push(speed);
      const adjusted = terrainCost(op, ledger);
      const ordinaryConsumption = !teleport && !speed.warning && adjusted !== null ? (adjusted ?? op.distance) * speed.feetPerUnit / speed.speed : 0;
      op.spending = { ...speed, stepEligibility: captureStepEligibility(actor, speed.mode), automaticStep: 1,
        ordinaryConsumption, consumption: ordinaryConsumption };
      records.push(op);
      distance += op.distance;
      hampered ||= op.distance > 0 && part.terrain?.multiplier > 1;
      if (teleport) continue;
      ordinary ||= op.distance > 0;
      if (speed.warning || adjusted === null) { incomplete = true; warnings.push(speed.warning ?? part.terrain?.warning ?? "Region cost could not be measured."); continue; }
      const c = adjusted ?? op.distance;
      cost += c; consumption += c * speed.feetPerUnit / speed.speed;
      blindConsumption += op.distance * speed.feetPerUnit / speed.speed;
    }
    from = to;
  }
  return { distance, cost, consumption, blindConsumption, units: config.units, incomplete, displaced: displaced && !ordinary, hampered,
    warnings: [...new Set(warnings)], speeds };
}
