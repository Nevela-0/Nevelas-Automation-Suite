import { MODULE } from "../../../../common/module.js";
import { elementFromHtmlLike } from "../../../../common/foundryCompat.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import {
  completeSpellbookPreparation,
  getPendingSpellbookIds,
  REST_PREPARE_SPELLBOOKS_OPTION,
  setSpellbookPreparationPending
} from "./flags.js";
import { openSpellbookPreparationAfterRest } from "./access.js";
import { getEffectiveSpellbookRestMode, isSpellbookManagementEnabled } from "./preferences.js";
import { applyRandomSpellbookPreparation } from "./randomPreparation.js";
import {
  isSpellbookPreparationFullModeEnabled,
  shouldAutoOpenSpellbookPreparationAfterRest
} from "./settings.js";

const WRAPPED_ACTOR_TYPES = ["character", "npc", "haunt", "trap", "vehicle"];

const activeRests = new WeakMap();

function getRestActor(app) {
  return app?.actor ?? app?.document ?? app?.object ?? null;
}

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getActorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function getSpellbook(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return null;
  return actor?.system?.attributes?.spells?.spellbooks?.[normalizedBookId] ?? null;
}

function getSpellbookMode(actor, bookId) {
  return normalizeId(getSpellbook(actor, bookId)?.spellPreparationMode);
}

function isAtWillSpell(item) {
  return item?.system?.atWill === true;
}

function getOrCreateItemUpdate(itemUpdates, itemId) {
  const normalizedItemId = normalizeId(itemId);
  if (!normalizedItemId) return null;

  let update = itemUpdates.find((entry) => normalizeId(entry?._id) === normalizedItemId);
  if (!update) {
    update = { _id: normalizedItemId };
    itemUpdates.push(update);
  }
  return update;
}

function resetSpellItemPreparation(itemUpdates, item, mode) {
  const update = getOrCreateItemUpdate(itemUpdates, item?.id);
  if (!update) return;

  foundry.utils.setProperty(update, "system.preparation.value", 0);
  if (mode === "prepared") {
    foundry.utils.setProperty(update, "system.preparation.max", 0);
  }
}

function resetPreparedSpellbookRestItemUpdates(actor, options, _updateData, itemUpdates) {
  if (!isSpellbookPreparationFullModeEnabled()) return;
  if (actor?.isOwner !== true) return;
  if (options?.restoreDailyUses !== true) return;
  if (!Array.isArray(itemUpdates)) return;

  const context = activeRests.get(actor)?.at(-1);
  const plan = getRestPreparationPlan(actor, context?.shouldPrepareSpellbooks
    ?? (options?.[REST_PREPARE_SPELLBOOKS_OPTION] !== false));
  if (context) context.plan = plan;
  const reselectBookIds = new Set(plan.reselectBookIds);
  if (!reselectBookIds.size) return;

  for (const item of getActorItems(actor)) {
    if (item?.type !== "spell" || isAtWillSpell(item)) continue;

    const bookId = normalizeId(item.system?.spellbook);
    if (!reselectBookIds.has(bookId)) continue;

    const mode = getSpellbookMode(actor, bookId);
    if (mode !== "prepared" && mode !== "hybrid") continue;

    resetSpellItemPreparation(itemUpdates, item, mode);
  }
}

function getRestPreparationPlan(actor, shouldPrepareSpellbooks) {
  const bookIds = getEligibleSpellbookIds(actor)
    .filter((bookId) => isSpellbookManagementEnabled(actor, bookId));
  const reselectBookIds = shouldPrepareSpellbooks
    ? bookIds.filter(bookId => getEffectiveSpellbookRestMode(actor, bookId) === "reselect") : [];
  const randomBookIds = shouldPrepareSpellbooks
    ? bookIds.filter(bookId => getEffectiveSpellbookRestMode(actor, bookId) === "random") : [];
  return { bookIds, reselectBookIds, randomBookIds };
}

function appendPrepareSpellbookCheckbox(app, html) {
  if (!isSpellbookPreparationFullModeEnabled()) return;

  const root = elementFromHtmlLike(html);
  if (!root) return;

  const actor = getRestActor(app);
  if (!getEligibleSpellbookIds(actor).some((bookId) => isSpellbookManagementEnabled(actor, bookId))) return;
  if (root.querySelector(`input[name="${REST_PREPARE_SPELLBOOKS_OPTION}"]`)) return;

  const checkboxGroup = root.querySelector(".form-body .form-group.inline-stacked")
    ?? root.querySelector(".form-group.inline-stacked");
  if (!checkboxGroup) return;

  const label = document.createElement("label");
  label.classList.add("checkbox");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = REST_PREPARE_SPELLBOOKS_OPTION;
  input.checked = true;
  input.dataset.dtype = "Boolean";

  label.append(input, " Prepare Spellbook");
  checkboxGroup.append(label);
}

