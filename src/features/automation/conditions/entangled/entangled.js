import { MODULE } from '../../../../common/module.js';
import { buildGrappleConcentrationData } from '../grappled/grappled.js';

export async function handleEntangledConcentration(action) {
  const handling = game.settings.get(MODULE.ID, 'entangledGrappledHandling');
  if (handling !== 'entangled' && handling !== 'both') return;

  const itemSource = action.item;
  const token = action.token;
  const actor = token?.actor;
  if (!actor) return;
  if (itemSource.type !== "spell") return;

  const notifyConcentrationDc = (data) => {
    const msg = game.i18n.format('NAS.conditions.main.GrappleConcentrationDC', {
      dc: data.dc,
      spellLevel: data.spellLevel,
      grappleTotal: data.grappleTotal
    });
    ui.notifications.info(msg);
  };

  const rollWithContext = async (spellbook, reason) => {
    const data = buildGrappleConcentrationData(actor, action);
    const options = { skipDialog, dc: data.dc, reason };
    notifyConcentrationDc(data);
    await actor.rollConcentration(spellbook, options);
  };

  const skipDialog = game.user.isGM;

  if (actor.statuses.has("entangled")) {
    await rollWithContext(itemSource.system.spellbook, "entangled");
  }
}



