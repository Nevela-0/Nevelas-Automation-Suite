export const METAMAGIC_DEFINITION = {
  key: "extendSpell",
  name: "Extend Spell",
  prefix: "Extend",
};

export function applyExtendSpell(context) {
  if (!context?.duration) return false;

  const units = (context.duration.units ?? "").toString().toLowerCase();
  if (context.duration.concentration) return false;
  if (units === "inst" || units === "instantaneous" || units === "perm" || units === "permanent") {
    return false;
  }

  const baseTotal = Number(context.duration.evaluated?.total ?? 0);
  const extendedTotal = baseTotal * 2;
  context.duration.value = Number.isFinite(extendedTotal) ? String(extendedTotal) : context.duration.value;
  context.duration.evaluated = {
    ...(context.duration.evaluated ?? {}),
    total: Number.isFinite(extendedTotal) ? extendedTotal : baseTotal,
  };

  if (!context.metamagic) {
    context.metamagic = { applied: [], slotIncrease: 0 };
  }

  if (!context.metamagic.applied.includes(METAMAGIC_DEFINITION.name)) {
    context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
    context.metamagic.slotIncrease += 1;
  }

  return true;
}
