import { copy, fail, historyAt } from "./model.js";
import { isFoundryV13Plus } from "../../common/foundryCompat.js";

export const MOVEMENT_FLAG = "actionTrackerMovement";
export const samePosition = (a, b) => !!a && !!b && ["x", "y", "elevation"].every((key) => Math.abs(a[key] - b[key]) < 1e-7);
export const configKey = (config) => JSON.stringify(config);

export function readMovement(value) {
  if (value == null) return { version: 1, revision: 0, operations: [], gaps: [] };
  if (value.version !== 1) fail("unsupportedVersion", "Unsupported movement tracking version.");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.operations) || !Array.isArray(value.gaps)) {
    fail("invalidState", "Invalid saved movement history.");
  }
  if (value.spending) {
    if (value.spending.version !== 1) fail("unsupportedVersion", "Unsupported movement spending version.");
    if (![value.spending.sequences, value.spending.boundaries, value.spending.requests].every(Array.isArray)) {
      fail("invalidState", "Invalid saved movement spending history.");
    }
  }
  if (value.steps && (value.steps.version !== 1 || !Array.isArray(value.steps.declarations) || !Array.isArray(value.steps.groups))) {
    fail("invalidState", "Invalid saved step history.");
  }
  if (value.activities && (value.activities.version !== 1 || !Array.isArray(value.activities.entries) || !Array.isArray(value.activities.uses))) fail("invalidState", "Invalid saved activity history.");
  for (const record of value.operations) {
    if (!Number.isFinite(record.distance) || record.distance < 0 || !record.operationId || !Array.isArray(record.points)) {
      fail("invalidState", "Invalid saved movement record.");
    }
  }
  return copy(value);
}

export function normalizeMovement(input) {
  const record = copy(input);
  if (!record || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.operationId ?? "") || !record.turn?.id
    || typeof record.tokenUuid !== "string" || typeof record.sceneUuid !== "string") fail("invalidMovement", "Invalid movement identity.");
  if (record.continuityGap !== undefined && (typeof record.continuityGap !== "string" || record.continuityGap.length > 256)) fail("invalidMovement", "Invalid movement gap identity.");
  for (const key of ["groupId", "declarationId", "activityId"]) if (record[key] != null && !/^[a-zA-Z0-9_-]{1,128}$/.test(record[key])) fail("invalidMovement", "Invalid movement group identity.");
  if (!Array.isArray(record.points) || record.points.length < 2 || record.points.length > 10000) fail("invalidMovement", "Invalid movement path.");
  for (const point of record.points) {
    if (![point.x, point.y, point.elevation].every(Number.isFinite)) fail("invalidMovement", "Movement coordinates must be finite.");
    if (point.cube && ![point.cube.q, point.cube.r, point.cube.s].every(Number.isFinite)) fail("invalidMovement", "Invalid hex coordinates.");
  }
  const c = record.config;
  if (!c || ![c.size, c.distance].every((n) => Number.isFinite(n) && n > 0) || ![0, 1, 2, 3, 4, 5].includes(c.type)
    || !Number.isInteger(c.diagonals) || c.diagonals < 0 || c.diagonals > 6 || typeof c.units !== "string") {
    fail("invalidMovement", "Invalid scene measurement configuration.");
  }
  return record;
}

function alternating3(axes, phase) {
  const whole = axes.map(Math.floor);
  const fraction = axes.map((n, i) => n - whole[i]);
  const base = whole[0] + whole[1] / 2 + whole[2] / 4;
  const weights = [1 - fraction[0], fraction[0] - fraction[1], fraction[1] - fraction[2], fraction[2]];
  return [0, 1, 1.5, 1.75].reduce((n, offset, i) => n + weights[i] * Math.floor(base + offset), 0) - phase;
}
const alternating2 = (n) => Math.floor(n / 2) + Math.max(0, n % 2 - 1);

export function measureCompatible(points, config) {
  return measureCompatiblePart(points, config).distance;
}

export function measureCompatiblePart(points, config, carry = {}) {
  const phase = config.diagonals === 5 ? 1 : 0;
  const axes = [...(carry.axes ?? [phase, phase, phase])];
  let hexDiagonals = carry.hexDiagonals ?? phase, previousLattice = carry.previousLattice ?? 0, total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const vertical = Math.abs(b.elevation - a.elevation) / config.distance;
    if (config.type === 0) {
      total += Math.hypot((b.x - a.x) / config.size, (b.y - a.y) / config.size, vertical) * config.distance;
      continue;
    }
    let travel;
    if (config.type === 1) travel = [Math.abs(b.x - a.x) / config.size, Math.abs(b.y - a.y) / config.size, vertical].sort((x, y) => y - x);
    else {
      if (!a.cube || !b.cube) fail("invalidMovement", "Hex movement requires measured cube coordinates.");
      const horizontal = Math.max(...["q", "r", "s"].map((key) => Math.abs(b.cube[key] - a.cube[key])));
      travel = [horizontal, vertical].sort((x, y) => y - x).concat(0);
    }
    const [major, middle, minor] = travel;
    let units;
    switch (config.diagonals) {
      case 3: case 6: units = major + middle + minor; break;
      case 0: units = major; break;
      case 1: units = major + (Math.SQRT2 - 1) * (middle - minor) + (Math.sqrt(3) - 1) * minor; break;
      case 2: units = major + 0.5 * middle + 0.25 * minor; break;
      case 4: case 5:
        if (config.type === 1) {
          travel.forEach((n, axis) => { axes[axis] += n; });
          const lattice = alternating3(axes, phase);
          units = lattice - previousLattice;
          previousLattice = lattice;
        } else {
          units = major + alternating2(hexDiagonals + middle) - alternating2(hexDiagonals);
          hexDiagonals += middle;
        }
        break;
    }
    total += units * config.distance;
  }
  return { distance: Math.max(0, total), carry: { axes, hexDiagonals, previousLattice } };
}

