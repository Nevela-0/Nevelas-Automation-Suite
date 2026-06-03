import { MODULE } from '../../../../common/module.js';

export const CONCEALED_CONDITION_ID = "concealed";
export const CONCEALED_VARIANT_FLAG = "concealedVariant"; 
export const CONCEALED_PICKER_NORMAL_ID = `${CONCEALED_CONDITION_ID}:normal`;
export const CONCEALED_PICKER_TOTAL_ID = `${CONCEALED_CONDITION_ID}:total`;
const INVISIBLE_CONDITION_ID = "invisible";

export function actorHasBlindFight(actor) {
  return actor?.items?.some(i => i.type === "feat" && i.name?.toLowerCase() === "blind-fight") ?? false;
}

export function normalizeConcealedVariant(value, fallback = null) {
  const variant = String(value ?? "");
  if (variant === "normal" || variant === "total") return variant;
  return fallback;
}

export function getConcealedVariant(actor) {
  if (!actor) return null;
  for (const ae of actor.effects ?? []) {
    if (!ae?.statuses?.has?.(CONCEALED_CONDITION_ID)) continue;
    const v = ae.getFlag?.(MODULE.ID, CONCEALED_VARIANT_FLAG);
    return (v === "total" || v === "normal") ? v : "normal";
  }
  return null;
}

export function concealedVariantFromApplication(application = {}, fallback = null) {
  return normalizeConcealedVariant(application?.flags?.[MODULE.ID]?.[CONCEALED_VARIANT_FLAG], fallback);
}

export function isConcealedPickerId(id) {
  const value = String(id ?? "").trim();
  return value === CONCEALED_CONDITION_ID || value === CONCEALED_PICKER_NORMAL_ID || value === CONCEALED_PICKER_TOTAL_ID;
}

export function concealedVariantFromPickerId(id, fallback = "normal") {
  const value = String(id ?? "").trim();
  if (value === CONCEALED_PICKER_TOTAL_ID) return "total";
  if (value === CONCEALED_PICKER_NORMAL_ID || value === CONCEALED_CONDITION_ID) return "normal";
  return normalizeConcealedVariant(value, fallback);
}

export function concealedPickerIdForVariant(variant = "normal") {
  return normalizeConcealedVariant(variant, "normal") === "total" ? CONCEALED_PICKER_TOTAL_ID : CONCEALED_PICKER_NORMAL_ID;
}

export function conditionIdFromConcealedPickerId(id) {
  return isConcealedPickerId(id) ? CONCEALED_CONDITION_ID : String(id ?? "").trim();
}

function getLocalizedConditionName() {
  const key = "NAS.conditions.list.concealed.label";
  const t = game?.i18n?.localize?.(key);
  return (t && t !== key) ? t : "Concealed";
}

export function getConcealedPickerLabel(variant = "normal") {
  const normalized = normalizeConcealedVariant(variant, "normal");
  const key = normalized === "total"
    ? "NAS.conditions.main.Concealed50"
    : "NAS.conditions.main.Concealed20";
  const localized = game?.i18n?.localize?.(key);
  if (localized && localized !== key) return localized;
  return `${getLocalizedConditionName()} (${normalized === "total" ? "50%" : "20%"})`;
}

function getVariantLabel(variant) {
  const key = variant === "total"
    ? "NAS.conditions.main.ConcealedTotal"
    : "NAS.conditions.main.ConcealedNormal";
  const t = game?.i18n?.localize?.(key);
  if (t && t !== key) return t;
  return variant === "total" ? "Total" : "Normal";
}

export function concealedEffectNameForVariant(variant = "normal") {
  const normalized = normalizeConcealedVariant(variant, "normal");
  const baseName = getLocalizedConditionName();
  return normalized === "total" ? `${baseName} (${getVariantLabel(normalized)})` : baseName;
}

export function concealedApplicationDataForVariant(variant = "normal") {
  const normalized = normalizeConcealedVariant(variant, "normal");
  return {
    flags: {
      [MODULE.ID]: {
        [CONCEALED_VARIANT_FLAG]: normalized
      }
    }
  };
}

export function concealedEffectDataForVariant(variant = "normal") {
  return {
    name: concealedEffectNameForVariant(variant),
    ...concealedApplicationDataForVariant(variant)
  };
}

