import { MODULE } from "../../common/module.js";

export const AUTOMATIC_TRACKING_SETTING = "automaticActionTracking";
export const TRACKER_UI_SETTING = "actionTrackerInterface";

const refresh = () => globalThis.Hooks?.callAll?.("nasActionTrackerSettingsChanged");

export function registerActionTrackerSettings() {
  game.settings.register(MODULE.ID, AUTOMATIC_TRACKING_SETTING, {
    name: game.i18n.localize("NAS.settings.automaticActionTracking.name"),
    scope: "world", config: true, type: Boolean, default: false, onChange: refresh
  });
  for (const [key, options] of [
    [TRACKER_UI_SETTING, { scope: "world", type: Boolean, default: false }],
    ["automaticMovementSpending", { scope: "world", type: Boolean, default: false }],
    ["actionTrackerMovement", { scope: "world", type: Boolean, default: false }],
    ["actionTrackerMovementMarkers", { scope: "world", type: Boolean, default: false }],
    ["actionTrackerVisibility", { scope: "world", type: String, default: "owners", choices: {
      owners: game.i18n.localize("NAS.settings.actionTrackerVisibility.owners"),
      party: game.i18n.localize("NAS.settings.actionTrackerVisibility.party"),
      all: game.i18n.localize("NAS.settings.actionTrackerVisibility.all")
    } }],
    ["actionTrackerShowFree", { scope: "client", type: Boolean, default: false }]
  ]) {
    game.settings.register(MODULE.ID, key, {
      name: game.i18n.localize(`NAS.settings.${key}.name`),
      config: true, onChange: refresh, ...options
    });
  }
}

export function trackerSettings(game = globalThis.game) {
  const read = (scope, key, fallback) => {
    try { return game?.settings?.get(scope, key) ?? fallback; }
    catch { return fallback; }  
  };
  return {
    enabled: read(MODULE.ID, TRACKER_UI_SETTING, false) === true,
    automatic: read(MODULE.ID, AUTOMATIC_TRACKING_SETTING, false) === true,
    automaticMovement: read(MODULE.ID, "automaticMovementSpending", false) === true,
    movement: read(MODULE.ID, "actionTrackerMovement", false) === true,
    movementMarkers: read(MODULE.ID, "actionTrackerMovementMarkers", false) === true,
    visibility: read(MODULE.ID, "actionTrackerVisibility", "owners"),
    showFree: read(MODULE.ID, "actionTrackerShowFree", false) === true,
    economy: read("pf1", "unchainedActionEconomy", false) ? "unchained" : "normal"
  };
}

export function isAutomaticTrackingEnabled() {
  return globalThis.game?.settings?.get(MODULE.ID, AUTOMATIC_TRACKING_SETTING) === true;
}
