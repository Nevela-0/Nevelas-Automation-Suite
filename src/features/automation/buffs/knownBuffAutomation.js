import { MODULE } from "../../../common/module.js";
import { getStoredBuffCasterLevel } from "../utils/spellLevels.js";

export const KNOWN_BUFF_AUTOMATION_OPTION = "knownBuffAutomation";

const REACTIVE_FLAG_KEY = "itemReactiveEffects";

const SPELL_SOURCES = {
  fireShield: "Compendium.pf1.spells.Item.nfm6i9z9r3n2fku7",
  resistEnergy: "Compendium.pf1.spells.Item.tkjnm3lw7ni82tag",
  resistEnergyCommunal: "Compendium.pf1.spells.Item.ay8nnkkegcb1zfb0",
  protectionFromEnergy: "Compendium.pf1.spells.Item.1vh2ewwvzvxunoxk",
  protectionFromEnergyCommunal: "Compendium.pf1.spells.Item.5l72if837ynbu3gz",
  draconicReservoir: "Compendium.pf1.spells.Item.mjxpdh9jlmr92f1q"
};

const BUFF_SOURCES = {
  resistEnergy: "Compendium.pf-content.pf-buffs.Item.E7bgAFaQDWwPBH8G",
  protectionFromEnergy: "Compendium.pf-content.pf-buffs.Item.p2JgcKLVXMawO3uL",
  protectionFromArrows: "Compendium.pf-content.pf-buffs.Item.Zom7V8sNXZF2ML0M",
  stoneskin: "Compendium.pf-content.pf-buffs.Item.dYMrU01t5FNMgNra",
  draconicReservoir: "Compendium.nevelas-automation-suite.Buffs.Item.OfvCtkK4rj5BuajQ",
  fireShieldCold: "Compendium.pf-content.pf-buffs.Item.yCiDEzWdU6lYzQ8c",
  fireShieldWarm: "Compendium.pf-content.pf-buffs.Item.ho1oC6OgCT4DLVEp",
  firewalkersMeditation: "Compendium.nevelas-automation-suite.Buffs.Item.zEvklJ48nPPzYMhR",
  defendingBone: "Compendium.nevelas-automation-suite.Buffs.Item.PDjIBEROakfxjVbX"
};

const RESIST_PROTECTION_ENERGIES = ["acid", "cold", "electric", "fire", "sonic"];
const DRACONIC_ENERGIES = ["acid", "cold", "electric", "fire"];

const SOURCE_TO_KIND = new Map(Object.entries(BUFF_SOURCES).map(([kind, source]) => [source, kind]));

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function getItemSourceIds(item) {
  if (!item) return [];
  const ids = [
    item.flags?.[MODULE.ID]?.sourceId,
    item._stats?.compendiumSource,
    item.flags?.core?.sourceId,
    String(item.uuid ?? "").startsWith("Compendium.") ? item.uuid : ""
  ];
  return uniqueStrings(ids);
}

export function hasItemSource(item, sourceUuid) {
  return getItemSourceIds(item).includes(sourceUuid);
}

export function normalizeEnergyType(value, { allowed = RESIST_PROTECTION_ENERGIES } = {}) {
  const raw = String(value ?? "").trim().toLowerCase();
  const aliases = {
    electricity: "electric",
    electrical: "electric",
    electric: "electric"
  };
  const normalized = aliases[raw] ?? raw;
  if (allowed.includes(normalized)) return normalized;
  for (const [, damageType] of pf1?.registry?.damageTypes?.entries?.() ?? []) {
    const id = String(damageType?.id ?? "").trim();
    const name = String(damageType?.name ?? "").trim().toLowerCase();
    if (allowed.includes(id) && (normalized === id.toLowerCase() || normalized === name)) return id;
  }
  return "fire";
}

