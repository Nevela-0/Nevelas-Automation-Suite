import { MODULE } from "../../common/module.js";
import { elementFromHtmlLike, isFoundryV13Plus } from "../../common/foundryCompat.js";
import { captureTurn } from "./model.js";
import { MOVEMENT_FLAG, samePosition } from "./movementModel.js";
import { previewRoute, tokenPosition } from "./movementPreview.js";
import { activityChoice, chooseMovement, checkBlindMovement, needsBlindCheck } from "./movementDialogs.js";
import { trackerSettings } from "./settings.js";

export const INTENT = "nasMovementIntent";
const decisionKey = (p) => JSON.stringify([p.revision, p.economy, p.automatic, p.consumed, p.paid, p.consumption, p.projected,
  p.cost, p.incomplete, p.hampered, p.activity?.id, p.step?.id, p.speeds?.map((s) => [s.mode, s.speed, s.feetPerUnit, s.warning])]);

export function createMovementInterception({ getGame, service, createId, choose = chooseMovement,
  blind = checkBlindMovement, notify = () => {}, trackRequest = (_uuid, _request, task) => task(),
  mutationStatus = () => ({}), holdMovement = () => () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const busy = new Set(), rulers = new Map(), routes = new Map(), huds = new Map();
  let registered = false;
  const permitted = (token) => !!token && !token.isPreview && token.parent?.tokens?.get(token.id) === token
    && (getGame().user?.isGM || token.actor?.testUserPermission?.(getGame().user, "OWNER"));
  function combatantFor(token) {
    if (!trackerSettings(getGame()).movement) return null;
    const matches = Array.from(getGame().combats ?? []).filter((c) => c.active && c.round > 0
      && (!c.scene?.id || c.scene.id === token.parent.id)).map((c) => c.combatant).filter((c) => c?.token?.uuid === token.uuid);
    if (matches.length > 1) notify("Movement activity selection skipped: this token matches multiple active encounters.");
    return matches.length === 1 ? matches[0] : null;
  }
  const current = (entry) => permitted(entry.token) && samePosition(tokenPosition(entry.token), entry.origin)
    && ["width", "height", "shape"].every((key) => tokenPosition(entry.token)[key] === entry.origin[key])
    && (!entry.combatant || (combatantFor(entry.token) === entry.combatant && captureTurn(entry.combatant.parent).id === entry.turn.id));
  const request = (combatant, input) => trackRequest(combatant.uuid, input, () => service.movementRequest(combatant.uuid, input));

  async function prepare(token, waypoints, { contextual = false } = {}) {
    const game = getGame(), combatant = combatantFor(token), origin = tokenPosition(token);
    const turn = combatant ? captureTurn(combatant.parent) : null;
    const entry = { token, combatant, origin, turn, observationId: createId(), routeId: createId() };
    const mode = isFoundryV13Plus(game) ? token.movementAction ?? "walk" : combatant?.getFlag(MODULE.ID, MOVEMENT_FLAG)?.spending?.mode ?? "walk";
    let preview;
    if (combatant && game.users?.activeGM?.active) {
      const result = await service.previewMovement(combatant.uuid, { tokenUuid: token.uuid, origin, waypoints, expectedCheckpointId: turn.id });
      if (!result.ok) {
        notify(result.message);
        if (["staleTurn", "staleMovement", "missingToken", "forbidden"].includes(result.code)) return null;
      } else preview = result.preview;
    } else if (combatant) notify("Movement will continue, but activity selection and tracking require a connected GM.");
    if (!preview) {
      try { preview = previewRoute(token, waypoints, { game, mode }); }
      catch (error) { notify(error.message); preview = { incomplete: true, distance: 0, cost: 0, consumption: 0, warnings: [error.message] }; }
      Object.assign(preview, { economy: trackerSettings(game).economy, consumed: 0, remaining: 0, projected: 0 });
    }
    if (!current(entry)) { notify("The token or turn changed while preparing movement. Try the route again."); return null; }
    let selected;
    if (combatant && game.users?.activeGM?.active && !preview.displaced && (contextual || preview.needsChoice)) {
      if (contextual || (!preview.activity && !preview.step)) {
        selected = await choose({ ...preview, contextual }, game);
        if (!selected) return null;
      }
    }
    if (preview.incomplete && combatant) notify("The route's movement cost could not be fully verified. Movement remains allowed; review its saved history.");
    if (!contextual && !(await blind(token, preview, game))) return null;
    if (!current(entry)) { notify("The token, permissions or turn changed while the movement dialog was open. Try the route again."); return null; }

    if (combatant && preview.revision !== undefined) {
      const check = await service.previewMovement(combatant.uuid, { tokenUuid: token.uuid, origin, waypoints, expectedCheckpointId: turn.id });
      if (!check.ok || decisionKey(check.preview) !== decisionKey(preview)) {
        notify(check.message ?? "Movement capacity or accounting changed while the dialog was open. Try the route again."); return null;
      }
    }
    if (contextual && ["finishActivity", "cancelStep"].includes(selected?.choice)) {
      const input = { kind: selected.choice, operationId: createId(),
        ...(selected.choice === "finishActivity" ? { activityId: preview.activity?.id } : { declarationId: preview.step?.id }) };
      const result = await request(combatant, input);
      if (!result?.ok) notify(result?.message ?? "The movement activity could not be closed.");
      return result?.ok ? entry : null;
    }
    const choice = activityChoice(selected?.choice ?? "ordinary");
    if (choice && combatant) {
      const input = { kind: "armActivity", operationId: createId(), expectedCheckpointId: turn.id,
        expectedMovementRevision: preview.revision, expectedTokenUuid: token.uuid, expectedOrigin: origin,
        economy: preview.economy, assessment: selected.assessment, ...choice };
      const result = await request(combatant, input);
      if (!result?.ok) {

        entry.unconfirmedActivityId = input.operationId;
        service.markMovementIncomplete(combatant.uuid, turn, "The movement activity declaration could not be confirmed.");
        notify(`${result?.message ?? "Activity selection could not be confirmed."} Movement will continue; review the incomplete activity accounting and the saved retry request.`);
      } else entry.armedId = input.operationId;
    }
    entry.activityId = entry.armedId ?? entry.unconfirmedActivityId ?? preview.activity?.id ?? null;
    if (!current(entry)) { await abandon(entry); return null; }
    return entry;
  }
  async function abandon(entry) {
    if (!entry?.armedId || !entry.combatant) return;

    const state = await service.getMovementSpending(entry.combatant.uuid).catch(() => null);
    if (state?.activeActivity?.id !== entry.armedId || state.activeActivity.status !== "armed") return;
    const result = await request(entry.combatant, { kind: "finishActivity", operationId: `${entry.armedId}_cancel`, activityId: entry.armedId });
    if (!result?.ok) notify("The unused activity could not be canceled; review its saved status before moving again.");
  }
  async function settle(entry) {
    if (!entry.committed || !entry.combatant || !getGame().users?.activeGM?.active) return;
    for (let i = 0; i < 20; i++) {
      const result = await service.movementReceipt(entry.combatant.uuid, entry.observationId);
      if (!result.ok || result.saved) return;
      await sleep(100);
    }
    service.markMovementIncomplete(entry.combatant.uuid, entry.turn, "Movement acknowledgment was delayed; the next route may need manual review.");
    notify("Movement completed, but its tracking acknowledgment is delayed. Review history before moving again.");
  }
  function stamp(options, entry) {
    options[INTENT] ??= {};
    options[INTENT][entry.token.id] = { routeId: entry.routeId, observationId: entry.observationId, activityId: entry.activityId, turn: entry.turn };
  }
  async function updates(wrapped, changes = [], options = {}) {
    const tokens = changes.map((change) => ({ change, token: options.parent?.tokens?.get(change._id) }))
      .filter(({ token, change }) => permitted(token) && !options.isUndo && !options.isPaste && !options.teleport
        && (combatantFor(token) || needsBlindCheck(token, getGame()))
        && (options.movement?.[token.id]?.waypoints?.length || ["x", "y", "elevation"].some((k) => Object.hasOwn(change, k) && change[k] !== tokenPosition(token)[k])));
    if (!tokens.length) return wrapped(changes, options);
    const owned = [], entries = [], releases = [], rulerSteps = [];
    try {
      for (const { token, change } of tokens) {
        const ruler = rulers.get(token.uuid);
        if (ruler) {
          if (!permitted(token) || (ruler.turn && captureTurn(ruler.combatant.parent).id !== ruler.turn.id)) return [];

          stamp(options, { ...ruler, observationId: createId() });
          rulerSteps.push({ ruler, origin: tokenPosition(token) }); continue;
        }
        const path = options.movement?.[token.id]?.waypoints ?? [{ ...tokenPosition(token), ...change }];

        const prior = options._movementArguments?.movementId && options[INTENT]?.[token.id];
        const c = combatantFor(token);
        if (prior?.turn && (!c || captureTurn(c.parent).id !== prior.turn.id)) { notify("The turn changed before this movement could continue."); return []; }
        const continuing = prior && routes.get(token.uuid) === prior.routeId;
        if (busy.has(token.uuid) && !continuing) { notify("A movement decision for this token is already pending."); return []; }
        if (!continuing) {
          if (c && mutationStatus(c.uuid).pending) { notify("A tracker request is still pending; try this movement after it settles."); return []; }
          busy.add(token.uuid); owned.push(token.uuid);
          if (c) releases.push(holdMovement(c));
        }
        let entry;
        if (prior) {
          entry = { token, origin: tokenPosition(token), combatant: c, turn: prior.turn, activityId: prior.activityId, observationId: createId(), routeId: prior.routeId };
        } else entry = await prepare(token, path);
        if (!entry) return [];
        routes.set(token.uuid, entry.routeId);
        entries.push(entry); stamp(options, entry);
      }
      if (entries.some((entry) => !current(entry))) { notify("Movement changed while another token was being prepared. Try the route again."); return []; }
      const result = await wrapped(changes, options);
      for (const entry of entries) entry.committed = !samePosition(entry.origin, tokenPosition(entry.token))
        || !!options._movement?.[entry.token.id]?.passed?.waypoints?.length;
      for (const step of rulerSteps) step.ruler.committed ||= !samePosition(step.origin, tokenPosition(step.ruler.token));
      for (const entry of entries) try { await settle(entry); } catch (error) { notify(`Movement completed; tracking acknowledgment failed: ${error.message}`); }
      return result;
    } finally {
      for (const entry of entries) if (!entry.committed && samePosition(entry.origin, tokenPosition(entry.token))) {
        try { await abandon(entry); } catch (error) { notify(`Review the unused activity: ${error.message}`); }
      }
      for (const uuid of owned) { busy.delete(uuid); routes.delete(uuid); }
      for (const release of releases) release();
    }
  }
  async function ruler(ruler, run, placeable) {
    const token = placeable.document ?? placeable;
    if (!permitted(token)) return run();
    if (!combatantFor(token) && !needsBlindCheck(token, getGame())) return run();
    if (busy.has(token.uuid)) { notify("A movement decision for this token is already pending."); return; }
    const c = combatantFor(token);
    if (c && mutationStatus(c.uuid).pending) { notify("A tracker request is still pending; try this movement after it settles."); return; }
    const segments = (ruler.segments ?? []).filter((s) => !s.history);
    if (!segments.length) return run();
    const dx = token.x - segments[0].ray.A.x, dy = token.y - segments[0].ray.A.y;
    const path = segments.map((s) => ({ x: Math.round(s.ray.B.x + dx), y: Math.round(s.ray.B.y + dy), teleport: !!s.teleport }));
    busy.add(token.uuid);
    const release = c ? holdMovement(c) : () => {};
    let entry;
    try {
      entry = await prepare(token, path);
      if (!entry) return;
      rulers.set(token.uuid, entry);
      return await run();
    } finally {
      rulers.delete(token.uuid);
      if (entry && !entry.committed && samePosition(entry.origin, tokenPosition(token))) {
        try { await abandon(entry); } catch (error) { notify(`Review the unused activity: ${error.message}`); }
      }
      busy.delete(token.uuid);
      release();
    }
  }
  async function contextual(token) {
    const c = combatantFor(token);
    if (!permitted(token) || !c || !getGame().users?.activeGM?.active || busy.has(token.uuid)
      || (!getGame().user.isGM && token.object?.isVisible === false)
      || mutationStatus(c.uuid).pending) return;
    if (mutationStatus(c.uuid).failure) {
      notify("A previous tracker request is unconfirmed. Review its fixed retry or dismiss it in the tracker/history before choosing another activity."); return;
    }
    busy.add(token.uuid);
    const release = holdMovement(c);
    try { return await prepare(token, [tokenPosition(token)], { contextual: true }); }
    finally { busy.delete(token.uuid); release(); }
  }
  function renderHUD(app, html) {
    const root = elementFromHtmlLike(app.element) ?? elementFromHtmlLike(html), token = app.object?.document ?? app.object;
    if (root) huds.set(app, root);
    root?.querySelector(".nas-movement-intent")?.remove();
    if (!root || !permitted(token) || !combatantFor(token) || (!getGame().user.isGM && token.object?.isVisible === false)) return;
    const button = root.ownerDocument.createElement("button"); button.type = "button"; button.className = "control-icon nas-movement-intent";
    button.setAttribute("aria-label", "Movement activity"); button.title = "Movement… — choose an activity, including a short Charge or Withdraw";
    const icon = root.ownerDocument.createElement("i"); icon.className = "fas fa-route"; icon.setAttribute("aria-hidden", "true"); button.append(icon);
    button.disabled = !getGame().users?.activeGM?.active;
    if (button.disabled) button.title = "Movement activity selection requires a connected GM";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void contextual(token).catch((error) => notify(error.message)); });
    (root.querySelector(".col.right") ?? root).append(button);
  }
  function register(hooks = globalThis.Hooks, wrapper = globalThis.libWrapper) {
    if (registered || !wrapper) return;
    registered = true;

    wrapper.register(MODULE.ID, "CONFIG.Token.documentClass.updateDocuments", updates, "MIXED");
    hooks.on("renderTokenHUD", renderHUD);
    hooks.on("closeTokenHUD", (app) => { huds.get(app)?.querySelector(".nas-movement-intent")?.remove(); huds.delete(app); });
    const refreshHUD = () => {
      for (const [app, root] of huds) {
        if (!root.isConnected) huds.delete(app);
        else renderHUD(app, root);
      }
    };
    for (const hook of ["updateCombat", "deleteCombat", "updateCombatant", "deleteCombatant", "updateActor", "updateUser",
      "updateToken", "deleteToken", "userConnected", "nasActionTrackerSettingsChanged"]) hooks.on(hook, refreshHUD);
  }
  return { updates, ruler, prepare, contextual, renderHUD, register };
}
