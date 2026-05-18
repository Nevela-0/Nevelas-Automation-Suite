import {
  getGeneratedPreparedSpellItemFlag,
  isGeneratedPreparedSpellItem
} from "./preparedItems.js";

const MAX_SPELL_LEVEL = 9;

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return Math.max(0, Math.trunc(Number(fallback) || 0));
  return Math.max(0, Math.trunc(number));
}

function toSpellLevel(value, fallback = 0) {
  return Math.min(MAX_SPELL_LEVEL, toNonNegativeInteger(value, fallback));
}

function getActionActor(actionUse) {
  return actionUse?.actor ?? actionUse?.token?.actor ?? actionUse?.item?.actor ?? null;
}

function getSpellbookData(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!actor || !normalizedBookId) return null;
  return actor.system?.attributes?.spells?.spellbooks?.[normalizedBookId] ?? null;
}

function isHybridSpellbook(spellbookData) {
  const mode = normalizeId(spellbookData?.spellPreparationMode).toLowerCase();
  return mode === "hybrid" || (spellbookData?.prepared === true && spellbookData?.spontaneous === true);
}

function usesSpellPoints(spellbookData) {
  return spellbookData?.spellPoints?.useSystem === true || spellbookData?.spellPoints?.use === true;
}

function getPreparationValue(item) {
  return toNonNegativeInteger(item?.system?.preparation?.value, 0);
}

function getSpellLevelData(actor, bookId, targetSlotLevel) {
  const spellbookData = getSpellbookData(actor, bookId);
  const spellLevelKey = `spell${targetSlotLevel}`;
  return {
    spellbookData,
    spellLevelKey,
    spellLevelData: spellbookData?.spells?.[spellLevelKey] ?? null
  };
}

function getPreparedSpellFlag(actionUse, context) {
  if (context?.spellbookPreparedSpell?.generated === true) return context.spellbookPreparedSpell;
  const item = actionUse?.item ?? null;
  return getGeneratedPreparedSpellItemFlag(item);
}

export function getPreparedVariantConsumptionState(actionUse, context, { includeDefaultTarget = false } = {}) {
  const item = actionUse?.item ?? null;
  const flag = getPreparedSpellFlag(actionUse, context);
  if (!item || item.type !== "spell") return { eligible: false, reason: "not a spell item" };
  if (!isGeneratedPreparedSpellItem(item) || flag?.generated !== true) {
    return { eligible: false, reason: "not a generated prepared spell" };
  }
  if (item.system?.atWill === true) return { eligible: false, reason: "at-will spell" };

  const actor = getActionActor(actionUse);
  const bookId = normalizeId(flag.spellbookId ?? item.system?.spellbook);
  const spellbookData = getSpellbookData(actor, bookId);
  if (!actor || !bookId || !spellbookData) return { eligible: false, reason: "missing spellbook data" };
  if (!isHybridSpellbook(spellbookData)) return { eligible: false, reason: "not a hybrid spellbook" };
  if (usesSpellPoints(spellbookData)) return { eligible: false, reason: "spell points are handled by PF1" };

  const originalSpellLevel = toSpellLevel(flag.originalSpellLevel ?? item.system?.level ?? 0, 0);
  const preparedSlotLevel = toSpellLevel(flag.preparedSlotLevel ?? originalSpellLevel, originalSpellLevel);
  const itemSpellLevel = toSpellLevel(item.system?.level ?? originalSpellLevel, originalSpellLevel);
  const dynamicConsumedSlotIncrease = toNonNegativeInteger(
    context?.metamagic?.consumedSlotIncrease
      ?? context?.metamagic?.dynamicConsumedSlotIncrease
      ?? 0,
    0
  );
  const targetSlotLevel = preparedSlotLevel + dynamicConsumedSlotIncrease;
  const needsBridge = targetSlotLevel !== itemSpellLevel
    || context?.metamagic?.preparedSpellbookHigherSlotConsumptionDeferred === true;

  if (!includeDefaultTarget && !needsBridge) {
    return {
      eligible: false,
      reason: "PF1 already targets the desired spell level",
      actor,
      item,
      bookId,
      spellbookData,
      originalSpellLevel,
      preparedSlotLevel,
      itemSpellLevel,
      dynamicConsumedSlotIncrease,
      targetSlotLevel
    };
  }

  const { spellLevelKey, spellLevelData } = getSpellLevelData(actor, bookId, targetSlotLevel);
  return {
    eligible: true,
    actor,
    item,
    flag,
    bookId,
    spellbookData,
    spellLevelKey,
    spellLevelData,
    originalSpellLevel,
    preparedSlotLevel,
    itemSpellLevel,
    dynamicConsumedSlotIncrease,
    targetSlotLevel,
    preparationValue: getPreparationValue(item),
    hasTargetPool: Boolean(spellLevelData)
  };
}

