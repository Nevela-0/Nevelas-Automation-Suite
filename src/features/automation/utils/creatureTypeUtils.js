import { MODULE } from "../../../common/module.js";

export function getAlignmentValue(alignment) {
  return (alignment ?? "").toString().toLowerCase();
}

const ALIGNMENT_REQUIREMENT_ALIASES = {
  g: "good",
  e: "evil",
  l: "lawful",
  c: "chaotic"
};

const ALIGNMENT_REQUIREMENT_KINDS = new Set([
  "any",
  "good",
  "evil",
  "lawful",
  "chaotic",
  "lg",
  "ng",
  "cg",
  "ln",
  "tn",
  "cn",
  "le",
  "ne",
  "ce"
]);

const EXACT_ALIGNMENT_KINDS = new Set(["lg", "ng", "cg", "ln", "tn", "cn", "le", "ne", "ce"]);

const ALIGNMENT_TEXT_ALIASES = {
  lawfulgood: "lg",
  neutralgood: "ng",
  chaoticgood: "cg",
  lawfulneutral: "ln",
  trueneutral: "tn",
  neutral: "tn",
  chaoticneutral: "cn",
  lawfulevil: "le",
  neutralevil: "ne",
  chaoticevil: "ce"
};

export function normalizeAlignmentRequirementKind(value) {
  const raw = String(value ?? "any").trim().toLowerCase();
  const kind = ALIGNMENT_REQUIREMENT_ALIASES[raw] ?? raw;
  return ALIGNMENT_REQUIREMENT_KINDS.has(kind) ? kind : "any";
}

function getActorAlignmentCode(alignment) {
  const raw = getAlignmentValue(alignment);
  if (EXACT_ALIGNMENT_KINDS.has(raw)) return raw;
  const compact = raw.replace(/[^a-z]/g, "");
  if (EXACT_ALIGNMENT_KINDS.has(compact)) return compact;
  if (ALIGNMENT_TEXT_ALIASES[compact]) return ALIGNMENT_TEXT_ALIASES[compact];
  return raw;
}

export function actorMatchesAlignmentRequirement(actor, requirement) {
  const kind = normalizeAlignmentRequirementKind(requirement);
  if (kind === "any") return true;

  const alignment = getActorAlignmentCode(actor?.system?.details?.alignment);
  if (!alignment) return false;
  if (EXACT_ALIGNMENT_KINDS.has(kind)) return alignment === kind;
  if (EXACT_ALIGNMENT_KINDS.has(alignment)) {
    if (kind === "good") return alignment.includes("g");
    if (kind === "evil") return alignment.includes("e");
    if (kind === "lawful") return alignment.includes("l");
    if (kind === "chaotic") return alignment.includes("c");
  }
  if (kind === "good") return /\bgood\b/.test(alignment);
  if (kind === "evil") return /\bevil\b/.test(alignment);
  if (kind === "lawful") return /\blawful\b/.test(alignment);
  if (kind === "chaotic") return /\bchaotic\b/.test(alignment);
  return true;
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
