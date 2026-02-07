export const METAMAGIC_DEFINITION = {
  key: "silentSpell",
  name: "Silent Spell",
  prefix: "Silent",
};

export function applySilentSpell(context) {
  if (!context?.components) return;

  if (context.components.verbal === true) {
    context.components.verbal = false;
  }

  if (!context.metamagic) {
    context.metamagic = { applied: [], slotIncrease: 0 };
  }

  if (!context.metamagic.applied.includes(METAMAGIC_DEFINITION.name)) {
    context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
    context.metamagic.slotIncrease += 1;
  }
}
