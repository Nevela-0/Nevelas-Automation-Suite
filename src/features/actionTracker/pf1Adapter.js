import { captureTurn, copy, fail, normalizeCosts } from "./model.js";
import { activationMetadata, normalizePF1Details, resolvePF1Costs } from "./pf1Costs.js";

import { isMovementBoundary } from "./movementSpending.js";
import { activeActivity } from "./movementActivities.js";
import { MODULE } from "../../common/module.js";
import { springFeats, SPRING_VARIANTS } from "./springAttack.js";
import { trackerSettings } from "./settings.js";

export function createPF1Adapter({ getGame, service, createId, isEnabled, observeBoundaries = () => false, emitPrepare, notify = () => {}, trackRequest = (_uuid, _request, task) => task() }) {
  const uses = new WeakMap();

  function target(combatant) {
    return { combatantUuid: combatant.uuid, expectedCheckpointId: captureTurn(combatant.parent).id };
  }
  function activityContext(selected) {
    const combatant = Array.from(getGame()?.combats ?? []).flatMap((c) => Array.from(c.combatants ?? [])).find((c) => c.uuid === selected?.combatantUuid);
    const ledger = combatant?.getFlag?.(MODULE.ID, "actionTrackerMovement") ?? {};
    return { activityId: activeActivity(ledger)?.id ?? null, spring: copy(activeActivity(ledger)?.spring ?? null),
      activityHistory: ledger.activities?.entries.some((a) => a.checkpointId === selected?.expectedCheckpointId) ?? false };
  }

  function resolveTarget(actionUse) {
    const combat = getGame()?.combat;
    if (!combat) return null;
    const token = actionUse.token?.document ?? actionUse.token;
    const actor = actionUse.actor ?? actionUse.item?.actor;
    const candidates = Array.from(combat.combatants ?? []).filter((entry) => token
      ? !!token.uuid && entry.token?.uuid === token.uuid
      : !!actor && (entry.actor === actor || (!!actor.uuid && entry.actor?.uuid === actor.uuid)));
    if (candidates.length > 1) fail("ambiguousCombatant", "More than one combatant matches this use. Select one with actionTracker.configureUse.");
    return candidates.length ? target(candidates[0]) : null;
  }

  function capture(actionUse) {
    if (!actionUse || typeof actionUse !== "object") fail("invalidUse", "A PF1 ActionUse is required.");
    if (uses.has(actionUse)) return uses.get(actionUse);
    const context = { operationId: createId(), userId: getGame()?.user?.id, target: null, skip: false, finalized: false };
    uses.set(actionUse, context);
    try { context.target = resolveTarget(actionUse); context.initialTargetUuid = context.target?.combatantUuid; Object.assign(context, activityContext(context.target)); }
    catch (error) { context.error = error; }
    return context;
  }

  function configureUse(actionUse, overrides) {
    const context = capture(actionUse);
    if (context.finalized) fail("useFinalized", "This action use has already been finalized.");
    if (context.userId !== getGame()?.user?.id) fail("forbidden", "Only the initiating client can configure this use.");
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) fail("invalidUse", "An override object is required.");
    for (const key of Object.keys(overrides)) {
      if (!["combatantUuid", "skip", "costs", "nextTurnCosts"].includes(key)) fail("invalidUse", `Unknown action tracker override '${key}'.`);
    }
    const next = {};
    if (Object.hasOwn(overrides, "skip")) {
      if (typeof overrides.skip !== "boolean") fail("invalidUse", "Skip must be a boolean.");
      next.skip = overrides.skip;
    }
    if (Object.hasOwn(overrides, "costs") || Object.hasOwn(overrides, "nextTurnCosts")) {
      next.costs = normalizeCosts(overrides.costs);
      next.nextTurnCosts = normalizeCosts(overrides.nextTurnCosts);
    }
    if (Object.hasOwn(overrides, "combatantUuid")) {
      let selected;
      for (const combat of getGame()?.combats ?? []) {
        selected = Array.from(combat.combatants ?? []).find((entry) => entry.uuid === overrides.combatantUuid);
        if (selected) break;
      }
      if (!selected) fail("missingCombatant", "The requested combatant no longer exists.");

      next.target = selected.uuid === context.target?.combatantUuid ? context.target : target(selected);
      next.error = undefined;
    }
    Object.assign(context, next);
    context.configured = context.skip || Object.hasOwn(context, "costs") || context.target?.combatantUuid !== context.initialTargetUuid;
    return copy({ operationId: context.operationId, ...context.target, skip: context.skip });
  }

  function diagnostic(actionUse, context, result) {
    if (actionUse.shared) actionUse.shared.nasActionTrackerResult = copy(result);
    if ((!result.ok || result.notice) && getGame()?.user?.id === context.userId) {
      try { notify(result.notice ? { ...result, message: result.notice } : result); } catch (error) { console.warn("NAS action tracker notification failed", error); }
    }
    return result;
  }

  function eligibleSpring(actionUse) {
    return actionUse.item?.type !== "spell" && actionUse.action?.activation?.type === "attack"
      && ["mwak", "msak"].includes(actionUse.action?.actionType ?? actionUse.action?.data?.actionType)
      && actionUse.shared?.fullAttack !== true && actionUse.shared?.attacks?.length === 1;
  }
  async function prepareSpring(actionUse) {
    const context = uses.get(actionUse);
    if (!context?.target || context.configured || !eligibleSpring(actionUse)
      || (context.spring ? actionUse.shared?.nasSpringSelected === false : actionUse.shared?.nasSpringSelected !== true)) return { ok: true, skipped: true };
    const selected = Array.from(getGame()?.combats ?? []).flatMap((c) => Array.from(c.combatants ?? [])).find((c) => c.uuid === context.target.combatantUuid);
    if (selected && captureTurn(selected.parent).id !== context.target.expectedCheckpointId) return { ok: false, code: "staleTurn", message: "The turn changed while the attack dialog was open. Use a separate attack." };
    if (selected && !(getGame().user?.isGM || selected.actor?.testUserPermission?.(getGame().user, "OWNER"))) return { ok: false, code: "forbidden", message: "You no longer own this combatant." };
    const options = springContext(actionUse);
    if (!options) return { ok: false, code: "missingFeat", message: "Spring Attack requires an owned feat, movement tracking and this combatant's active turn. Use a separate attack." };
    if (options.disabledReason) return { ok: false, code: "unavailableActivity", message: options.disabledReason };
    const targets = Array.from(actionUse.shared?.targets ?? getGame()?.user?.targets ?? [])
      .map((t) => t?.document?.uuid ?? t?.uuid).filter((id) => typeof id === "string");
    context.reserveRequest ??= context.spring ? { kind: "reserveSpringAttack", operationId: createId(), attackId: context.operationId,
      expectedCheckpointId: context.target.expectedCheckpointId, activityId: context.activityId, targets }
      : { kind: "beginSpringAttack", operationId: createId(), attackId: context.operationId,
        expectedCheckpointId: context.target.expectedCheckpointId, targets, economy: trackerSettings(getGame()).economy,
        springVariant: options.highest,
        mythic: options.mythicAvailable,
        mythicPower: options.mythicAvailable && actionUse.shared.nasSpringPower === true };
    context.reserveTarget ??= context.target.combatantUuid;
    const result = await service.movementRequest(context.reserveTarget, context.reserveRequest);
    if (!result.ok) return result;
    if (result.reservation?.status !== "pending") return { ok: false, code: "reservationExpired", message: "This Spring Attack reservation is no longer pending. Use a separate attack or start a new use." };
    context.reservation = result.reservation;
    if (result.activity) { context.activityId = result.activity.id; context.spring = copy(result.activity.spring); }
    actionUse.shared.attackBonus ??= [];

    const component = `${result.reservation.penalty}[Spring Attack ${result.reservation.slot}]`;
    if (!context.springComponent) actionUse.shared.attackBonus.push(component);
    context.springComponent = component;
    return result;
  }
  async function releaseSpring(actionUse, { separate = false } = {}) {
    const context = uses.get(actionUse);
    if (separate) {
      actionUse.shared.nasSpringSelected = false;
      if (context?.springComponent) actionUse.shared.attackBonus = actionUse.shared.attackBonus.filter((p) => p !== context.springComponent);
      if (context) context.springComponent = null;
    }
    if (!context?.reserveRequest || (!separate && context.pending && !context.configured)) return { ok: true, skipped: true };
    context.releaseRequest ??= { kind: "releaseSpringAttack", operationId: createId(),
      activityId: context.reserveRequest.kind === "beginSpringAttack" ? context.reserveRequest.operationId : context.activityId, attackId: context.operationId };
    return service.movementRequest(context.reserveTarget, context.releaseRequest);
  }
  function springContext(actionUse) {
    const context = uses.get(actionUse), game = getGame();
    if (!context?.target || context.configured || !trackerSettings(game).movement) return null;
    const combatant = Array.from(game.combats ?? []).flatMap((c) => Array.from(c.combatants ?? [])).find((c) => c.uuid === context.target.combatantUuid);
    if (!combatant?.parent.active || combatant.parent.round < 1 || combatant.parent.combatant !== combatant
      || captureTurn(combatant.parent).id !== context.target.expectedCheckpointId
      || !(game.user?.isGM || combatant.actor?.testUserPermission?.(game.user, "OWNER"))) return null;
    const feats = springFeats(actionUse.actor ?? actionUse.item?.actor);
    if (!feats.highest || (context.spring && (!feats.evidence[context.spring.variant] || (context.spring.mythic && !feats.evidence.mythic)))) return null;
    return copy({ spring: context.spring, highest: feats.highest,
      variants: Object.keys(SPRING_VARIANTS).filter((key) => feats.evidence[key]), mythicAvailable: !!feats.evidence.mythic,
      disabledReason: !game.users?.activeGM?.active ? "A connected GM is required for Spring Attack tracking." : null });
  }

  async function finalize(actionUse, message, context) {
    const skipped = (reason) => ({ ok: true, skipped: true, reason, operationId: context.operationId });
    try {
      if (context.userId !== getGame()?.user?.id) return diagnostic(actionUse, context, skipped("differentUser"));

      emitPrepare(actionUse, copy({ operationId: context.operationId, userId: context.userId, ...context.target }));
      context.finalized = true;
      const tracking = isEnabled() && !context.skip;
      const boundaries = observeBoundaries();
      const activities = context.activityHistory || context.activityId;
      if (!tracking && !boundaries && !activities) return diagnostic(actionUse, context, skipped(context.skip ? "configuredSkip" : "disabled"));
      if (!context.target && !context.error) return diagnostic(actionUse, context, skipped("notInCombat"));
      const nas = actionUse.shared?.nasSpellContext;
      const details = normalizePF1Details({
        economy: getGame().settings.get("pf1", "unchainedActionEconomy") ? "unchained" : "normal",
        activation: nas?.activation ?? actionUse.action?.activation ?? actionUse.item?.system?.activation ?? {},
        activationSource: nas?.activation ? "nas" : "pf1",
        fullAttack: actionUse.shared?.fullAttack === true,
        extraFullRound: nas?.activationExtraFullRound === true
      });
      const hasCosts = Object.hasOwn(context, "costs");
      if (!hasCosts && details.activation.type === "passive") return diagnostic(actionUse, context, skipped("passive"));
      if (context.error) throw context.error;
      const use = {
        operationId: context.operationId,
        expectedCheckpointId: context.target.expectedCheckpointId,
        label: actionUse.action?.name || actionUse.item?.name || "Action",
        source: {
          itemUuid: actionUse.item?.uuid,
          actionId: actionUse.action?.id,
          messageUuid: message?.uuid ?? actionUse.shared?.message?.uuid
        }
      };
      const ownTurn = context.target.expectedCheckpointId.endsWith(":" + context.target.combatantUuid);

      if ((activities || (boundaries && hasCosts)) && ownTurn) {
        const melee = ["mwak", "msak"].includes(actionUse.action?.actionType ?? actionUse.action?.data?.actionType);
        const attacks = actionUse.shared?.attacks;
        const request = {
          kind: "completeActivityUse", operationId: context.operationId, expectedCheckpointId: context.target.expectedCheckpointId,
          activityId: context.activityId, use, details, tracking,
          eligible: melee && actionUse.item?.type !== "spell" && !details.fullAttack && (!Array.isArray(attacks) || attacks.length === 1),
          charge: actionUse.shared?.charge === true, optOut: context.configured === true,
          ...(context.spring ? { springSelected: !!context.reservation && actionUse.shared?.nasSpringSelected !== false,
            appliedPenalty: context.springComponent ? context.reservation.penalty : null } : {}),
          targets: Array.from(actionUse.shared?.targets ?? []).map((entry) => entry?.document?.uuid ?? entry?.uuid).filter((id) => typeof id === "string"),
          ...(hasCosts ? { override: { costs: context.costs, nextTurnCosts: context.nextTurnCosts, metadata: activationMetadata(details, ["explicitOverride"]) } } : {})
        };
        const task = () => service.movementRequest(context.target.combatantUuid, request);
        return diagnostic(actionUse, context, await trackRequest(context.target.combatantUuid, request, task));
      }
      if (!tracking) {
        const ownTurn = context.target.expectedCheckpointId.endsWith(":" + context.target.combatantUuid);
        const boundary = ownTurn && isMovementBoundary(resolvePF1Costs(details, { used: {}, onTurn: ownTurn }));
        const result = boundary ? await service.movementRequest(context.target.combatantUuid, {
          kind: "movementBoundary", operationId: context.operationId, expectedCheckpointId: context.target.expectedCheckpointId, details
        }) : skipped("noMovementBoundary");
        return diagnostic(actionUse, context, result);
      }
      const result = hasCosts
        ? await service.recordUse(context.target.combatantUuid, {
          ...use, costs: context.costs, nextTurnCosts: context.nextTurnCosts,
          metadata: activationMetadata(details, ["explicitOverride"])
        }, "pf1")
        : await service.recordPF1Use(context.target.combatantUuid, use, details);
      return diagnostic(actionUse, context, result);
    } catch (error) {
      return diagnostic(actionUse, context, {
        ok: false, operationId: context.operationId, code: error.code ?? "trackingFailed",
        message: error.message || "Action tracking failed; the PF1 use completed."
      });
    } finally { context.finalized = true; }
  }

  function complete(actionUse, message) {

    const context = uses.get(actionUse);
    if (!context) return Promise.resolve({ ok: true, skipped: true, reason: "notCaptured" });

    context.pending ??= Promise.resolve().then(() => finalize(actionUse, message, context));
    return context.pending;
  }

  async function awaitCompletion(actionUse) {

    return uses.get(actionUse)?.pending ?? null;
  }

  return { capture, configureUse, complete, awaitCompletion, prepareSpring, releaseSpring, springContext };
}
