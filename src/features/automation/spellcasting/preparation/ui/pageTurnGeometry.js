import { spellbookText as t } from "../i18n.js";
const EPSILON = 0.001;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getHardPageHinge({ stageRect, pageRect, direction, single = false }) {
  const pageLeft = finite(pageRect.left);
  const pageWidth = Math.max(1, finite(pageRect.width, 1));
  const x = single
    ? pageLeft + (direction > 0 ? 0 : pageWidth)
    : finite(stageRect.left) + (Math.max(1, finite(stageRect.width, 1)) / 2);
  return { x, originX: x - pageLeft };
}

function pointDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function dot(left, right) {
  return (left.x * right.x) + (left.y * right.y);
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y
  };
}

function removeDuplicatePoints(points) {
  const unique = [];
  for (const point of points) {
    if (!unique.some((candidate) => pointDistance(candidate, point) < EPSILON)) {
      unique.push(point);
    }
  }
  if (unique.length > 1 && pointDistance(unique[0], unique.at(-1)) < EPSILON) {
    unique.pop();
  }
  return unique;
}

function clipPolygonToHalfPlane(polygon, origin, normal, keepPositive) {
  if (!polygon.length) return [];
  const side = keepPositive ? 1 : -1;
  const signedDistance = (point) => dot(subtract(point, origin), normal) * side;
  const output = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentDistance = signedDistance(current);
    const nextDistance = signedDistance(next);
    const currentInside = currentDistance >= -EPSILON;
    const nextInside = nextDistance >= -EPSILON;

    if (currentInside) output.push(current);
    if (currentInside === nextInside) continue;

    const denominator = currentDistance - nextDistance;
    if (Math.abs(denominator) < EPSILON) continue;
    const ratio = currentDistance / denominator;
    output.push({
      x: current.x + ((next.x - current.x) * ratio),
      y: current.y + ((next.y - current.y) * ratio)
    });
  }

  return removeDuplicatePoints(output);
}

function rectangle(width, height) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}

function chooseFarthestPair(points) {
  if (points.length < 2) return null;
  let pair = [points[0], points[1]];
  let maximum = pointDistance(pair[0], pair[1]);

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const distance = pointDistance(points[left], points[right]);
      if (distance > maximum) {
        maximum = distance;
        pair = [points[left], points[right]];
      }
    }
  }

  return {
    start: pair[0],
    end: pair[1],
    length: maximum,
    midpoint: {
      x: (pair[0].x + pair[1].x) / 2,
      y: (pair[0].y + pair[1].y) / 2
    },
    angle: Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x) * (180 / Math.PI)
  };
}

function getCreaseSegment(rectanglePoints, midpoint, normal) {
  const intersections = [];
  for (let index = 0; index < rectanglePoints.length; index += 1) {
    const start = rectanglePoints[index];
    const end = rectanglePoints[(index + 1) % rectanglePoints.length];
    const startDistance = dot(subtract(start, midpoint), normal);
    const endDistance = dot(subtract(end, midpoint), normal);

    if (Math.abs(startDistance) < EPSILON) intersections.push(start);
    if (startDistance * endDistance < -(EPSILON * EPSILON)) {
      const ratio = startDistance / (startDistance - endDistance);
      intersections.push({
        x: start.x + ((end.x - start.x) * ratio),
        y: start.y + ((end.y - start.y) * ratio)
      });
    }
    if (Math.abs(endDistance) < EPSILON) intersections.push(end);
  }

  return chooseFarthestPair(removeDuplicatePoints(intersections));
}

function reflectionAcrossLine(midpoint, unitNormal) {
  const { x: nx, y: ny } = unitNormal;
  const offset = 2 * ((nx * midpoint.x) + (ny * midpoint.y));
  return {
    a: 1 - (2 * nx * nx),
    b: -2 * nx * ny,
    c: -2 * nx * ny,
    d: 1 - (2 * ny * ny),
    e: offset * nx,
    f: offset * ny
  };
}

export function getFoldCorner({ width, height, direction }) {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  return {
    x: direction > 0 ? safeWidth : 0,
    y: safeHeight
  };
}