export function shouldDeferPreparedVariantHigherSlotConsumption(actionUse, context) {
  const state = getPreparedVariantConsumptionState(actionUse, context, { includeDefaultTarget: true });
  return state.eligible === true;
}

function setOwnMethod(item, methodName, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(item, methodName);
  const hadOwnDescriptor = descriptor !== undefined;
  Object.defineProperty(item, methodName, {
    configurable: true,
    writable: true,
    value: fn
  });
  return () => {
    if (hadOwnDescriptor) {
      Object.defineProperty(item, methodName, descriptor);
    } else {
      delete item[methodName];
    }
  };
}

function buildPreparedConsumptionSnapshot(state) {
  return {
    mode: "hybrid",
    spellbookId: state.bookId,
    originalSpellLevel: state.originalSpellLevel,
    itemSpellLevel: state.itemSpellLevel,
    preparedSlotLevel: state.preparedSlotLevel,
    dynamicConsumedSlotIncrease: state.dynamicConsumedSlotIncrease,
    targetSlotLevel: state.targetSlotLevel,
    spellLevelKey: state.spellLevelKey,
    hasTargetPool: state.hasTargetPool,
    preparationValue: state.preparationValue
  };
}

export function installPreparedVariantConsumptionOverrides(actionUse, context) {
  const state = getPreparedVariantConsumptionState(actionUse, context);
  if (state.eligible !== true) return () => {};

  const restoreGetSpellUses = setOwnMethod(state.item, "getSpellUses", function getNasPreparedSpellUses(max = false) {
    const preparationValue = getPreparationValue(this);
    if (preparationValue <= 0) return 0;

    const { spellLevelData } = getSpellLevelData(state.actor, state.bookId, state.targetSlotLevel);
    if (!spellLevelData) return 0;

    if (max) {
      const maximum = Number(spellLevelData.max ?? 0);
      return Math.max(Number.isFinite(maximum) ? maximum : 0, preparationValue);
    }

    const value = Number(spellLevelData.value ?? 0);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });

  const restoreAddCharges = setOwnMethod(state.item, "addCharges", async function addNasPreparedSpellCharges(delta) {
    const amount = Number(delta ?? 0);
    if (!Number.isFinite(amount) || amount === 0) return this;

    const { spellLevelKey, spellLevelData } = getSpellLevelData(state.actor, state.bookId, state.targetSlotLevel);
    if (!spellLevelData) return this;

    const current = Number(spellLevelData.value ?? 0);
    const nextValue = Math.max(0, (Number.isFinite(current) ? current : 0) + amount);
    const updatePath = `system.attributes.spells.spellbooks.${state.bookId}.spells.${spellLevelKey}.value`;
    await state.actor.update({
      [updatePath]: nextValue
    }, {
      nasSpellbookPreparation: true,
      pf1: { action: "spellbookPreparedSpellConsumption" }
    });

    return this;
  });

  context.spellbookPreparedSpell ??= {};
  context.spellbookPreparedSpell.consumption = buildPreparedConsumptionSnapshot(state);
  context.metamagic ??= {};
  context.metamagic.preparedSpellbookConsumption = buildPreparedConsumptionSnapshot(state);

  return () => {
    restoreAddCharges();
    restoreGetSpellUses();
  };
}
