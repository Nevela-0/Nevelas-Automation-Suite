import {
  getRuntimeCasterLevel,
  getRuntimeSpellLevel,
  rollDataWithRuntimeLevels,
} from "./spellLevels.js";

export function refreshSpellSaveDc(action, context) {
  if (!Number.isFinite(context?.save?.nativeDc) || typeof action?.action?.getDC !== "function") return;
  const dc = action.action.getDC(action.shared?.rollData ?? {});
  if (!Number.isFinite(dc)) return;
  context.save.dc += dc - context.save.nativeDc;
  context.save.nativeDc = dc;
  context.save.evaluated = { raw: context.save.dc, total: context.save.dc };
}

async function evaluateFormula(rawValue, rollData) {
  const value = rawValue ?? "";
  if (value === "" || value === null || value === undefined) {
    return { raw: "", total: 0 };
  }

  try {
    const roll = await new Roll(value, rollData).evaluate({ async: true });
    const total = roll?.total;
    return { raw: value, total };
  } catch (error) {
    const numericFallback = Number(value);
    return { raw: value, total: Number.isNaN(numericFallback) ? 0 : numericFallback };
  }
}

function buildComponentsData(action) {
  const actionComponents = action.action?.components ?? {};
  const itemComponents = action.item?.system?.components ?? {};

  return {
    value: actionComponents.value ?? itemComponents.value ?? "",
    verbal: actionComponents.verbal ?? itemComponents.verbal ?? false,
    somatic: actionComponents.somatic ?? itemComponents.somatic ?? false,
    thought: actionComponents.thought ?? itemComponents.thought ?? false,
    emotion: actionComponents.emotion ?? itemComponents.emotion ?? false,
    material: actionComponents.material ?? itemComponents.material ?? false,
    focus: actionComponents.focus ?? itemComponents.focus ?? false,
    divineFocus: actionComponents.divineFocus ?? itemComponents.divineFocus ?? 0,
  };
}

function buildActivationData(action) {
  const activation = action.action?.activation ?? action.item?.system?.activation ?? {};
  return {
    cost: activation.cost ?? 0,
    type: activation.type ?? "",
    unchained: {
      cost: activation.unchained?.cost ?? 0,
      type: activation.unchained?.type ?? "",
    },
  };
}

function buildAlignmentData(action) {
  const itemAlignments = action.item?.system?.alignments ?? {};
  const actionAlignments = action.action?.alignments ?? {};

  const keys = ["lawful", "chaotic", "good", "evil"];
  const resolved = {};
  keys.forEach((key) => {
    const override = actionAlignments[key];
    resolved[key] = typeof override === "boolean" ? override : Boolean(itemAlignments[key]);
  });

  return {
    item: {
      lawful: Boolean(itemAlignments.lawful),
      chaotic: Boolean(itemAlignments.chaotic),
      good: Boolean(itemAlignments.good),
      evil: Boolean(itemAlignments.evil),
    },
    action: {
      lawful: actionAlignments.lawful ?? null,
      chaotic: actionAlignments.chaotic ?? null,
      good: actionAlignments.good ?? null,
      evil: actionAlignments.evil ?? null,
    },
    resolved,
  };
}

function parseMetamagicNames(formData) {
  const raw = formData?.metamagicNames;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMetamagicSources(formData) {
  const raw = formData?.metamagicSources;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((source) => ({
      type: (source?.type ?? "").toString(),
      itemUuid: (source?.itemUuid ?? "").toString(),
      metamagicName: (source?.metamagicName ?? "").toString()
    })).filter((source) => source.metamagicName);
  } catch {
    return [];
  }
}

