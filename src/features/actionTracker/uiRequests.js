import { trackerSettings } from "./settings.js";
import { canSeeCounters, canManage } from "./uiModel.js";
import { STEP_REQUESTS } from "./movementSteps.js";
import { ACTIVITY_REQUESTS } from "./movementActivities.js";

export const canInspectHistory = (combatant, user) =>
  !!combatant && canManage(combatant, user) && canSeeCounters(combatant, user, "owners");

export function createTrackerRequests({ getGame, service, recordManualUse, notify = () => {} }) {
  const requests = new Map();
  const externalPending = new Map(), deferredFailures = new Map();
  const listeners = new Set();
  const hasGM = () => !!(getGame()?.users?.activeGM?.active && getGame().users.activeGM.isGM);
  const permitted = (request, requireEnabled = true) => {
    const game = getGame();
    const combat = game?.combats?.get(request.combatId);
    const combatant = Array.from(combat?.combatants ?? []).find((entry) => entry.uuid === request.combatantUuid);
    return (!requireEnabled || trackerSettings(game).enabled) && combat?.visible !== false
      && combat?.uuid === request.combatUuid && canInspectHistory(combatant, game?.user);
  };
  const changed = (request) => Promise.all(Array.from(listeners, async (listener) => {
    try { await listener({ combatUuid: request.combatUuid }); }
    catch (error) { console.warn("NAS action tracker UI refresh failed", error); }
  }));
  const status = (uuid) => ({ ...requests.get(uuid), pending: !!requests.get(uuid)?.pending || (externalPending.get(uuid) ?? 0) > 0, hasGM: hasGM() });
  const promote = (uuid) => {
    if (requests.has(uuid)) return;
    const failures = deferredFailures.get(uuid);
    if (failures?.length) requests.set(uuid, failures.shift());
    if (!failures?.length) deferredFailures.delete(uuid);
  };

  async function mutate(request) {
    if (!permitted(request) || !hasGM() || status(request.combatantUuid).pending) return;
    const entry = { request: structuredClone(request), pending: true, failure: null };
    requests.set(request.combatantUuid, entry);
    void changed(request);
    let result;
    try {
      result = request.kind === "spend" ? await recordManualUse(request.combatantUuid, entry.request)
        : ["payMovement", "endMovement", "movementMode", "linkMovementPayment", "unlinkMovementPayment", ...STEP_REQUESTS, ...ACTIVITY_REQUESTS].includes(request.kind) ? await service.movementRequest(request.combatantUuid, entry.request)
        : request.kind === "excludeMovement" ? await service.excludeMovement(request.combatantUuid, request.operationId)
          : await service.undoUse(request.combatantUuid, request.operationId);
    } catch (error) {
      result = { ok: false, code: error.code ?? "trackingFailed", message: error.message ?? "The tracker change could not be confirmed." };
    }
    if (requests.get(request.combatantUuid) === entry) {
      if (result.ok) { requests.delete(request.combatantUuid); promote(request.combatantUuid); }
      else {
        entry.pending = false;
        entry.failure = result;
        notify(result.message);
      }
    }
    await changed(request);
    return result;
  }

  return {
    status, mutate,
    hold(request) {
      const uuid = request.combatantUuid;
      externalPending.set(uuid, (externalPending.get(uuid) ?? 0) + 1); void changed(request);
      let released = false;
      return () => {
        if (released) return; released = true;
        const count = (externalPending.get(uuid) ?? 1) - 1;
        if (count) externalPending.set(uuid, count); else externalPending.delete(uuid);
        void changed(request);
      };
    },
    async trackExternal(request, task) {
      const uuid = request.combatantUuid;
      externalPending.set(uuid, (externalPending.get(uuid) ?? 0) + 1); void changed(request);
      let result;
      try { result = await task(); }
      catch (error) { result = { ok: false, code: "trackingFailed", message: error.message }; }
      externalPending.set(uuid, externalPending.get(uuid) - 1);
      if (!externalPending.get(uuid)) externalPending.delete(uuid);
      if (!result.ok) {
        const entry = { request: structuredClone(request), pending: false, failure: result };
        if (!requests.has(uuid)) requests.set(uuid, entry);
        else { const queue = deferredFailures.get(uuid) ?? []; queue.push(entry); deferredFailures.set(uuid, queue); }
      }
      await changed(request); return result;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    prune() {
      for (const [uuid, entry] of requests) if (!entry.pending && !permitted(entry.request, false)) { requests.delete(uuid); deferredFailures.delete(uuid); }
    },
    retry(uuid) {
      const entry = requests.get(uuid);
      if (entry?.failure && !entry.pending) return mutate(entry.request);
    },
    dismiss(uuid) {
      const entry = requests.get(uuid);
      if (!entry || entry.pending) return;
      requests.delete(uuid);
      promote(uuid);
      return changed(entry.request);
    }
  };
}
