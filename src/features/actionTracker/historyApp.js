import { MODULE } from "../../common/module.js";
import { elementFromHtmlLike, isFoundryV13Plus, legacyFormApplicationConstructor } from "../../common/foundryCompat.js";

export function createHistoryApplication({ attach, detach, beforeRender = () => {}, title, position = {}, game = globalThis.game }) {
  let closed = false;
  const closing = (app) => {
    if (closed) return;
    closed = true;
    detach({ ...app.position });
  };
  const template = `modules/${MODULE.ID}/src/templates/action-tracker-history.html`;
  if (isFoundryV13Plus(game)) {
    const { ApplicationV2, HandlebarsApplicationMixin } = globalThis.foundry?.applications?.api ?? {};
    if (!ApplicationV2 || !HandlebarsApplicationMixin) throw new Error("The Foundry v13 history window is not available yet.");
    class ActionTrackerHistoryV2 extends HandlebarsApplicationMixin(ApplicationV2) {
      static DEFAULT_OPTIONS = {

        id: "nas-action-tracker-history-{id}", classes: ["nas-at-history-app"],
        window: { resizable: true }, position: { width: 700, height: 580 }
      };
      static PARTS = { history: { template, forms: { form: { handler: async () => {}, closeOnSubmit: false, submitOnChange: false } } } };
      _canRender(options) { return !closed && super._canRender(options); }
      async _preRender(context, options) {
        if (!closed) beforeRender();
        await super._preRender(context, options);
      }
      async _onRender(context, options) {
        await super._onRender(context, options);
        if (!closed) attach(elementFromHtmlLike(this.element));
      }
      async close(options) {

        closing(this);
        return super.close(options);
      }
    }
    const app = new ActionTrackerHistoryV2({ window: { title }, position });
    return {
      open() { if (!closed) return app.render({ force: true }); },
      async focus() { await app.maximize(); if (!closed) app.bringToFront(); },
      close() { return app.close(); }
    };
  }
  const Base = legacyFormApplicationConstructor();
  if (!Base) throw new Error("The Foundry history window is not available yet.");
  class ActionTrackerHistory extends Base {
    static get defaultOptions() {
      return globalThis.foundry.utils.mergeObject(super.defaultOptions, {
        id: "nas-action-tracker-history", classes: ["nas-at-history-app"], title,
        template,
        width: 700, height: 580, resizable: true,
        closeOnSubmit: false, submitOnChange: false, submitOnClose: false
      });
    }
    getData() { return {}; }
    async _updateObject() {}
    async _render(...args) {
      if (closed) return;
      beforeRender();
      await super._render(...args);

      if (closed) await super.close();
    }
    activateListeners(html) {
      if (closed) return;
      super.activateListeners(html);
      attach(elementFromHtmlLike(html));
    }
    async close(options) {
      closing(this);
      return super.close(options);
    }
  }
  const app = new ActionTrackerHistory({}, position);
  return {
    open() { if (!closed) app.render(true); },
    async focus() { await app.maximize(); if (!closed) app.bringToTop(); },
    close() { return app.close(); }
  };
}
