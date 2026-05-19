import { elementFromHtmlLike } from "../../../../common/foundryCompat.js";
import { getEligibleSpellbookIds } from "./eligibility.js";
import { isSpellbookPreparationPending } from "./flags.js";
import {
  getPreparedSlotMarkerLabels,
  getUntrackedKnownSpellMarker,
  isItemHintsIntegrationActive
} from "./itemHintsCompat.js";
import { getKnownSpells } from "./knownSpells.js";
import { SpellbookPreparationApp } from "./app.js";
import {
  getGeneratedPreparedSpellItemFlag,
  isGeneratedPreparedSpellItem,
  isSpellbookPreparedItemsManaged
} from "./preparedItems.js";
import {
  getSpellbookAnimationMode,
  isSpellbookPreparedVariantSupportEnabled,
  shouldHideSpellbookSourceSpells,
  shouldShowSpellbookPrepareControl
} from "./settings.js";

const PREPARE_CONTROL_SELECTOR = "[data-nas-spellbook-prepare]";
const SPELL_LEVEL_COUNT = 10;

function localize(key, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.localize(fullKey);
  return value && value !== fullKey ? value : fallback;
}

function getSheetActor(app) {
  return app?.actor ?? app?.document ?? app?.object ?? null;
}

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getActorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function isAtWillSpell(item) {
  return item?.system?.atWill === true;
}

function getSpellLevel(value, fallback = 0) {
  const level = Number(value);
  if (!Number.isInteger(level)) return Math.max(0, Math.min(SPELL_LEVEL_COUNT - 1, Number(fallback) || 0));
  return Math.max(0, Math.min(SPELL_LEVEL_COUNT - 1, level));
}

function getSpellbookBody(root, bookId) {
  return root.querySelector(`.item-groups-list.book-${bookId}-body`);
}

function findSpellbookConfiguration(body) {
  let sibling = body?.previousElementSibling ?? null;
  while (sibling) {
    if (sibling.matches?.(".inventory-filters.spellbook-configuration")) return sibling;
    sibling = sibling.previousElementSibling;
  }
  return null;
}

function hasPrepareControl(container, bookId) {
  return Array.from(container.querySelectorAll(PREPARE_CONTROL_SELECTOR))
    .some((element) => element.dataset.bookId === bookId);
}

function createPrepareControl(actor, bookId) {
  const pending = isSpellbookPreparationPending(actor, bookId);
  const control = document.createElement("a");
  control.classList.add("nas-spellbook-prepare-control");
  control.classList.add(`nas-spellbook-animation-${getSpellbookAnimationMode()}`);
  if (pending) control.classList.add("nas-spellbook-prepare-pending");
  control.dataset.nasSpellbookPrepare = "true";
  control.dataset.bookId = bookId;
  control.dataset.tooltip = pending
    ? localize("tooltips.preparePending", "Prepare this spellbook for the new day")
    : localize("tooltips.prepare", "Prepare this spellbook");
  control.setAttribute("aria-label", control.dataset.tooltip);

  const icon = document.createElement("i");
  icon.classList.add("fa-solid", "fa-book-open-reader");
  icon.setAttribute("inert", "");

  control.append(icon);
  control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    SpellbookPreparationApp.open(actor, bookId);
  });

  return control;
}

function injectSpellbookPrepareControl(actor, root, bookId) {
  const body = getSpellbookBody(root, bookId);
  const configuration = findSpellbookConfiguration(body);
  if (!configuration || hasPrepareControl(configuration, bookId)) return;

  const target = configuration.querySelector(".summary .spellcasting-config")
    ?? configuration.querySelector(".summary");
  if (!target) return;

  target.prepend(createPrepareControl(actor, bookId));
}

function findItemSheetRows(body, itemId) {
  const normalizedItemId = normalizeId(itemId);
  if (!body || !normalizedItemId) return [];

  const rows = Array.from(body.querySelectorAll("[data-item-id]"))
    .filter((element) => normalizeId(element.dataset.itemId ?? element.getAttribute("data-item-id")) === normalizedItemId)
    .map((element) => element.closest(".item") ?? element.closest("li") ?? element);
  return Array.from(new Set(rows)).filter(Boolean);
}

