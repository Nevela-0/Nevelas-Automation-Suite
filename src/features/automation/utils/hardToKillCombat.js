import { MODULE } from "../../../common/module.js";
import { detectHardToKillItems, getHtkFlag } from "./hardToKill.js";

async function expireFightOnTempIfNeeded(actor) {
  const flag = getHtkFlag(actor);
  const temp = flag?.fightOnTemp;
  if (!temp?.expiresAt) return;
  const now = game.time?.worldTime ?? 0;
  if (now < temp.expiresAt) return;

  const amount = Number(temp.amount ?? 0) || 0;
  if (amount > 0) {
    const hp = actor.system?.attributes?.hp;
    const currentTemp = Number(hp?.temp ?? 0) || 0;
    const nextTemp = Math.max(0, currentTemp - amount);
    await actor.update({ "system.attributes.hp.temp": nextTemp });
  }
  await actor.setFlag(MODULE.ID, "htk", { ...flag, fightOnTemp: null });
}

async function maybeApplyFerocityRoundLoss(actor) {
  const hp = actor.system?.attributes?.hp;
  if (!hp || !Number.isFinite(hp.value)) return;
  if (hp.value >= 0) return;
  if (actor.statuses?.has?.("unconscious")) return;

  const htkItems = await detectHardToKillItems(actor);
  const hasFerocity =
    Boolean(htkItems.ferocityUmr) ||
    Boolean(htkItems.ferocityOrc) ||
    Boolean(htkItems.ferociousResolve) ||
    Boolean(htkItems.unstoppableRavager); 

  if (!hasFerocity) return;

  const conScore = Number(actor.system?.abilities?.con?.total ?? actor.system?.abilities?.con?.value ?? 0) || 0;
  if (conScore > 0 && hp.value <= -conScore) return;

  await actor.update({ "system.attributes.hp.value": hp.value - 1 });
}

async function maybeStartFightOnWindowForCurrent(combat) {
  const tokenId = combat.combatant?.token?.id ?? combat.combatant?.tokenId ?? null;
  if (!tokenId) return;
  const token = canvas.tokens.get(tokenId);
  const actor = token?.actor;
  if (!actor) return;

  const flag = getHtkFlag(actor);
  if (!flag?.fightOnRoundPending) return;

  const skips = Math.max(0, Number(flag?.fightOnSkipTurnEnds ?? 0) || 0);
  await actor.setFlag(MODULE.ID, "htk", {
    ...flag,
    fightOnRoundPending: false,
    fightOnRoundActive: true,
    fightOnDropAfterTurn: true,
    fightOnSkipTurnEnds: skips,
  });
}

async function maybeEndFightOnWindowForPrevious(combat) {
  const prevTokenId = combat.previous?.tokenId ?? null;
  if (!prevTokenId) return;
  const prevToken = canvas.tokens.get(prevTokenId);
  const actor = prevToken?.actor;
  if (!actor) return;

  const flag = getHtkFlag(actor);
  if (!flag?.fightOnDropAfterTurn) return;

  const skips = Math.max(0, Number(flag?.fightOnSkipTurnEnds ?? 0) || 0);
  if (skips > 0) {
    await actor.setFlag(MODULE.ID, "htk", {
      ...flag,
      fightOnSkipTurnEnds: skips - 1,
    });
    return;
  }

  const hp = actor.system?.attributes?.hp;
  const value = Number(hp?.value ?? 0) || 0;

  if (value <= 0) {
    await actor.setCondition?.("unconscious", true);
    await actor.setCondition?.("prone", true);
  }

  await actor.setFlag(MODULE.ID, "htk", {
    ...flag,
    fightOnRoundActive: false,
    fightOnDropAfterTurn: false,
    fightOnSkipTurnEnds: 0,
  });
}

export function handleHtkCombatUpdate(combat, update) {
  if (!combat) return;
  if (update?.turn === undefined && update?.round === undefined) return;

  void (async () => {
    await maybeEndFightOnWindowForPrevious(combat);
    await maybeStartFightOnWindowForCurrent(combat);

    const prevTokenId = combat.previous?.tokenId ?? null;
    if (prevTokenId) {
      const prevToken = canvas.tokens.get(prevTokenId);
      if (prevToken?.actor) {
        await maybeApplyFerocityRoundLoss(prevToken.actor);
        await expireFightOnTempIfNeeded(prevToken.actor);
      }
    }

    const curTokenId = combat.combatant?.token?.id ?? combat.combatant?.tokenId ?? null;
    if (curTokenId) {
      const curToken = canvas.tokens.get(curTokenId);
      if (curToken?.actor) await expireFightOnTempIfNeeded(curToken.actor);
    }
  })();
}

