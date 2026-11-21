import { clonePlainData } from "../../../../common/foundryCompat.js";
import { spellbookText as t } from "./i18n.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import {
  countMissingKnownSpellImports,
  getKnownSpells,
  importMissingKnownSpells,
  initializeKnownSpellbook,
  isKnownSpellbookInitialized,
  removeKnownSpell
} from "./knownSpells.js";
import {
  addPreparedSpellVariant,
  getGeneratedPreparedSpellItemsForEntry,
  getGeneratedPreparedCount,
  getSpentPreparationCount,
  getPreparedEntriesForKnownSpells,
  getSourceItemForKnownSpell,
  isSpellbookPreparedItemsManaged,
  removePreparedSpellVariant,
  removePreparedSpellVariantsForKnown,
  syncGeneratedPreparedSpellItems,
  updatePreparedSpellVariant
} from "./preparedItems.js";
import {
  calculatePreparedSlotLevel,
  getMetamagicSummary,
  getPreparedMetamagicChoices,
  normalizeMetamagicSelections
} from "./metamagicInscription.js";
import { allocatePreparationCopies, canUseRegularPreparationSlots, getSpellbookLevelPreparationCaps } from "./slotAvailability.js";
import { completeSpellbookPreparation, isSpellbookPreparationPending } from "./flags.js";
import { getSpellbookPreferences, isSpellbookManagementEnabled } from "./preferences.js";
import { isSpellbookPreparationFullModeEnabled } from "./settings.js";

const id = (value) => `${value ?? ""}`.trim();
const spellbook = (actor, bookId) => actor?.system?.attributes?.spells?.spellbooks?.[bookId];
const integer = (value) => Math.max(0, Math.trunc(Number(value) || 0));
const levelLabel = (level) => globalThis.pf1?.config?.spellLevels?.[level]
  ?? (level === 0 ? t("Cantrips") : t("Level {level}", {level}));

function requireBook(actor, bookId, { writable = false } = {}) {
  if (!getEligibleSpellbookIds(actor).includes(id(bookId))) throw new Error(t("Choose an active prepared or hybrid spellbook."));
  if (writable && actor.isOwner !== true) throw new Error(t("You do not have permission to change this actor's spellbook."));
  return spellbook(actor, id(bookId));
}

function preparationCount(item, mode) {
  return mode === "hybrid" ? (Number(item?.system?.preparation?.value) > 0 ? 1 : 0)
    : integer(item?.system?.preparation?.max);
}

function draftValue(draft, spell) {
  if (draft?.has?.(spell.id)) return draft.get(spell.id);
  if (draft && Object.prototype.hasOwnProperty.call(draft, spell.id)) return draft[spell.id];
  return spell.prepared ?? 0;
}

