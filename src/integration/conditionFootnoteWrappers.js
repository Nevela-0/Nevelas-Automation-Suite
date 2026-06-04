import { MODULE } from '../common/module.js';
import { CONCEALED_CONDITION_ID, actorHasBlindFight, getConcealedVariant } from '../features/automation/conditions/concealed/concealed.js';
import {
  addAttackFootnoteToAllAttacks,
  addCardFootnote,
  registerActionEffectNoteCallback,
  registerAttackFootnoteRenderCallbacks
} from '../features/automation/utils/footnotes.js';

let _conditionFootnoteWrapperRegistered = false;
let _conditionAttackFootnotesRegistered = false;

function escapeHtml(value) {
  if (typeof globalThis.foundry?.utils?.escapeHTML === "function") {
    return globalThis.foundry.utils.escapeHTML(String(value ?? ""));
  }
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function getConcealedVariantForTargets(targets = []) {
  let chosen = null;
  for (const target of targets) {
    const actor = target?.actor;
    if (!actor?.statuses?.has?.(CONCEALED_CONDITION_ID)) continue;
    const variant = getConcealedVariant(actor) || "normal";
    chosen = (!chosen || (chosen === "normal" && variant === "total")) ? variant : chosen;
    if (chosen === "total") break;
  }
  return chosen;
}

function concealedFootnoteLabel(variant) {
  return variant === "total"
    ? game.i18n.localize("NAS.conditions.main.ConcealedFootnoteTotalLabel")
    : game.i18n.localize("NAS.conditions.main.ConcealedFootnoteLabel");
}

function concealedThreshold(variant) {
  return variant === "total" ? 50 : 20;
}

function concealedTooltip(variant, hasBlindFight) {
  const key = variant === "total"
    ? "NAS.conditions.main.ConcealedFootnoteTooltipTotal"
    : "NAS.conditions.main.ConcealedFootnoteTooltipNormal";
  const base = game.i18n.localize(key);
  if (!hasBlindFight) return base;
  return `${base} ${game.i18n.localize("NAS.conditions.main.ConcealedFootnoteTooltipBlindFight")}`;
}

function concealedFootnoteText(variant, attackerActor) {
  const hasBF = actorHasBlindFight(attackerActor);
  const roll = hasBF ? "[[2d100kh]]" : "[[1d100]]";
  const label = concealedFootnoteLabel(variant);
  const text = game.i18n.format("NAS.conditions.main.ConcealedFootnote", {
    label,
    roll
  });
  const tooltip = concealedTooltip(variant, hasBF);
  return `<span data-nas-concealment-footnote="${escapeAttribute(variant)}" data-nas-concealment-threshold="${concealedThreshold(variant)}" data-tooltip="${escapeAttribute(tooltip)}">${escapeHtml(text)}</span>`;
}

function queueConcealedAttackFootnotes(actionUse) {
  if (!actionUse?.action?.hasAttack) return;
  const shared = actionUse.shared;
  if (!Array.isArray(shared?.targets) || !shared.targets.length) return;
  if (!Array.isArray(shared?.chatAttacks) || !shared.chatAttacks.length) return;

  const variant = getConcealedVariantForTargets(shared.targets);
  if (!variant) return;
  const attackerActor = actionUse.token?.actor ?? actionUse.actor;
  addAttackFootnoteToAllAttacks(shared, concealedFootnoteText(variant, attackerActor));
}

function inlineRollTotalFromElement(element) {
  const raw = element?.dataset?.roll;
  if (!raw) return null;
  const candidates = [raw, unescape(raw)];
  try {
    candidates.push(decodeURIComponent(raw));
  } catch (_err) {
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const total = Number(parsed?.total);
      if (Number.isFinite(total)) return Math.floor(total);
    } catch (_err) {
    }
  }
  return null;
}

function updateConcealmentFootnoteResults(chatAttack) {
  const html = String(chatAttack?.effectNotesHTML ?? "");
  if (!html.includes("data-nas-concealment-footnote")) return;

  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const note of doc.querySelectorAll("[data-nas-concealment-footnote]")) {
    const roll = note.querySelector(".inline-roll[data-roll]");
    const total = inlineRollTotalFromElement(roll);
    if (!Number.isFinite(total)) continue;

    const threshold = Number(note.dataset.nasConcealmentThreshold);
    if (!Number.isFinite(threshold)) continue;

    note.querySelector("[data-nas-concealment-result]")?.remove();

    const result = total <= threshold
      ? game.i18n.localize("NAS.conditions.main.ConcealedFootnoteMiss")
      : game.i18n.localize("NAS.conditions.main.ConcealedFootnoteHit");
    const resultEl = doc.createElement("span");
    resultEl.dataset.nasConcealmentResult = "true";
    resultEl.textContent = ` - ${result}`;
    note.appendChild(resultEl);
    changed = true;
  }

  if (changed) chatAttack.effectNotesHTML = doc.body.innerHTML;
}

export function registerConditionFootnoteWrapper(isGrappleSelected) {
  if (!_conditionAttackFootnotesRegistered) {
    _conditionAttackFootnotesRegistered = true;
    registerActionEffectNoteCallback(queueConcealedAttackFootnotes);
    registerAttackFootnoteRenderCallbacks({ afterRender: updateConcealmentFootnoteResults });
  }

  if (_conditionFootnoteWrapperRegistered) return;
  _conditionFootnoteWrapperRegistered = true;

  if (!game.modules.get("lib-wrapper")?.active) {
    console.warn(`${MODULE.ID} | libWrapper missing; grapple footnotes disabled.`);
    return;
  }

  libWrapper.register(
    MODULE.ID,
    "pf1.actionUse.ActionUse.prototype.addFootnotes",
    async function (wrapped, ...args) {
      await wrapped(...args);
      try {
        if (!this.action?.hasAttack) return;
        const actor = this.token?.actor ?? this.actor;

        if (isGrappleSelected(this) && actor?.statuses?.has?.("grappling")) {
          const text = game.i18n.localize('NAS.conditions.main.GrappleFootnote');
          addCardFootnote(this.shared, text);
        }
      } catch (err) {
        console.error(`${MODULE.ID} | Failed to append condition footnote`, err);
      }
    },
    "WRAPPER"
  );
}