export function getFoldPointForProgress({
  width,
  height,
  direction,
  bindingInset = 0,
  progress,
  verticalInfluence = 0
}) {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const safeBindingInset = Math.max(0, finite(bindingInset));
  const travel = (safeWidth + safeBindingInset) * 2;
  const normalized = clamp(progress, 0, 1);
  const corner = getFoldCorner({ width: safeWidth, height: safeHeight, direction });
  const horizontalDirection = direction > 0 ? -1 : 1;
  const vertical = clamp(verticalInfluence, -1, 1);
  const liftRatio = 0.12 - (vertical * 0.075);

  return {
    x: corner.x + (horizontalDirection * travel * normalized),
    y: corner.y - (Math.sin(Math.PI * normalized) * safeHeight * liftRatio)
  };
}

export function interpolateFoldPoint(from, to, progress) {
  const normalized = clamp(progress, 0, 1);
  return {
    x: finite(from?.x) + ((finite(to?.x) - finite(from?.x)) * normalized),
    y: finite(from?.y) + ((finite(to?.y) - finite(from?.y)) * normalized)
  };
}

export function getPolygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(twiceArea) / 2;
}

export function createPageFoldState({
  width,
  height,
  direction,
  bindingInset = 0,
  pointer
}) {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const safeBindingInset = Math.max(0, finite(bindingInset));
  const travel = (safeWidth + safeBindingInset) * 2;
  const safeDirection = direction > 0 ? 1 : -1;
  const corner = getFoldCorner({
    width: safeWidth,
    height: safeHeight,
    direction: safeDirection
  });
  const rawPointer = {
    x: finite(pointer?.x, corner.x),
    y: finite(pointer?.y, corner.y)
  };
  const x = safeDirection > 0
    ? clamp(rawPointer.x, -safeWidth - (safeBindingInset * 2), safeWidth)
    : clamp(rawPointer.x, 0, travel);
  const innerEdgeX = safeDirection > 0 ? 0 : safeWidth;
  const reachX = x - innerEdgeX;

  const maxLift = Math.sqrt(Math.max(0, safeWidth ** 2 - reachX ** 2));
  const clampedPointer = {
    x,
    y: clamp(rawPointer.y, Math.max(-safeHeight * 0.15, safeHeight - maxLift), safeHeight)
  };
  const displacement = subtract(clampedPointer, corner);
  const distance = Math.hypot(displacement.x, displacement.y);
  const pageRectangle = rectangle(safeWidth, safeHeight);
  const progress = clamp(Math.abs(clampedPointer.x - corner.x) / travel, 0, 1);

  if (distance < EPSILON) {
    return {
      width: safeWidth,
      height: safeHeight,
      direction: safeDirection,
      corner,
      pointer: { ...corner },
      progress: 0,
      foldAmount: 0,
      crossedSpine: false,
      resting: true,
      frontPolygon: pageRectangle,
      foldedPolygon: [],
      reflection: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      crease: null,
      shadowOpacity: 0,
      shadowWidth: 0
    };
  }

  const midpoint = {
    x: (corner.x + clampedPointer.x) / 2,
    y: (corner.y + clampedPointer.y) / 2
  };
  const unitNormal = {
    x: displacement.x / distance,
    y: displacement.y / distance
  };
  const towardCorner = subtract(corner, clampedPointer);
  const foldedPolygon = clipPolygonToHalfPlane(
    pageRectangle,
    midpoint,
    towardCorner,
    true
  );
  const frontPolygon = clipPolygonToHalfPlane(
    pageRectangle,
    midpoint,
    towardCorner,
    false
  );
  const crease = getCreaseSegment(pageRectangle, midpoint, displacement);
  const foldAmount = clamp(
    distance / Math.hypot(travel, safeHeight),
    0,
    1
  );
  const crossedSpine = safeDirection > 0
    ? clampedPointer.x <= -safeBindingInset
    : clampedPointer.x >= safeWidth + safeBindingInset;

  return {
    width: safeWidth,
    height: safeHeight,
    direction: safeDirection,
    corner,
    pointer: clampedPointer,
    midpoint,
    progress,
    foldAmount,
    crossedSpine,
    resting: false,
    frontPolygon,
    foldedPolygon,
    reflection: reflectionAcrossLine(midpoint, unitNormal),
    crease,
    shadowOpacity: clamp(
      0.08 + (Math.sin(Math.PI * progress) * 0.34) + (foldAmount * 0.16),
      0,
      0.58
    ),
    shadowWidth: 12 + (Math.sin(Math.PI * progress) * 32) + (foldAmount * 18)
  };
}
