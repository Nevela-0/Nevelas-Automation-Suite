import { MODULE } from "../../../common/module.js";

const ATTACK_FOOTNOTE_QUEUE_KEY = "__nasPendingAttackFootnotes";

let _footnoteHooksRegistered = false;
const _actionEffectNoteCallbacks = new Set();
const _beforeAttackNoteRenderCallbacks = new Set();
const _afterAttackNoteRenderCallbacks = new Set();

function runCallbackSet(callbacks, arg, label) {
  for (const callback of callbacks) {
    try {
      callback(arg);
    } catch (err) {
      console.error(`${MODULE.ID} | Failed during ${label}`, err);
    }
  }
}

export function registerActionEffectNoteCallback(callback) {
  if (typeof callback === "function") _actionEffectNoteCallbacks.add(callback);
}

export function registerAttackFootnoteRenderCallbacks({ beforeRender = null, afterRender = null } = {}) {
  if (typeof beforeRender === "function") _beforeAttackNoteRenderCallbacks.add(beforeRender);
  if (typeof afterRender === "function") _afterAttackNoteRenderCallbacks.add(afterRender);
}

export function registerSharedFootnoteHooks() {
  if (_footnoteHooksRegistered) return;
  _footnoteHooksRegistered = true;

  if (!game.modules.get("lib-wrapper")?.active) {
    console.warn(`${MODULE.ID} | libWrapper missing; attack-level footnote helpers disabled.`);
    return;
  }

  libWrapper.register(
    MODULE.ID,
    "pf1.actionUse.ActionUse.prototype.addEffectNotes",
    async function (wrapped, ...args) {
      try {
        this.shared ??= {};
        this.shared[ATTACK_FOOTNOTE_QUEUE_KEY] = Object.create(null);
        runCallbackSet(_actionEffectNoteCallbacks, this, "action effect-note footnote preparation");
      } catch (err) {
        console.error(`${MODULE.ID} | Failed preparing attack footnote queue`, err);
      }
      return wrapped(...args);
    },
    "WRAPPER"
  );

  libWrapper.register(
    MODULE.ID,
    "pf1.actionUse.ChatAttack.prototype.setEffectNotesHTML",
    async function (wrapped, ...args) {
      try {
        runCallbackSet(_beforeAttackNoteRenderCallbacks, this, "pre-attack effect-note rendering");
        injectQueuedAttackFootnotes(this);
      } catch (err) {
        console.error(`${MODULE.ID} | Failed injecting queued attack footnotes`, err);
      }

      const result = await wrapped(...args);

      try {
        runCallbackSet(_afterAttackNoteRenderCallbacks, this, "post-attack effect-note rendering");
      } catch (err) {
        console.error(`${MODULE.ID} | Failed after attack effect-note rendering`, err);
      }

      return result;
    },
    "WRAPPER"
  );
}

export function addCardFootnote(shared, text, { dedupe = true } = {}) {
  const trimmed = String(text ?? "").trim();
  if (!shared || !trimmed) return;
  shared.templateData ??= {};
  if (!Array.isArray(shared.templateData.footnotes)) shared.templateData.footnotes = [];
  if (dedupe && shared.templateData.footnotes.some((entry) => entry?.text === trimmed)) return;
  shared.templateData.footnotes.push({ text: trimmed });
}

function getPendingAttackFootnoteQueue(shared) {
  if (!shared) return null;
  shared[ATTACK_FOOTNOTE_QUEUE_KEY] ??= Object.create(null);
  return shared[ATTACK_FOOTNOTE_QUEUE_KEY];
}

function queueAttackFootnote(shared, attackIndex, text) {
  if (!shared || !Number.isInteger(attackIndex)) return;
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;

  const queue = getPendingAttackFootnoteQueue(shared);
  if (!queue) return;
  queue[attackIndex] ??= [];
  if (!queue[attackIndex].includes(trimmed)) queue[attackIndex].push(trimmed);
}

export function addAttackFootnote(shared, attackIndex, text, { dedupe = true } = {}) {
  const index = Number(attackIndex);
  const trimmed = String(text ?? "").trim();
  if (!shared || !Number.isInteger(index) || !trimmed) return;

  queueAttackFootnote(shared, index, trimmed);

  if (!Array.isArray(shared.chatAttacks)) return;
  const chatAttack = shared.chatAttacks[index];
  if (!chatAttack) return;
  if (!Array.isArray(chatAttack.effectNotes)) chatAttack.effectNotes = [];
  if (dedupe && chatAttack.effectNotes.some((entry) => entry?.text === trimmed)) return;
  chatAttack.effectNotes.push({ text: trimmed });
}

export function addAttackFootnoteToAllAttacks(shared, text, options = {}) {
  if (!Array.isArray(shared?.chatAttacks)) return;
  for (let index = 0; index < shared.chatAttacks.length; index += 1) {
    addAttackFootnote(shared, index, text, options);
  }
}

function injectQueuedAttackFootnotes(chatAttack) {
  const actionUse = chatAttack?.actionUse;
  const shared = actionUse?.shared;
  const pendingByIndex = shared?.[ATTACK_FOOTNOTE_QUEUE_KEY];
  if (!pendingByIndex || !Array.isArray(shared?.chatAttacks)) return;

  const attackIndex = shared.chatAttacks.indexOf(chatAttack);
  if (attackIndex < 0) return;
  const pendingNotes = pendingByIndex[attackIndex] ?? [];
  if (!pendingNotes.length) return;

  if (!Array.isArray(chatAttack.effectNotes)) chatAttack.effectNotes = [];
  const existingText = new Set(chatAttack.effectNotes.map((entry) => entry?.text).filter(Boolean));
  for (const text of pendingNotes) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || existingText.has(trimmed)) continue;
    chatAttack.effectNotes.push({ text: trimmed });
    existingText.add(trimmed);
  }
}
