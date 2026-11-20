import { MODULE } from "../../../../common/module.js";
import { getSpellbookDefaultRestMode } from "./settings.js";

export const SPELLBOOK_PREFERENCES_FLAG = "spellbookPreferences";
export const SPELLBOOK_REST_MODES = Object.freeze(["inherit", "retain", "reselect", "random"]);

export function getSpellbookPreferences(actor, bookId) {
  const key = `${bookId ?? ""}`.trim();
  const flag = actor?.getFlag?.(MODULE.ID, SPELLBOOK_PREFERENCES_FLAG)
    ?? actor?.flags?.[MODULE.ID]?.[SPELLBOOK_PREFERENCES_FLAG];
  const record = flag?.books?.[key];
  return {
    enabled: record?.enabled !== false,
    restMode: SPELLBOOK_REST_MODES.includes(record?.restMode) ? record.restMode : "inherit"
  };
}

export function isSpellbookManagementEnabled(actor, bookId) {
  return getSpellbookPreferences(actor, bookId).enabled;
}

export function getEffectiveSpellbookRestMode(actor, bookId) {
  const { restMode } = getSpellbookPreferences(actor, bookId);
  return restMode === "inherit" ? getSpellbookDefaultRestMode() : restMode;
}
