import { fail, normalizeActivation, normalizeMetadata } from "./model.js";

export function normalizePF1Details(input) {
  if (!input || !["normal", "unchained"].includes(input.economy)) fail("invalidActivation", "Unknown action economy.");
  if (!["pf1", "nas"].includes(input.activationSource)) fail("invalidActivation", "Unknown activation source.");
  return {
    economy: input.economy,
    activation: normalizeActivation(input.activation),
    activationSource: input.activationSource,
    fullAttack: input.fullAttack === true,
    extraFullRound: input.extraFullRound === true
  };
}

export function activationMetadata(details, inference = []) {
  const { activation, economy, activationSource, extraFullRound } = details;
  return normalizeMetadata({
    activation, economy, activationSource, inference,
    ...(["round", "minute", "hour"].includes(activation.type) || extraFullRound
      ? { continuation: { activation, extraFullRound } } : {})
  });
}

export function resolvePF1Costs(input, { used = {}, onTurn }) {
  const details = normalizePF1Details(input);
  const { activation: { type, cost }, economy, fullAttack, activationSource } = details;
  let costs = {};
  let nextTurnCosts = {};
  const inference = [];
  const full = economy === "unchained" ? { action: 3 } : { standard: 1, move: 1 };
  if (["free", "nonaction"].includes(type)) costs = { [type]: 1 };
  else if (["round", "minute", "hour"].includes(type)) {
    costs = full;
    inference.push("startingTurnOnly");
  } else if (type === "aoo" || (type === "attack" && !onTurn)) {
    costs = economy === "unchained" ? { aoo: 1, reaction: 1 } : { aoo: 1 };
    if (type === "attack") inference.push("offTurnAttackAsAoo");
  } else if (economy === "unchained") {
    if (type === "action") {
      if (!Number.isSafeInteger(cost) || cost < 1) fail("invalidActivation", "An unchained action needs a positive whole act cost.");
      costs = { action: cost };
    } else if (type === "reaction") costs = { reaction: 1 };
    else if (type === "attack") costs = { action: 1 };
    else if (activationSource === "nas" && type === "swift") costs = { action: 1 };
    else if (activationSource === "nas" && type === "full") costs = full;
    else fail("unsupportedActivation", `Cannot infer unchained action costs for activation '${type || "missing"}'.`);
  } else {
    switch (type) {
      case "standard": costs = { standard: 1 }; break;
      case "move":
        if ((used.move ?? 0) === 0 || (used.standard ?? 0) !== 0) costs = { move: 1 };
        else { costs = { standard: 1 }; inference.push("moveUsesStandard"); }
        break;
      case "attack": costs = fullAttack ? full : { standard: 1 }; break;
      case "full": costs = full; break;
      case "swift": costs = { swift: 1 }; break;
      case "immediate":
        costs = onTurn ? { immediate: 1, swift: 1 } : { immediate: 1 };
        if (!onTurn) nextTurnCosts = { swift: 1 };
        break;
      default: fail("unsupportedActivation", `Cannot infer action costs for activation '${type || "missing"}'.`);
    }
  }
  return { costs, nextTurnCosts, metadata: activationMetadata(details, inference) };
}
