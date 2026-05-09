function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInt(value, { min = 0 } = {}) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const int = Math.floor(number);
  return int >= min ? int : null;
}

function firstFiniteInt(candidates = [], options = {}) {
  for (const value of candidates) {
    const int = finiteInt(value, options);
    if (int !== null) return int;
  }
  return null;
}

function getSpellbookData(actor, item) {
  const spellbookKey = item?.system?.spellbook;
  if (!spellbookKey) return null;
  return actor?.system?.attributes?.spells?.spellbooks?.[spellbookKey] ?? null;
}

export function getRuntimeCasterLevel(actionUse, fallbackItem = null) {
  const action = actionUse?.action ?? actionUse;
  const item = fallbackItem ?? actionUse?.item ?? action?.item ?? null;
  const actor = actionUse?.actor ?? actionUse?.token?.actor ?? item?.actor ?? null;
  const actionRollData = action?.getRollData?.() ?? null;
  const itemRollData = item?.getRollData?.() ?? null;
  const spellbook = getSpellbookData(actor, item);
  return firstFiniteInt([
    actionUse?.shared?.rollData?.cl,
    actionRollData?.cl,
    itemRollData?.cl,
    item?.casterLevel,
    item?.system?.cl,
    spellbook?.cl?.total,
    spellbook?.cl?.autoSpellLevelTotal,
    actor?.getRollData?.()?.cl,
    item?.system?.level
  ], { min: 0 }) ?? 0;
}

export function getRuntimeSpellLevel(actionUse, fallbackItem = null) {
  const action = actionUse?.action ?? actionUse;
  const item = fallbackItem ?? actionUse?.item ?? action?.item ?? null;
  const actionRollData = action?.getRollData?.() ?? null;
  const itemRollData = item?.getRollData?.() ?? null;
  return firstFiniteInt([
    actionUse?.shared?.rollData?.sl,
    actionRollData?.sl,
    itemRollData?.sl,
    item?.spellLevel,
    item?.system?.level
  ], { min: 0 }) ?? 0;
}

export function getStoredBuffCasterLevel(buffItem, actor = null) {
  const itemRollData = buffItem?.getRollData?.() ?? null;
  const owner = actor ?? buffItem?.actor ?? null;
  const spellbook = getSpellbookData(owner, buffItem);
  return firstFiniteInt([
    buffItem?.system?.level,
    itemRollData?.cl,
    buffItem?.casterLevel,
    buffItem?.system?.cl,
    spellbook?.cl?.total,
    spellbook?.cl?.autoSpellLevelTotal,
    owner?.getRollData?.()?.cl
  ], { min: 0 }) ?? 0;
}

export function rollDataWithRuntimeLevels(rollData = {}, { casterLevel = null, spellLevel = null } = {}) {
  const base = rollData && typeof rollData === "object" ? { ...rollData } : {};
  const cl = finiteInt(casterLevel, { min: 0 });
  const sl = finiteInt(spellLevel, { min: 0 });
  if (cl !== null) base.cl = cl;
  if (sl !== null) base.sl = sl;
  return base;
}
