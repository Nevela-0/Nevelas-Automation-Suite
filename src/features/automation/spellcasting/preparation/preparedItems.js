import { MODULE } from "../../../../common/module.js";
import {
  AUTO_SUFFIX_MODE,
  MANUAL_SUFFIX_MODE,
  buildPreparedEntryDisplayName,
  buildMetamagicOptionsFromSelections,
  calculatePreparedSlotLevel,
  normalizeMetamagicOptions,
  normalizeMetamagicSelections,
  normalizeSuffixMode
} from "./metamagicInscription.js";

export const SPELLBOOK_PREPARED_ITEM_FLAG = "spellbookPreparedSpell";
export const SPELLBOOK_PREPARED_ITEMS_FLAG = "spellbookPreparedSpells";
export const SPELLBOOK_PREPARED_ITEM_VERSION = 1;
export const SPELLBOOK_PREPARED_ITEMS_VERSION = 1;
export const BASE_PREPARED_VARIANT = "base";
export const CUSTOM_PREPARED_VARIANT = "custom";
const BASE_PREPARED_ENTRY_PREFIX = "base:";

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function cloneData(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function coerceNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getActorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function getActorItem(actor, itemId) {
  const id = normalizeId(itemId);
  if (!id) return null;
  return actor?.items?.get?.(id) ?? getActorItems(actor).find((item) => item?.id === id) ?? null;
}

function getPreparedItemFlag(item) {
  return item?.getFlag?.(MODULE.ID, SPELLBOOK_PREPARED_ITEM_FLAG)
    ?? item?.flags?.[MODULE.ID]?.[SPELLBOOK_PREPARED_ITEM_FLAG]
    ?? null;
}

function getSpellLevel(itemOrData, fallback = 0) {
  const level = Number(itemOrData?.system?.level ?? itemOrData?.level ?? fallback);
  return Number.isInteger(level) ? Math.max(0, level) : 0;
}

function isAtWillSpell(itemOrData) {
  return itemOrData?.system?.atWill === true;
}

function getPreparedEntryIdForKnown(knownSpellId) {
  return `${BASE_PREPARED_ENTRY_PREFIX}${normalizeId(knownSpellId)}`;
}

function isLiveSourceSpell(item, bookId) {
  return item?.type === "spell"
    && normalizeId(item.system?.spellbook) === normalizeId(bookId)
    && !isGeneratedPreparedSpellItem(item);
}

function normalizePreparedSpellbook(book) {
  return {
    managed: book?.managed === true,
    managedAtWorldTime: book?.managedAtWorldTime ?? null,
    managedAtRealTime: book?.managedAtRealTime ?? null,
    userId: normalizeId(book?.userId),
    entries: Array.isArray(book?.entries)
      ? book.entries.map((entry) => normalizeCustomPreparedEntry(entry)).filter(Boolean)
      : []
  };
}

function normalizeCustomPreparedEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id) || `entry-${randomId()}`;
  const knownSpellId = normalizeId(entry.knownSpellId);
  if (!knownSpellId) return null;

  const originalSpellLevel = getSpellLevel({ level: entry.originalSpellLevel }, 0);
  const metamagic = normalizeMetamagicSelections(entry.metamagic, { originalLevel: originalSpellLevel });
  const preparedSlotLevel = calculatePreparedSlotLevel(originalSpellLevel, metamagic);
  const sort = Number(entry.sort);
  const suffix = normalizeId(entry.suffix) || "Variant";
  const suffixMode = entry.suffixMode === undefined && suffix !== "Variant"
    ? MANUAL_SUFFIX_MODE
    : normalizeSuffixMode(entry.suffixMode);

  return {
    id,
    knownSpellId,
    variant: CUSTOM_PREPARED_VARIANT,
    suffix,
    originalSpellLevel,
    preparedSlotLevel,
    metamagic,
    metamagicOptions: {
      ...buildMetamagicOptionsFromSelections(metamagic),
      ...normalizeMetamagicOptions(entry.metamagicOptions, { originalLevel: originalSpellLevel })
    },
    suffixMode,
    sort: Number.isFinite(sort) ? sort : 0
  };
}

