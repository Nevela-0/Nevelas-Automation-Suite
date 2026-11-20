import { spellbookText as t } from "../i18n.js";
import {
  PROTOTYPE_ID,
  SpellbookPrototypeApp
} from "./app.js";
import { findPrototypePopout } from "./bookPopout.js";
import { getActorSpellbookChoices } from "../actorPreparation.js";

const MODULE_ID = "nevelas-automation-suite";
const STYLE_ID = "nas-spellbook-redesign-prototype-styles";
const STYLE_PATH = `/modules/${MODULE_ID}/src/templates/spellbook/styles.css`;

function ensurePrototypeStyles() {
  const existing = document.getElementById(STYLE_ID);
  if (existing?.getAttribute("href") === STYLE_PATH) return;
  const link = existing ?? document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = STYLE_PATH;
  if (!existing) document.head.appendChild(link);
}

export function openSpellbookPrototype(options = {}) {
  if (!globalThis.game?.ready) {
    ui.notifications.warn(t("Open the spellbook after the Foundry world is ready."));
    return null;
  }

  ensurePrototypeStyles();
  const poppedOut = findPrototypePopout(PROTOTYPE_ID);
  const existing = poppedOut?.app ?? Object.values(ui.windows ?? {}).find((app) => (
    app instanceof SpellbookPrototypeApp || app?.id === PROTOTYPE_ID
  ));
  const restRequest = Array.isArray(options.restBookIds);
  if (existing) {
    const context = existing.functionality;
    const sameActor = options.actor && (context?.actor === options.actor
      || (options.actor.uuid && context?.actor?.uuid === options.actor.uuid));
    const sameBook = options.bookId === undefined || options.bookId === context?.bookId;
    let connected;
    if (restRequest) context?.requestPreparationAfterRest(options.actor, options.restBookIds);
    else if (options.actor && !(sameActor && sameBook)) connected = context?.connectActor(options.actor, options.bookId);
    if (poppedOut) poppedOut.window.focus();
    else if (existing.rendered) existing.bringToFront();
    else existing.render(true);
    if (!restRequest && options.showOptions && connected !== false) existing.showOptions?.();
    return existing;
  }

  const actor = options.actor ?? globalThis.canvas?.tokens?.controlled?.find(token => token.actor?.isOwner)?.actor
    ?? game.user?.character ?? Array.from(game.actors ?? []).find(actor => actor.isOwner && getActorSpellbookChoices(actor).length);
  if (!actor || !getActorSpellbookChoices(actor).length) {
    ui.notifications.warn(t("Choose an actor with an active prepared or hybrid spellbook."));
    return null;
  }
  const app = new SpellbookPrototypeApp({ ...options, actor });
  if (restRequest || options.showOptions) app.showOptions();
  return app.render(true);
}

export { openSpellbookPrototype as openSpellbook };
