export const ABSORPTION_PRESET_IDS = new Set([
  "custom",
  "ablativeBarrier",
  "protectionFromArrows",
  "protectionFromEnergy",
  "draconicReservoir",
  "stoneskin",
  "defendingBone",
  "firewalkersMeditation"
]);

const PHYSICAL_DAMAGE_TYPES = ["bludgeoning", "piercing", "slashing"];
const STANDARD_ENERGY_TYPES = ["acid", "cold", "electric", "fire", "sonic"];
const DRACONIC_ENERGY_TYPES = ["acid", "cold", "electric", "fire"];

export function absorptionPresetUsesEnergyType(preset) {
  return preset === "protectionFromEnergy" || preset === "draconicReservoir";
}

export function getAbsorptionPresetEnergyOptions(preset) {
  return preset === "draconicReservoir" ? DRACONIC_ENERGY_TYPES : STANDARD_ENERGY_TYPES;
}

export function normalizeAbsorptionPresetId(value) {
  const preset = String(value ?? "");
  return ABSORPTION_PRESET_IDS.has(preset) ? preset : "ablativeBarrier";
}

export function normalizeAbsorptionPresetEnergyType(preset, value) {
  const allowed = getAbsorptionPresetEnergyOptions(preset);
  const raw = String(value ?? "").trim();
  const energyType = raw === "electricity" ? "electric" : raw;
  return allowed.includes(energyType) ? energyType : "fire";
}

export function absorptionPresetDefaults(preset, raw = {}) {
  const id = normalizeAbsorptionPresetId(preset);
  const energyType = normalizeAbsorptionPresetEnergyType(id, raw?.energyType);
  if (id === "protectionFromArrows") return { totalFormula: "min(100, 10 * @cl)", perAttackFormula: "10", energyType };
  if (id === "protectionFromEnergy") return { totalFormula: "min(120, 12 * @cl)", perAttackFormula: "min(120, 12 * @cl)", energyType };
  if (id === "draconicReservoir") return { totalFormula: "min(60, 6 * @cl)", perAttackFormula: "min(60, 6 * @cl)", energyType };
  if (id === "stoneskin") return { totalFormula: "min(150, 10 * @cl)", perAttackFormula: "10", energyType };
  if (id === "defendingBone") return { totalFormula: "min(50, 5 * @cl)", perAttackFormula: "5", energyType };
  if (id === "firewalkersMeditation") return { totalFormula: "min(100, 10 * @cl)", perAttackFormula: "10", energyType };
  return { totalFormula: "min(50, 5 * @cl)", perAttackFormula: "5", energyType };
}

export function absorptionPresetRules(preset, perAttackFormula, raw = {}) {
  const id = normalizeAbsorptionPresetId(preset);
  const energyType = normalizeAbsorptionPresetEnergyType(id, raw?.energyType);
  if (id === "protectionFromArrows") {
    return [{
      damageKind: "any",
      sourceKind: "rangedWeapon",
      damageTypeIds: [...PHYSICAL_DAMAGE_TYPES],
      includeUntyped: false,
      action: "reduce",
      amountFormula: perAttackFormula || "10",
      defenseKind: "dr",
      reductionBypassTypes: ["magic"],
      spendPool: true
    }];
  }
  if (id === "protectionFromEnergy" || id === "draconicReservoir") {
    return [{
      damageKind: "any",
      sourceKind: "anyAttack",
      damageTypeIds: [energyType],
      includeUntyped: false,
      action: "reduce",
      amountFormula: perAttackFormula || absorptionPresetDefaults(id, raw).perAttackFormula,
      defenseKind: "er",
      reductionBypassTypes: [energyType],
      spendPool: true
    }];
  }
  if (id === "stoneskin") {
    return [{
      damageKind: "any",
      sourceKind: "weapon",
      damageTypeIds: [...PHYSICAL_DAMAGE_TYPES],
      includeUntyped: false,
      action: "reduce",
      amountFormula: perAttackFormula || "10",
      defenseKind: "dr",
      reductionBypassTypes: ["adamantine"],
      spendPool: true
    }];
  }
  if (id === "defendingBone") {
    return [{
      damageKind: "any",
      sourceKind: "anyAttack",
      damageTypeIds: [...PHYSICAL_DAMAGE_TYPES],
      includeUntyped: false,
      action: "reduce",
      amountFormula: perAttackFormula || "5",
      defenseKind: "dr",
      reductionBypassTypes: ["bludgeoning"],
      spendPool: true,
      requiresNoOtherDr: true
    }];
  }
  if (id === "firewalkersMeditation") {
    return [{
      damageKind: "any",
      sourceKind: "anyAttack",
      damageTypeIds: [...PHYSICAL_DAMAGE_TYPES],
      includeUntyped: false,
      action: "reduce",
      amountFormula: "5",
      defenseKind: "dr",
      reductionBypassTypes: ["magic"],
      spendPool: true,
      showAsGrantedDefense: true
    }, {
      damageKind: "any",
      sourceKind: "anyAttack",
      damageTypeIds: ["fire"],
      includeUntyped: false,
      action: "reduce",
      amountFormula: perAttackFormula || "10",
      defenseKind: "er",
      reductionBypassTypes: ["fire"],
      spendPool: true,
      showAsGrantedDefense: true
    }];
  }
  return [{
    damageKind: "lethal",
    sourceKind: "anyAttack",
    damageTypeIds: [],
    includeUntyped: true,
    action: "convertToNonlethal",
    amountFormula: perAttackFormula || "5",
    spendPool: true
  }, {
    damageKind: "nonlethal",
    sourceKind: "anyAttack",
    damageTypeIds: [],
    includeUntyped: true,
    action: "reduce",
    amountFormula: perAttackFormula || "5",
    defenseKind: "dr",
    reductionBypassTypes: ["-"],
    spendPool: false
  }];
}
