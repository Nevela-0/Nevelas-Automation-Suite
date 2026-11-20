import { MODULE } from "../../../../common/module.js";
import { registerSpellbookPreparationActorSheetHooks } from "./actorSheet.js";
import { registerSpellbookPreparationItemHintsCompatibility } from "./itemHintsCompat.js";
import { registerSpellbookPreparationRestHooks } from "./restHooks.js";

const STYLESHEET_ID = "nas-spellbook-preparation-styles";
const STYLESHEET_PATH = `modules/${MODULE.ID}/src/templates/css/spellbook-preparation.css`;
let registered = false;

function ensureSpellbookPreparationStyles() {
  if (!globalThis.document?.head || document.getElementById(STYLESHEET_ID)) return;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = STYLESHEET_PATH;
  document.head.appendChild(link);
}

export function registerSpellbookPreparation() {
  if (registered) return;
  registered = true;

  ensureSpellbookPreparationStyles();
  registerSpellbookPreparationRestHooks();
  registerSpellbookPreparationActorSheetHooks();
  registerSpellbookPreparationItemHintsCompatibility();
}