function makeSpell(actor, bookId, known, entry, mode, managed) {
  const live = getSourceItemForKnownSpell(actor, bookId, known);
  const source = live ?? known.itemData ?? known;
  const candidateLevel = Number(source.system?.level ?? known.level);
  const originalLevel = Number.isInteger(candidateLevel) && candidateLevel >= 0 && candidateLevel <= 9 ? candidateLevel : 0;
  const isVariant = entry.variant === "custom";
  const selections = isVariant ? normalizeMetamagicSelections(entry.metamagic, { originalLevel, sourceItem: source }) : [];
  const level = isVariant ? calculatePreparedSlotLevel(originalLevel, selections) : originalLevel;
  const atWill = source.system?.atWill === true;
  const preparations = managed ? getGeneratedPreparedSpellItemsForEntry(actor, bookId, entry)
    : !isVariant && live ? [live] : [];
  const prepared = !live || atWill ? 0 : preparations.reduce((sum, item) =>
    sum + (managed ? getGeneratedPreparedCount(item, mode) : preparationCount(item, mode)), 0);
  const domain = source.isDomain === true || source.system?.domain === true;
  const regularEligible = domain && canUseRegularPreparationSlots(spellbook(actor, bookId), source);
  const schoolKey = source.system?.school ?? known.school ?? "";
  const school = globalThis.pf1?.config?.spellSchools?.[schoolKey] ?? schoolKey;
  const rawCost = Number(source.slotCost ?? source.system?.slotCost ?? 1);
  const preparedEntry = {
    ...clonePlainData(entry),
    originalSpellLevel: originalLevel,
    preparedSlotLevel: level,
    metamagic: selections
  };
  return {
    id: entry.id,
    knownSpellId: known.id,
    sourceItemId: known.sourceItemId,
    name: live?.name || source.name || known.name || t("Unknown spell"),
    img: live?.img || source.img || known.img || "icons/svg/book.svg",
    school: typeof school === "string" ? school : id(school?.label ?? schoolKey),
    level,
    originalLevel,
    originalSpellLevel: originalLevel,
    preparedSlotLevel: level,
    prepared,
    count: prepared,
    slotCost: Number.isFinite(rawCost) ? Math.max(0, rawCost) : 1,
    domain, regularEligible,
    spent: mode === "prepared" ? preparations.reduce((sum, item) => sum + getSpentPreparationCount(item), 0) : 0,
    atWill,
    missing: !live,
    isVariant,
    suffix: entry.suffix ?? "",
    metamagic: getMetamagicSummary(selections),
    metamagicSelections: selections,
    preparedEntry
  };
}

export function rebuildActorDraftSpell(actor, bookId, spell, entry) {
  const known = getKnownSpells(actor, bookId).find(candidate => candidate.id === spell.knownSpellId);
  if (!known) return null;
  const book = spellbook(actor, bookId);
  return makeSpell(actor, bookId, known, entry, book?.spellPreparationMode, isSpellbookPreparedItemsManaged(actor, bookId));
}

function metadataSnapshot(actor, bookId, known, entries) {
  return JSON.stringify({
    mode: spellbook(actor, bookId)?.spellPreparationMode,
    preferences: getSpellbookPreferences(actor, bookId),
    known: known.map((entry) => ({ id: entry.id, sourceItemId: entry.sourceItemId, level: entry.level })),
    entries,
    sources: known.map((entry) => {
      const source = getSourceItemForKnownSpell(actor, bookId, entry);
      return source ? { id: source.id, level: source.system?.level, domain: source.isDomain === true || source.system?.domain === true,
        atWill: source.system?.atWill === true, slotCost: source.slotCost ?? source.system?.slotCost ?? 1 } : null;
    })
  });
}

export function getActorSpellbookChoices(actor) {
  return getEligibleSpellbookIds(actor).map((bookId) => {
    const book = spellbook(actor, bookId);
    return { id: bookId, label: book.name || book.label || bookId, mode: book.spellPreparationMode };
  });
}

export function loadActorSpellbook(actor, bookId, { draft } = {}) {
  const normalizedBookId = id(bookId);
  const book = requireBook(actor, normalizedBookId);
  const mode = book.spellPreparationMode;
  const initialized = isKnownSpellbookInitialized(actor, normalizedBookId);
  const known = initialized ? getKnownSpells(actor, normalizedBookId) : [];
  const entries = getPreparedEntriesForKnownSpells(actor, normalizedBookId, known);
  const knownById = new Map(known.map((entry) => [entry.id, entry]));
  const managed = isSpellbookPreparedItemsManaged(actor, normalizedBookId);
  const spells = entries.map((entry) => makeSpell(actor, normalizedBookId, knownById.get(entry.knownSpellId), entry, mode, managed));
  if (draft) for (const spell of spells) {
    const value = Number(draftValue(draft, spell));
    spell.prepared = mode === "hybrid" ? (value > 0 ? 1 : 0) : integer(value);
    spell.count = spell.prepared;
  }
  return {
    key: "actor",
    label: actor.name || "Actor spellbook",
    actorId: id(actor.id),
    actorUuid: id(actor.uuid),
    bookId: normalizedBookId,
    actorName: actor.name || "Actor",
    bookName: book.name || book.label || normalizedBookId,
    castingMode: mode === "hybrid" ? t("Arcanist") : t("Prepared"),
    mode,
    initialized,
    knownSpellCount: known.length,
    managed,
    preferences: getSpellbookPreferences(actor, normalizedBookId),
    pending: isSpellbookPreparationPending(actor, normalizedBookId),
    importableSpellCount: countMissingKnownSpellImports(actor, normalizedBookId),
    levels: Array.from({ length: 10 }, (_, level) => {
      const caps = getSpellbookLevelPreparationCaps(book, level);
      return { level, label: levelLabel(level), normalCap: caps.normal, domainCap: caps.domain,
        normalAvailability: caps.normalAvailability, domainAvailability: caps.domainAvailability };
    }),
    spells,
    metadataSnapshot: metadataSnapshot(actor, normalizedBookId, known, entries),
    removedEntryIds: [],
    removedKnownSpellIds: []
  };
}

