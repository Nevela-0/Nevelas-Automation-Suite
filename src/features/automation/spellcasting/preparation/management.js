import { clonePlainData } from "../../../../common/foundryCompat.js";
import { spellbookText as t } from "./i18n.js";
import { MODULE } from "../../../../common/module.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import { getSpellbookPreparationPending, SPELLBOOK_PREPARATION_FLAG } from "./flags.js";
import { getKnownSpells } from "./knownSpells.js";
import {
  BASE_PREPARED_VARIANT,
  getGeneratedPreparedSpellItemFlag,
  getGeneratedPreparedSpellItems,
  getPreparedSpellbook,
  getSourceItemForKnownSpell,
  isGeneratedPreparedSpellItem,
  isRegularBasePreparation,
  makeGeneratedPreparedItemData
} from "./preparedItems.js";
import { getSpellbookLevelPreparationCaps } from "./slotAvailability.js";
import {
  getSpellbookPreferences, SPELLBOOK_PREFERENCES_FLAG, SPELLBOOK_REST_MODES
} from "./preferences.js";

const queues = new WeakMap();
const integer = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;

const syncOptions = () => ({ nasSpellbookPreparation: true, pf1: { action: "spellbookPreparation" } });
const prep = item => ({ value: integer(item?.system?.preparation?.value), max: integer(item?.system?.preparation?.max) });
const update = (item, preparation) => ({ _id: item.id,
  "system.preparation.value": preparation.value, "system.preparation.max": preparation.max });

function validate(actor, bookId, options) {
  if (actor?.isOwner !== true) throw new Error(t("You do not have permission to change this spellbook's options."));
  if (!getEligibleSpellbookIds(actor).includes(bookId) || /[.]/.test(bookId)) {
    throw new Error(t("This spellbook cannot use NAS preparation options."));
  }
  if (typeof options?.enabled !== "boolean" || !SPELLBOOK_REST_MODES.includes(options?.restMode)) {
    throw new Error(t("Choose a valid management and rest option."));
  }
  if (typeof actor.update !== "function") throw new Error(t("The actor cannot save spellbook options."));
}

function restorableSource(actor, bookId, entry) {
  const source = getSourceItemForKnownSpell(actor, bookId, entry);
  return source?.system?.atWill === true ? null : source;
}

function verifyRestoredCapacity(actor, bookId, generated, preparations, movedSources) {
  const book = actor.system.attributes.spells.spellbooks[bookId];
  const used = new Map();
  const add = (source, level, preparation) => {
    const count = book.spellPreparationMode === "hybrid" ? (preparation.value > 0 ? 1 : 0) : preparation.max;
    const domain = source.isDomain === true || source.system?.domain === true;
    const pool = domain ? "domain" : "normal";
    const cost = Math.max(0, Number(source.slotCost ?? source.system?.slotCost ?? 1) || 0);
    const key = `${level}:${pool}`;
    const total = (used.get(key) ?? 0) + count * cost;
    used.set(key, total);
    const cap = getSpellbookLevelPreparationCaps(book, level)[pool];
    if (cap !== null && total > cap) {
      throw new Error(t("Level {level} {pool} preparations exceed {cap} slots. Reduce PF1 preparations before enabling NAS again.", {level, pool: t(pool), cap}));
    }
  };
  for (const item of generated) {
    const flag = getGeneratedPreparedSpellItemFlag(item);
    const source = restorableSource(actor, bookId, flag);
    if (!source) continue;
    add(flag?.regularSlotCopy ? item : source, integer(flag?.preparedSlotLevel ?? item.system?.level), preparations.get(item) ?? prep(item));
  }

  for (const source of Array.from(actor.items ?? [])) {
    if (source.type !== "spell" || `${source.system?.spellbook ?? ""}` !== bookId
      || source.system?.atWill === true || isGeneratedPreparedSpellItem(source) || movedSources.has(source.id)) continue;
    add(source, integer(source.system?.level), prep(source));
  }
}

