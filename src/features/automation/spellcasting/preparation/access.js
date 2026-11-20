import { SpellbookPreparationApp } from "./app.js";
import { isSpellbookManagementEnabled } from "./preferences.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import { getPendingSpellbookIds } from "./flags.js";

export function openSpellbookOptions(actor, bookId) {
  return SpellbookPreparationApp.open(actor, bookId, { showOptions: true });
}

export function openSpellbookPreparationAfterRest(actor, bookIds) {
  if (actor?.isOwner !== true) return null;
  const eligible = new Set(getEligibleSpellbookIds(actor));
  const pending = new Set(getPendingSpellbookIds(actor));
  const remaining = [...new Set(Array.isArray(bookIds) ? bookIds.map(id => `${id ?? ""}`.trim()) : [])]
    .filter(id => eligible.has(id) && pending.has(id) && isSpellbookManagementEnabled(actor, id));
  if (!remaining.length) return null;
  return SpellbookPreparationApp.open(actor, remaining[0], { restBookIds: remaining });
}
