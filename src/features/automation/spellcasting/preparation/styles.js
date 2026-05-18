import { MODULE } from "../../../../common/module.js";

const STYLESHEET_ID = "nas-spellbook-preparation-styles";
const STYLESHEET_PATH = `modules/${MODULE.ID}/src/templates/css/spellbook-preparation.css`;

export function ensureSpellbookPreparationStyles() {
  if (!globalThis.document?.head) return;
  if (document.getElementById(STYLESHEET_ID)) return;

  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = STYLESHEET_PATH;
  document.head.appendChild(link);
}

