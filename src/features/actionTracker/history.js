import { MODULE } from "../../common/module.js";
import { captureTurn, includeCheckpoint, readTimeline, TRACKER_FLAG } from "./model.js";
import { trackerSettings } from "./settings.js";
import { createTrackerLocalizer } from "./uiModel.js";
import { canInspectHistory } from "./uiRequests.js";
import { buildHistoryView } from "./historyView.js";
import { createHistoryApplication } from "./historyApp.js";
import { ensureTrackerStyles } from "./uiStyles.js";

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function combinedHistory(combat, histories, { type = "all", turn = "all", page = 0 } = {}) {
  const currentTurn = captureTurn(combat);
  const { timeline } = includeCheckpoint(readTimeline(combat.getFlag(MODULE.ID, TRACKER_FLAG)), currentTurn);
  const positions = new Map(timeline.checkpoints.map((checkpoint, index) => [checkpoint.id, index]));
  const checkpoints = new Map(timeline.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const currentId = currentTurn.id;
  const selectedId = turn === "current" ? currentId : turn;
  const entries = histories.flatMap(({ combatant, actions = [], movements = [], spending }) =>
    [["action", actions], ["movement", [...movements, ...(spending?.activities ?? []).map((a) => ({ ...a, activityKind: a.kind, kind: "activity", operationId: a.id }))]]].flatMap(([entryType, records]) => records.map((use) => ({
      combatant, type: entryType, use, checkpoint: checkpoints.get(use.checkpointId),
      key: JSON.stringify([combatant.uuid, entryType, use.operationId]),
      later: positions.get(use.checkpointId) > positions.get(currentId)
    }))))
    .filter((entry) => (type === "all" || entry.type === type) && (turn === "all" || entry.use.checkpointId === selectedId))
    .sort((a, b) => (positions.get(b.use.checkpointId) ?? -1) - (positions.get(a.use.checkpointId) ?? -1)
      || (b.use.createdAt ?? 0) - (a.use.createdAt ?? 0)
      || compareText(a.combatant.uuid, b.combatant.uuid)
      || compareText(a.type, b.type) || compareText(a.use.operationId, b.use.operationId));
  const pages = Math.max(1, Math.ceil(entries.length / 20));
  const selectedPage = Math.max(0, Math.min(page, pages - 1));
  return { entries: entries.slice(selectedPage * 20, (selectedPage + 1) * 20),
    total: entries.length, page: selectedPage, pages, timeline };
}

export function createTrackerHistory({ getGame, service, requests, notify = () => {}, createId, createApplication = createHistoryApplication }) {
  const t = createTrackerLocalizer(getGame);
  const paymentChoices = new Map();
  const expanded = new Set();
  const selection = { combatUuid: null, combatantUuid: null, type: "all", turn: "all", page: 0 };
  let host, root, opened = false, epoch = 0, generation = 0, position = {}, scrollTop = 0, focusKey = null, focusFallback = null;
  const combats = () => Array.from(getGame()?.combats ?? []);
  const findCombat = () => combats().find((combat) => combat.uuid === selection.combatUuid);
  const permitted = (combat) => combat?.visible === false ? [] : Array.from(combat?.combatants ?? []).filter((entry) => canInspectHistory(entry, getGame()?.user));
  const safe = (task) => {
    try { return Promise.resolve(task()).catch((error) => notify(error.message)); }
    catch (error) { notify(error.message); }
  };

  function remember() {
    if (!root) return;
    for (const details of root.querySelectorAll("details[data-disclosure-key]")) {
      if (details.hasAttribute("open")) expanded.add(details.dataset.disclosureKey);
      else expanded.delete(details.dataset.disclosureKey);
    }
    for (const field of root.querySelectorAll(".nas-at-payment-sequence, .nas-at-step-assessment, .nas-at-activity-attack")) paymentChoices.set(field.dataset.focusKey, field.value);
    const scroll = root.querySelector(".nas-at-history-scroll");
    if (scroll) scrollTop = scroll.scrollTop ?? 0;
    const focus = root.ownerDocument.activeElement;
    if (focus && root.contains(focus)) {
      focusKey = focus.dataset.focusKey ?? null;
      focusFallback = focus.closest(".nas-at-history-entry")?.dataset.focusKey ?? "log";
    }
    else if (focus && focus !== root.ownerDocument.body && focus !== root.ownerDocument.documentElement) focusKey = null;
  }

  function detached(nextPosition = {}) {
    remember();
    position = Object.fromEntries(Object.entries(nextPosition).filter(([key]) => ["width", "height", "left", "top"].includes(key)));
    opened = false;
    epoch += 1;
    generation += 1;
    root?.replaceChildren();
    root = null;
    host = null;
  }

  async function close() {
    const current = host;
    if (!opened) return;

    remember();
    opened = false;
    epoch += 1;
    root?.replaceChildren();
    await current?.close();
  }

  async function open(combatant) {
    const combat = combatant?.parent ?? combatant?.combat;
    if (!trackerSettings(getGame()).enabled || combat?.visible === false || !combats().includes(combat) || !canInspectHistory(combatant, getGame()?.user)
      || combat.combatants.get(combatant.id) !== combatant) return;
    const retarget = selection.combatUuid !== combat.uuid || selection.combatantUuid !== combatant.uuid;
    if (retarget) {
      remember();
      Object.assign(selection, { combatUuid: combat.uuid, combatantUuid: combatant.uuid, type: "all", turn: "all", page: 0 });
      scrollTop = 0; focusKey = null; focusFallback = null;

      root?.replaceChildren();
    }
    if (!opened) {
      opened = true;
      const current = ++generation;
      try {
        host = createApplication({
          title: t("historyTitle", "Action and movement history"), position, game: getGame(),
          beforeRender() {
            if (opened && generation === current) { remember(); epoch += 1; }
          },
          attach(element) {
            if (!opened || generation !== current || !element) return;
            root = element.querySelector(".nas-at-history-mount") ?? element;
            ensureTrackerStyles(root.ownerDocument);
            void safe(refresh);
          },
          detach(nextPosition) { if (generation === current) detached(nextPosition); }
        });
        await host.open();
      } catch (error) { if (generation === current) detached(position); throw error; }
    } else {
      void safe(() => host.focus());
      await refresh();
    }
  }

  async function refresh(event) {
    if (!opened) return;
    if (!trackerSettings(getGame()).enabled) return close();
    if (event?.combatUuid && event.combatUuid !== selection.combatUuid) return;
    if (!root) return;
    remember();
    const target = root;
    const revision = ++epoch;
    const snapshot = { ...selection };
    const combat = findCombat();
    const candidates = permitted(combat);
    const selected = selection.combatantUuid === "*" ? candidates : candidates.filter((entry) => entry.uuid === selection.combatantUuid);

    target.replaceChildren();
    const loading = target.ownerDocument.createElement("p");
    loading.textContent = t("loadingHistory", "Loading history…");
    loading.setAttribute("role", "status");
    target.append(loading);
    let error, log, movement;
    const checkpointId = combat ? captureTurn(combat).id : null;
    const valid = () => opened && root === target && revision === epoch && target.isConnected
      && trackerSettings(getGame()).enabled && findCombat() === combat
      && (!combat || captureTurn(combat).id === checkpointId);
    const current = (entry) => !!entry && combat?.visible !== false && combat?.combatants.get(entry.id) === entry && canInspectHistory(entry, getGame()?.user);
    const histories = await Promise.all(selected.map(async (combatant) => {

      const read = async (method, options) => current(combatant) ? service[method](combatant.uuid, options) : undefined;
      const values = await Promise.allSettled([
        read("getHistory"), read("getMovementHistory"),
        snapshot.combatantUuid !== "*" ? read("getMovementState",
          ["all", "current"].includes(snapshot.turn) ? {} : { checkpointId: snapshot.turn }) : undefined,
        read("getMovementSpending", { all: true, ...(["all", "current"].includes(snapshot.turn) ? {} : { checkpointId: snapshot.turn }) })
      ]);
      const failure = values.find((value) => value.status === "rejected");
      return {
        combatant,
        actions: values[0].status === "fulfilled" ? values[0].value ?? [] : [],
        movements: values[1].status === "fulfilled" ? values[1].value ?? [] : [],
        movement: values[2].status === "fulfilled" ? values[2].value : undefined,
        spending: values[3].status === "fulfilled" ? values[3].value : undefined,
        error: failure?.reason
      };
    }));
    if (!valid()) return;
    const visible = histories.filter((data) => current(data.combatant));
    const availableCombats = combats().filter((entry) => entry.visible !== false && permitted(entry).length);
    const availableCombatants = permitted(combat);
    if (!combat || combat.visible === false || (snapshot.combatantUuid !== "*" && !visible.length)) {
      error = t("historyUnavailable", "This encounter or combatant is unavailable or you no longer have permission to inspect it.");
    } else {
      try {
        log = combinedHistory(combat, visible, snapshot);
        selection.page = log.page;
        movement = snapshot.combatantUuid === "*" ? undefined : visible[0]?.movement;
      } catch (failure) { error = failure.message; }
    }
    const act = (action, uuid, value) => {
      if (!valid()) return;
      if (action === "previous" || action === "next") {
        selection.page = Math.max(0, selection.page + (action === "next" ? 1 : -1));
        scrollTop = 0;
        target.querySelector(".nas-at-history-scroll")?.scrollTo?.(0, 0);
        const scroll = target.querySelector(".nas-at-history-scroll");
        if (scroll) scroll.scrollTop = 0;
        return refresh();
      }
      const combatant = availableCombatants.find((entry) => entry.uuid === uuid);
      if (!current(combatant)) return;
      const status = requests.status(uuid);
      if (status.pending) return;
      if (action === "dismiss") return requests.dismiss(uuid);
      if (action === "retry") return requests.retry(uuid);
      if (!status.hasGM || status.failure) return;
      if (["convert-activity", "link-activity-attack", "unlink-activity-attack", "release-spring-attack"].includes(action)) {
        const [activityId, attackId] = action !== "convert-activity" ? JSON.parse(value) : [value];
        if (!log?.entries.some((item) => item.combatant.uuid === uuid && item.use.kind === "activity" && item.use.id === activityId)) return;
        return requests.mutate({ combatUuid: combat.uuid, combatId: combat.id, combatantUuid: uuid,
          kind: { "convert-activity": "convertActivity", "link-activity-attack": "linkActivityAttack", "unlink-activity-attack": "unlinkActivityAttack", "release-spring-attack": "releaseSpringAttack" }[action], operationId: createId(), activityId, ...(attackId ? { attackId } : {}) });
      }
      if (["classify-step", "classify-ordinary"].includes(action)) {
        const [operationId, assessment] = JSON.parse(value);
        const entry = log?.entries.find((item) => item.combatant.uuid === uuid && item.type === "movement" && item.use.operationId === operationId);
        if (!entry?.use.step) return;
        return requests.mutate({ combatUuid: combat.uuid, combatId: combat.id, combatantUuid: uuid, kind: "classifyMovement", operationId: createId(),
          groupId: entry.use.step.groupId, classification: action === "classify-step" ? "step" : "ordinary", assessment });
      }
      if (["link-payment", "unlink-payment"].includes(action)) {
        const [actionId, sequenceId] = action === "link-payment" ? JSON.parse(value) : [value];
        const entry = log?.entries.find((item) => item.combatant.uuid === uuid && item.type === "action" && item.use.operationId === actionId);
        if (!entry || entry.use.undone) return;
        return requests.mutate({ combatUuid: combat.uuid, combatId: combat.id, combatantUuid: uuid,
          kind: action === "link-payment" ? "linkMovementPayment" : "unlinkMovementPayment", operationId: createId(), actionId,
          ...(sequenceId ? { sequenceId } : {}) });
      }
      const entry = log?.entries.find((item) => item.combatant.uuid === uuid && item.use.operationId === value
        && item.type === (action === "undo" ? "action" : "movement"));
      if (!entry || (action === "undo" ? entry.use.undone : entry.use.kind !== "move" || entry.use.excluded || entry.use.reversed)) return;
      return requests.mutate({ combatUuid: combat.uuid, combatId: combat.id, combatantUuid: uuid,
        kind: action === "undo" ? "undo" : "excludeMovement", operationId: value });
    };
    const filter = (key, value) => {
      if (!valid()) return;
      if (key === "combatUuid") {
        if (!availableCombats.some((entry) => entry.uuid === value)) return;
        Object.assign(selection, { combatUuid: value, combatantUuid: "*", turn: "all" });
      } else if (key === "combatantUuid") {
        if (value !== "*" && !availableCombatants.some((entry) => entry.uuid === value && current(entry))) return;
        selection.combatantUuid = value;
      } else if (key === "type" && ["all", "action", "movement"].includes(value)) selection.type = value;
      else if (key === "turn" && (["all", "current"].includes(value) || log?.timeline.checkpoints.some((entry) => entry.id === value))) selection.turn = value;
      else return;
      selection.page = 0;
      scrollTop = 0;
      const scroll = target.querySelector(".nas-at-history-scroll");
      if (scroll) scroll.scrollTop = 0;
      return refresh();
    };
    const view = buildHistoryView({
      document: target.ownerDocument, game: getGame(), selection, combats: availableCombats,
      combat, combatants: availableCombatants, histories: error ? [] : visible, log, movement, error, requests, t, expanded,
      onAction: (...args) => safe(() => act(...args)), onFilter: (...args) => safe(() => filter(...args))
    });
    for (const field of view.querySelectorAll(".nas-at-payment-sequence, .nas-at-step-assessment, .nas-at-activity-attack")) {
      const selected = paymentChoices.get(field.dataset.focusKey);
      if (Array.from(field.options ?? field.querySelectorAll("option")).some((o) => o.value === selected)) {
        for (const option of field.querySelectorAll("option")) option.removeAttribute("selected");
        Array.from(field.querySelectorAll("option")).find((o) => o.value === selected).selected = true;
      }
    }
    target.replaceChildren(view);
    const scroll = view.querySelector(".nas-at-history-scroll");
    if (scroll) scroll.scrollTop = scrollTop;
    const active = target.ownerDocument.activeElement;
    if (focusKey && (!active || active === target.ownerDocument.body || active === target.ownerDocument.documentElement || target.contains(active))) {
      const controls = Array.from(view.querySelectorAll("[data-focus-key]"));
      const focused = controls.find((entry) => entry.dataset.focusKey === focusKey && !entry.disabled)
        ?? controls.find((entry) => entry.dataset.focusKey === focusFallback)
        ?? scroll;
      focused?.focus?.({ preventScroll: true });
    }
  }
  return { open, close, refresh };
}
