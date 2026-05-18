const PREPARED_CAPABLE_MODES = new Set(["prepared", "hybrid"]);
const EXCLUDED_SPELLBOOK_KEYS = new Set(["spelllike"]);

function isActorDocument(actor) {
  return actor?.documentName === "Actor";
}

function normalizeKey(value) {
  return (value ?? "").toString().trim();
}

export function getEligibleSpellbookIds(actor) {
  if (!isActorDocument(actor)) return [];

  const spellbooks = actor.system?.attributes?.spells?.spellbooks;
  if (!spellbooks || typeof spellbooks !== "object") return [];

  const ids = [];
  for (const [bookId, book] of Object.entries(spellbooks)) {
    const key = normalizeKey(bookId);
    if (!key || EXCLUDED_SPELLBOOK_KEYS.has(key)) continue;
    if (!book || book.inUse === false) continue;

    const mode = normalizeKey(book.spellPreparationMode);
    if (!PREPARED_CAPABLE_MODES.has(mode)) continue;

    ids.push(key);
  }

  return ids;
}

export function hasEligibleSpellbooks(actor) {
  return getEligibleSpellbookIds(actor).length > 0;
}
