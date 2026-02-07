export const METAMAGIC_DEFINITION = {
  key: "maximizeSpell",
  name: "Maximize Spell",
  prefix: "Maximize",
};

function updateFormula(formula) {
  if (!formula || typeof formula !== "string") return { formula, changed: false };
  const dicePattern =
    /(\([^)]*\)|@cl|clamp\([^)]*\)|min\([^)]*\)|floor\([^)]*\)|\d+)(\s*\)*)\s*d\s*(\d+)/gi;
  let match;
  let lastIndex = 0;
  let updated = "";
  let changed = false;
  while ((match = dicePattern.exec(formula)) !== null) {
    const full = match[0];
    const countExpr = match[1];
    const trailingParens = match[2] ?? "";
    const faces = match[3];
    const combinedExpr = `${countExpr}${trailingParens}`.trim();
    const replacement = `(${combinedExpr} * ${faces})`;
    updated += formula.slice(lastIndex, match.index);
    updated += replacement;
    changed = true;
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

export function applyMaximizeSpell(context) {
  if (!context?.damage?.parts || !Array.isArray(context.damage.parts)) return false;

  const overrides = [];
  context.damage.parts.forEach((part, index) => {
    if (!part || typeof part !== "object") return;
    const baseFormula = part.formula ?? part[0];
    const formula = getCurrentFormula(context, index, baseFormula);
    if (!formula) return;
    const updated = updateFormula(formula);
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
    context.metamagic.slotIncrease += 3;
  }

  return true;
}