function parseMetamagicOptions(formData) {
  const raw = formData?.metamagicOptions;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseTraitOptions(formData) {
  const raw = formData?.traitOptions;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => `${value}`).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseFeatOptions(formData) {
  const raw = formData?.featOptions;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function refreshSpellCasterLevelData(action, context) {
  if (!context) return false;
  const casterLevel = getRuntimeCasterLevel(action);
  if (context.casterLevel === casterLevel) return false;
  const rollData = rollDataWithRuntimeLevels(action.shared?.rollData ?? {}, {
    casterLevel,
    spellLevel: context.spellLevel?.effective ?? getRuntimeSpellLevel(action),
  });
  context.casterLevel = casterLevel;

  const dependsOnCl = value => typeof value === "string" && /@cl\b/.test(value);
  if (dependsOnCl(context.duration?.value)) {
    context.duration.evaluated = await evaluateFormula(context.duration.value, rollData);
  }
  for (const key of ["value", "minValue"]) {
    const formula = context.range?.range?.[key];
    if (!dependsOnCl(formula)) continue;
    context.range.evaluated ??= {};
    context.range.evaluated[key] = await evaluateFormula(formula, rollData);
  }
  if (Number.isFinite(context.save?.nativeDc)) {
    refreshSpellSaveDc(action, context);
  } else if (dependsOnCl(context.save?.dc)) {
    context.save.evaluated = await evaluateFormula(context.save.dc, rollData);
  }
  return true;
}

export async function collectSpellActionData(action) {
  const casterLevel = getRuntimeCasterLevel(action);
  const effectiveSpellLevel = getRuntimeSpellLevel(action);
  const rollData = rollDataWithRuntimeLevels(action.shared?.rollData ?? {}, {
    casterLevel,
    spellLevel: effectiveSpellLevel,
  });
  const duration = (action.action?.duration ?? action.item?.system?.duration ?? {});
  const durationEval = await evaluateFormula(duration.value, rollData);

  const range = action.action?.range ?? action.item?.system?.range ?? {};
  const rangeValueEval = await evaluateFormula(range.value, rollData);
  const rangeMinValueEval = await evaluateFormula(range.minValue, rollData);

  const save = action.action?.save ?? action.item?.system?.save ?? {};

  const nativeDc = typeof action.action?.getDC === "function" ? action.action.getDC(rollData) : null;
  const saveDc = Number.isFinite(nativeDc) ? nativeDc : save.dc ?? "";
  const saveDcEval = Number.isFinite(nativeDc)
    ? { raw: saveDc, total: saveDc }
    : await evaluateFormula(saveDc, rollData);

  const areaString = action.action?.area;
  const measureTemplateEnabled = action.formData && action.formData["measure-template"];
  const templateSize = Number(action.action?.measureTemplate?.size || 0);
  const isAreaOfEffect = !!areaString || (measureTemplateEnabled && templateSize > 5);

  const metamagicNames = parseMetamagicNames(action.formData);
  const metamagicSources = parseMetamagicSources(action.formData);
  const metamagicOptions = parseMetamagicOptions(action.formData);
  return {
    actor: action.actor ?? action.token?.actor ?? null,
    item: action.item ?? null,
    formData: action.formData ?? {},
    metamagicNames,
    metamagicSources,
    metamagicOptions,
    traitOptions: parseTraitOptions(action.formData),
    featOptions: parseFeatOptions(action.formData),
    casterLevel,
    spellLevel: {
      original: effectiveSpellLevel,
      effective: effectiveSpellLevel,
    },
    duration: {
      value: duration.value ?? "",
      units: duration.units ?? "",
      dismiss: Boolean(duration.dismiss),
      concentration: Boolean(duration.concentration),
      evaluated: durationEval,
    },
    components: buildComponentsData(action),
    activation: buildActivationData(action),
    range: {
      touch: Boolean(action.action?.touch),
      hasRange: Boolean(action.action?.hasRange),
      isRanged: Boolean(action.action?.isRanged),
      range: {
        value: range.value ?? "",
        minUnits: range.minUnits ?? "",
        minValue: range.minValue ?? "",
        units: range.units ?? "",
        maxIncrements: range.maxIncrements ?? 1,
      },
      evaluated: {
        value: rangeValueEval,
        minValue: rangeMinValueEval,
      },
    },
    save: {
      dc: saveDc,
      nativeDc,
      type: save.type ?? "",
      description: save.description ?? "",
      harmless: Boolean(save.harmless),
      evaluated: saveDcEval,
    },
    damage: {
      hasDamage: Boolean(action.item?.hasDamage),
      parts: action.action?.damage?.parts ?? [],
      critParts: action.action?.damage?.critParts ?? [],
      nonCritParts: action.action?.damage?.nonCritParts ?? [],
    },
    alignments: buildAlignmentData(action),
    area: {
      areaString,
      measureTemplateEnabled: Boolean(measureTemplateEnabled),
      templateSize,
      isAreaOfEffect,
    },
    measureTemplate: {
      type: action.action?.measureTemplate?.type ?? "",
      size: action.action?.measureTemplate?.size ?? "",
    },
    attacks: {
      hasAttack: Boolean(action.item?.hasAttack),
    },
    actionType: action.action?.actionType ?? "",
  };
}