function normalizePreparedSpellbooksFlag(flag) {
  const books = {};
  const rawBooks = flag?.books && typeof flag.books === "object" ? flag.books : {};

  for (const [bookId, book] of Object.entries(rawBooks)) {
    const normalizedBookId = normalizeId(bookId);
    if (!normalizedBookId) continue;
    books[normalizedBookId] = normalizePreparedSpellbook(book);
  }

  return {
    version: SPELLBOOK_PREPARED_ITEMS_VERSION,
    books
  };
}

async function setPreparedSpellbooksFlag(actor, flag) {
  if (!actor || typeof actor.setFlag !== "function") return;
  await actor.setFlag(MODULE.ID, SPELLBOOK_PREPARED_ITEMS_FLAG, normalizePreparedSpellbooksFlag(flag));
}

function nowMetadata() {
  return {
    managedAtWorldTime: game.time?.worldTime ?? null,
    managedAtRealTime: Date.now(),
    userId: game.user?.id ?? ""
  };
}

function makePreparedItemFlag(bookId, knownSpell, sourceItem, {
  preparedEntry = null,
  variant = BASE_PREPARED_VARIANT,
  preparedSlotLevel = null,
  suffix = ""
} = {}) {
  const originalSpellLevel = getSpellLevel(sourceItem, knownSpell?.level ?? 0);
  const entryId = normalizeId(preparedEntry?.id) || getPreparedEntryIdForKnown(knownSpell?.id);
  const entryVariant = normalizeId(preparedEntry?.variant) || variant || BASE_PREPARED_VARIANT;
  const slotLevel = preparedEntry?.preparedSlotLevel !== undefined
    ? getSpellLevel({ level: preparedEntry.preparedSlotLevel }, originalSpellLevel)
    : (preparedSlotLevel === null ? originalSpellLevel : getSpellLevel({ level: preparedSlotLevel }, originalSpellLevel));
  const entrySuffix = normalizeId(preparedEntry?.suffix ?? suffix);
  const metamagic = normalizeMetamagicSelections(preparedEntry?.metamagic, { originalLevel: originalSpellLevel });

  return {
    version: SPELLBOOK_PREPARED_ITEM_VERSION,
    generated: true,
    spellbookId: normalizeId(bookId),
    knownSpellId: normalizeId(knownSpell?.id),
    preparedEntryId: entryId,
    sourceItemId: normalizeId(sourceItem?.id ?? knownSpell?.sourceItemId),
    sourceUuid: normalizeId(sourceItem?.uuid ?? knownSpell?.sourceUuid),
    variant: entryVariant,
    suffix: entrySuffix,
    originalSpellLevel,
    preparedSlotLevel: slotLevel,
    metamagic,
    metamagicOptions: {
      ...buildMetamagicOptionsFromSelections(metamagic),
      ...normalizeMetamagicOptions(preparedEntry?.metamagicOptions, { originalLevel: originalSpellLevel })
    },
    suffixMode: normalizeSuffixMode(preparedEntry?.suffixMode)
  };
}

function makeGeneratedPreparedItemData(bookId, knownSpell, preparedEntry, sourceItem, count, mode) {
  const data = cloneData(sourceItem?.toObject?.() ?? sourceItem ?? {});
  delete data._id;

  data.type = "spell";
  data.name = buildPreparedEntryDisplayName(sourceItem?.name || knownSpell?.name || data.name || "", preparedEntry)
    || data.name
    || knownSpell?.name
    || "";
  data.img = data.img || knownSpell?.img || "icons/svg/book.svg";
  data.system ??= {};
  data.system.spellbook = normalizeId(bookId);
  data.system.level = getSpellLevel(sourceItem, knownSpell?.level ?? data.system.level ?? 0);
  data.system.preparation ??= {};

  if (mode === "hybrid") {
    data.system.preparation.value = count > 0 ? 1 : 0;
  } else {
    data.system.preparation.value = count;
    data.system.preparation.max = count;
  }

  data.flags ??= {};
  data.flags[MODULE.ID] ??= {};
  data.flags[MODULE.ID][SPELLBOOK_PREPARED_ITEM_FLAG] = makePreparedItemFlag(bookId, knownSpell, sourceItem, {
    preparedEntry
  });

  return data;
}