function parseSpellListDataKey(dataList) {
  const key = normalizeId(dataList);
  const match = /^spell-(.+)-(\d+)$/.exec(key);
  if (!match) return null;
  return {
    bookId: match[1],
    level: Number(match[2])
  };
}

function findSpellLevelList(body, bookId, level) {
  const normalizedBookId = normalizeId(bookId);
  const targetLevel = getSpellLevel(level);
  const lists = Array.from(body?.querySelectorAll?.('ol.item-list[data-list^="spell-"][data-level]') ?? []);

  return lists.find((list) => {
    const key = parseSpellListDataKey(list.dataset.list);
    return key?.bookId === normalizedBookId && key.level === targetLevel;
  }) ?? lists.find((list) => Number(list.dataset.level) === targetLevel) ?? null;
}

function isSpellNotificationElement(element) {
  const className = element?.className?.toString?.().toLowerCase() ?? "";
  return className.includes("notification")
    || className.includes("open-slot")
    || className.includes("open-slots");
}

function getDirectChildForDescendant(parent, descendant) {
  if (!parent || !descendant) return null;
  return Array.from(parent.children ?? [])
    .find((child) => child === descendant || child.contains(descendant))
    ?? null;
}

function findSpellNotificationAnchor(list) {
  const directNotification = Array.from(list?.children ?? []).find((child) => isSpellNotificationElement(child));
  if (directNotification) return directNotification;

  const nestedNotification = list?.querySelector?.(".spell-notification, .spellbook-notification, .notification, [class*='notification'], [class*='open-slot']");
  return getDirectChildForDescendant(list, nestedNotification);
}

function insertSpellRowIntoLevelList(list, row) {
  const anchor = findSpellNotificationAnchor(list);
  if (anchor && anchor !== row) {
    list.insertBefore(row, anchor);
  } else if (row.parentElement !== list) {
    list.append(row);
  }
}

function getFallbackHintContainer(row) {
  const itemName = row?.querySelector?.(".item-name");
  if (!itemName) return null;

  const existing = itemName.querySelector(".nas-prepared-slot-hints");
  if (existing) return existing;

  const container = document.createElement("div");
  container.classList.add("nas-prepared-slot-hints");

  const nameHeader = itemName.querySelector("h4");
  if (nameHeader) {
    nameHeader.after(container);
  } else {
    itemName.append(container);
  }

  return container;
}

function annotatePreparedSlotRow(row, renderedLevel, preparedSlotLevel) {
  if (!row) return;

  row.classList.add("nas-prepared-slot-relocated");
  row.dataset.nasPreparedSlotLevel = `${preparedSlotLevel}`;
  row.dataset.nasOriginalSpellLevel = `${renderedLevel}`;

  if (isItemHintsIntegrationActive()) {
    row.querySelector(".nas-prepared-slot-hints")?.remove();
    row.querySelector(".nas-prepared-slot-badge")?.remove();
    return;
  }

  const { label, tooltip } = getPreparedSlotMarkerLabels(renderedLevel, preparedSlotLevel);
  const container = getFallbackHintContainer(row);
  if (!container) return;

  const existing = row.querySelector(".nas-prepared-slot-badge");
  if (existing) {
    existing.textContent = label;
    existing.dataset.tooltip = tooltip;
    existing.setAttribute("aria-label", tooltip);
    return;
  }

  const badge = document.createElement("span");
  badge.classList.add("nas-prepared-slot-badge");
  badge.dataset.tooltip = tooltip;
  badge.setAttribute("aria-label", tooltip);
  badge.textContent = label;

  container.append(badge);
}

function annotateUntrackedKnownSpellRow(actor, item, row) {
  if (!row) return;

  const marker = getUntrackedKnownSpellMarker(actor, item);
  if (!marker) return;

  row.classList.add("nas-known-spell-missing-source");

  if (isItemHintsIntegrationActive()) {
    row.querySelector(".nas-known-spell-missing-badge")?.remove();
    return;
  }

  const container = getFallbackHintContainer(row);
  if (!container) return;

  const existing = row.querySelector(".nas-known-spell-missing-badge");
  if (existing) {
    existing.textContent = marker.label;
    existing.dataset.tooltip = marker.tooltip;
    existing.setAttribute("aria-label", marker.tooltip);
    return;
  }

  const badge = document.createElement("span");
  badge.classList.add("nas-known-spell-missing-badge");
  badge.dataset.tooltip = marker.tooltip;
  badge.setAttribute("aria-label", marker.tooltip);
  badge.textContent = marker.label;

  container.append(badge);
}