async function updateSpellbookPreparationAfterRest(actor, restResult, plan, shouldOpenPreparationApps, randomize) {
  if (!isSpellbookPreparationFullModeEnabled()) return;
  if (!restResult || restResult.options?.restoreDailyUses !== true) return;
  if (actor?.isOwner !== true) return;

  const eligible = new Set(getEligibleSpellbookIds(actor));
  const bookIds = plan.bookIds.filter(bookId => eligible.has(bookId) && isSpellbookManagementEnabled(actor, bookId));
  const reselectBookIds = new Set(plan.reselectBookIds.filter(bookId => bookIds.includes(bookId)));
  const randomBookIds = new Set(plan.randomBookIds ?? []);
  const randomized = [], failedRandom = [];

  for (const bookId of bookIds) {
    if (actor.isOwner !== true) break;
    if (!getEligibleSpellbookIds(actor).includes(bookId) || !isSpellbookManagementEnabled(actor, bookId)) continue;
    if (reselectBookIds.has(bookId)) continue;
    if (!randomBookIds.has(bookId)) {
      await completeSpellbookPreparation(actor, bookId);
      continue;
    }
    if (actor.isOwner !== true || !getEligibleSpellbookIds(actor).includes(bookId)
      || !isSpellbookManagementEnabled(actor, bookId) || getEffectiveSpellbookRestMode(actor, bookId) !== "random") continue;
    try {
      Hooks.callAll?.("nasSpellbookRandomPreparationStarted", actor, { bookId });
      await randomize(actor, bookId);
      await completeSpellbookPreparation(actor, bookId);
      randomized.push(bookId);
    } catch (error) {
      failedRandom.push(bookId);
      const name = getSpellbook(actor, bookId)?.name || bookId;
      console.warn(`${MODULE.ID} | Random preparation failed for ${name}`, error);
      globalThis.ui?.notifications?.warn?.(`Random preparation could not finish for ${name}. Open the spellbook to prepare it: ${error?.message || "unknown error"}`);
    } finally {
      Hooks.callAll?.("nasSpellbookRandomPreparationFinished", actor, { bookId });
    }
  }
  if (actor.isOwner !== true) return;
  const pendingBooks = [...reselectBookIds, ...failedRandom]
    .filter(bookId => getEligibleSpellbookIds(actor).includes(bookId) && isSpellbookManagementEnabled(actor, bookId));
  if (pendingBooks.length) {
    await setSpellbookPreparationPending(actor, {
      bookIds: Array.from(new Set([...getPendingSpellbookIds(actor), ...pendingBooks])),
      hours: restResult.options?.hours
    });
  }

  Hooks.callAll?.("nasSpellbookPreparationRestCompleted", actor, {
    bookIds, reselectBookIds: [...reselectBookIds], randomBookIds: randomized, failedRandomBookIds: failedRandom
  });

  if (shouldOpenPreparationApps && pendingBooks.length) {
    await openSpellbookPreparationAfterRest(actor, pendingBooks);
  }
}

function getActorDocumentClassPath(actorType) {
  return `CONFIG.Actor.documentClasses.${actorType}.prototype.performRest`;
}

function registerPerformRestWrappers(randomize) {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications.error(`${MODULE.NAME} requires the 'libWrapper' module. Please install and activate it.`);
    return;
  }

  for (const actorType of WRAPPED_ACTOR_TYPES) {
    const actorClass = CONFIG.Actor.documentClasses?.[actorType];
    if (typeof actorClass?.prototype?.performRest !== "function") continue;

    libWrapper.register(
      MODULE.ID,
      getActorDocumentClassPath(actorType),
      async function (wrapped, options = {}, ...args) {
        const shouldPrepareSpellbooks = options?.[REST_PREPARE_SPELLBOOKS_OPTION] !== false;
        const hasSpellbookPreparationOption = Object.prototype.hasOwnProperty.call(
          options ?? {},
          REST_PREPARE_SPELLBOOKS_OPTION
        );
        const shouldOpenPreparationApps = hasSpellbookPreparationOption && shouldPrepareSpellbooks;
        const canAutoOpenPreparationApps = shouldOpenPreparationApps
          && shouldAutoOpenSpellbookPreparationAfterRest();
        const contexts = activeRests.get(this) ?? [];
        const context = { shouldPrepareSpellbooks, plan: null };
        contexts.push(context);
        activeRests.set(this, contexts);
        let result;
        try {
          result = await wrapped.call(this, options, ...args);
          try {
            await updateSpellbookPreparationAfterRest(
              this,
              result,
              context.plan ?? getRestPreparationPlan(this, shouldPrepareSpellbooks),
              canAutoOpenPreparationApps,
              randomize
            );
          } catch (error) {
            console.warn(`${MODULE.ID} | Failed to update spellbook preparation rest state`, error);
          }
          return result;
        } finally {
          const index = contexts.indexOf(context);
          if (index !== -1) contexts.splice(index, 1);
          if (!contexts.length) activeRests.delete(this);
        }
      },
      "MIXED"
    );
  }
}

export function registerSpellbookPreparationRestHooks({ randomize = applyRandomSpellbookPreparation } = {}) {
  Hooks.on("renderActorRestDialog", appendPrepareSpellbookCheckbox);
  Hooks.on("pf1PreActorRest", resetPreparedSpellbookRestItemUpdates);
  registerPerformRestWrappers(randomize);
}
