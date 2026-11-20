import { elementFromHtmlLike, foundryGeneration } from "../../common/foundryCompat.js";
import { captureTurn } from "./model.js";
import { trackerSettings } from "./settings.js";
import { canManage, canSeeCounters, choiceLabel, createTrackerLocalizer } from "./uiModel.js";
import { buildTrackerRow } from "./uiView.js";
import { ensureTrackerStyles } from "./uiStyles.js";
import { createTrackerRequests } from "./uiRequests.js";
import { createTrackerHistory } from "./history.js";

const OWNED = ".nas-action-tracker";

export function createTrackerUI({ getGame, service, recordManualUse, createId, notify = () => {}, createHistoryApplication }) {
  const instances = new Map();
  const requests = createTrackerRequests({ getGame, service, recordManualUse, notify });
  const historyWindow = createTrackerHistory({ getGame, service, requests, notify, createId, createApplication: createHistoryApplication });
  const t = createTrackerLocalizer(getGame);
  let warnedLegacy = false;
  const viewed = (app, data) => app.viewed !== undefined ? app.viewed : data?.combat ?? null;
  const available = (combat) => !!combat && combat.visible !== false && getGame()?.combats?.get(combat.id) === combat;
  const remove = (root) => root?.querySelectorAll(OWNED).forEach((node) => {
    node.closest("li.combatant")?.classList.remove("nas-at-host");
    node.remove();
  });

  function warnLegacy() {
    const game = getGame();
    const settings = trackerSettings(game);
    if (!warnedLegacy && game?.user?.isGM && (settings.enabled || settings.automatic || settings.movement) && game.modules?.get("pf1-action-tracker")?.active) {
      warnedLegacy = true;
      notify(t("legacyWarning", "Both action trackers are enabled. Disable pf1-action-tracker in Manage Modules to switch to NAS."));
    }
  }

  async function refresh(event) {
    warnLegacy();
    requests.prune();
    await Promise.all([historyWindow.refresh(event), ...Array.from(instances, ([app, instance]) => {
      if (!event?.combatUuid || instance.combat?.uuid === event.combatUuid || viewed(app, instance.data)?.uuid === event.combatUuid) {
        return render(app, instance.root, instance.data);
      }
    })]);
  }
  requests.subscribe(refresh);

  function act(instance, view, action, value) {
    const { app, combat } = instance;
    const { combatant, panel } = view;
    const game = getGame();
    if (instances.get(app) !== instance || !available(combat) || viewed(app, instance.data) !== combat
      || combat.combatants.get(combatant.id) !== combatant || !trackerSettings(game).enabled
      || !canSeeCounters(combatant, game.user, trackerSettings(game).visibility) || !canManage(combatant, game.user)) return;
    if (action === "expand") panel.open = !panel.open;
    else if (action === "close-menu") { panel.open = false; instance.nextFocus = { uuid: combatant.uuid, key: "expand:" }; }
    else if (action === "history") return historyWindow.open(combatant);
    else {
      const status = requests.status(combatant.uuid);
      if (status?.pending) return;
      if (action === "dismiss") return requests.dismiss(combatant.uuid);
      else {
        if (!status.hasGM) return;
        if (action === "retry") {
          if (status?.failure) return requests.retry(combatant.uuid);
          return;
        }
        if (status?.failure) return;
        const base = { combatUuid: combat.uuid, combatId: combat.id, combatantUuid: combatant.uuid };
        if (action === "spend") {
          const turn = captureTurn(combat);
          if (turn.round < 1 || !turn.combatantUuid) return;
          return requests.mutate({
            ...base, kind: "spend", choice: value, economy: trackerSettings(game).economy,
            expectedCheckpointId: turn.id, operationId: createId(),
            label: t("manualLabel", "Manual: {action}", { action: choiceLabel(value, t) })
          });
        }
        if (["payMovement", "endMovement", "movementMode", "finishActivity"].includes(action)) {
          const turn = captureTurn(combat);
          if (!["movementMode", "finishActivity"].includes(action) && (turn.round < 1 || turn.combatantUuid !== combatant.uuid)) return;
          return requests.mutate({ ...base, kind: action, operationId: createId(), expectedCheckpointId: turn.id,
            ...(action === "finishActivity" ? { activityId: value }
              : action === "movementMode" ? { mode: value } : {}) });
        }
        if (action === "undo-last") {

          const operationId = view.lastOperationId;
          if (operationId) {
            return requests.mutate({ ...base, kind: "undo", operationId });
          }
          return;
        }
      }
    }
    return refresh({ combatUuid: combat.uuid });
  }

  async function render(app, html, data) {
    const root = elementFromHtmlLike(app.element) ?? elementFromHtmlLike(html);
    if (!root) return;
    let instance = instances.get(app);
    if (!instance) {
      instance = { app, panels: new Map(), epoch: 0 };
      instances.set(app, instance);
    }
    const focus = root.ownerDocument?.activeElement;
    if (focus && root.contains(focus) && focus.closest?.(OWNED)) {
      instance.focus = { uuid: focus.closest(OWNED).dataset.combatantUuid, key: focus.dataset.focusKey };
    } else if (focus && focus !== root.ownerDocument.body && focus !== root.ownerDocument.documentElement) {
      instance.focus = null;
    }
    if (instance.nextFocus) { instance.focus = instance.nextFocus; instance.nextFocus = null; }
    if (instance.root !== root) remove(instance.root);
    Object.assign(instance, { root, data, combat: viewed(app, data) });
    const epoch = ++instance.epoch;
    const combat = instance.combat;

    remove(root);
    warnLegacy();
    const game = getGame();
    const settings = trackerSettings(game);
    if (!settings.enabled || !available(combat)) return;
    ensureTrackerStyles(root.ownerDocument);
    const checkpointId = captureTurn(combat).id;
    const valid = (row, combatant) => instances.get(app) === instance && instance.epoch === epoch
      && instance.root === root && root.isConnected && row.isConnected && root.contains(row)
      && viewed(app, instance.data) === combat && available(combat) && captureTurn(combat).id === checkpointId
      && combat.combatants.get(combatant.id) === combatant;
    for (const uuid of instance.panels.keys()) {
      if (!Array.from(combat.combatants).some((entry) => entry.uuid === uuid)) instance.panels.delete(uuid);
    }
    await Promise.all(Array.from(root.querySelectorAll("li.combatant[data-combatant-id]"), async (row) => {
      const combatant = combat.combatants.get(row.dataset.combatantId);
      const anchor = row.querySelector(".token-name");
      if (!anchor || !canSeeCounters(combatant, game.user, settings.visibility)) return;
      const manage = canManage(combatant, game.user);
      const panel = instance.panels.get(combatant.uuid) ?? { open: false };
      instance.panels.set(combatant.uuid, panel);
      let state, details, error;
      try {
        let movementRead;
        if (manage && (settings.movement || panel.open)) movementRead = service.getMovementDetails(combatant.uuid);
        else if (settings.movement) movementRead = service.getMovementState(combatant.uuid).then(movement => ({ movement }));
        [state, details] = await Promise.all([service.getState(combatant.uuid, { includeUndoTarget: manage }), movementRead]);
      } catch (failure) { error = failure; }
      const current = trackerSettings(getGame());
      if (!valid(row, combatant) || !current.enabled || !canSeeCounters(combatant, getGame().user, current.visibility)
        || manage !== canManage(combatant, getGame().user)) return;
      const view = { combatant, panel, lastOperationId: state?.lastOperationId };
      const content = buildTrackerRow({
        document: root.ownerDocument, combat, combatant, user: getGame().user, settings: current,
        state, movement: settings.movement ? details?.movement : undefined, movementSpending: details?.spending,
        generation: foundryGeneration(getGame()) ?? 12, panel, manage, error, t,
        status: requests.status(combatant.uuid),
        onAction: (action, value) => {
          if (!valid(row, combatant)) return;

          try { Promise.resolve(act(instance, view, action, value)).catch((failure) => notify(failure.message)); }
          catch (failure) { notify(failure.message); }
        }
      });

      row.classList.add("nas-at-host");
      row.append(content);
      const active = root.ownerDocument.activeElement;
      if (instance.focus?.uuid === combatant.uuid && instance.focus.key
        && (!active || active === root.ownerDocument.body || root.contains(active))) {
        Array.from(content.querySelectorAll("[data-focus-key]")).find((control) => control.dataset.focusKey === instance.focus.key)?.focus?.({ preventScroll: true });
        instance.focus = null;
      }
    }));
  }

  function close(app) {
    const instance = instances.get(app);
    if (!instance) return;
    instance.epoch += 1;
    remove(instance.root);
    instances.delete(app);
  }

  return { render, refresh, close, warnLegacy, historyWindow,
    mutationStatus: requests.status,
    holdMovement(combatant) { return requests.hold({ combatantUuid: combatant.uuid, combatUuid: combatant.parent.uuid }); },
    trackRequest(uuid, input, task) {
      const combat = Array.from(getGame()?.combats ?? []).find((c) => Array.from(c.combatants).some((cb) => cb.uuid === uuid));
      if (!combat) return task();
      return requests.trackExternal({ ...input, combatantUuid: uuid, combatId: combat.id, combatUuid: combat.uuid }, task);
    } };
}