async function saveOptions(actor, bookId, options) {
  validate(actor, bookId, options);
  const current = getSpellbookPreferences(actor, bookId);
  const raw = actor.getFlag?.(MODULE.ID, SPELLBOOK_PREFERENCES_FLAG)?.books?.[bookId]
    ?? actor.flags?.[MODULE.ID]?.[SPELLBOOK_PREFERENCES_FLAG]?.books?.[bookId] ?? {};
  if (current.enabled === options.enabled && current.restMode === options.restMode) return current;

  const managedBefore = getPreparedSpellbook(actor, bookId)?.managed === true;
  const generated = getGeneratedPreparedSpellItems(actor, bookId).filter(item => item.system?.atWill !== true
    && `${item.system?.spellbook ?? ""}` === bookId);
  const updates = new Map(), originals = new Map();
  const creates = [];
  let suspended = raw.suspendedPreparations ?? null;
  const stage = (item, preparation) => {
    if (item.isOwner === false) throw new Error(t("You do not have permission to update {name}.", {name: item.name || t("a spell")}));
    originals.set(item.id, update(item, prep(item)));
    updates.set(item.id, update(item, preparation));
  };

  if (managedBefore && current.enabled !== options.enabled) {
    if (!options.enabled) {
      suspended = generated.map(item => ({ itemId: item.id, ...prep(item) }));
      const restoredSources = new Set();
      for (const item of generated) {

        if (isRegularBasePreparation(item)) continue;
        const flag = getGeneratedPreparedSpellItemFlag(item);
        const source = restorableSource(actor, bookId, flag);
        if ((flag?.variant || BASE_PREPARED_VARIANT) === BASE_PREPARED_VARIANT && source) {

          if (restoredSources.has(source.id)) throw new Error(t("Duplicate NAS base preparations found. Apply a clean preparation before opting out."));
          restoredSources.add(source.id);
          stage(source, prep(item));
        }
        stage(item, { value: 0, max: 0 });
      }
    } else {
      const saved = new Map((Array.isArray(suspended) ? suspended : []).map(entry => [entry.itemId, entry]));
      const restorations = new Map();
      const movedSources = new Set();
      for (const item of generated) {
        if (isRegularBasePreparation(item)) continue;
        const flag = getGeneratedPreparedSpellItemFlag(item);
        const source = restorableSource(actor, bookId, flag);
        if (!source) continue;
        let preparation;
        if ((flag?.variant || BASE_PREPARED_VARIANT) === BASE_PREPARED_VARIANT) {
          if (movedSources.has(source.id)) throw new Error(t("Duplicate NAS base preparations found. Resolve the duplicate copies before enabling NAS."));
          movedSources.add(source.id);
          preparation = prep(source);
          stage(source, { value: 0, max: 0 });
        } else if (saved.has(item.id)) preparation = prep({ system: { preparation: saved.get(item.id) } });
        else continue;
        restorations.set(item, preparation);
        stage(item, preparation);
      }
      for (const known of getKnownSpells(actor, bookId)) {
        const source = restorableSource(actor, bookId, known);
        if (!source || movedSources.has(source.id)) continue;
        const preparation = prep(source);
        const count = actor.system.attributes.spells.spellbooks[bookId].spellPreparationMode === "hybrid"
          ? (preparation.value > 0 ? 1 : 0) : preparation.max;
        if (!count) continue;
        const data = makeGeneratedPreparedItemData(bookId, known, { id: `base:${known.id}`, knownSpellId: known.id,
          variant: BASE_PREPARED_VARIANT }, source, count,
        actor.system.attributes.spells.spellbooks[bookId].spellPreparationMode);
        data.system.preparation = { ...data.system.preparation, ...preparation };
        creates.push(data);
        restorations.set(data, preparation);
        movedSources.add(source.id);
        stage(source, { value: 0, max: 0 });
      }
      verifyRestoredCapacity(actor, bookId, [...generated, ...creates], restorations, movedSources);
      suspended = null;
    }
  }

  const record = { ...clonePlainData(raw), enabled: options.enabled, restMode: options.restMode,
    suspendedPreparations: suspended, updatedBy: globalThis.game?.user?.id ?? "" };
  const flagUpdate = { [`flags.${MODULE.ID}.${SPELLBOOK_PREFERENCES_FLAG}.books.${bookId}`]: record };

  if (!options.enabled) {
    const pending = getSpellbookPreparationPending(actor);
    if (pending?.pending === true && pending.bookIds?.includes(bookId)) {
      const remaining = pending.bookIds.filter(id => id !== bookId);
      if (remaining.length) flagUpdate[`flags.${MODULE.ID}.${SPELLBOOK_PREPARATION_FLAG}`] = { ...clonePlainData(pending), bookIds: remaining };
      else flagUpdate[`flags.${MODULE.ID}.-=${SPELLBOOK_PREPARATION_FLAG}`] = null;
    }
  }
  if (updates.size && typeof actor.updateEmbeddedDocuments !== "function") {
    throw new Error(t("The actor cannot update its spell preparations."));
  }
  if (creates.length && (typeof actor.createEmbeddedDocuments !== "function" || typeof actor.deleteEmbeddedDocuments !== "function")) {
    throw new Error(t("The actor cannot transfer its PF1 preparations back to NAS."));
  }
  let created = [];
  try {
    if (updates.size) await actor.updateEmbeddedDocuments("Item", [...updates.values()], syncOptions());
    if (creates.length) created = await actor.createEmbeddedDocuments("Item", creates, syncOptions());
    await actor.update(flagUpdate, syncOptions());
  }
  catch (error) {
    const createdIds = created.map(item => item.id ?? item._id).filter(Boolean);
    if (createdIds.length) {
      try { await actor.deleteEmbeddedDocuments("Item", createdIds, syncOptions()); }
      catch (rollbackError) { console.error(`${MODULE.ID} | Could not remove incomplete NAS preparations after a failed options save.`, rollbackError); }
    }
    if (originals.size) {
      try { await actor.updateEmbeddedDocuments("Item", [...originals.values()], syncOptions()); }
      catch (rollbackError) { console.error(`${MODULE.ID} | Could not restore preparation after a failed options save.`, rollbackError); }
    }
    throw error;
  }
  if (actor.sheet?.rendered) actor.sheet.render(false);
  return getSpellbookPreferences(actor, bookId);
}

export async function saveSpellbookOptions(actor, bookId, options) {
  if (!actor || typeof actor !== "object") throw new Error(t("Choose an actor spellbook first."));
  const previous = queues.get(actor) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(() => saveOptions(actor, `${bookId ?? ""}`.trim(), options));
  queues.set(actor, result);
  try { return await result; }
  finally { if (queues.get(actor) === result) queues.delete(actor); }
}
