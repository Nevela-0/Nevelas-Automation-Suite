import { clonePlainData } from "../../../../../common/foundryCompat.js";
import { spellbookText as t } from "../i18n.js";
import { rebuildActorDraftSpell } from "../actorPreparation.js";

const count = (mode, value) => mode === "hybrid" ? (Number(value) > 0 ? 1 : 0) : Math.max(0, Math.trunc(Number(value) || 0));
const editableEntryKeys = ["suffix", "suffixMode", "metamagic", "metamagicOptions"];

export const draftMetadata = fixture => JSON.stringify({
  entries: (fixture.spells ?? []).map(spell => ({ id: spell.id, entry: spell.preparedEntry })).sort((a, b) => a.id.localeCompare(b.id)),
  removedEntries: [...(fixture.removedEntryIds ?? [])].sort(), removedKnown: [...(fixture.removedKnownSpellIds ?? [])].sort()
});

export function contextHasDirtyPreparation(context) {
  return Boolean(context?.fixture && ((context.fixture.refreshConflicts?.length ?? 0) > 0
    || draftMetadata(context.fixture) !== context.savedMetadata
    || context.fixture.spells.some(spell => count(context.fixture.mode, context.draft.get(spell.id)) !== (context.savedCounts.get(spell.id) ?? 0))));
}

export function contextHasDirtyOptions(context) {
  const saved = context?.fixture?.preferences ?? { enabled: true, restMode: "inherit" };
  return Boolean(context?.fixture && (context.managementEnabled !== saved.enabled || context.restMode !== saved.restMode));
}

export function rebasePreparation(context, fresh) {
  const old = context.fixture, draft = context.draft;
  const savedEntries = new Map(JSON.parse(context.savedMetadata).entries.map(entry => [entry.id, entry.entry]));
  const dirtyCounts = new Set(old.spells.filter(spell => (old.retainedCountIds ?? []).includes(spell.id)
    || count(old.mode, draft.get(spell.id)) !== (context.savedCounts.get(spell.id) ?? 0)).map(spell => spell.id));
  const oldById = new Map(old.spells.map(spell => [spell.id, spell]));
  const dirtyPatches = new Map();
  for (const spell of old.spells) {
    const saved = savedEntries.get(spell.id);
    const patch = Object.fromEntries(editableEntryKeys.filter(key => JSON.stringify(spell.preparedEntry?.[key]) !== JSON.stringify(saved?.[key]))
      .map(key => [key, clonePlainData(spell.preparedEntry[key])]));
    if (Object.keys(patch).length) dirtyPatches.set(spell.id, patch);
  }
  const savedCounts = new Map(fresh.spells.map(spell => [spell.id, Number(spell.prepared) || 0]));
  const savedMetadata = draftMetadata(fresh);
  const freshById = new Map(fresh.spells.map(spell => [spell.id, spell]));
  const freshKnown = new Set(fresh.spells.map(spell => spell.knownSpellId));
  const conflicts = [];
  fresh.modeConflictReason = old.modeConflictReason || (old.mode !== fresh.mode && contextHasDirtyPreparation(context)
    ? t("The preparation mode changed. Your unsaved changes are still here. Choose Discard changes to use the new mode.") : "");
  if (fresh.modeConflictReason) conflicts.push(fresh.modeConflictReason);
  const spells = fresh.spells.map(spell => {
    const patch = dirtyPatches.get(spell.id);
    const rebuilt = patch && context.actor
      ? rebuildActorDraftSpell(context.actor, fresh.bookId, spell, { ...spell.preparedEntry, ...patch }) : null;
    const result = rebuilt ?? spell;
    if (result.missing && (dirtyCounts.has(spell.id) || patch)) conflicts.push(t("{name}: the original spell is missing. Your unsaved changes are still here. Restore the spell or choose Discard changes.", {name: spell.name}));
    return result;
  });
  for (const spell of old.spells) {
    if (freshById.has(spell.id)) continue;
    if (!spell.id.startsWith("draft-") && !dirtyCounts.has(spell.id) && !dirtyPatches.has(spell.id)) continue;
    const rebuilt = context.actor ? rebuildActorDraftSpell(context.actor, fresh.bookId, spell, spell.preparedEntry) : null;
    const orphan = !freshKnown.has(spell.knownSpellId) || (!spell.id.startsWith("draft-") && !freshById.has(spell.id));
    if (orphan || rebuilt?.missing) {
      conflicts.push(t("{name}: the spell or its inscription is missing. Your unsaved changes are still here. Restore it or choose Discard changes.", {name: spell.name}));
    }
    spells.push({ ...(rebuilt ?? clonePlainData(spell)),
      ...(spell.randomPreparation === true ? { randomPreparation: true } : {}),
      ...(orphan ? { missing: true } : {}) });
  }
  fresh.removedEntryIds = (old.removedEntryIds ?? []).filter(id => freshById.has(id));
  fresh.removedKnownSpellIds = (old.removedKnownSpellIds ?? []).filter(id => freshKnown.has(id));
  fresh.spells = spells.filter(spell => !fresh.removedEntryIds.includes(spell.id) && !fresh.removedKnownSpellIds.includes(spell.knownSpellId));
  fresh.refreshConflicts = [...new Set(conflicts)];
  fresh.retainedCountIds = fresh.spells.filter(spell => dirtyCounts.has(spell.id)
    && (spell.missing || !freshById.has(spell.id) || fresh.modeConflictReason)).map(spell => spell.id);

  const nextDraft = new Map(fresh.spells.map(spell => [spell.id,
    dirtyCounts.has(spell.id) || (spell.id.startsWith("draft-") && oldById.has(spell.id)) ? draft.get(spell.id) : spell.prepared]));
  return { ...context, fixture: fresh, savedCounts, savedMetadata, draft: nextDraft,
    managementEnabled: context.managementEnabled === old.preferences.enabled ? fresh.preferences.enabled : context.managementEnabled,
    restMode: context.restMode === old.preferences.restMode ? fresh.preferences.restMode : context.restMode };
}
