import { registerSpellbookPreparationActorSheetHooks } from "./actorSheet.js";
import { registerSpellbookPreparationItemHintsCompatibility } from "./itemHintsCompat.js";
import { registerSpellbookPreparationRestHooks } from "./restHooks.js";
import { ensureSpellbookPreparationStyles } from "./styles.js";

let registered = false;

export function registerSpellbookPreparation() {
  if (registered) return;
  registered = true;

  ensureSpellbookPreparationStyles();
  registerSpellbookPreparationRestHooks();
  registerSpellbookPreparationActorSheetHooks();
  registerSpellbookPreparationItemHintsCompatibility();
}