function buildGeneratedPreparedItemUpdate(item, bookId, knownSpell, preparedEntry, sourceItem, count, mode) {
  const data = makeGeneratedPreparedItemData(bookId, knownSpell, preparedEntry, sourceItem, count, mode);
  data._id = item.id;
  return data;
}

function getSourceItemForKnownSpell(actor, bookId, knownSpell) {
  const source = getActorItem(actor, knownSpell?.sourceItemId);
  return isLiveSourceSpell(source, bookId) ? source : null;
}

function getSyncOptions() {
  return {
    nasSpellbookPreparation: true,
    pf1: { action: "spellbookPreparation" }
  };
}

export function isGeneratedPreparedSpellItem(item) {
  const flag = getPreparedItemFlag(item);
  return item?.type === "spell" && flag?.generated === true;
}

export function getGeneratedPreparedSpellItemFlag(item) {
  return getPreparedItemFlag(item);
}

export function getPreparedSpellbooksFlag(actor) {
  return normalizePreparedSpellbooksFlag(actor?.getFlag?.(MODULE.ID, SPELLBOOK_PREPARED_ITEMS_FLAG));
}

export function getPreparedSpellbook(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return null;
  return getPreparedSpellbooksFlag(actor).books[normalizedBookId] ?? null;
}

export function isSpellbookPreparedItemsManaged(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return false;
  return getPreparedSpellbooksFlag(actor).books[normalizedBookId]?.managed === true;
}

export function getCustomPreparedSpellEntries(actor, bookId) {
  return getPreparedSpellbook(actor, bookId)?.entries ?? [];
}

export function getBasePreparedEntryId(knownSpellId) {
  return getPreparedEntryIdForKnown(knownSpellId);
}

export function getPreparedEntriesForKnownSpell(actor, bookId, knownSpell) {
  const knownSpellId = normalizeId(knownSpell?.id);
  if (!knownSpellId) return [];

  const originalSpellLevel = getSpellLevel({ level: knownSpell?.level }, 0);
  const base = {
    id: getPreparedEntryIdForKnown(knownSpellId),
    knownSpellId,
    variant: BASE_PREPARED_VARIANT,
    suffix: "",
    originalSpellLevel,
    preparedSlotLevel: originalSpellLevel,
    metamagic: [],
    metamagicOptions: {},
    suffixMode: AUTO_SUFFIX_MODE,
    sort: -1
  };
  const customEntries = getCustomPreparedSpellEntries(actor, bookId)
    .filter((entry) => entry.knownSpellId === knownSpellId)
    .sort((a, b) => {
      if (a.sort !== b.sort) return a.sort - b.sort;
      return a.suffix.localeCompare(b.suffix, game.i18n?.lang, { sensitivity: "base", numeric: true });
    });

  return [base, ...customEntries];
}

export function getPreparedEntriesForKnownSpells(actor, bookId, knownSpells) {
  return (knownSpells ?? []).flatMap((knownSpell) => getPreparedEntriesForKnownSpell(actor, bookId, knownSpell));
}

