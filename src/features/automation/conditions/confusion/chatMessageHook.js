import { MODULE } from '../../../../common/module.js';

export function registerConfusionChatMessageHook() {
  Hooks.on("renderChatMessage", (message, html, data) => {
    if (!game.settings.get(MODULE.ID, 'handleConfused')) return;
    
    let tokenImgs;
    if (typeof html.find === 'function') {
      tokenImgs = html.find('.NAS-token img');
      tokenImgs.click(async ev => {
        const tokenUuid = $(ev.currentTarget).closest('.NAS-token').data('uuid');
        const tokenDocument = await fromUuid(tokenUuid);
        const token = canvas.tokens.get(tokenDocument.id);
        if (token) {
          token.control({releaseOthers: true});
          canvas.animatePan({x: token.center?.x, y: token.center?.y, duration: 1000});
        }
      });
      tokenImgs.hover(
        async ev => {
          const tokenUuid = $(ev.currentTarget).closest('.NAS-token').data('uuid');
          const tokenDocument = await fromUuid(tokenUuid);
          const token = canvas.tokens.get(tokenDocument.id);
          if (token) token._onHoverIn(ev);
        },
        async ev => {
          const tokenUuid = $(ev.currentTarget).closest('.NAS-token').data('uuid');
          const tokenDocument = await fromUuid(tokenUuid);
          const token = canvas.tokens.get(tokenDocument.id);
          if (token) token._onHoverOut(ev);
        }
      );
    } else {
      tokenImgs = html.querySelectorAll('.NAS-token img');
      tokenImgs.forEach(img => {
        img.addEventListener('click', async ev => {
          const icToken = ev.currentTarget.closest('.NAS-token');
          const tokenUuid = icToken?.dataset.uuid;
          const tokenDocument = await fromUuid(tokenUuid);
          const token = canvas.tokens.get(tokenDocument.id);
          if (token) {
            token.control({releaseOthers: true});
            canvas.animatePan({x: token.center?.x, y: token.center?.y, duration: 1000});
          }
        });
        img.addEventListener('mouseenter', async ev => {
          const icToken = ev.currentTarget.closest('.NAS-token');
          const tokenUuid = icToken?.dataset.uuid;
          const tokenDocument = await fromUuid(tokenUuid);
          const token = canvas.tokens.get(tokenDocument.id);
          if (token) token._onHoverIn(ev);
        });
        img.addEventListener('mouseleave', async ev => {
          const icToken = ev.currentTarget.closest('.NAS-token');
          const tokenUuid = icToken?.dataset.uuid;
          const tokenDocument = await fromUuid(tokenUuid);
          const token = canvas.tokens.get(tokenDocument.id);
          if (token) token._onHoverOut(ev);
        });
      });
    }
  });
}