export function getActorPreparationValidation(fixture, draft) {
  const errors = [...(fixture.refreshConflicts ?? [])];
  if (fixture.unavailableReason) errors.unshift(fixture.unavailableReason);
  if (!fixture.initialized) errors.push(t("Choose Copy spells from sheet or Start empty on the inside cover before preparing spells."));
  const levels = (fixture.levels ?? []).map((level) => ({ ...level, normalUsed: 0, domainUsed: 0, overLimit: false }));
  const byLevel = new Map(levels.map((level) => [level.level, level]));
  const counts = new Map();
  const domainCopies = new Map();

  const spells = fixture.spells ?? [];
  for (const spell of [...spells.filter(s => !s.regularEligible), ...spells.filter(s => s.regularEligible)]) {
    if (counts.has(spell.id)) errors.push(t("Duplicate prepared entry: {id}.", {id: spell.id}));
    const raw = Number(draftValue(draft, spell));
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) errors.push(t("{name}: preparation must be a non-negative whole number.", {name: spell.name}));
    const count = fixture.mode === "hybrid" ? (raw > 0 ? 1 : 0) : integer(raw);
    counts.set(spell.id, count);
    if (count < spell.spent) errors.push(t("{name}: spent preparations cannot be replaced before resting.", {name: spell.name}));
    if (count > 0 && spell.missing) errors.push(t("{name}: the original spell is missing.", {name: spell.name}));
    if (count > 0 && spell.atWill) errors.push(t("{name}: at-will spells do not use prepared copies.", {name: spell.name}));
    const level = byLevel.get(spell.level);
    if (!level && count > 0) errors.push(t("{name}: invalid prepared spell level.", {name: spell.name}));
    if (level && count > 0) {
      const special = spell.domain && (!spell.regularEligible || level.domainCap > 0);
      const availability = special ? level.domainAvailability : level.normalAvailability;
      const cap = special ? level.domainCap : level.normalCap;
      const unavailable = availability
        ? availability.unavailable === true || availability.state === "unavailable"
        : cap !== null && cap !== undefined && Number(cap) <= 0;
      if (unavailable) {
        const warning = availability?.reason === "lowAbilityScore" ? t("Casting ability too low")
          : spell.domain ? t("No domain capacity") : t("Level unavailable");
        errors.push(`${spell.name}: ${warning}.`);
      }
    }
    if (level && !spell.missing && !spell.atWill) {
      domainCopies.set(spell.id, allocatePreparationCopies(level, spell, count));
    }
  }
  for (const level of levels) {
    for (const pool of ["normal", "domain"]) {
      const cap = level[`${pool}Cap`];
      if (cap !== null && level[`${pool}Used`] > cap) {
        level.overLimit = true;
        errors.push(t("{level}: {pool} preparation exceeds {cap} slots.", {level: level.label, pool: t(pool), cap}));
      }
    }
  }
  return { valid: errors.length === 0, overLimit: levels.some((level) => level.overLimit), errors,
    levels, counts, domainCopies, totals: new Map(levels.map((level) => [level.level, { normal: level.normalUsed, domain: level.domainUsed }])) };
}