export async function addPreparedSpellVariant(actor, bookId, knownSpell, { suffix = "Variant" } = {}) {
  const normalizedBookId = normalizeId(bookId);
  const knownSpellId = normalizeId(knownSpell?.id);
  if (!normalizedBookId || !knownSpellId) return null;

  const flag = getPreparedSpellbooksFlag(actor);
  const book = normalizePreparedSpellbook(flag.books[normalizedBookId]);
  const existingForSpell = book.entries.filter((entry) => entry.knownSpellId === knownSpellId);
  const maxSort = existingForSpell.reduce((max, entry) => Math.max(max, Number(entry.sort) || 0), -1);
  const originalSpellLevel = getSpellLevel({ level: knownSpell?.level }, 0);
  const entry = normalizeCustomPreparedEntry({
    id: `entry-${randomId()}`,
    knownSpellId,
    variant: CUSTOM_PREPARED_VARIANT,
    suffix,
    originalSpellLevel,
    preparedSlotLevel: originalSpellLevel,
    metamagic: [],
    metamagicOptions: {},
    suffixMode: AUTO_SUFFIX_MODE,
    sort: maxSort + 1
  });

  book.entries = [...book.entries, entry];
  flag.books[normalizedBookId] = book;
  await setPreparedSpellbooksFlag(actor, flag);
  return entry;
}

export async function updatePreparedSpellVariant(actor, bookId, entryId, {
  suffix,
  metamagic,
  metamagicOptions,
  suffixMode,
  preparedSlotLevel
} = {}) {
  const normalizedBookId = normalizeId(bookId);
  const normalizedEntryId = normalizeId(entryId);
  if (!normalizedBookId || !normalizedEntryId) return null;

  const flag = getPreparedSpellbooksFlag(actor);
  const book = normalizePreparedSpellbook(flag.books[normalizedBookId]);
  let updated = null;
  book.entries = book.entries.map((entry) => {
    if (entry.id !== normalizedEntryId) return entry;
    updated = normalizeCustomPreparedEntry({
      ...entry,
      ...(suffix !== undefined ? { suffix: normalizeId(suffix) || "Variant" } : {}),
      ...(metamagic !== undefined ? { metamagic } : {}),
      ...(metamagicOptions !== undefined ? { metamagicOptions } : {}),
      ...(suffixMode !== undefined ? { suffixMode } : {}),
      ...(preparedSlotLevel !== undefined ? { preparedSlotLevel } : {})
    });
    return updated;
  });

  if (!updated) return null;
  flag.books[normalizedBookId] = book;
  await setPreparedSpellbooksFlag(actor, flag);
  return updated;
}

export async function removePreparedSpellVariant(actor, bookId, entryId) {
  const normalizedBookId = normalizeId(bookId);
  const normalizedEntryId = normalizeId(entryId);
  if (!normalizedBookId || !normalizedEntryId) return false;

  const flag = getPreparedSpellbooksFlag(actor);
  const book = normalizePreparedSpellbook(flag.books[normalizedBookId]);
  const nextEntries = book.entries.filter((entry) => entry.id !== normalizedEntryId);
  if (nextEntries.length === book.entries.length) return false;

  book.entries = nextEntries;
  flag.books[normalizedBookId] = book;
  await setPreparedSpellbooksFlag(actor, flag);
  return true;
}

export async function removePreparedSpellVariantsForKnown(actor, bookId, knownSpellId) {
  const normalizedBookId = normalizeId(bookId);
  const normalizedKnownSpellId = normalizeId(knownSpellId);
  if (!normalizedBookId || !normalizedKnownSpellId) return 0;

  const flag = getPreparedSpellbooksFlag(actor);
  const book = normalizePreparedSpellbook(flag.books[normalizedBookId]);
  const nextEntries = book.entries.filter((entry) => entry.knownSpellId !== normalizedKnownSpellId);
  const removed = book.entries.length - nextEntries.length;
  if (removed <= 0) return 0;

  book.entries = nextEntries;
  flag.books[normalizedBookId] = book;
  await setPreparedSpellbooksFlag(actor, flag);
  return removed;
}

export async function markSpellbookPreparedItemsManaged(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return;

  const flag = getPreparedSpellbooksFlag(actor);
  flag.books[normalizedBookId] = {
    ...normalizePreparedSpellbook(flag.books[normalizedBookId]),
    ...nowMetadata(),
    managed: true
  };

  await setPreparedSpellbooksFlag(actor, flag);
}

