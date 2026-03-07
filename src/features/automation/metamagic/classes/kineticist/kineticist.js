import { resolveEnglishName } from "../../../utils/compendiumNameResolver.js";
import { resolveMetamagicNameFromDatabase } from "../../metamagic.js";

const METAKINESIS_COMPENDIUM_SOURCE = "Compendium.pf1.class-abilities.Item.2Od2zrFivfso93Iz";
const METAKINESIS_ENGLISH_NAME = "Metakinesis";

const EXPANDED_METAKINESIS_COMPENDIUM_SOURCE = "Compendium.pf-content.pf-feats.Item.PYzWKRPLbVjccqY8";
const EXPANDED_METAKINESIS_ENGLISH_NAME = "Expanded Metakinesis";

const METAMAGIC_INVOCATION_COMPENDIUM_SOURCE = "Compendium.pf-content.pf-feats.Item.H9WiCQ2l7em8fwHY";
const METAMAGIC_INVOCATION_ENGLISH_NAME = "Metamagic Invocation";

const KINETIC_INVOCATION_COMPENDIUM_SOURCE = "Compendium.pf-content.pf-feats.Item.BrWYYYDVVs2qe1vg";
const KINETIC_INVOCATION_ENGLISH_NAME = "Kinetic Invocation";

function isEnglishLanguage() {
  return (game?.i18n?.lang ?? "en").toLowerCase().startsWith("en");
}

function isFeatItem(item) {
  const subType = item?.subType ?? item?.system?.subType;
  return item?.type === "feat" && (subType === "feat" || subType === "classFeat");
}

function getBabeleOriginalName(item) {
  const direct = item?.flags?.babele?.originalName;
  const canUseBabele = game?.modules?.get?.("babele")?.active === true;
  const hasGetFlag = canUseBabele && typeof item?.getFlag === "function";

  let viaGetFlag = null;
  try {
    viaGetFlag = hasGetFlag ? item.getFlag("babele", "originalName") : null;
  } catch (_err) {
    viaGetFlag = null;
  }

  return direct ?? viaGetFlag ?? null;
}

function getFeatFastMatchReason(item, { compendiumSource, englishName }) {
  const source = item?._stats?.compendiumSource ?? "";
  if (source && source === compendiumSource) return "compendiumSource";

  const originalName = getBabeleOriginalName(item);
  if (originalName && originalName === englishName) return "babele.originalName";

  if (isEnglishLanguage() && (item?.name ?? "") === englishName) return "name";
  return null;
}

async function actorHasFeat(actor, { compendiumSource, englishName }) {
  const items = actor?.items;
  if (!items) return false;

  const feats = Array.from(items).filter(isFeatItem);
  if (!feats.length) return false;

  for (const feat of feats) {
    const reason = getFeatFastMatchReason(feat, { compendiumSource, englishName });
    if (reason) return true;
  }

  if (isEnglishLanguage()) return false;
  for (const feat of feats) {
    const resolved = await resolveEnglishName(feat?.name, { documentName: "Item", deepScanMode: "off" });
    if ((resolved ?? "") === englishName) return true;
  }

  return false;
}

async function findFeat(actor, { compendiumSource, englishName }) {
  const items = actor?.items;
  if (!items) return null;

  const feats = Array.from(items).filter(isFeatItem);
  if (!feats.length) return null;

  for (const feat of feats) {
    const reason = getFeatFastMatchReason(feat, { compendiumSource, englishName });
    if (reason) return feat;
  }

  if (isEnglishLanguage()) return null;
  for (const feat of feats) {
    const resolved = await resolveEnglishName(feat?.name, { documentName: "Item", deepScanMode: "off" });
    if ((resolved ?? "") === englishName) return feat;
  }

  return null;
}

function normalizeClassKey(value) {
  return (value ?? "").toString().trim().toLowerCase();
}

function getAssociatedClassKeySetFromFeat(feat) {
  if (!feat) return new Set();
  const assoc = feat?.system?.associations?.classes;
  if (Array.isArray(assoc) && assoc.length) {
    return new Set(assoc.map(normalizeClassKey).filter(Boolean));
  }
  const cls = feat?.system?.class;
  if (typeof cls === "string" && cls.trim()) {
    return new Set([normalizeClassKey(cls)]);
  }
  return new Set();
}

function getSpellbookClassKey(spellItem) {
  const cls =
    spellItem?.spellbook?.class ??
    spellItem?.system?.spellbook?.class ??
    null;
  return normalizeClassKey(cls);
}

function getAssociatedClassKeys(item) {
  const assoc = item?.system?.associations?.classes;
  if (Array.isArray(assoc) && assoc.length) {
    return assoc.map((v) => (v ?? "").toString().trim()).filter(Boolean);
  }
  const cls = item?.system?.class;
  if (typeof cls === "string" && cls.trim()) return [cls.trim()];
  return ["kineticist"];
}