function relocateGeneratedPreparedSpellItems(actor, root, bookId) {
  if (!isSpellbookPreparedItemsManaged(actor, bookId)) return;

  const body = getSpellbookBody(root, bookId);
  if (!body) return;

  for (const item of getActorItems(actor)) {
    if (
      item?.type !== "spell"
      || normalizeId(item.system?.spellbook) !== normalizeId(bookId)
      || !isGeneratedPreparedSpellItem(item)
    ) {
      continue;
    }

    const flag = getGeneratedPreparedSpellItemFlag(item);
    const preparedSlotLevel = getSpellLevel(flag?.preparedSlotLevel, item.system?.level ?? flag?.originalSpellLevel ?? 0);
    const renderedLevel = getSpellLevel(item.system?.level, flag?.originalSpellLevel ?? preparedSlotLevel);
    const rows = findItemSheetRows(body, item.id);
    if (!rows.length) continue;

    if (preparedSlotLevel === renderedLevel) continue;

    const targetList = findSpellLevelList(body, bookId, preparedSlotLevel);
    if (!targetList) continue;

    for (const row of rows) {
      annotatePreparedSlotRow(row, renderedLevel, preparedSlotLevel);
      insertSpellRowIntoLevelList(targetList, row);
    }
  }
}

function annotateUntrackedKnownSpellItems(actor, root, bookId) {
  if (!isSpellbookPreparedItemsManaged(actor, bookId)) return;

  const body = getSpellbookBody(root, bookId);
  if (!body) return;

  for (const item of getActorItems(actor)) {
    if (
      item?.type !== "spell"
      || normalizeId(item.system?.spellbook) !== normalizeId(bookId)
      || isGeneratedPreparedSpellItem(item)
      || isAtWillSpell(item)
    ) {
      continue;
    }

    if (!getUntrackedKnownSpellMarker(actor, item)) continue;

    for (const row of findItemSheetRows(body, item.id)) {
      annotateUntrackedKnownSpellRow(actor, item, row);
    }
  }
}

function hideManagedSourceSpellItems(actor, root, bookId) {
  if (!isSpellbookPreparedItemsManaged(actor, bookId)) return;

  const body = getSpellbookBody(root, bookId);
  if (!body) return;

  const knownSourceIds = new Set(getKnownSpells(actor, bookId)
    .map((entry) => normalizeId(entry.sourceItemId))
    .filter(Boolean));

  for (const item of getActorItems(actor)) {
    if (
      item?.type !== "spell"
      || normalizeId(item.system?.spellbook) !== normalizeId(bookId)
      || isGeneratedPreparedSpellItem(item)
      || isAtWillSpell(item)
    ) {
      continue;
    }

    if (!knownSourceIds.has(normalizeId(item.id))) continue;

    for (const row of findItemSheetRows(body, item.id)) {
      row.classList.add("nas-hidden-known-spell-source");
      row.style.display = "none";
    }
  }
}

export function injectSpellbookPreparationActorSheetControls(app, html) {
  if (!isSpellbookPreparedVariantSupportEnabled()) return;

  const root = elementFromHtmlLike(html);
  const actor = getSheetActor(app);
  if (!root || !actor) return;

  for (const bookId of getEligibleSpellbookIds(actor)) {
    annotateUntrackedKnownSpellItems(actor, root, bookId);
    if (shouldHideSpellbookSourceSpells()) hideManagedSourceSpellItems(actor, root, bookId);
    relocateGeneratedPreparedSpellItems(actor, root, bookId);
    if (actor.isOwner !== false && shouldShowSpellbookPrepareControl()) {
      injectSpellbookPrepareControl(actor, root, bookId);
    }
  }
}

export function registerSpellbookPreparationActorSheetHooks() {
  Hooks.on("renderActorSheet", injectSpellbookPreparationActorSheetControls);
}
