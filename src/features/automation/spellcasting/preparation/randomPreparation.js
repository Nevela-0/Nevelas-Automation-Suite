import { createNasId } from "../../utils/nasIds.js";
import { clonePlainData } from "../../../../common/foundryCompat.js";
import { spellbookText as t } from "./i18n.js";
import { applyActorPreparation, getActorPreparationValidation, loadActorSpellbook } from "./actorPreparation.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import { isSpellbookManagementEnabled } from "./preferences.js";
import { getSourceItemForKnownSpell } from "./preparedItems.js";
import {
  getPreparedMetamagicChoices,
  buildMetamagicAutoSuffix,
  buildMetamagicOptionsFromSelections,
  calculatePreparedSlotLevel,
  getMetamagicSummary,
  normalizeMetamagicSelections,
} from "./metamagicInscription.js";
import { allocatePreparationCopies, getSpellbookLevelAvailability } from "./slotAvailability.js";

const MAX_CANDIDATES_PER_SPELL = 128;
const MAX_RANDOM_COMBINATIONS = 16;
const MAX_ALLOCATIONS_PER_POOL = 10000;
const key = (value) => `${value ?? ""}`.trim();

function randomIndex(random, length) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error(t("Random preparation requires random values from 0 up to, but not including, 1."));
  return Math.floor(value * length);
}

function signature(entry, source) {
  return JSON.stringify(normalizeMetamagicSelections(entry.metamagic, {
    originalLevel: Number(source.system?.level) || 0, sourceItem: source
  }).map(({ key: featKey, options }) => [featKey, options]));
}

function candidateEntries(actor, source, base, random) {
  const empty = { ...clonePlainData(base.preparedEntry), variant: "custom", suffixMode: "auto", suffix: "",
    metamagic: [], metamagicOptions: {} };
  const entries = new Map([["[]", clonePlainData(base.preparedEntry)]]);
  const book = actor.system.attributes.spells.spellbooks[source.system.spellbook];
  const originalLevel = Number(source.system.level) || 0;
  const remember = (selections) => {
    const metamagic = normalizeMetamagicSelections(selections, { originalLevel, sourceItem: source });

    const increased = originalLevel + metamagic.filter((selection) => selection.key !== "heightenSpell")
      .reduce((total, selection) => total + selection.slotIncrease, 0);
    const level = calculatePreparedSlotLevel(originalLevel, metamagic);
    if (increased > 9 || !getSpellbookLevelAvailability(book, level, base).available) return;
    const entry = { ...empty, metamagic, preparedSlotLevel: level,
      metamagicOptions: buildMetamagicOptionsFromSelections(metamagic), suffix: buildMetamagicAutoSuffix(metamagic) };
    if (entries.size < MAX_CANDIDATES_PER_SPELL) entries.set(signature(entry, source), entry);
  };
  const choices = getPreparedMetamagicChoices(actor, source, empty).filter((choice) => !choice.disabled && !choice.invalid);
  const choicesWithSelections = choices.map((choice) => {
    const enabledOptions = (choice.hasHeightenOptions ? choice.heightenChoices : choice.hasReachOptions ? choice.reachChoices : [])
      .filter((option) => !option.disabled);
    const optionValues = enabledOptions.length ? enabledOptions.map((option) => option.value) : [null];
    return optionValues.map((value) => ({ key: choice.key, name: choice.name, prefix: choice.prefix,
      sourceItemId: choice.sourceItemId, sourceUuid: choice.sourceUuid,
      options: choice.hasHeightenOptions ? { heightenSpellLevel: value }
        : choice.hasReachOptions ? { reachSpellSteps: value } : {} }));
  });

  for (const selections of choicesWithSelections) for (const selection of selections) remember([selection]);
  for (let attempt = 0; choices.length > 1 && attempt < MAX_RANDOM_COMBINATIONS && entries.size < MAX_CANDIDATES_PER_SPELL; attempt++) {
    const selections = [];
    for (const options of choicesWithSelections) {
      if (randomIndex(random, 2) === 0) continue;
      selections.push(options[randomIndex(random, options.length)]);
    }
    if (selections.length > 1) remember(selections);
  }
  return entries;
}