export function measureMovement(points, config) {
  if (isFoundryV13Plus() && globalThis.foundry?.grid) {
    const classes = globalThis.foundry.grid;
    const Grid = config.type === 0 ? classes.GridlessGrid : config.type === 1 ? classes.SquareGrid : classes.HexagonalGrid;
    if (Grid) return new Grid(config).measurePath(points).distance;
  }
  return measureCompatible(points, config);
}

export function appendMovement(ledger, input, { userId, now, measure = measureMovement }) {
  const record = normalizeMovement(input);
  const current = ledger.operations.filter((op) => op.checkpointId === record.turn.id);
  const unresolvedUndo = current.at(-1)?.kind === "undo" && !current.at(-1).targets?.length;
  const previous = unresolvedUndo ? null : current.filter((op) => op.kind === "move" && !op.reversed).at(-1);
  const continuous = previous && previous.kind === "move" && !previous.breakAfter
    && previous.tokenUuid === record.tokenUuid && configKey(previous.config) === configKey(record.config)
    && samePosition(previous.points.at(-1), record.points[0]);
  let priorPoints = [];
  if (continuous) {
    const chain = ledger.operations.filter((op) => op.chainId === previous.chainId && !op.reversed && op.kind === "move");
    priorPoints = chain.flatMap((op, i) => i ? op.points.slice(1) : op.points);
  }
  const allPoints = priorPoints.length ? priorPoints.concat(record.points.slice(1)) : record.points;
  const distance = record.teleport ? 0 : Math.max(0, measure(allPoints, record.config) - (priorPoints.length ? measure(priorPoints, record.config) : 0));
  if (!Number.isFinite(distance)) fail("invalidMovement", "Movement distance could not be measured.");
  const operation = {
    ...record, checkpointId: record.turn.id, kind: "move", userId, createdAt: now,
    chainId: continuous && !record.teleport ? previous.chainId : record.operationId,
    breakAfter: !!record.teleport, distance, excluded: !!record.teleport, reversed: false,
    exclusionReason: record.teleport ? "teleport" : null
  };

  operation.request = copy(record);
  ledger.operations.push(operation);
  return operation;
}

export function movementState(timeline, ledger, combatantUuid, checkpointId, measure = measureMovement) {
  historyAt(timeline, ledger);  
  const index = timeline.checkpoints.findIndex((cp) => cp.id === checkpointId);
  if (index < 0) fail("unknownCheckpoint", "The requested turn has not been recorded.");
  const selected = timeline.checkpoints[index];
  const own = selected.round > 0 ? timeline.checkpoints.slice(0, index + 1).findLast((cp) => cp.combatantUuid === combatantUuid) : null;
  const operations = ledger.operations.filter((op) => op.checkpointId === own?.id);
  const groups = [];
  for (const op of operations) {
    if (op.kind !== "move" || op.reversed) continue;
    let group = groups.find((g) => g.units === op.config.units);
    if (!group) groups.push(group = { units: op.config.units, distance: 0 });
    if (!op.excluded) group.distance += op.distance;
  }
  const first = operations.find((op) => op.kind === "move" && !op.reversed);
  const last = operations.at(-1);
  const liveMoves = operations.filter((op) => op.kind === "move" && !op.reversed);
  const latest = liveMoves.at(-1);
  let marker = latest;
  for (let i = liveMoves.length - 2; i >= 0; i--) {
    const candidate = liveMoves[i];
    if (candidate.tokenUuid !== latest.tokenUuid || candidate.sceneUuid !== latest.sceneUuid || configKey(candidate.config) !== configKey(latest.config)) break;
    marker = candidate;
  }
  const direct = first && last && operations.filter((op) => !op.reversed).every((op) => first.tokenUuid === op.tokenUuid && configKey(first.config) === configKey(op.config))
    ? { distance: measure([first.points[0], last.points.at(-1)], first.config), units: first.config.units } : null;
  return copy({ version: 1, revision: ledger.revision, combatantUuid, checkpointId, ownCheckpointId: own?.id ?? null,
    groups, direct, origin: marker?.points[0] ?? null, appearance: marker?.appearance ?? null, tokenUuid: marker?.tokenUuid ?? null,
    sceneUuid: marker?.sceneUuid ?? null, incomplete: ledger.gaps.some((gap) => gap.checkpointId === own?.id) });
}

export const movementHistory = (timeline, ledger) => historyAt(timeline, ledger);