export function getGeneratedPreparedSpellItems(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return [];

  return getActorItems(actor).filter((item) => {
    const flag = getPreparedItemFlag(item);
    return item?.type === "spell"
      && flag?.generated === true
      && normalizeId(flag.spellbookId) === normalizedBookId;
  });
}

export function findGeneratedPreparedSpellItem(actor, bookId, knownSpellId, variant = BASE_PREPARED_VARIANT) {
  const normalizedKnownSpellId = normalizeId(knownSpellId);
  const normalizedVariant = normalizeId(variant) || BASE_PREPARED_VARIANT;
  if (!normalizedKnownSpellId) return null;

  return getGeneratedPreparedSpellItems(actor, bookId).find((item) => {
    const flag = getPreparedItemFlag(item);
    return normalizeId(flag?.knownSpellId) === normalizedKnownSpellId
      && (normalizeId(flag?.variant) || BASE_PREPARED_VARIANT) === normalizedVariant;
  }) ?? null;
}

export function findGeneratedPreparedSpellItemForEntry(actor, bookId, preparedEntry) {
  const entryId = normalizeId(preparedEntry?.id);
  const knownSpellId = normalizeId(preparedEntry?.knownSpellId);
  const variant = normalizeId(preparedEntry?.variant) || BASE_PREPARED_VARIANT;
  if (!entryId || !knownSpellId) return null;

  return getGeneratedPreparedSpellItems(actor, bookId).find((item) => {
    const flag = getPreparedItemFlag(item);
    const flagEntryId = normalizeId(flag?.preparedEntryId);
    if (flagEntryId) return flagEntryId === entryId;

    return variant === BASE_PREPARED_VARIANT
      && normalizeId(flag?.knownSpellId) === knownSpellId
      && (normalizeId(flag?.variant) || BASE_PREPARED_VARIANT) === BASE_PREPARED_VARIANT;
  }) ?? null;
}

export function getGeneratedPreparedCount(item, mode) {
  if (!item || isAtWillSpell(item)) return 0;
  if (mode === "hybrid") return Number(item.system?.preparation?.value ?? 0) > 0 ? 1 : 0;
  return coerceNonNegativeInteger(item.system?.preparation?.max ?? item.system?.preparation?.value ?? 0);
}

export async function deletePreparedSpellItemsForKnown(actor, bookId, knownSpellId) {
  const normalizedKnownSpellId = normalizeId(knownSpellId);
  if (!normalizedKnownSpellId) return 0;

  const ids = getGeneratedPreparedSpellItems(actor, bookId)
    .filter((item) => normalizeId(getPreparedItemFlag(item)?.knownSpellId) === normalizedKnownSpellId)
    .map((item) => item.id)
    .filter(Boolean);

  if (ids.length > 0) {
    await actor.deleteEmbeddedDocuments("Item", ids, getSyncOptions());
  }

  return ids.length;
}

export async function deletePreparedSpellItemForEntry(actor, bookId, entryId) {
  const normalizedEntryId = normalizeId(entryId);
  if (!normalizedEntryId) return 0;

  const ids = getGeneratedPreparedSpellItems(actor, bookId)
    .filter((item) => {
      const flag = getPreparedItemFlag(item);
      const preparedEntryId = normalizeId(flag?.preparedEntryId)
        || ((normalizeId(flag?.variant) || BASE_PREPARED_VARIANT) === BASE_PREPARED_VARIANT
          ? getPreparedEntryIdForKnown(flag?.knownSpellId)
          : "");
      return preparedEntryId === normalizedEntryId;
    })
    .map((item) => item.id)
    .filter(Boolean);

  if (ids.length > 0) {
    await actor.deleteEmbeddedDocuments("Item", ids, getSyncOptions());
  }

  return ids.length;
}

