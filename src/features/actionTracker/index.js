import { MODULE } from "../../common/module.js";
import { createNasId } from "../automation/utils/nasIds.js";
import { createActionTrackerService, TRACKER_SOCKET } from "./service.js";
import { captureTurn, copy, TRACKER_FLAG } from "./model.js";
import { createPF1Adapter } from "./pf1Adapter.js";
import { isAutomaticTrackingEnabled, trackerSettings } from "./settings.js";
import { createManualUseRecorder } from "./manual.js";
import { createTrackerUI, registerTrackerUIHooks } from "./ui.js";
import { MOVEMENT_FLAG } from "./movementModel.js";
import { createMovementAdapter } from "./movementAdapter.js";
import { createMovementMarkers } from "./movementMarkers.js";
import { renderRegionPresets } from "./regionPresets.js";
import { renderSpringDialog } from "./springDialog.js";
import { createMovementInterception } from "./movementInterception.js";

let trackerSocket;
let hooksRegistered = false;

function emit(name, ...args) {
  try { globalThis.Hooks?.callAll?.(name, ...args); }
  catch (error) { console.warn(`[${MODULE.ID}] ${name} listener failed`, error); }
}

const service = createActionTrackerService({
  moduleId: MODULE.ID,
  getGame: () => globalThis.game,
  resolveUuid: (uuid) => globalThis.fromUuid(uuid),
  getSocket: () => trackerSocket,
  createId: () => createNasId(24),
  onCommitted: (event) => emit("nasActionTrackerCommitted", event)
});

export const { getState, getHistory, recordUse, undoUse, undoLastUse } = service;

export const recordManualUse = createManualUseRecorder(service);

const trackerUI = createTrackerUI({
  getGame: () => globalThis.game, service, recordManualUse,
  createId: () => createNasId(24),
  notify: (message) => globalThis.ui?.notifications?.warn(message)
});

const movementInterception = createMovementInterception({ getGame: () => globalThis.game, service,
  createId: () => createNasId(24), trackRequest: trackerUI.trackRequest,
  mutationStatus: trackerUI.mutationStatus, holdMovement: trackerUI.holdMovement,
  notify: (message) => globalThis.ui?.notifications?.warn(message) });
const movementAdapter = createMovementAdapter({ getGame: () => globalThis.game, service, createId: () => createNasId(24),
  interceptRuler: (ruler, run, token) => movementInterception.ruler(ruler, run, token),
  changed: (combat, uuid, gap) => {
    changed(combat, "state", uuid);
    if (gap && game.users.activeGM?.id === game.user.id && trackerSocket) {
      void trackerSocket.executeForOthers("actionTrackerMovementGap", { combatantUuid: uuid, ...gap })
        .catch((error) => console.warn("NAS movement gap notification", error));
    }
  },
  report: (message, userId) => {
    if (userId === game.user.id) globalThis.ui?.notifications?.warn(`Movement tracking: ${message}`);
    else if (game.users.activeGM?.id === game.user.id && trackerSocket) {
      void trackerSocket.executeAsUser("actionTrackerMovementNotice", userId, message).catch((error) => console.warn("NAS movement notice", error));
    }
    console.warn(`[${MODULE.ID}] Movement tracking`, message);
  }
});
service.finishRulerMovement = async (request) => {
  const gm = game.users.activeGM;
  if (!gm?.active || !trackerSocket) return { ok: false, message: "Movement tracking requires a connected GM." };
  return trackerSocket.executeAsUser("actionTrackerFinishRuler", gm.id, request);
};
const movementMarkers = createMovementMarkers({ getGame: () => globalThis.game, getCanvas: () => globalThis.canvas,
  service, loadTexture: (src) => globalThis.loadTexture(src) });

const adapter = createPF1Adapter({
  getGame: () => globalThis.game, service, createId: () => createNasId(24),
  isEnabled: isAutomaticTrackingEnabled,
  observeBoundaries: () => trackerSettings().movement,
  emitPrepare: (actionUse, context) => emit("nasActionTrackerPrepareUse", actionUse, context),
  trackRequest: trackerUI.trackRequest,
  notify: (result) => {
    globalThis.ui?.notifications?.warn(`Action tracker: ${result.message}`);
    console.warn(`[${MODULE.ID}] Action tracker`, result);
  }
});