export function planRandomSpellbookPreparation(actor, requestedBookId, {
  fixture = null, random = Math.random,
  createId = createNasId
} = {}) {
  const bookId = key(requestedBookId);
  if (actor?.isOwner !== true) throw new Error(t("You do not have permission to change this actor's spellbook."));
  if (!getEligibleSpellbookIds(actor).includes(bookId)) throw new Error(t("Choose an active prepared or hybrid spellbook."));
  if (!isSpellbookManagementEnabled(actor, bookId)) throw new Error(t("NAS management is off for this spellbook."));
  fixture ??= loadActorSpellbook(actor, bookId);
  if (key(fixture.actorUuid) !== key(actor.uuid) || key(fixture.actorId) !== key(actor.id) || fixture.bookId !== bookId) {
    throw new Error(t("This preparation belongs to a different actor or spellbook."));
  }
  if (!fixture.initialized) throw new Error(t("Choose Copy spells from sheet or Start empty before preparing random spells."));
  if (fixture.unavailableReason || fixture.refreshConflicts?.length) throw new Error(fixture.unavailableReason || t("Resolve the spellbook's conflicting changes before choosing random preparation."));
  const removedKnown = new Set(fixture.removedKnownSpellIds ?? []);
  const removedEntries = new Set(fixture.removedEntryIds ?? []);

  const spells = (fixture.spells ?? []).filter((spell) => !(spell.randomPreparation === true && spell.id.startsWith("draft-")))
    .map((spell) => clonePlainData(spell));
  const originalOrder = new Map(spells.map((spell, index) => [spell.id, index]));
  const counts = new Map(spells.map((spell) => [spell.id, spell.spent ?? 0]));
  const candidates = [];
  for (const base of spells.filter((spell) => !spell.isVariant && !spell.missing && !spell.atWill
    && !removedKnown.has(spell.knownSpellId) && !removedEntries.has(spell.id))) {
    const source = getSourceItemForKnownSpell(actor, bookId, base);
    if (!source || source.system?.atWill === true) continue;
    const entries = candidateEntries(actor, source, base, random);
    const existing = new Map(spells.filter((spell) => spell.knownSpellId === base.knownSpellId && !removedEntries.has(spell.id))
      .map((spell) => [signature(spell.preparedEntry, source), spell]));
    for (const [entrySignature, entry] of entries) {
      const matching = entrySignature === "[]" ? base : existing.get(entrySignature);

      const preparedEntry = matching ? { ...clonePlainData(matching.preparedEntry), metamagic: entry.metamagic,
        metamagicOptions: entry.metamagicOptions, preparedSlotLevel: entry.preparedSlotLevel } : entry;
      const selections = normalizeMetamagicSelections(preparedEntry.metamagic, { originalLevel: base.originalLevel, sourceItem: source });
      const preparedSlotLevel = calculatePreparedSlotLevel(base.originalLevel, selections);

      const spell = matching && entrySignature === "[]" ? matching : { ...base, id: preparedEntry.id,
        isVariant: true, spent: matching?.spent ?? 0, preparedEntry, suffix: preparedEntry.suffix, level: preparedSlotLevel,
        preparedSlotLevel, metamagicSelections: selections, metamagic: getMetamagicSummary(selections) };
      if (!spell || spell.missing || spell.atWill || !Number.isFinite(spell.slotCost) || spell.slotCost < 0) continue;
      candidates.push({ spell, entry: preparedEntry, existingId: matching?.id ?? null,
        order: matching ? originalOrder.get(matching.id) : Infinity });
    }
  }
  const warnings = [];
  const levels = [];
  const selected = new Map();
  for (const level of fixture.levels ?? []) {
    const summary = { level: level.level, normalUsed: 0, domainUsed: 0, normalRemaining: null, domainRemaining: null };
    const levelCandidates = candidates.filter(candidate => candidate.spell.level === level.level);
    const rows = new Map(spells.filter(spell => spell.level === level.level && spell.spent > 0)
      .map(spell => [spell.id, { spell, count: spell.spent, order: originalOrder.get(spell.id) }]));
    const levelTotals = (added) => {
      const trial = new Map(rows);
      if (added) {
        const id = added.existingId ?? added;
        trial.set(id, { spell: added.spell, count: (trial.get(id)?.count ?? 0) + 1, order: added.order });
      }
      const ordered = [...trial.values()].sort((a, b) =>
        Number(Boolean(a.spell.regularEligible)) - Number(Boolean(b.spell.regularEligible)) || a.order - b.order);
      const total = { domainCap: level.domainCap, normalUsed: 0, domainUsed: 0 };
      for (const row of ordered) allocatePreparationCopies(total, row.spell, row.count);
      return total;
    };
    let totals = levelTotals();
    for (const pool of ["domain", "normal"]) {
      const cap = level[`${pool}Cap`];
      const availability = level[`${pool}Availability`];
      if (cap === null || cap === undefined || !Number.isFinite(Number(cap))) {
        warnings.push(t("{level}: {pool} capacity is unknown; left unprepared.", {level: level.label ?? t("Level {level}", {level: level.level}), pool: t(pool)}));
        continue;
      }
      summary[`${pool}Remaining`] = Math.max(0, cap - totals[`${pool}Used`]);
      if (cap <= 0 || availability?.unavailable === true || availability?.unknown === true) continue;
      const poolCandidates = levelCandidates.filter(({ spell }) => pool === "domain" ? spell.domain : !spell.domain || spell.regularEligible);
      let allocations = 0;
      while (allocations < MAX_ALLOCATIONS_PER_POOL) {
        const fitting = poolCandidates.filter(candidate => {
          if ((fixture.mode === "hybrid" || candidate.spell.slotCost === 0) && rows.has(candidate.existingId ?? candidate)) return false;
          const trial = levelTotals(candidate);
          return trial.domainUsed <= level.domainCap && (level.normalCap === null || trial.normalUsed <= level.normalCap)
            && (!candidate.spell.slotCost || trial[`${pool}Used`] > totals[`${pool}Used`]);
        });
        if (!fitting.length) break;
        const candidate = fitting[randomIndex(random, fitting.length)];
        selected.set(candidate, (selected.get(candidate) ?? 0) + 1);
        const id = candidate.existingId ?? candidate;
        rows.set(id, { spell: candidate.spell, count: (rows.get(id)?.count ?? 0) + 1, order: candidate.order });
        totals = levelTotals();
        allocations++;
      }
      summary[`${pool}Remaining`] = Math.max(0, cap - totals[`${pool}Used`]);
      summary[`${pool}Used`] = totals[`${pool}Used`];
      if (allocations === MAX_ALLOCATIONS_PER_POOL) warnings.push(t("{level}: random preparation stopped at the safety limit.", {level: level.label ?? t("Level {level}", {level: level.level})}));
    }
    levels.push(summary);
  }
  const ids = new Set(spells.map((spell) => spell.id));
  let ordinal = 0;
  for (const [candidate, count] of selected) {
    let entryId = candidate.existingId;
    if (!entryId) {
      entryId = `draft-${key(createId()) || "random"}`;
      if (ids.has(entryId)) {
        do { entryId = `draft-random-${++ordinal}`; } while (ids.has(entryId));
      }
      const entry = { ...candidate.entry, id: entryId };
      spells.push({ ...candidate.spell, id: entryId, preparedEntry: entry, randomPreparation: true, prepared: 0, count: 0 });
      ids.add(entryId);
    } else if (candidate.spell.isVariant) {
      const index = spells.findIndex((spell) => spell.id === entryId);
      spells[index] = { ...candidate.spell, id: entryId, preparedEntry: { ...candidate.entry, id: entryId } };
    }
    counts.set(entryId, (counts.get(entryId) ?? 0) + count);
  }
  const validation = getActorPreparationValidation({ ...fixture, spells }, counts);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  return { spells, entries: spells.map((spell) => spell.preparedEntry), counts, levels, warnings,
    selectedCount: [...counts.values()].reduce((total, count) => total + count, 0) };
}

export async function applyRandomSpellbookPreparation(actor, bookId, options = {}) {
  const fixture = loadActorSpellbook(actor, bookId);
  const plan = planRandomSpellbookPreparation(actor, bookId, { ...options, fixture });

  if (plan.warnings.some((warning) => warning.includes("capacity is unknown"))) {
    throw new Error(t("Random preparation was not applied because a spellbook capacity is unknown. Saved choices were retained."));
  }
  const result = await applyActorPreparation(actor, bookId, { ...fixture, spells: plan.spells }, plan.counts);
  return { ...result, randomSummary: { selectedCount: plan.selectedCount, levels: plan.levels, warnings: plan.warnings } };
}
