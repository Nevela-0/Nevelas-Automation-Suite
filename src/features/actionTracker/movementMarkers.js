import { canManage } from "./uiModel.js";
import { trackerSettings } from "./settings.js";
import { captureTurn } from "./model.js";
import { isFoundryV13Plus } from "../../common/foundryCompat.js";

export function createMovementMarkers({ getGame, getCanvas, service, loadTexture, pixi = () => globalThis.PIXI }) {
  const markers = new Map();
  let epoch = 0;
  function clear() {
    epoch += 1;
    for (const marker of markers.values()) {
      marker.parent?.removeChild(marker);
      marker.destroy({ children: true, texture: false, baseTexture: false });
    }
    markers.clear();
  }
  function permitted(combatant, canvas, origin) {
    const game = getGame();
    const token = combatant.token?.object;
    if (!canManage(combatant, game.user) || combatant.visible === false || !token?.isVisible) return false;
    if (game.user.isGM) return true;
    if (combatant.hidden || combatant.token.hidden) return false;
    const visibility = canvas.effects?.visibility ?? canvas.visibility;
    return !!visibility?.testVisibility?.(origin, { object: token, tolerance: 0 });
  }
  async function refresh() {
    clear();
    const ticket = epoch;
    const game = getGame(), canvas = getCanvas(), settings = trackerSettings(game);
    if (isFoundryV13Plus(game) || !settings.movement || !settings.movementMarkers || !canvas?.ready || !canvas.tokens) return;
    const scene = canvas.scene;
    const valid = (combat, combatant, state) => ticket === epoch && getCanvas() === canvas && canvas.ready && canvas.scene === scene
      && getGame().combats.get(combat.id) === combat && combat.active && combat.combatants.get(combatant.id) === combatant
      && trackerSettings(getGame()).movement && trackerSettings(getGame()).movementMarkers && captureTurn(combat).id === state.checkpointId
      && combatant.token?.uuid === state.tokenUuid && state.sceneUuid === scene.uuid && permitted(combatant, canvas, state.origin);
    await Promise.all(Array.from(game.combats ?? []).filter((combat) => combat.active && combat.round > 0)
      .flatMap((combat) => Array.from(combat.combatants).map(async (combatant) => {
        if (combatant.token?.parent?.uuid !== scene.uuid || !canManage(combatant, game.user)) return;
        try {
          const state = await service.getMovementState(combatant.uuid);
          if (!state.origin || !state.appearance || !valid(combat, combatant, state)) return;
          let texture;
          try { if (state.appearance.src) texture = await loadTexture(state.appearance.src); }
          catch {   }
          if (!valid(combat, combatant, state)) return;
          const P = pixi();
          const appearance = state.appearance;
          const width = appearance.width * appearance.sizeX, height = appearance.height * appearance.sizeY;
          let marker;
          if (texture) {
            marker = new P.Sprite(texture);
            marker.anchor.set(0.5);
            const fit = Math.min(width / (texture.width || width), height / (texture.height || height));
            marker.width = (texture.width || width) * fit * Math.abs(appearance.scaleX);
            marker.height = (texture.height || height) * fit * Math.abs(appearance.scaleY);
            if (appearance.scaleX < 0) marker.scale.x *= -1;
            if (appearance.scaleY < 0) marker.scale.y *= -1;
            marker.rotation = appearance.rotation * Math.PI / 180;
          } else {
            marker = new P.Graphics();
            marker.lineStyle(2, 0xFFFFFF, 1).drawRect(-width / 2, -height / 2, width, height);
          }
          marker.position.set(state.origin.x, state.origin.y);
          marker.alpha = 0.3;
          marker.eventMode = "none";
          marker.interactiveChildren = false;
          markers.set(combatant.uuid, marker);
          canvas.tokens.addChild(marker);
        } catch (error) { console.warn("NAS starting-position marker", error); }
      })));
  }
  function register(hooks = globalThis.Hooks) {
    const safe = () => { void refresh().catch((error) => console.warn("NAS starting-position markers", error)); };
    hooks.on("canvasTearDown", clear);
    for (const name of ["canvasReady", "nasActionTrackerChanged", "nasActionTrackerSettingsChanged", "updateCombat",
      "deleteCombat", "deleteCombatant", "updateCombatant", "deleteToken", "updateToken", "updateActor", "updateUser", "sightRefresh", "refreshToken"]) hooks.on(name, safe);
  }
  return { refresh, clear, register };
}
