import { MODULE } from '../../common/module.js';

const SURPRISED_FLAG = "surprisedInSurpriseRound";
const SURPRISE_TOGGLE_SELECTOR = '[data-action="nas-toggle-surprise-eligible"]';

function localizeWithFallback(key, fallback) {
  const localized = game.i18n.localize(key);
  return localized === key ? fallback : localized;
}

function isCombatantMarkedSurprised(combatant) {
  const flagValue = combatant?.getFlag?.(MODULE.ID, SURPRISED_FLAG);
  return flagValue === undefined ? false : Boolean(flagValue);
}

async function setCombatantSurprised(combatant, value) {
  if (!combatant?.setFlag) return;
  await combatant.setFlag(MODULE.ID, SURPRISED_FLAG, Boolean(value));
}

function updateEligibilityButtonState(button, surprised) {
  if (!button) return;
  button.classList.toggle("active", surprised);
  button.setAttribute("aria-pressed", surprised ? "true" : "false");
}

export function handleCombatTrackerRender(app, html, data) {
  if (!game.settings.get(MODULE.ID, 'autoApplyFF')) return;
  const surpriseSelector = '[data-control="nas-surprise-round"]';
  const surprisedLabel = localizeWithFallback("NAS.combat.buttons.surprised.name", "Surprised");
  const surprisedTooltip = localizeWithFallback("NAS.combat.buttons.surprised.tooltip", "Surprised");
  const surpriseRoundLabel = localizeWithFallback("NAS.combat.buttons.surpriseRound.name", game.i18n.localize('NAS.conditions.main.SurpriseRound'));
  const surpriseRoundTooltip = localizeWithFallback("NAS.combat.buttons.surpriseRound.tooltip", surpriseRoundLabel);
  if (!data.combat) {
    if (typeof html.find === 'function') {
      html.find(surpriseSelector).remove();
    } else {
      html.querySelectorAll(surpriseSelector).forEach(btn => btn.remove());
    }
    return;
  }

  if (game.user.isGM) {
    const canEditEligibility = data.combat?.current?.round === 0;
    const listSelector = 'li.combatant[data-combatant-id]';

    if (typeof html.find === "function") {
      html.find(`${listSelector} .combatant-controls`).each((_idx, el) => {
        const controls = el;
        const combatantId = controls.closest("li.combatant")?.dataset?.combatantId;
        if (!combatantId) return;
        const combatant = data.combat.combatants.get(combatantId);
        if (!combatant) return;

        $(controls).find(SURPRISE_TOGGLE_SELECTOR).remove();

        const surprised = isCombatantMarkedSurprised(combatant);
        const btn = $(
          `<button type="button" class="inline-control combatant-control icon fa-solid fa-person-falling-burst" data-action="nas-toggle-surprise-eligible" data-tooltip="${surprisedTooltip}" aria-label="${surprisedLabel}" title="${surprisedTooltip}"></button>`
        );
        btn.prop("disabled", !canEditEligibility);
        btn.on("click.nas", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!canEditEligibility) return;
          await setCombatantSurprised(combatant, !isCombatantMarkedSurprised(combatant));
          app?.render?.();
        });

        const effects = controls.querySelector(".token-effects");
        if (effects?.parentNode) {
          effects.parentNode.insertBefore(btn[0], effects);
        } else {
          controls.appendChild(btn[0]);
        }
        updateEligibilityButtonState(btn[0], surprised);
      });
    } else {
      html.querySelectorAll(`${listSelector} .combatant-controls`).forEach((controls) => {
        const combatantId = controls.closest("li.combatant")?.dataset?.combatantId;
        if (!combatantId) return;
        const combatant = data.combat.combatants.get(combatantId);
        if (!combatant) return;

        controls.querySelectorAll(SURPRISE_TOGGLE_SELECTOR).forEach((b) => b.remove());

        const surprised = isCombatantMarkedSurprised(combatant);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "inline-control combatant-control icon fa-solid fa-person-falling-burst";
        btn.dataset.action = "nas-toggle-surprise-eligible";
        btn.dataset.tooltip = surprisedTooltip;
        btn.setAttribute("aria-label", surprisedLabel);
        btn.title = surprisedTooltip;
        btn.disabled = !canEditEligibility;
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!canEditEligibility) return;
          await setCombatantSurprised(combatant, !isCombatantMarkedSurprised(combatant));
          app?.render?.();
        });

        const effects = controls.querySelector(".token-effects");
        if (effects?.parentNode) {
          effects.parentNode.insertBefore(btn, effects);
        } else {
          controls.appendChild(btn);
        }
        updateEligibilityButtonState(btn, surprised);
      });
    }
  }
  let combatControls;
  if (typeof html.find === "function") {
    combatControls = html.find('nav.combat-controls[data-application-part="footer"]');
    if (!combatControls.length) combatControls = html.find('.combat-controls').first();
  } else {
    combatControls = html.querySelector('nav.combat-controls[data-application-part="footer"]') || html.querySelector('.combat-controls');
  }

  const isSurprise = data.combat?.getFlag(MODULE.ID, 'isSurprise') || false;
  const isRoundOne = data.combat?.current?.round === 1;
  
  if (isSurprise && isRoundOne) {
    let roundDisplay;
    const surpriseRoundText = game.i18n.localize('NAS.conditions.main.SurpriseRound');
    if (typeof html.find === "function") {
      roundDisplay = html.find('.encounter-title');
      if (roundDisplay.length) {
        roundDisplay.html(`<span style="color: red; font-weight: bold;">${surpriseRoundText}</span>`);
      }
    } else {
      roundDisplay = html.querySelector('.encounter-title');
      if (roundDisplay) {
        roundDisplay.innerHTML = `<span style="color: red; font-weight: bold;">${surpriseRoundText}</span>`;
      }
    }
  }

  if (data.combat?.current?.round === 0 && game.user.isGM) {
    const surpriseRoundLabel = game.i18n.localize('NAS.conditions.main.SurpriseRound');
    const surpriseSelector = '[data-control="nas-surprise-round"]';

    const resetExemptFlags = async (combat) => {
      const selectedTokens = canvas.tokens.controlled.map(token => token.id); 

      const flagPromises = combat.turns.map(async turn => {
        const tokenId = turn.tokenId;
        const token = canvas.tokens.get(tokenId);

        if (token) {
          const isSelected = selectedTokens.includes(tokenId);
          return token.actor.setFlag(MODULE.ID, 'exemptFromSurprise', isSelected);
        }
      });

      await Promise.all(flagPromises);
    };

    const handleSurpriseClick = async () => {
      const isSurprise = data.combat?.getFlag(MODULE.ID, 'isSurprise') || false;

      await resetExemptFlags(data.combat);

      if (!isSurprise) {
        await data.combat?.setFlag(MODULE.ID, 'isSurprise', true);
      }
      data.combat?.startCombat();
    };

    let surpriseRoundButton;

    if (typeof html.find === 'function') {
      const placeholderNav = html.find('nav.combat-controls.add-placeholder');
      const footerNav = html.find('nav.combat-controls[data-application-part="footer"]');
      const baseControls = placeholderNav.length ? placeholderNav : footerNav.length ? footerNav : html.find('.combat-controls').first();

      baseControls.css('flex-direction', 'column');

      html.find(surpriseSelector).remove();
      surpriseRoundButton = $(
        `<a class="combat-control" data-control="nas-surprise-round" aria-label="${surpriseRoundLabel}" role="button">
          ${surpriseRoundLabel}
        </a>`
      );

      if (placeholderNav.length) {
        placeholderNav.append(surpriseRoundButton);
      } else {
        const beginCombatButton = footerNav.find('a[data-control="startCombat"], button[data-action="startCombat"]');
        if (beginCombatButton.length) {
          beginCombatButton.before(surpriseRoundButton);
        } else {
          baseControls.prepend(surpriseRoundButton);  
        }
      }

      surpriseRoundButton.off('.nas').on('click.nas', handleSurpriseClick);
    } else {
      const placeholderNav = html.querySelector('nav.combat-controls.add-placeholder');
      const footerNav = html.querySelector('nav.combat-controls[data-application-part="footer"]');
      const baseControls = placeholderNav ?? footerNav ?? html.querySelector('.combat-controls');

      if (baseControls) baseControls.style.flexDirection = 'column';

      html.querySelectorAll(surpriseSelector).forEach(btn => btn.remove());
      surpriseRoundButton = document.createElement('button');
      surpriseRoundButton.classList.add('combat-control');
      surpriseRoundButton.setAttribute('aria-label', surpriseRoundLabel);
      surpriseRoundButton.dataset.control = 'nas-surprise-round';
      surpriseRoundButton.type = 'button';
      surpriseRoundButton.textContent = surpriseRoundLabel;

      if (placeholderNav) {
        placeholderNav.appendChild(surpriseRoundButton); 
      } else if (footerNav) {
        const beginCombatButton = footerNav.querySelector('button[data-action="startCombat"], a[data-control="startCombat"]');
        if (beginCombatButton && beginCombatButton.parentNode) {
          beginCombatButton.parentNode.insertBefore(surpriseRoundButton, beginCombatButton);
        } else {
          footerNav.insertBefore(surpriseRoundButton, footerNav.firstChild);
        }
      } else if (baseControls) {
        baseControls.insertBefore(surpriseRoundButton, baseControls.firstChild);
      }

      surpriseRoundButton.addEventListener('click', handleSurpriseClick);
    }

    if (typeof combatControls.on === 'function') {
      combatControls.on('click', 'a[data-control="startCombat"]', async () => {
        const isSurprise = data.combat?.getFlag(MODULE.ID, 'isSurprise') || false;
        await resetExemptFlags(data.combat);
        if (isSurprise) {
          await data.combat?.setFlag(MODULE.ID, 'isSurprise', false);
        }
      });
    } else {
      const startCombatButton = combatControls.querySelector('button[data-action="startCombat"]');
      if (startCombatButton) {
        startCombatButton.addEventListener('click', async () => {
          const isSurprise = data.combat?.getFlag(MODULE.ID, 'isSurprise') || false;
          await resetExemptFlags(data.combat);
          if (isSurprise) {
            await data.combat?.setFlag(MODULE.ID, 'isSurprise', false);
          }
        });
      }
    }
  }
}



