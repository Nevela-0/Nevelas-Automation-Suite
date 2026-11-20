import { MODULE } from "../../../common/module.js";
import { elementFromHtmlLike, htmlElementFromRenderArg, onRenderChatMessageCompat } from "../../../common/foundryCompat.js";
import { getDazingExtraRoundsForTarget } from "../metamagic/dazingSpell.js";
import { actionCardSaveData, savedActionSaveTargets, validSaveType, saveRollTotal, saveRollDc } from "./actionSaveContext.js";

const SAVE_BUTTON_SELECTOR = 'button[data-action="save"]';
const LISTENER_FLAG = "nasPersistentSaveListener";
export const SAVE_TOKEN_FLAG = "nasSaveTokenInteraction";
const ACTIVE_SAVE_CLICKS = new Set();
let hooksRegistered = false;

function getMessageFromEvent(event) {
  const messageEl = event.target?.closest?.(".chat-message");
  if (!messageEl) return null;
  const messageId = messageEl.dataset?.messageId;
  if (!messageId) return null;
  return game.messages?.get(messageId) ?? null;
}

export function buildTokenHeaderHtml(tokenDoc, labelText) {
  const img = tokenDoc?.texture?.src ?? tokenDoc?.img ?? "";
  const name = tokenDoc?.name ?? "";
  const uuid = tokenDoc?.uuid ?? "";
  const showLabel = Boolean(labelText);
  return `
    <div class="NAS-token" data-uuid="${uuid}" style="margin-bottom: 6px;">
      <div style="display: flex; justify-content: center;">
        <img src="${img}" title="${name}" width="48" height="48" style="margin-bottom: 6px; cursor: pointer;"/>
      </div>
      ${showLabel ? `<span style="text-align: center; display: block;">${name} ${labelText}</span>` : ""}
    </div>
  `;
}

function getPersistentLabel(isSecond) {
  if (!isSecond) return "";
  return game.i18n.localize("NAS.metamagic.PersistentSaveSecond");
}

function canSuppressPrivateSaveOutcome(message) {
  if (game.user?.isGM) return false;
  if (!game.settings.get(MODULE.ID, "hidePrivateSaveRollOutcomeFromPlayers")) return false;
  if (message?.isContentVisible !== false) return false;
  if (!Array.isArray(message?.whisper) || message.whisper.length === 0) return false;
  const content = String(message?.content ?? "");
  return /saving throw/i.test(content) || /save/i.test(message?.flavor ?? "");
}

function isOutcomeElement(element) {
  if (!element) return false;
  const text = element.textContent?.trim?.() ?? "";
  if (!/^(success|failure)$/i.test(text)) return false;
  const classText = String(element.className ?? "");
  return /success|failure|result|outcome|save/i.test(classText);
}

function suppressPrivateSaveOutcome(html) {
  const root = htmlElementFromRenderArg(html);
  if (!root) return;

  const candidates = root.querySelectorAll?.(
    ".success, .failure, .result, .outcome, .save-result, .dc-result, [class*='success'], [class*='failure']"
  ) ?? [];
  candidates.forEach((element) => {
    if (isOutcomeElement(element)) element.style.display = "none";
  });

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach((node) => {
    if (!/^\s*(success|failure)\s*$/i.test(node.nodeValue ?? "")) return;
    const parent = node.parentElement;
    if (parent && isOutcomeElement(parent)) return;
    node.nodeValue = "";
  });
}

function attachTokenImageInteractions(html) {
  const root = htmlElementFromRenderArg(html);
  if (!root) return;
  const tokenImgs =
    typeof root.find === "function"
      ? root.find(".NAS-token img")
      : root.querySelectorAll(".NAS-token img");
  if (!tokenImgs?.length) return;
  const attach = (img) => {
    img.addEventListener("click", async (ev) => {
      const icToken = ev.currentTarget.closest(".NAS-token");
      const tokenUuid = icToken?.dataset?.uuid;
      if (!tokenUuid) return;
      const tokenDocument = await fromUuid(tokenUuid);
      const token = canvas.tokens?.get?.(tokenDocument?.id);
      if (token) {
        token.control({ releaseOthers: true });
        canvas.animatePan({ x: token.center?.x, y: token.center?.y, duration: 1000 });
      }
    });
    img.addEventListener("mouseenter", async (ev) => {
      const icToken = ev.currentTarget.closest(".NAS-token");
      const tokenUuid = icToken?.dataset?.uuid;
      if (!tokenUuid) return;
      const tokenDocument = await fromUuid(tokenUuid);
      const token = canvas.tokens?.get?.(tokenDocument?.id);
      if (token) token._onHoverIn(ev);
    });
    img.addEventListener("mouseleave", async (ev) => {
      const icToken = ev.currentTarget.closest(".NAS-token");
      const tokenUuid = icToken?.dataset?.uuid;
      if (!tokenUuid) return;
      const tokenDocument = await fromUuid(tokenUuid);
      const token = canvas.tokens?.get?.(tokenDocument?.id);
      if (token) token._onHoverOut(ev);
    });
  };

  if (typeof tokenImgs.each === "function") {
    tokenImgs.each((_, img) => attach(img));
  } else {
    tokenImgs.forEach((img) => attach(img));
  }
}

