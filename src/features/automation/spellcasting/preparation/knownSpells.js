import { MODULE } from "../../../../common/module.js";
import { isGeneratedPreparedSpellItem } from "./preparedItems.js";

export const SPELLBOOK_KNOWN_SPELLS_FLAG = "spellbookKnownSpells";
export const SPELLBOOK_KNOWN_SPELLS_VERSION = 1;

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function cloneData(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function randomId() {
  return globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nowMetadata() {
  return {
    importedAtWorldTime: game.time?.worldTime ?? null,
    importedAtRealTime: Date.now(),
    userId: game.user?.id ?? ""
  };
}

function getSpellItemData(item, bookId) {
  const data = cloneData(item?.toObject?.() ?? item ?? {});
  delete data._id;

  if (!data.system || typeof data.system !== "object") data.system = {};
  data.system.spellbook = bookId;

  if (data.system.atWill !== true) {
    if (!data.system.preparation || typeof data.system.preparation !== "object") {
      data.system.preparation = {};
    }
    data.system.preparation.value = 0;
    data.system.preparation.max = 0;
  }

  return data;
}

function getSpellLevel(item) {
  const level = Number(item?.system?.level);
  return Number.isInteger(level) ? level : 99;
}

function getItemSort(item) {
  const sort = Number(item?.sort);
  return Number.isFinite(sort) ? sort : 0;
}

function sortSpellItems(items) {
  return [...items].sort((a, b) => {
    const aLevel = getSpellLevel(a);
    const bLevel = getSpellLevel(b);
    if (aLevel !== bLevel) return aLevel - bLevel;

    const aSort = getItemSort(a);
    const bSort = getItemSort(b);
    if (aSort !== bSort) return aSort - bSort;

    return (a?.name ?? "").localeCompare(b?.name ?? "", game.i18n?.lang, { sensitivity: "base", numeric: true });
  });
}

function createKnownSpellEntry(item, bookId) {
  return {
    id: `known-${randomId()}`,
    sourceItemId: item?.id ?? "",
    sourceUuid: item?.uuid ?? "",
    spellbookId: bookId,
    name: item?.name ?? "",
    img: item?.img || "icons/svg/book.svg",
    level: getSpellLevel(item),
    sort: getItemSort(item),
    itemData: getSpellItemData(item, bookId)
  };
}

function normalizeKnownSpellEntry(entry, bookId) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeId(entry.id) || `known-${randomId()}`;
  const spellbookId = normalizeId(entry.spellbookId) || bookId;
  return {
    id,
    sourceItemId: normalizeId(entry.sourceItemId),
    sourceUuid: normalizeId(entry.sourceUuid),
    spellbookId,
    name: normalizeId(entry.name),
    img: entry.img || "icons/svg/book.svg",
    level: Number.isInteger(Number(entry.level)) ? Number(entry.level) : 99,
    sort: Number.isFinite(Number(entry.sort)) ? Number(entry.sort) : 0,
    itemData: entry.itemData && typeof entry.itemData === "object" ? cloneData(entry.itemData) : {}
  };
}

function normalizeKnownSpellbook(book, bookId) {
  const knownSpells = Array.isArray(book?.knownSpells)
    ? book.knownSpells
      .map((entry) => normalizeKnownSpellEntry(entry, bookId))
      .filter(Boolean)
    : [];

  return {
    initialized: book?.initialized === true,
    importedAtWorldTime: book?.importedAtWorldTime ?? null,
    importedAtRealTime: book?.importedAtRealTime ?? null,
    userId: normalizeId(book?.userId),
    knownSpells
  };
}

function normalizeKnownSpellbooksFlag(flag) {
  const books = {};
  const rawBooks = flag?.books && typeof flag.books === "object" ? flag.books : {};

  for (const [bookId, book] of Object.entries(rawBooks)) {
    const normalizedBookId = normalizeId(bookId);
    if (!normalizedBookId) continue;
    books[normalizedBookId] = normalizeKnownSpellbook(book, normalizedBookId);
  }

  return {
    version: SPELLBOOK_KNOWN_SPELLS_VERSION,
    books
  };
}

async function setKnownSpellbooksFlag(actor, flag) {
  if (!actor || typeof actor.setFlag !== "function") return;
  await actor.setFlag(MODULE.ID, SPELLBOOK_KNOWN_SPELLS_FLAG, normalizeKnownSpellbooksFlag(flag));
}

export function getKnownSpellbooksFlag(actor) {
  return normalizeKnownSpellbooksFlag(actor?.getFlag?.(MODULE.ID, SPELLBOOK_KNOWN_SPELLS_FLAG));
}

export function getKnownSpellbook(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return null;
  return getKnownSpellbooksFlag(actor).books[normalizedBookId] ?? null;
}

export function isKnownSpellbookInitialized(actor, bookId) {
  return getKnownSpellbook(actor, bookId)?.initialized === true;
}

export function getKnownSpells(actor, bookId) {
  return getKnownSpellbook(actor, bookId)?.knownSpells ?? [];
}

export function getCurrentSpellItemsForBook(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  return sortSpellItems(Array.from(actor?.items ?? [])
    .filter((item) => (
      item?.type === "spell"
      && normalizeId(item.system?.spellbook) === normalizedBookId
      && !isGeneratedPreparedSpellItem(item)
    )));
}

export function countMissingKnownSpellImports(actor, bookId) {
  const knownSourceIds = new Set(getKnownSpells(actor, bookId)
    .map((entry) => normalizeId(entry.sourceItemId))
    .filter(Boolean));

  return getCurrentSpellItemsForBook(actor, bookId)
    .filter((item) => !knownSourceIds.has(normalizeId(item.id)))
    .length;
}

export async function initializeKnownSpellbook(actor, bookId, { importCurrent = false } = {}) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return null;

  const flag = getKnownSpellbooksFlag(actor);
  const existing = normalizeKnownSpellbook(flag.books[normalizedBookId], normalizedBookId);
  const metadata = nowMetadata();
  const knownSpells = importCurrent
    ? getCurrentSpellItemsForBook(actor, normalizedBookId).map((item) => createKnownSpellEntry(item, normalizedBookId))
    : existing.knownSpells;

  flag.books[normalizedBookId] = {
    ...existing,
    ...metadata,
    initialized: true,
    knownSpells
  };

  await setKnownSpellbooksFlag(actor, flag);
  return flag.books[normalizedBookId];
}