function stagedFixture(actor, bookId, fixture, fresh) {
  const known = getKnownSpells(actor, bookId);
  const knownById = new Map(known.map((entry) => [entry.id, entry]));
  const current = new Map(fresh.spells.map((spell) => [spell.id, spell]));
  const removedKnown = new Set(fixture.removedKnownSpellIds ?? []);
  const removedEntries = new Set(fixture.removedEntryIds ?? []);
  for (const knownId of removedKnown) if (!knownById.has(knownId)) throw new Error(t("Your known spells have changed. Reopen the spellbook before preparing spells."));
  const spells = (fixture.spells ?? []).filter((spell) => !removedKnown.has(spell.knownSpellId) && !removedEntries.has(spell.id)).map((spell) => {
    const entry = clonePlainData(spell.preparedEntry);
    const knownSpell = knownById.get(spell.knownSpellId);
    const existing = current.get(spell.id);
    if (!knownSpell || entry.id !== spell.id || entry.knownSpellId !== knownSpell.id
      || (!existing && (!spell.id.startsWith("draft-") || entry.variant !== "custom"))
      || (existing && existing.isVariant !== (entry.variant === "custom"))) {
      throw new Error(t("Your prepared spells have changed. Reopen the spellbook before preparing spells."));
    }
    const staged = makeSpell(actor, bookId, knownSpell, entry, fresh.mode, fresh.managed);
    staged.prepared = spell.prepared;
    if (staged.isVariant && JSON.stringify(existing?.preparedEntry?.metamagic ?? []) !== JSON.stringify(staged.metamagicSelections)) {
      const source = getSourceItemForKnownSpell(actor, bookId, knownSpell);
      const choices = getPreparedMetamagicChoices(actor, source, staged.preparedEntry);
      for (const selected of staged.metamagicSelections) {
        const choice = choices.find((candidate) => candidate.key === selected.key);
        if (!choice || choice.invalid) throw new Error(t("{name}: that metamagic selection is no longer available.", {name: spell.name}));
      }
    }
    return staged;
  });
  const included = new Map(spells.map((spell) => [spell.id, spell]));
  for (const spell of fresh.spells) {
    const replacement = included.get(spell.id);
    if (spell.spent && (!replacement || replacement.level !== spell.level
      || JSON.stringify(replacement.metamagicSelections) !== JSON.stringify(spell.metamagicSelections))) {
      throw new Error(t("{name}: spent preparations cannot be replaced before resting.", {name: spell.name}));
    }
    if (!included.has(spell.id) && !removedKnown.has(spell.knownSpellId) && !removedEntries.has(spell.id)) {
      throw new Error(t("A spell is missing from your preparation. Reopen the spellbook before preparing spells."));
    }
    if (removedEntries.has(spell.id) && !spell.isVariant && !removedKnown.has(spell.knownSpellId)) {
      throw new Error(t("Choose the original spell under Manage this spellbook to remove it."));
    }
  }
  return { ...fresh, spells, removedEntryIds: [...removedEntries], removedKnownSpellIds: [...removedKnown] };
}