async function resolveTokenDoc({ entry, message, actor, allowGlobal }) {
  if (entry?.tokenUuid) {
    const tokenDoc = await fromUuid(entry.tokenUuid);
    if (tokenDoc) return tokenDoc;
  }
  if (message?.speaker?.token && canvas?.scene?.id === message.speaker?.scene) {
    const tokenDoc = canvas.tokens?.get?.(message.speaker.token)?.document ?? null;
    if (tokenDoc) return tokenDoc;
  }
  if (allowGlobal && actor?.id && canvas?.tokens?.placeables?.length) {
    const token = canvas.tokens.placeables.find((placeable) => placeable?.actor?.id === actor.id);
    return token?.document ?? null;
  }
  return null;
}

function registerPersistentSaveChatMessageHook() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("pf1ActorRollSave", async (actor, message, savingThrowId) => {
    const flags = message?.flags?.[MODULE.ID]?.metamagic;
    const entry = flags?.persistentSave ? { tokenUuid: flags.tokenUuid, second: flags.persistentSecond } : null;
    if (!message || typeof message.update !== "function") return;
    const allowGlobal = game.settings.get(MODULE.ID, "saveRollTokenInteraction");
    const labelText = getPersistentLabel(entry?.second);
    if (!allowGlobal && !labelText) return;

    const tokenDoc = await resolveTokenDoc({ entry, message, actor, allowGlobal });

    const canAddToken = Boolean(allowGlobal && tokenDoc);
    const header = canAddToken
      ? buildTokenHeaderHtml(tokenDoc, labelText)
      : labelText
        ? `<p>${labelText}</p>`
        : "";
    if (!header) return;
    const content = `${header}${message.content ?? ""}`;

    const updateData = { content };
    if (canAddToken) {
      foundry.utils.setProperty(
        updateData,
        `flags.${MODULE.ID}.${SAVE_TOKEN_FLAG}`,
        true
      );
    }
    if (entry) {
      foundry.utils.setProperty(
        updateData,
        `flags.${MODULE.ID}.metamagic.persistentSave`,
        true
      );
    }
    foundry.utils.setProperty(
      updateData,
      `flags.${MODULE.ID}.metamagic.persistentSecond`,
      Boolean(entry?.second)
    );
    if (tokenDoc?.uuid) {
      foundry.utils.setProperty(
        updateData,
        `flags.${MODULE.ID}.metamagic.tokenUuid`,
        tokenDoc.uuid
      );
    }
    await message.update(updateData);
  });

  onRenderChatMessageCompat((message, html) => {

    registerPersistentSpellSaveOverrides(html, message);
    if (canSuppressPrivateSaveOutcome(message)) suppressPrivateSaveOutcome(html);

    const allowGlobal = message?.flags?.[MODULE.ID]?.[SAVE_TOKEN_FLAG];
    const isPersistent = message?.flags?.[MODULE.ID]?.metamagic?.persistentSave;
    if (!allowGlobal && !isPersistent) return;
    attachTokenImageInteractions(html);
  });
  Hooks.on("updateChatMessage", (message, changes) => {
    const completed = changes?.flags?.[MODULE.ID]?.saveResolutionComplete
      ?? changes?.[`flags.${MODULE.ID}.saveResolutionComplete`];
    if (completed === true) return recordCompletedPersistentSave(message).catch(error => console.error(`${MODULE.ID} | Save result update failed`, error));
  });
}

function getSelectedTokens() {
  return Array.from(canvas?.tokens?.controlled ?? []);
}

async function resolveTargetsFromMessage(uuids) {
  const resolved = await Promise.all(
    [...new Set(uuids)].map(async (uuid) => {
      try {
        return await fromUuid(uuid);
      } catch {
        return null;
      }
    })
  );
  return resolved.filter(Boolean);
}

async function applyDazedCondition(targetActor, rounds) {
  if (!targetActor || !Number.isFinite(rounds) || rounds <= 0) return;
  const duration = {
    rounds,
    seconds: rounds * 6,
    startRound: game.combat?.round ?? null,
    startTurn: game.combat?.turn ?? null,
    startTime: game.time?.worldTime ?? null,
  };
  await targetActor.setCondition("dazed", { duration });
}

export async function recordCompletedPersistentSave(message) {
  if (!game.users?.activeGM?.isSelf || message?.flags?.[MODULE.ID]?.saveResolutionComplete !== true) return;
  const type = validSaveType(message?.system?.subject?.save);
  const total = saveRollTotal(message);
  if (!type || total == null || !message.system?.reference) return;
  const card = await fromUuid(message.system.reference);
  const token = game.scenes?.get(message.speaker?.scene)?.tokens?.get(message.speaker?.token);
  if (!card || !token?.actor) return;
  await card.setFlag("pf1", "targetDefense", { [token.uuid]: { save: { [type]: total } } });
}

