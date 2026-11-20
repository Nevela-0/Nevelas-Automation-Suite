import { fail } from "./model.js";

export function manualChoices(economy) {
  return economy === "unchained"
    ? ["act1", "act2", "act3", "reaction", "aoo", "free", "nonaction"]
    : ["standard", "move", "full", "swift", "immediate", "aoo", "free", "nonaction"];
}

export function createManualUseRecorder(service) {
  return function recordManualUse(combatantUuid, request) {
    if (!["normal", "unchained"].includes(request?.economy) || !manualChoices(request.economy).includes(request.choice)) {
      fail("invalidUse", "Unknown manual action choice.");
    }
    if (!request.operationId || !request.expectedCheckpointId) fail("invalidUse", "Manual actions require a captured turn and operation ID.");
    const isAct = request.choice.startsWith("act");
    return service.recordPF1Use(combatantUuid, {
      operationId: request.operationId, expectedCheckpointId: request.expectedCheckpointId,
      label: request.label ?? `Manual: ${request.choice}`
    }, {
      economy: request.economy, activationSource: "pf1",
      activation: { type: isAct ? "action" : request.choice, cost: isAct ? Number(request.choice.at(-1)) : 1 }
    }, "manual");
  };
}