export async function clearSourceSpellPreparationCounts(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return 0;

  const updates = getActorItems(actor)
    .filter((item) => (
      item?.type === "spell"
      && normalizeId(item.system?.spellbook) === normalizedBookId
      && !isGeneratedPreparedSpellItem(item)
      && !isAtWillSpell(item)
    ))
    .map((item) => ({
      _id: item.id,
      "system.preparation.value": 0,
      "system.preparation.max": 0
    }));

  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments("Item", updates, getSyncOptions());
  }

  return updates.length;
}

export async function syncGeneratedPreparedSpellItems(actor, bookId, knownSpells, preparedEntries, desiredById, mode) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return { created: 0, updated: 0, deleted: 0 };

  const knownSpellMap = new Map((knownSpells ?? [])
    .map((knownSpell) => [normalizeId(knownSpell?.id), knownSpell])
    .filter(([knownSpellId]) => Boolean(knownSpellId)));
  const existingByEntryId = new Map();
  for (const item of getGeneratedPreparedSpellItems(actor, normalizedBookId)) {
    const flag = getPreparedItemFlag(item);
    const knownSpellId = normalizeId(flag?.knownSpellId);
    if (!knownSpellId) continue;
    const entryId = normalizeId(flag?.preparedEntryId)
      || ((normalizeId(flag?.variant) || BASE_PREPARED_VARIANT) === BASE_PREPARED_VARIANT
        ? getPreparedEntryIdForKnown(knownSpellId)
        : "");
    if (!entryId) continue;
    const items = existingByEntryId.get(entryId) ?? [];
    items.push(item);
    existingByEntryId.set(entryId, items);
  }

  const creates = [];
  const updates = [];
  const deleteIds = [];
  const entryIds = new Set();

  for (const preparedEntry of preparedEntries ?? []) {
    const entryId = normalizeId(preparedEntry?.id);
    const knownSpellId = normalizeId(preparedEntry?.knownSpellId);
    if (!entryId || !knownSpellId) continue;
    entryIds.add(entryId);

    const knownSpell = knownSpellMap.get(knownSpellId);
    const existing = existingByEntryId.get(entryId) ?? [];
    const sourceItem = getSourceItemForKnownSpell(actor, normalizedBookId, knownSpell);
    const sourceAtWill = isAtWillSpell(sourceItem ?? knownSpell?.itemData);
    const desiredCount = coerceNonNegativeInteger(desiredById?.get?.(entryId) ?? 0);
    const count = mode === "hybrid" ? (desiredCount > 0 ? 1 : 0) : desiredCount;
    const primaryExisting = existing[0] ?? null;

    if (!knownSpell || !sourceItem || sourceAtWill || count <= 0) {
      deleteIds.push(...existing.map((item) => item.id).filter(Boolean));
      continue;
    }

    if (primaryExisting) {
      updates.push(buildGeneratedPreparedItemUpdate(primaryExisting, normalizedBookId, knownSpell, preparedEntry, sourceItem, count, mode));
      deleteIds.push(...existing.slice(1).map((item) => item.id).filter(Boolean));
    } else {
      creates.push(makeGeneratedPreparedItemData(normalizedBookId, knownSpell, preparedEntry, sourceItem, count, mode));
    }
  }

  for (const [entryId, items] of existingByEntryId.entries()) {
    if (!entryIds.has(entryId)) {
      deleteIds.push(...items.map((item) => item.id).filter(Boolean));
    }
  }

  const uniqueDeleteIds = Array.from(new Set(deleteIds));
  if (uniqueDeleteIds.length > 0) {
    await actor.deleteEmbeddedDocuments("Item", uniqueDeleteIds, getSyncOptions());
  }
  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments("Item", updates, getSyncOptions());
  }
  if (creates.length > 0) {
    await actor.createEmbeddedDocuments("Item", creates, getSyncOptions());
  }

  await clearSourceSpellPreparationCounts(actor, normalizedBookId);
  await markSpellbookPreparedItemsManaged(actor, normalizedBookId);

  return {
    created: creates.length,
    updated: updates.length,
    deleted: uniqueDeleteIds.length
  };
}