export async function importMissingKnownSpells(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return { added: 0, book: null };

  const flag = getKnownSpellbooksFlag(actor);
  const existing = normalizeKnownSpellbook(flag.books[normalizedBookId], normalizedBookId);
  const knownSourceIds = new Set(existing.knownSpells
    .map((entry) => normalizeId(entry.sourceItemId))
    .filter(Boolean));
  const missingEntries = getCurrentSpellItemsForBook(actor, normalizedBookId)
    .filter((item) => !knownSourceIds.has(normalizeId(item.id)))
    .map((item) => createKnownSpellEntry(item, normalizedBookId));

  const metadata = existing.initialized ? {} : nowMetadata();
  flag.books[normalizedBookId] = {
    ...existing,
    ...metadata,
    initialized: true,
    knownSpells: [...existing.knownSpells, ...missingEntries]
  };

  await setKnownSpellbooksFlag(actor, flag);
  return { added: missingEntries.length, book: flag.books[normalizedBookId] };
}

export async function removeKnownSpell(actor, bookId, knownSpellId) {
  const normalizedBookId = normalizeId(bookId);
  const normalizedKnownSpellId = normalizeId(knownSpellId);
  if (!normalizedBookId || !normalizedKnownSpellId) return false;

  const flag = getKnownSpellbooksFlag(actor);
  const existing = normalizeKnownSpellbook(flag.books[normalizedBookId], normalizedBookId);
  const nextKnownSpells = existing.knownSpells.filter((entry) => entry.id !== normalizedKnownSpellId);
  if (nextKnownSpells.length === existing.knownSpells.length) return false;

  flag.books[normalizedBookId] = {
    ...existing,
    initialized: true,
    knownSpells: nextKnownSpells
  };

  await setKnownSpellbooksFlag(actor, flag);
  return true;
}
