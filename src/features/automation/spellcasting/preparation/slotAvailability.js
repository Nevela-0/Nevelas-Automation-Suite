const MAX_SPELL_LEVEL = 9;

export const SLOT_AVAILABILITY = {
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown"
};

function toSpellLevel(value, fallback = 0) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number)) return Math.max(0, Math.min(MAX_SPELL_LEVEL, Number(fallback) || 0));
  return Math.max(0, Math.min(MAX_SPELL_LEVEL, number));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getPositiveCapacity(candidates = {}) {
  const finite = Object.values(candidates)
    .map((value) => finiteNumber(value))
    .filter((value) => value !== null);
  const positive = finite.filter((value) => value > 0);

  return {
    finite,
    positive,
    cap: positive.length ? Math.max(...positive) : null
  };
}

function unavailable(level, key, reason, candidates = {}, levelData = null, cap = 0) {
  return {
    level,
    key,
    state: SLOT_AVAILABILITY.UNAVAILABLE,
    available: false,
    unavailable: true,
    unknown: false,
    cap,
    reason,
    candidates,
    lowAbilityScore: levelData?.lowAbilityScore === true,
    hasData: Boolean(levelData)
  };
}

function unknown(level, key, reason, candidates = {}, levelData = null) {
  return {
    level,
    key,
    state: SLOT_AVAILABILITY.UNKNOWN,
    available: false,
    unavailable: false,
    unknown: true,
    cap: null,
    reason,
    candidates,
    lowAbilityScore: levelData?.lowAbilityScore === true,
    hasData: Boolean(levelData)
  };
}

function available(level, key, cap, candidates = {}, levelData = null) {
  return {
    level,
    key,
    state: SLOT_AVAILABILITY.AVAILABLE,
    available: true,
    unavailable: false,
    unknown: false,
    cap,
    reason: "",
    candidates,
    lowAbilityScore: levelData?.lowAbilityScore === true,
    hasData: Boolean(levelData)
  };
}

export function getSpellbookLevelNormalAvailability(spellbook, level) {
  const spellLevel = toSpellLevel(level, 0);
  const key = `spell${spellLevel}`;
  const levelData = spellbook?.spells?.[key] ?? null;
  const candidates = {
    "preparation.max": levelData?.preparation?.max,
    "slots.max": levelData?.slots?.max,
    "casts.max": levelData?.casts?.max,
    max: levelData?.max,
    base: levelData?.base
  };

  if (!levelData) return unavailable(spellLevel, key, "missingLevelData", candidates, levelData);
  if (levelData.lowAbilityScore === true) return unavailable(spellLevel, key, "lowAbilityScore", candidates, levelData);

  const capacity = getPositiveCapacity(candidates);
  if (capacity.cap !== null) return available(spellLevel, key, capacity.cap, candidates, levelData);
  if (capacity.finite.length > 0) return unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);

  return unknown(spellLevel, key, "unknownCapacity", candidates, levelData);
}

export function getSpellbookLevelDomainAvailability(spellbook, level) {
  const spellLevel = toSpellLevel(level, 0);
  const key = `spell${spellLevel}`;
  const levelData = spellbook?.spells?.[key] ?? null;
  const candidates = {
    "preparation.domain": levelData?.preparation?.domain,
    "domain.max": levelData?.domain?.max
  };

  if (!levelData) return unavailable(spellLevel, key, "missingLevelData", candidates, levelData);
  if (levelData.lowAbilityScore === true) return unavailable(spellLevel, key, "lowAbilityScore", candidates, levelData);

  const capacity = getPositiveCapacity(candidates);
  if (capacity.cap !== null) return available(spellLevel, key, capacity.cap, candidates, levelData);

  return unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);
}

export function getSpellbookLevelAvailability(spellbook, level, { domain = false } = {}) {
  return domain
    ? getSpellbookLevelDomainAvailability(spellbook, level)
    : getSpellbookLevelNormalAvailability(spellbook, level);
}

export function getSpellbookLevelPreparationCaps(spellbook, level) {
  const normal = getSpellbookLevelNormalAvailability(spellbook, level);
  const domain = getSpellbookLevelDomainAvailability(spellbook, level);

  return {
    normal: normal.cap,
    domain: domain.cap ?? 0,
    normalAvailability: normal,
    domainAvailability: domain
  };
}