function titleCaseOptionLabel(id, fallback) {
  const text = String(fallback ?? id ?? "").trim();
  if (!text) return "";
  return text.replace(/\p{L}[\p{L}'-]*/gu, (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1));
}

export function energyTypeLabel(id) {
  const normalized = normalizeEnergyType(id, { allowed: RESIST_PROTECTION_ENERGIES });
  for (const [, value] of pf1?.registry?.damageTypes?.entries?.() ?? []) {
    if (String(value?.id ?? "") === normalized) return titleCaseOptionLabel(normalized, value?.name);
  }
  return titleCaseOptionLabel(normalized, normalized);
}

function sourceKindForAction(action) {
  const ids = getItemSourceIds(action?.item);
  if (ids.includes(SPELL_SOURCES.resistEnergy) || ids.includes(SPELL_SOURCES.resistEnergyCommunal)) {
    return "resistProtection";
  }
  if (ids.includes(SPELL_SOURCES.protectionFromEnergy) || ids.includes(SPELL_SOURCES.protectionFromEnergyCommunal)) {
    return "resistProtection";
  }
  if (ids.includes(SPELL_SOURCES.draconicReservoir)) return "draconic";
  return "";
}

export function isKnownEnergyTypePlaceholderBuff(action, buff) {
  const actionKind = sourceKindForAction(action);
  if (actionKind !== "resistProtection") return false;
  const buffKind = knownBuffKind(buff);
  if (buffKind !== "resistEnergy" && buffKind !== "protectionFromEnergy") return false;
  return /\(\s*type\s*\)\s*$/i.test(String(buff?.name ?? buff?.document?.name ?? ""));
}

function energyOptionsForPrompt(kind) {
  const allowed = kind === "draconic" ? DRACONIC_ENERGIES : RESIST_PROTECTION_ENERGIES;
  return allowed.map((id) => ({ id, label: energyTypeLabel(id) }));
}

export async function promptKnownBuffAutomationForAction(action) {
  const kind = sourceKindForAction(action);
  if (!kind) return undefined;
  const options = energyOptionsForPrompt(kind);
  const title = game.i18n.localize("NAS.buffs.SelectEnergyType") || "Select Energy Type";
  const content = `
    <form>
      <div class="form-group">
        <label>${foundry.utils.escapeHTML(title)}</label>
        <div class="form-fields">
          <select name="energyType">
            ${options.map((option) => `<option value="${option.id}" ${option.id === "fire" ? "selected" : ""}>${foundry.utils.escapeHTML(option.label)}</option>`).join("")}
          </select>
        </div>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    new Dialog({
      title,
      content,
      buttons: {
        apply: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize("NAS.buffs.ApplyBuff") || "Apply Buff",
          callback: (html) => {
            const select = typeof html.find === "function" ? html.find('[name="energyType"]') : html.querySelector?.('[name="energyType"]');
            const raw = select?.val?.() ?? select?.value ?? "fire";
            resolve({
              energyType: normalizeEnergyType(raw, { allowed: kind === "draconic" ? DRACONIC_ENERGIES : RESIST_PROTECTION_ENERGIES })
            });
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize("Cancel"),
          callback: () => resolve(null)
        }
      },
      default: "apply",
      close: () => resolve(null)
    }).render(true);
  });
}

function knownBuffKindFromSourceIds(sourceIds = []) {
  for (const source of sourceIds) {
    const kind = SOURCE_TO_KIND.get(source);
    if (kind) return kind;
  }
  return "";
}

function knownBuffKind(buffOrItem) {
  const sourceIds = getItemSourceIds(buffOrItem?.document ?? buffOrItem);
  return knownBuffKindFromSourceIds(sourceIds);
}

function energyFromName(name, allowed) {
  const match = String(name ?? "").match(/\(([^)]+)\)\s*$/);
  return match ? normalizeEnergyType(match[1], { allowed }) : "";
}

function energyChoiceFromOptions(options = {}, allowed = RESIST_PROTECTION_ENERGIES, item = null) {
  const explicit = options?.[KNOWN_BUFF_AUTOMATION_OPTION]?.energyType;
  if (explicit) return normalizeEnergyType(explicit, { allowed });
  const flags = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY] ?? {};
  const absorptionEnergy = flags?.absorption?.energyType;
  if (absorptionEnergy) return normalizeEnergyType(absorptionEnergy, { allowed });
  const grantedTypes = flags?.grantedDefenses?.eres?.value?.[0]?.types;
  const grantedEnergy = Array.isArray(grantedTypes) ? grantedTypes[0] : "";
  if (grantedEnergy) return normalizeEnergyType(grantedEnergy, { allowed });
  const namedEnergy = energyFromName(item?.name, allowed);
  if (namedEnergy) return namedEnergy;
  return "fire";
}

function replaceTypeSuffix(name, energyType) {
  const label = energyTypeLabel(energyType);
  const text = String(name ?? "").trim();
  if (!text) return text;
  if (/\(\s*type\s*\)/i.test(text)) return text.replace(/\(\s*type\s*\)/i, `(${label})`);
  return text;
}

export function getKnownBuffApplicationName(buff, options = {}) {
  const kind = knownBuffKind(buff);
  if (kind === "resistEnergy" || kind === "protectionFromEnergy") {
    return replaceTypeSuffix(buff?.name ?? buff?.document?.name, energyChoiceFromOptions(options, RESIST_PROTECTION_ENERGIES, buff?.document ?? buff));
  }
  return buff?.name ?? buff?.document?.name ?? "";
}

function casterLevelNumber(casterLevel, item) {
  const candidates = [
    casterLevel,
    getStoredBuffCasterLevel(item),
    item?.getRollData?.()?.cl,
    item?.actor?.getRollData?.()?.cl
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return 0;
}

function resistEnergyAmount(casterLevel) {
  const cl = Number(casterLevel) || 0;
  if (cl >= 11) return 30;
  if (cl >= 7) return 20;
  return 10;
}

function grantedEnergyResistanceConfig(energyType, amount) {
  return {
    enabled: true,
    dr: { value: [], custom: "" },
    eres: {
      value: [{
        id: "known-resist-energy",
        amount,
        types: [energyType],
        operator: true,
        stackable: false
      }],
      custom: ""
    },
    di: [],
    ci: [],
    dv: []
  };
}

function absorptionPresetConfig(preset, energyType = "fire") {
  const totals = {
    protectionFromArrows: ["min(100, 10 * @cl)", "10"],
    protectionFromEnergy: ["min(120, 12 * @cl)", "min(120, 12 * @cl)"],
    draconicReservoir: ["min(60, 6 * @cl)", "min(60, 6 * @cl)"],
    stoneskin: ["min(150, 10 * @cl)", "10"],
    defendingBone: ["min(50, 5 * @cl)", "5"],
    firewalkersMeditation: ["min(100, 10 * @cl)", "10"]
  };
  const [totalFormula, perAttackFormula] = totals[preset] ?? totals.protectionFromArrows;
  return {
    enabled: true,
    preset,
    energyType,
    totalFormula,
    perAttackFormula,
    remaining: null,
    capacity: null,
    dischargeAtZero: true,
    showBadge: true,
    showHpBar: true,
    message: true,
    rules: []
  };
}

function fireShieldAbsorptionConfig(opposingEnergy) {
  return {
    enabled: true,
    preset: "custom",
    energyType: opposingEnergy,
    totalFormula: "",
    perAttackFormula: "floor(@nas.finalDamage / 2)",
    remaining: null,
    capacity: null,
    dischargeAtZero: false,
    showBadge: false,
    showHpBar: false,
    message: true,
    rules: [{
      damageKind: "any",
      sourceKind: "anyAttack",
      damageTypeIds: [opposingEnergy],
      includeUntyped: false,
      action: "reduce",
      amountFormula: "floor(@nas.finalDamage / 2)",
      defenseKind: "er",
      reductionBypassTypes: [opposingEnergy],
      spendPool: false
    }]
  };
}

function fireShieldOnStruckConfig(retaliationEnergy, casterLevel) {
  const bonus = Math.max(0, Math.min(15, Number(casterLevel) || 0));
  return {
    enabled: true,
    onStruckFunction: "damageAttacker",
    effects: [],
    rules: [{
      id: "known-fire-shield",
      enabled: true,
      mode: "formula",
      value: 0,
      formula: bonus > 0 ? `1d6 + ${bonus}` : "1d6",
      damageType: retaliationEnergy,
      damageTypes: [retaliationEnergy],
      sourceKind: "anyMelee",
      onlyIfDamaged: false,
      attackerCreatureKind: "any",
      save: {
        enabled: false,
        type: "ref",
        dcFormula: "",
        skipDialog: false,
        onSuccess: "negates",
        effects: {
          success: { effectKind: "none", buffUuid: "", conditionId: "" },
          failure: { effectKind: "none", buffUuid: "", conditionId: "" }
        }
      },
      spendPool: false,
      message: true
    }],
    pool: {
      enabled: false,
      totalFormula: "",
      remaining: null,
      capacity: null,
      dischargeAtZero: false,
      showBadge: false
    },
    buffRows: [],
    conditionRows: [],
    message: true
  };
}

function setFlagUpdate(updates, key, value) {
  updates[`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.${key}`] = {
    ...value,
    nasKnownBuffPreset: true
  };
}

function buildKnownBuffUpdates(item, options = {}) {
  const kind = knownBuffKind(item);
  if (!kind) return null;
  const updates = {};
  const cl = casterLevelNumber(options.casterLevel, item);

  if (kind === "resistEnergy") {
    const energyType = energyChoiceFromOptions(options, RESIST_PROTECTION_ENERGIES, item);
    updates.name = replaceTypeSuffix(item.name, energyType);
    setFlagUpdate(updates, "grantedDefenses", grantedEnergyResistanceConfig(energyType, resistEnergyAmount(cl)));
    return updates;
  }

  if (kind === "protectionFromEnergy") {
    const energyType = energyChoiceFromOptions(options, RESIST_PROTECTION_ENERGIES, item);
    updates.name = replaceTypeSuffix(item.name, energyType);
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("protectionFromEnergy", energyType));
    return updates;
  }

  if (kind === "draconicReservoir") {
    const energyType = energyChoiceFromOptions(options, DRACONIC_ENERGIES, item);
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("draconicReservoir", energyType));
    return updates;
  }

  if (kind === "protectionFromArrows") {
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("protectionFromArrows"));
    return updates;
  }

  if (kind === "stoneskin") {
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("stoneskin"));
    return updates;
  }

  if (kind === "firewalkersMeditation") {
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("firewalkersMeditation"));
    return updates;
  }

  if (kind === "defendingBone") {
    setFlagUpdate(updates, "absorption", absorptionPresetConfig("defendingBone"));
    return updates;
  }

  if (kind === "fireShieldCold") {
    setFlagUpdate(updates, "onStruck", fireShieldOnStruckConfig("cold", cl));
    setFlagUpdate(updates, "absorption", fireShieldAbsorptionConfig("fire"));
    return updates;
  }

  if (kind === "fireShieldWarm") {
    setFlagUpdate(updates, "onStruck", fireShieldOnStruckConfig("fire", cl));
    setFlagUpdate(updates, "absorption", fireShieldAbsorptionConfig("cold"));
    return updates;
  }

  return null;
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function getPropertyByDottedPath(source, path) {
  return path.split(".").reduce((value, part) => value?.[part], source);
}

function updateChangesItem(item, updates) {
  for (const [path, value] of Object.entries(updates ?? {})) {
    if (path === "name") {
      if (String(item?.name ?? "") !== String(value ?? "")) return true;
      continue;
    }
    if (!sameValue(getPropertyByDottedPath(item, path), value)) return true;
  }
  return false;
}

export async function configureKnownBuffAutomation(item, options = {}) {
  if (!item || item.type !== "buff") return false;
  const updates = buildKnownBuffUpdates(item, options);
  if (!updates || !Object.keys(updates).length) return false;

  const sourceId = getItemSourceIds(item).find((id) => SOURCE_TO_KIND.has(id));
  if (sourceId && !item.flags?.[MODULE.ID]?.sourceId) {
    updates[`flags.${MODULE.ID}.sourceId`] = sourceId;
  }

  if (!updateChangesItem(item, updates)) return false;
  await item.update(updates, { render: false });
  return true;
}

export function hasKnownBuffAutomationSource(item) {
  return Boolean(knownBuffKind(item));
}
