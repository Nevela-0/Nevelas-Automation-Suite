export const METAMAGIC_DEFINITION = {
  key: "intensifiedSpell",
  name: "Intensified Spell",
  prefix: "Intensified",
};

function getCapUpdateFromCount(countExpr, cl) {
  if (!countExpr || !Number.isFinite(cl)) return null;
  const expr = countExpr.replace(/^\(|\)$/g, "");
  const clValue = Number(cl);
  const half = Math.floor(clValue / 2);
  const doubled = clValue * 2;

  const clampMatch = expr.match(/clamp\(\s*floor\(\s*@cl\s*\/\s*2\s*\)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (clampMatch) {
    const cap = Number(clampMatch[2]);
    if (!Number.isFinite(cap) || half <= cap) return null;
    const nextCap = Math.min(cap + 5, half);
    return {
      updatedExpr: expr.replace(clampMatch[2], String(nextCap)),
      changed: true,
    };
  }

  const minCapHalf = expr.match(/min\(\s*(\d+)\s*,\s*floor\(\s*@cl\s*\/\s*2\s*\)\s*\)/i);
  if (minCapHalf) {
    const cap = Number(minCapHalf[1]);
    if (!Number.isFinite(cap) || half <= cap) return null;
    const nextCap = Math.min(cap + 5, half);
    return {
      updatedExpr: expr.replace(minCapHalf[1], String(nextCap)),
      changed: true,
    };
  }

  const minHalfCap = expr.match(/min\(\s*floor\(\s*@cl\s*\/\s*2\s*\)\s*,\s*(\d+)\s*\)/i);
  if (minHalfCap) {
    const cap = Number(minHalfCap[1]);
    if (!Number.isFinite(cap) || half <= cap) return null;
    const nextCap = Math.min(cap + 5, half);
    return {
      updatedExpr: expr.replace(minHalfCap[1], String(nextCap)),
      changed: true,
    };
  }

  const minCapCl = expr.match(/min\(\s*(\d+)\s*,\s*@cl\s*\)/i);
  if (minCapCl) {
    const cap = Number(minCapCl[1]);
    if (!Number.isFinite(cap) || clValue <= cap) return null;
    const nextCap = Math.min(cap + 5, clValue);
    return {
      updatedExpr: expr.replace(minCapCl[1], String(nextCap)),
      changed: true,
    };
  }

  const minClCap = expr.match(/min\(\s*@cl\s*,\s*(\d+)\s*\)/i);
  if (minClCap) {
    const cap = Number(minClCap[1]);
    if (!Number.isFinite(cap) || clValue <= cap) return null;
    const nextCap = Math.min(cap + 5, clValue);
    return {
      updatedExpr: expr.replace(minClCap[1], String(nextCap)),
      changed: true,
    };
  }

  const minCapDouble = expr.match(/min\(\s*(\d+)\s*,\s*@cl\s*\*\s*2\s*\)/i);
  if (minCapDouble) {
    const cap = Number(minCapDouble[1]);
    if (!Number.isFinite(cap) || doubled <= cap) return null;
    const nextCap = Math.min(cap + 5, doubled);
    return {
      updatedExpr: expr.replace(minCapDouble[1], String(nextCap)),
      changed: true,
    };
  }

  return null;
}

function updateFormula(formula, cl) {
  if (!formula || typeof formula !== "string") return { formula, changed: false };
  const dicePattern = /(\([^)]*\)|@cl|clamp\([^)]*\)|min\([^)]*\)|floor\([^)]*\)|\d+)(\s*\)*)\s*d\s*\d+/gi;
  let match;
  let lastIndex = 0;
  let updated = "";
  let changed = false;
  while ((match = dicePattern.exec(formula)) !== null) {
    const full = match[0];
    const countExpr = match[1];
    const trailingParens = match[2] ?? "";
    const combinedExpr = `${countExpr}${trailingParens}`.trim();
    const replacementInfo = getCapUpdateFromCount(combinedExpr, cl);
    const updatedCountExpr = replacementInfo?.updatedExpr;
    updated += formula.slice(lastIndex, match.index);
    if (updatedCountExpr) {
      const normalizedCount = combinedExpr.startsWith("(") && combinedExpr.endsWith(")")
        ? `(${updatedCountExpr})`
        : updatedCountExpr;
      updated += full.replace(combinedExpr, normalizedCount);
      changed = true;
    } else {
      updated += full;
    }
    lastIndex = match.index + full.length;
  }
  updated += formula.slice(lastIndex);
  return { formula: updated, changed };
}

function getCurrentFormula(context, index, fallback) {
  const overrides = context?.damageOverrides?.parts;
  if (Array.isArray(overrides)) {
    for (let i = overrides.length - 1; i >= 0; i -= 1) {
      const entry = overrides[i];
      if (entry?.index === index && entry?.formula) return entry.formula;
    }
  }
  return fallback;
}

export function applyIntensifiedSpell(context, cl) {
  if (!context?.damage?.parts || !Array.isArray(context.damage.parts)) return false;
  const clValue = Number(cl ?? context?.actor?.system?.attributes?.casterLevel?.value ?? 0);
  if (!Number.isFinite(clValue) || clValue <= 0) return false;

  const overrides = [];
  context.damage.parts.forEach((part, index) => {
    if (!part || typeof part !== "object") return;
    const baseFormula = part.formula ?? part[0];
    const formula = getCurrentFormula(context, index, baseFormula);
    if (!formula) return;
    const updated = updateFormula(formula, clValue);
    if (!updated.changed || updated.formula === formula) return;
    overrides.push({
      index,
      isArray: Array.isArray(part),
      formula: updated.formula,
    });
  });

  if (!overrides.length) return false;
  context.damageOverrides ??= { parts: [] };
  context.damageOverrides.parts = [
    ...(context.damageOverrides.parts ?? []),
    ...overrides,
  ];

  if (!context.metamagic) {
    context.metamagic = { applied: [], slotIncrease: 0 };
  }

  if (!context.metamagic.applied.includes(METAMAGIC_DEFINITION.name)) {
    context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
    context.metamagic.slotIncrease += 1;
  }

  return true;
}