function getAssociatedClassLevel(actor, item) {
  const keys = getAssociatedClassKeys(item);
  const classes = actor?.classes ?? {};
  const levels = keys.map((key) => {
    if (!key) return 0;
    const direct = classes?.[key]?.level;
    if (direct != null) return Number(direct) || 0;
    const lowered = typeof key === "string" ? classes?.[key.toLowerCase()]?.level : undefined;
    return Number(lowered) || 0;
  });
  const valid = levels.filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return 0;
  return Math.max(...valid);
}

function normalizeSupportedMetamagicName(name) {
  return resolveMetamagicNameFromDatabase(name);
}

function makeVirtualSource(label, metaName) {
  return {
    type: "class",
    label,
    metaName,
  };
}

function sourcesFromMetakinesis(level) {
  const sources = [];
  if (level >= 5) sources.push(makeVirtualSource("Empower Spell", "Empower Spell"));
  if (level >= 9) sources.push(makeVirtualSource("Maximize Spell", "Maximize Spell"));
  if (level >= 13) sources.push(makeVirtualSource("Quicken Spell", "Quicken Spell"));
  return sources;
}

function sourcesFromMetamagicInvocation() {
  // Only add metamagics NAS currently supports.
  const candidates = ["Enlarge Spell", "Extend Spell", "Intuitive Spell", "Logical Spell", "Quicken Spell", "Reach Spell", "Tenacious Spell"];
  return candidates
    .map((name) => normalizeSupportedMetamagicName(name))
    .filter(Boolean)
    .map((name) => makeVirtualSource(name, name));
}

function sourcesFromExpandedMetakinesis() {
  // Only add metamagics NAS currently supports.
  const candidates = ["Disrupting Spell", "Ectoplasmic Spell", "Furious Spell", "Merciful Spell", "Piercing Spell"];
  return candidates
    .map((name) => normalizeSupportedMetamagicName(name))
    .filter(Boolean)
    .map((name) => makeVirtualSource(name, name));
}

/**
 * Determine which (supported) metamagics a kinetic blast-like SLA can use based on the actor.
 * Per user spec, any item with system.abilityType === "sp" is treated as a blast for UI purposes.
 *
 * @param {Actor} actor
 * @param {Item} item
 * @returns {Promise<Array<{type: string, label: string, metaName: string}>>}
 */
export async function getKineticistMetamagicSources(actor, item) {
  if (!actor || !item) return [];

  const sources = [];

  const hasMetakinesis = await actorHasFeat(actor, {
    compendiumSource: METAKINESIS_COMPENDIUM_SOURCE,
    englishName: METAKINESIS_ENGLISH_NAME,
  });
  if (hasMetakinesis) {
    const level = getAssociatedClassLevel(actor, item);
    sources.push(...sourcesFromMetakinesis(level));
  }

  const hasExpandedMetakinesis = await actorHasFeat(actor, {
    compendiumSource: EXPANDED_METAKINESIS_COMPENDIUM_SOURCE,
    englishName: EXPANDED_METAKINESIS_ENGLISH_NAME,
  });
  if (hasExpandedMetakinesis) {
    sources.push(...sourcesFromExpandedMetakinesis());
  }

  // De-dupe by canonical metamagic name.
  const seen = new Set();
  return sources.filter((s) => {
    const key = (s?.metaName ?? "").toString();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getKineticInvocationSpellMetamagicSources(actor, spellItem) {
  if (!actor || !spellItem) return [];
  if (spellItem.type !== "spell") return [];

  const kineticInvocationFeat = await findFeat(actor, {
    compendiumSource: KINETIC_INVOCATION_COMPENDIUM_SOURCE,
    englishName: KINETIC_INVOCATION_ENGLISH_NAME,
  });
  if (!kineticInvocationFeat) return [];

  const metamagicInvocationFeat = await findFeat(actor, {
    compendiumSource: METAMAGIC_INVOCATION_COMPENDIUM_SOURCE,
    englishName: METAMAGIC_INVOCATION_ENGLISH_NAME,
  });
  if (!metamagicInvocationFeat) return [];

  const spellbookClass = getSpellbookClassKey(spellItem);
  if (!spellbookClass) return [];

  // Determine associated classes from the feats; default to kineticist if none are declared.
  const assoc = new Set();
  for (const key of getAssociatedClassKeySetFromFeat(kineticInvocationFeat)) assoc.add(key);
  for (const key of getAssociatedClassKeySetFromFeat(metamagicInvocationFeat)) assoc.add(key);
  if (assoc.size === 0) assoc.add("kineticist");

  if (!assoc.has(spellbookClass)) return [];

  // Return supported metamagics from Metamagic Invocation.
  return sourcesFromMetamagicInvocation();
}