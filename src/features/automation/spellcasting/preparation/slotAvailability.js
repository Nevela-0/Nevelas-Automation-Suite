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
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getFiniteCandidates(candidates = {}) {
  return Object.values(candidates)
    .map((value) => finiteNumber(value))
    .filter((value) => value !== null);
}

function getFirstCapacity(candidates = {}) {
  const finite = getFiniteCandidates(candidates);
  const cap = finite.length ? finite[0] : null;

  return {
    finite,
    cap
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

  const explicitCapacity = getFirstCapacity({
    "preparation.max": levelData?.preparation?.max,
    "slots.max": levelData?.slots?.max
  });
  if (explicitCapacity.cap !== null) {
    return explicitCapacity.cap > 0
      ? available(spellLevel, key, explicitCapacity.cap, candidates, levelData)
      : unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);
  }

  const fallbackCapacity = getFirstCapacity({
    "casts.max": levelData?.casts?.max,
    max: levelData?.max,
    base: levelData?.base
  });
  if (fallbackCapacity.cap !== null) {
    return fallbackCapacity.cap > 0
      ? available(spellLevel, key, fallbackCapacity.cap, candidates, levelData)
      : unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);
  }

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

  const preparationDomain = finiteNumber(levelData?.preparation?.domain);
  if (preparationDomain !== null) {
    return preparationDomain > 0
      ? available(spellLevel, key, preparationDomain, candidates, levelData)
      : unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);
  }

  const fallbackCapacity = getFirstCapacity({
    "domain.max": levelData?.domain?.max
  });
  if (fallbackCapacity.cap !== null && fallbackCapacity.cap > 0) {
    return available(spellLevel, key, fallbackCapacity.cap, candidates, levelData);
  }

  return unavailable(spellLevel, key, "zeroCapacity", candidates, levelData);
}

export function canUseRegularPreparationSlots(spellbook, source) {
  if (spellbook?.spellPreparationMode !== "prepared") return false;

  const bookClass = spellbook.class;
  if (bookClass === "wizard") return true;
  return Object.entries(source?.system?.learnedAt?.class ?? {}).some(([classes, level]) =>
    classes.split("/").includes(bookClass) && Number.isFinite(level) && level <= source.system.level);
}

export function allocatePreparationCopies(level, spell, count) {
  let special = spell.domain ? count : 0;
  if (spell.regularEligible && spell.slotCost > 0) {
    const remaining = Math.max(0, level.domainCap - level.domainUsed);
    special = Math.min(count, Math.floor(remaining / spell.slotCost));
  }
  level.domainUsed += special * spell.slotCost;
  level.normalUsed += (count - special) * spell.slotCost;
  return special;
}

export function getSpellbookLevelAvailability(spellbook, level, { domain = false, regularEligible = false } = {}) {
  if (domain) {
    const special = getSpellbookLevelDomainAvailability(spellbook, level);
    if (special.available || !regularEligible) return special;
  }
  return getSpellbookLevelNormalAvailability(spellbook, level);
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