export function registerTrackerUIHooks(ui, hooks = globalThis.Hooks) {
  const safe = (task) => (...args) => {
    try { return Promise.resolve(task(...args)).catch((error) => console.warn("NAS action tracker UI", error)); }
    catch (error) { console.warn("NAS action tracker UI", error); }
  };

  hooks.on("renderCombatTracker", safe((...args) => Promise.all([ui.render(...args), ui.historyWindow.refresh()])));
  hooks.on("closeCombatTracker", (app) => ui.close(app));
  hooks.on("nasActionTrackerChanged", safe(ui.refresh));
  hooks.on("nasActionTrackerSettingsChanged", safe(() => ui.refresh()));
  hooks.once("ready", safe(() => ui.refresh()));
  hooks.on("userConnected", safe(() => ui.refresh()));
  hooks.on("updateUser", safe(() => ui.refresh()));
  hooks.on("updateActor", (actor, change) => {
    if (Object.keys(change).some((key) => key === "ownership" || key.startsWith("ownership."))) return safe(() => ui.refresh())();
  });
  hooks.on("updateCombatant", (combatant, change) => {
    if (["hidden", "actorId", "tokenId", "sceneId", "name"].some((key) => Object.hasOwn(change, key))) {
      return safe(() => ui.refresh({ combatUuid: combatant.parent.uuid }))();
    }
  });
  hooks.on("updateToken", (token, change) => {
    if (Object.keys(change).some((key) => ["actorId", "actorLink", "delta", "hidden", "name"].some((field) => key === field || key.startsWith(`${field}.`)))) return safe(() => ui.refresh())();
  });
  hooks.on("updateActorDelta", (delta, change) => {
    if (Object.keys(change).some((key) => key === "ownership" || key.startsWith("ownership.") || key === "name")) return safe(() => ui.refresh())();
  });
  for (const hook of ["createCombat", "deleteCombat", "createCombatant", "deleteCombatant", "deleteActor", "deleteToken", "createActorDelta", "deleteActorDelta", "canvasReady"]) {
    hooks.on(hook, safe(() => ui.refresh()));
  }
  hooks.on("updateCombat", safe(() => ui.refresh()));
  hooks.on("updateSetting", (setting) => {
    if (setting.key === "pf1.unchainedActionEconomy") return safe(() => ui.refresh())();
  });
}
