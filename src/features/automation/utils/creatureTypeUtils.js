import { MODULE } from "../../../common/module.js";

export function getAlignmentValue(alignment) {
  return (alignment ?? "").toString().toLowerCase();
}

function parseAliasList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean);
  }
  const text = String(value ?? "");
  return text
    .split(/[,;|]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function addCollectionValues(out, source) {
  if (!source) return;
  if (typeof source === "string") {
    parseAliasList(source).forEach((entry) => out.add(entry));
    return;
  }
  if (Array.isArray(source)) {
    source.forEach((entry) => {
      const text = String(entry ?? "").trim().toLowerCase();
      if (text) out.add(text);
    });
    return;
  }
  if (typeof source.forEach === "function") {
    source.forEach((entry) => {
      const text = String(entry ?? "").trim().toLowerCase();
      if (text) out.add(text);
    });
    return;
  }
  if (typeof source === "object") {
    Object.values(source).forEach((entry) => addCollectionValues(out, entry));
  }
}

export function getCreatureTypeValues(actor) {
  const values = new Set();
  const addValue = (value) => {
    const text = value?.toString?.().trim();
    if (text) values.add(text.toLowerCase());
  };

  const types = actor?.system?.traits?.creatureTypes;
  const standard = types?.standard;
  if (standard?.forEach) {
    standard.forEach((entry) => addValue(entry));
  }
  const total = types?.total;
  if (total?.forEach) {
    total.forEach((entry) => addValue(entry));
  }
  const names = types?.names ?? [];
  if (Array.isArray(names)) {
    names.forEach((entry) => addValue(entry));
  }

  const classes = actor?.classes ?? {};
  Object.values(classes).forEach((entry) => {
    if (!entry) return;
    addValue(entry?.name);
    addValue(entry?._id);
  });

  return Array.from(values);
}

export function collectCreatureIdentityEvidence(actor) {
  const out = new Set();
  const traits = actor?.system?.traits ?? {};

  addCollectionValues(out, traits?.ci?.names);
  addCollectionValues(out, traits?.ci?.custom);
  addCollectionValues(out, traits?.creatureTypes?.standard);
  addCollectionValues(out, traits?.creatureTypes?.total);
  addCollectionValues(out, traits?.creatureTypes?.names);
  addCollectionValues(out, traits?.creatureSubtypes?.standard);
  addCollectionValues(out, traits?.creatureSubtypes?.total);
  addCollectionValues(out, traits?.creatureSubtypes?.names);

  const classes = actor?.classes ?? {};
  Object.entries(classes).forEach(([key, cls]) => {
    const classKey = String(key ?? "").trim().toLowerCase();
    if (classKey) out.add(classKey);
    const className = String(cls?.name ?? "").trim().toLowerCase();
    if (className) out.add(className);
  });

  const raceName = String(actor?.race?.name ?? actor?.system?.details?.race ?? "").trim().toLowerCase();
  if (raceName) out.add(raceName);

  return Array.from(out);
}

function matchNeedles(evidence, needles) {
  if (!evidence.length || !needles.length) return false;
  return evidence.some((entry) => needles.some((needle) => entry.includes(needle)));
}

function getTypeNeedles(kind) {
  const translations = game.settings.get(MODULE.ID, "translations") || {};
  const translatedTrait = String(translations?.[kind] ?? `${kind} traits`).trim().toLowerCase();

  const classAliasKey = kind === "construct" ? "constructClassNames" : "undeadClassNames";
  const raceAliasKey = kind === "construct" ? "constructRaceNames" : "undeadRaceNames";
  const classAliases = parseAliasList(translations?.[classAliasKey]);
  const raceAliases = parseAliasList(translations?.[raceAliasKey]);

  const needles = new Set([
    kind,
    `${kind} traits`,
    translatedTrait,
    ...classAliases,
    ...raceAliases
  ].map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean));

  return Array.from(needles);
}

function resolveTypeByBooleanAndEvidence({ boolValue, evidence, needles }) {
  const hasEvidence = evidence.length > 0;
  const fromEvidence = matchNeedles(evidence, needles);
  if (!hasEvidence) return Boolean(boolValue);
  if (fromEvidence !== Boolean(boolValue)) return fromEvidence;
  return fromEvidence;
}

export function getCreatureTypeState(actor) {
  const traits = actor?.system?.traits ?? {};
  const boolConstruct = Boolean(traits?.construct);
  const boolUndead = Boolean(traits?.undead);
  const boolLiving = traits?.living;
  const evidence = collectCreatureIdentityEvidence(actor);

  const isConstruct = resolveTypeByBooleanAndEvidence({
    boolValue: boolConstruct,
    evidence,
    needles: getTypeNeedles("construct")
  });
  const isUndead = resolveTypeByBooleanAndEvidence({
    boolValue: boolUndead,
    evidence,
    needles: getTypeNeedles("undead")
  });

  const livingFromTypes = !(isConstruct || isUndead);
  const isLiving = (typeof boolLiving === "boolean" && boolLiving === livingFromTypes)
    ? boolLiving
    : livingFromTypes;

  return { isConstruct, isUndead, isLiving };
}
