import { MODULE } from "../../../../common/module.js";

export const SPELLBOOK_PREPARATION_FLAG = "spellbookPreparation";
export const REST_PREPARE_SPELLBOOKS_OPTION = "nasPrepareSpellbooks";

function coerceHours(value) {
  const hours = Number(value);
  return Number.isFinite(hours) ? hours : 8;
}

export async function setSpellbookPreparationPending(actor, { bookIds = [], hours = 8 } = {}) {
  if (!actor || typeof actor.setFlag !== "function") return;
  if (!Array.isArray(bookIds) || bookIds.length === 0) return;

  await actor.setFlag(MODULE.ID, SPELLBOOK_PREPARATION_FLAG, {
    pending: true,
    bookIds: [...bookIds],
    restedAtWorldTime: game.time?.worldTime ?? null,
    restedAtRealTime: Date.now(),
    hours: coerceHours(hours),
    userId: game.user?.id ?? ""
  });
}

export async function clearSpellbookPreparationPending(actor) {
  if (!actor || typeof actor.unsetFlag !== "function") return;
  if (actor.getFlag?.(MODULE.ID, SPELLBOOK_PREPARATION_FLAG) === undefined) return;
  await actor.unsetFlag(MODULE.ID, SPELLBOOK_PREPARATION_FLAG);
}

export function getSpellbookPreparationPending(actor) {
  const flag = actor?.getFlag?.(MODULE.ID, SPELLBOOK_PREPARATION_FLAG);
  return flag && typeof flag === "object" ? flag : null;
}

export function getPendingSpellbookIds(actor) {
  const flag = getSpellbookPreparationPending(actor);
  if (flag?.pending !== true || !Array.isArray(flag.bookIds)) return [];
  return flag.bookIds.map((id) => `${id}`).filter(Boolean);
}

export function isSpellbookPreparationPending(actor, bookId) {
  return getPendingSpellbookIds(actor).includes(`${bookId}`);
}

export async function completeSpellbookPreparation(actor, bookId) {
  if (!actor || typeof actor.setFlag !== "function") return;

  const flag = getSpellbookPreparationPending(actor);
  if (flag?.pending !== true || !Array.isArray(flag.bookIds)) return;

  const remainingBookIds = flag.bookIds
    .map((id) => `${id}`)
    .filter((id) => id && id !== `${bookId}`);

  if (remainingBookIds.length === 0) {
    await clearSpellbookPreparationPending(actor);
    return;
  }

  await actor.setFlag(MODULE.ID, SPELLBOOK_PREPARATION_FLAG, {
    ...flag,
    pending: true,
    bookIds: remainingBookIds
  });
}