export async function applyActorPreparation(actor, bookId, fixture, draft) {
  const normalizedBookId = id(bookId);
  requireBook(actor, normalizedBookId, { writable: true });
  if (!isSpellbookPreparationFullModeEnabled()) throw new Error(t("Full spellbook preparation is off in module settings. Your unsaved changes are still here."));
  if (!isSpellbookManagementEnabled(actor, normalizedBookId)) throw new Error(t("Turn on Use NAS for this spellbook and save its options before preparing spells."));
  if (fixture.actorId !== id(actor.id) || fixture.actorUuid !== id(actor.uuid) || fixture.bookId !== normalizedBookId) {
    throw new Error(t("This preparation belongs to a different actor or spellbook."));
  }
  if (fixture.unavailableReason || fixture.refreshConflicts?.length) {
    const validation = getActorPreparationValidation(fixture, draft);
    const error = new Error(validation.errors.join("\n"));
    error.validation = validation;
    throw error;
  }
  const fresh = loadActorSpellbook(actor, normalizedBookId);
  if (fixture.metadataSnapshot !== fresh.metadataSnapshot) throw new Error(t("The spellbook changed. Reopen it before preparing spells."));
  const staged = stagedFixture(actor, normalizedBookId, fixture, fresh);
  const validation = getActorPreparationValidation(staged, draft);
  if (!validation.valid) {
    const error = new Error(validation.errors.join("\n"));
    error.validation = validation;
    throw error;
  }

  const idMap = new Map();
  for (const spell of staged.spells.filter((entry) => entry.isVariant)) {
    let entryId = spell.id;
    if (entryId.startsWith("draft-")) {
      const known = getKnownSpells(actor, normalizedBookId).find((entry) => entry.id === spell.knownSpellId);
      const created = await addPreparedSpellVariant(actor, normalizedBookId, known, { suffix: spell.suffix });
      if (!created) throw new Error(t("Could not create the prepared variant."));
      entryId = created.id;
      idMap.set(spell.id, entryId);
    }
    const updated = await updatePreparedSpellVariant(actor, normalizedBookId, entryId, spell.preparedEntry);
    if (!updated) throw new Error(t("Could not update the prepared variant."));
  }
  for (const entryId of staged.removedEntryIds) {
    if (!entryId.startsWith("draft-")) await removePreparedSpellVariant(actor, normalizedBookId, entryId);
  }
  for (const knownId of staged.removedKnownSpellIds) {
    await removePreparedSpellVariantsForKnown(actor, normalizedBookId, knownId);
    await removeKnownSpell(actor, normalizedBookId, knownId);
  }
  const known = getKnownSpells(actor, normalizedBookId);
  const counts = new Map([...validation.counts].map(([entryId, count]) => [idMap.get(entryId) ?? entryId, count]));
  const entries = staged.spells.map((spell) => ({ ...spell.preparedEntry, id: idMap.get(spell.id) ?? spell.id }));
  const domainCopies = new Map([...validation.domainCopies].map(([key, count]) => [idMap.get(key) ?? key, count]));
  const result = await syncGeneratedPreparedSpellItems(actor, normalizedBookId, known, entries, counts, fresh.mode, domainCopies);
  await completeSpellbookPreparation(actor, normalizedBookId);
  if (actor.sheet?.rendered) actor.sheet.render(false);
  return { fixture: loadActorSpellbook(actor, normalizedBookId), idMap, ...result };
}

export async function importActorSpells(actor, bookId) {
  const normalizedBookId = id(bookId);
  requireBook(actor, normalizedBookId, { writable: true });
  if (!isSpellbookManagementEnabled(actor, normalizedBookId)) throw new Error(t("Turn on Use NAS for this spellbook and save its options before adding spells."));
  if (isKnownSpellbookInitialized(actor, normalizedBookId)) await importMissingKnownSpells(actor, normalizedBookId);
  else await initializeKnownSpellbook(actor, normalizedBookId, { importCurrent: true });
  return loadActorSpellbook(actor, normalizedBookId);
}

export async function startEmptyActorSpellbook(actor, bookId) {
  const normalizedBookId = id(bookId);
  requireBook(actor, normalizedBookId, { writable: true });
  if (!isSpellbookManagementEnabled(actor, normalizedBookId)) throw new Error(t("Turn on Use NAS for this spellbook and save its options before adding known spells."));

  if (!isKnownSpellbookInitialized(actor, normalizedBookId)) {
    await initializeKnownSpellbook(actor, normalizedBookId, { importCurrent: false });
  }

  return loadActorSpellbook(actor, normalizedBookId);
}