export const configureUse = adapter.configureUse;
export async function prepareSpringAttackUse(actionUse) {
  while (true) {
    let result;
    try { result = await adapter.prepareSpring(actionUse); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (result.ok) return true;
    if (result.code === "springAttackLimit") {
      ui.notifications.warn(result.message);
      await adapter.releaseSpring(actionUse, { separate: true }); return true;
    }

    const choice = await new Promise((resolve) => {
      const paragraph = document.createElement("p"); paragraph.textContent = result.message;
      new Dialog({ title: "Spring Attack could not be prepared", content: paragraph.outerHTML,
        buttons: { retry: { label: "Retry same attack", callback: () => resolve("retry") },
          separate: { label: "Use separate attack", callback: () => resolve("separate") },
          cancel: { label: "Cancel", callback: () => resolve("cancel") } },
        default: "cancel", close: () => resolve("cancel") }).render(true);
    });
    if (choice === "retry") continue;
    try { await adapter.releaseSpring(actionUse, { separate: choice === "separate" }); }
    catch (error) { ui.notifications.warn(`Spring Attack reservation needs review: ${error.message}`); }
    return choice === "separate";
  }
}
export async function releaseSpringAttackUse(actionUse) {
  try {
    const result = await adapter.releaseSpring(actionUse);
    if (!result.ok) globalThis.ui?.notifications?.warn(`Spring Attack reservation needs review: ${result.message}`);
  } catch (error) { globalThis.ui?.notifications?.warn(`Spring Attack reservation needs review: ${error.message}`); }
}

export async function awaitActionTrackerUse(actionUse) {
  try { return await adapter.awaitCompletion(actionUse); }
  catch (error) {
    console.warn(`[${MODULE.ID}] Action tracker completion failed`, error);
    return { ok: false, code: "trackingFailed", message: error.message };
  }
}

export function registerActionTrackerApi() {
  const module = globalThis.game?.modules?.get(MODULE.ID);
  if (!module) return;
  module.api ??= {};
  module.api.actionTracker = Object.freeze({
    apiVersion: 1, getState, getHistory, spend: recordUse, undoUse, undoLastUse, configureUse
  });
}

function trackerFlagChanged(change, flag = TRACKER_FLAG) {
  const path = `flags.${MODULE.ID}.${flag}`;
  return Object.keys(change).some((key) => key === path || key.startsWith(`${path}.`) || key === `flags.${MODULE.ID}.-=${flag}`)
    || Object.hasOwn(change[`flags.${MODULE.ID}`] ?? {}, flag)
    || Object.hasOwn(change.flags?.[MODULE.ID] ?? {}, flag)
    || Object.hasOwn(change.flags?.[MODULE.ID] ?? {}, `-=${flag}`);
}

function changed(combat, reason, combatantUuid = null) {
  if (!combat) return;
  emit("nasActionTrackerChanged", copy({
    combatUuid: combat.uuid, combatantUuid, reason, checkpointId: captureTurn(combat).id
  }));
}

export function registerActionTrackerSocket(socket) {
  trackerSocket = socket;
  socket.register(TRACKER_SOCKET, function (request) {
    return service.handleRequest(request, this.socketdata?.userId);
  });
  socket.register("actionTrackerFinishRuler", function (request) {
    return movementAdapter.finishRuler(request ?? {}, this.socketdata?.userId);
  });
  socket.register("actionTrackerMovementNotice", function (message) {
    if (this.socketdata?.userId === game.users.activeGM?.id && typeof message === "string") {
      globalThis.ui?.notifications?.warn(`Movement tracking: ${message.slice(0, 2048)}`);
    }
  });
  socket.register("actionTrackerMovementGap", function (gap) {
    if (this.socketdata?.userId !== game.users.activeGM?.id || typeof gap?.combatantUuid !== "string"
      || typeof gap?.turn?.id !== "string" || typeof gap?.message !== "string") return;
    const combatant = Array.from(game.combats ?? []).flatMap((combat) => Array.from(combat.combatants)).find((c) => c.uuid === gap.combatantUuid);
    if (!combatant) return;
    service.markMovementIncomplete(combatant.uuid, gap.turn, gap.message.slice(0, 2048));
    changed(combatant.parent, "state", combatant.uuid);
  });
}

export function registerActionTrackerHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerActionTrackerApi();
  registerTrackerUIHooks(trackerUI);
  movementInterception.register();
  movementAdapter.register();
  movementMarkers.register();
  Hooks.on("renderRegionBehaviorConfig", (app, html) => renderRegionPresets(app, html));
  Hooks.on("renderAttackDialog", (app, html) => renderSpringDialog(app, html, adapter.springContext(app.actionUse), game.user));
  Hooks.on("pf1CreateActionUse", (actionUse) => { adapter.capture(actionUse); });
  Hooks.on("pf1PostActionUse", (actionUse, message) => { void adapter.complete(actionUse, message); });
  const observe = (combat) => {
    if (!combat) return;
    void service.observeCombat(combat).then((result) => {
      if (!result.ok) console.warn(`[${MODULE.ID}] Action tracker: ${result.message}`);
    });
  };

  Hooks.on("updateCombat", (combat, change) => {
    if (Object.hasOwn(change, "active")) observe(combat);
    if (Object.hasOwn(change, "turn") || Object.hasOwn(change, "round")) {
      service.captureTurnStart(combat);
      observe(combat);
      if (combat.getFlag(MODULE.ID, TRACKER_FLAG)) changed(combat, "turn");
    } else if (trackerFlagChanged(change)) changed(combat, "state");
  });
  Hooks.on("combatStart", (combat) => {
    service.captureTurnStart(combat);
    observe(combat);
    if (combat.getFlag(MODULE.ID, TRACKER_FLAG)) changed(combat, "turn");
  });
  Hooks.on("updateCombatant", (combatant, change) => {
    if (Object.hasOwn(change, "initiative")) {
      observe(combatant.parent);
      if (combatant.parent.getFlag(MODULE.ID, TRACKER_FLAG)) changed(combatant.parent, "turn");
    }
    if (trackerFlagChanged(change) || trackerFlagChanged(change, MOVEMENT_FLAG)) changed(combatant.parent, "state", combatant.uuid);
  });
  Hooks.on("createCombatant", (combatant) => {
    observe(combatant.parent);
    if (combatant.parent.getFlag(MODULE.ID, TRACKER_FLAG)) changed(combatant.parent, "turn");
  });
  Hooks.on("deleteCombatant", (combatant) => {
    observe(combatant.parent);
    changed(combatant.parent, "deleted", combatant.uuid);
  });
  Hooks.on("deleteCombat", (combat) => changed(combat, "deleted"));
  const reconcile = () => {
    for (const combat of game.combats ?? []) {
      observe(combat);
      if (combat.getFlag(MODULE.ID, TRACKER_FLAG)) changed(combat, "reconcile");
    }
  };
  Hooks.once("ready", () => { registerActionTrackerApi(); reconcile(); });
  Hooks.on("userConnected", reconcile);
}