async function rollMetamagicSaveForTarget(target, saveType, dc, options) {
  const tokenDoc = target?.document ?? target;
  const actor = tokenDoc?.actor ?? (typeof target?.rollSavingThrow === "function" ? target : null);
  if (!actor) return;
  const persistent = options?.persistent === true;

  const saveSequence = persistent ? {} : null;
  const rollOptions = (second, saveDc = dc) => ({
    event: options.event,
    noSound: options.noSound || second,

    token: tokenDoc?.actor ? tokenDoc : undefined,

    reference: persistent ? undefined : options.reference,

    ...(typeof options.patternEffect === "boolean" ? { nasPatternEffect: options.patternEffect } : {}),
    ...(persistent ? { nasSaveSequence: saveSequence, nasSaveSequenceStep: second ? 1 : 0 } : {}),
    dc: saveDc,
    ...(persistent ? { messageData: { flags: { [MODULE.ID]: { metamagic: {
      persistentSave: true, persistentSecond: second, tokenUuid: tokenDoc?.actor ? tokenDoc.uuid : null
    } } } } } : {})
  });

  const first = await actor.rollSavingThrow(saveType, rollOptions(false));
  const firstTotal = saveRollTotal(first);
  if (firstTotal == null) return;  
  let final = first;
  let total = firstTotal;
  let effectiveDc = saveRollDc(first, dc);
  if (persistent && firstTotal >= effectiveDc) {
    final = await actor.rollSavingThrow(saveType, rollOptions(true, effectiveDc));
    total = saveRollTotal(final);
    if (total == null) return;
    effectiveDc = saveRollDc(final, effectiveDc);
  }
  if (persistent) {
    if (final !== first) await first.update({ "system.reference": options.reference });
    await final.update({
      "system.reference": options.reference,
      [`flags.${MODULE.ID}.saveResolutionComplete`]: true
    });
  }
  if (options.dazing && total < effectiveDc) {
    const extraRounds = getDazingExtraRoundsForTarget(options.dazingSpellName, actor);
    await applyDazedCondition(actor, (options.dazingRounds ?? 1) + extraRounds);
  }
}

export function registerPersistentSpellSaveOverrides(html, renderedMessage = null) {
  const root = elementFromHtmlLike(html);
  if (!root || root.dataset?.[LISTENER_FLAG]) return;
  root.dataset[LISTENER_FLAG] = "true";
  registerPersistentSaveChatMessageHook();

  root.addEventListener("click", async event => {
    const button = event.target?.closest?.(SAVE_BUTTON_SELECTOR);
    if (!button || button.dataset?.as === "speaker") return;
    const message = getMessageFromEvent(event) ?? renderedMessage;
    if (!message) return;
    const save = actionCardSaveData(message, button);
    if (!save) return;  
    const metamagic = game.settings.get(MODULE.ID, "enableMetamagicAutomation")
      ? message.flags?.[MODULE.ID]?.metamagic ?? {} : {};
    const selected = getSelectedTokens();
    const stored = savedActionSaveTargets(message);
    const hasMetamagic = metamagic.persistent || metamagic.dazing;

    if (!selected.length && stored === null && !hasMetamagic) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const key = message.uuid ?? message.id;
    if (ACTIVE_SAVE_CLICKS.has(key)) return;
    ACTIVE_SAVE_CLICKS.add(key);
    const wasDisabled = button.disabled;
    button.disabled = true;
    try {
      const targets = selected.length ? selected : stored !== null
        ? await resolveTargetsFromMessage(stored)
        : game.user?.character ? [game.user.character] : [];
      if (!targets.length) {
        ui.notifications.warn(game.i18n.localize("NAS.chatSaves.NoEligibleTargets"));
        return;
      }
      let noSound = false;
      for (const target of targets) {
        try {
          await rollMetamagicSaveForTarget(target, save.type, save.dc, {
            event, noSound, reference: message.uuid,
            patternEffect: message.flags?.[MODULE.ID]?.patternEffect?.version === 1
              ? message.flags[MODULE.ID].patternEffect.pattern : undefined,
            persistent: Boolean(metamagic.persistent), dazing: Boolean(metamagic.dazing),
            dazingRounds: metamagic.dazingRounds, dazingSpellName: metamagic.dazingSpellName
          });
        } catch (error) {
          console.error(`${MODULE.ID} | Failed to roll action save`, error);
          ui.notifications.error(game.i18n.localize("PF1.Error.NoSave"));
        }
        noSound = true;
      }
    } finally {
      button.disabled = wasDisabled;
      ACTIVE_SAVE_CLICKS.delete(key);
    }
  }, true);
}