export function normalizeConcealedPickerSelectedIds(selectedIds = []) {
  const out = [];
  let concealedVariant = null;
  for (const rawId of Array.isArray(selectedIds) ? selectedIds : []) {
    const id = String(rawId ?? "").trim();
    if (!id) continue;
    if (isConcealedPickerId(id)) {
      const variant = concealedVariantFromPickerId(id, "normal");
      concealedVariant = variant === "total" ? "total" : concealedVariant ?? "normal";
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  if (concealedVariant) out.push(concealedPickerIdForVariant(concealedVariant));
  return out;
}

export function concealedPickerIdFromConditionEffect(effect = {}) {
  if (String(effect?.conditionId ?? "") !== CONCEALED_CONDITION_ID) {
    return String(effect?.conditionId ?? "").trim();
  }
  return concealedPickerIdForVariant(concealedVariantFromApplication(effect?.application, "normal"));
}

async function promptConcealedVariant() {
  return new Promise(resolve => {
    const buttons = {
      normal: {
        label: game.i18n.localize('NAS.conditions.main.ConcealedNormal'),
        callback: () => resolve("normal")
      },
      total: {
        label: game.i18n.localize('NAS.conditions.main.ConcealedTotal'),
        callback: () => resolve("total")
      },
      cancel: {
        label: game.i18n.localize('NAS.common.buttons.cancel') ?? "Cancel",
        callback: () => resolve(null)
      }
    };

    new Dialog({
      title: game.i18n.localize('NAS.conditions.main.ConcealedDialogTitle'),
      content: `<p>${game.i18n.localize('NAS.conditions.list.concealed.description')}</p>`,
      buttons,
      default: "normal"
    }).render(true);
  });
}

function clonePlainObject(value) {
  const fu = globalThis.foundry?.utils;
  if (fu?.getType?.(value) === "Object" && typeof fu.duplicate === "function") {
    return fu.duplicate(value);
  }
  if (value && typeof value === "object") {
    return { ...value };
  }
  return {};
}

function applyConcealedDataToEnabled(enabled, variant) {
  const next = clonePlainObject(enabled);
  const effectData = concealedEffectDataForVariant(variant);
  next.flags ??= {};
  next.flags[MODULE.ID] ??= {};
  next.flags[MODULE.ID][CONCEALED_VARIANT_FLAG] = effectData.flags[MODULE.ID][CONCEALED_VARIANT_FLAG];
  next.name = effectData.name;
  return next;
}

function applyConcealedDataToBuffEffect(item, effectData) {
  if (!effectData || typeof effectData !== "object") return effectData;
  const statuses = Array.from(effectData.statuses ?? []);
  if (!statuses.includes(CONCEALED_CONDITION_ID)) return effectData;
  const variant = normalizeConcealedVariant(item?.getFlag?.(MODULE.ID, CONCEALED_VARIANT_FLAG), "normal");
  const next = clonePlainObject(effectData);
  next.flags ??= {};
  next.flags[MODULE.ID] ??= {};
  next.flags[MODULE.ID][CONCEALED_VARIANT_FLAG] = variant;
  return next;
}

export async function syncActiveBuffConcealedEffectVariant(item) {
  if (item?.type !== "buff" || item?.system?.active !== true) return;
  if (!Array.isArray(item.system?.conditions) || !item.system.conditions.includes(CONCEALED_CONDITION_ID)) return;
  const effect = item.effect;
  if (!effect?.statuses?.has?.(CONCEALED_CONDITION_ID)) return;
  const variant = normalizeConcealedVariant(item.getFlag?.(MODULE.ID, CONCEALED_VARIANT_FLAG), "normal");
  const update = concealedApplicationDataForVariant(variant);
  if (effect.getFlag?.(MODULE.ID, CONCEALED_VARIANT_FLAG) === variant) return;
  await effect.update(update);
}

export function registerConcealedConditionWrappers() {
  if (!game.modules.get("lib-wrapper")?.active) {
    console.warn(`${MODULE.ID} | libWrapper missing; concealed variant prompt disabled.`);
    return;
  }

  libWrapper.register(
    MODULE.ID,
    "pf1.documents.actor.ActorPF.prototype.setCondition",
    async function (wrapped, conditionId, enabled, context) {
      try {
        if (conditionId !== CONCEALED_CONDITION_ID && conditionId !== INVISIBLE_CONDITION_ID) {
          return await wrapped(conditionId, enabled, context);
        }

        if (enabled === false) {
          return await wrapped(conditionId, enabled, context);
        }

        const enabledIsObject = globalThis.foundry?.utils?.getType?.(enabled) === "Object";
        const incoming = enabledIsObject ? enabled : {};

        if (conditionId === INVISIBLE_CONDITION_ID) {
          const next = clonePlainObject(incoming);
          next.flags ??= {};
          next.flags[MODULE.ID] ??= {};
          next.flags[MODULE.ID][CONCEALED_VARIANT_FLAG] = "total";
          return await wrapped(conditionId, next, context);
        }

        const already = incoming?.flags?.[MODULE.ID]?.[CONCEALED_VARIANT_FLAG];
        if (already === "normal" || already === "total") {
          return await wrapped(conditionId, applyConcealedDataToEnabled(incoming, already), context);
        }

        const variant = await promptConcealedVariant();
        if (!variant) {
          const currentState = this?.statuses?.has?.(conditionId) ?? false;
          return await wrapped(conditionId, currentState, context);
        }

        return await wrapped(conditionId, applyConcealedDataToEnabled(incoming, variant), context);
      } catch (err) {
        console.error(`${MODULE.ID} | Concealed condition wrapper failed`, err);
        return await wrapped(conditionId, enabled, context);
      }
    },
    "WRAPPER"
  );

  if (pf1?.documents?.item?.ItemBuffPF?.prototype?.getRawEffectData) {
    libWrapper.register(
      MODULE.ID,
      "pf1.documents.item.ItemBuffPF.prototype.getRawEffectData",
      async function (wrapped, ...args) {
        const effectData = await wrapped(...args);
        try {
          return applyConcealedDataToBuffEffect(this, effectData);
        } catch (err) {
          console.error(`${MODULE.ID} | Failed to prepare concealed buff effect data`, err);
          return effectData;
        }
      },
      "WRAPPER"
    );
  }

  Hooks.on("updateItem", (item) => {
    void syncActiveBuffConcealedEffectVariant(item);
  });
}
