const PENDING_SELECTORS = new WeakMap();

function matchesSelector(app, item, attribute) {
  return (app?.document ?? app?.object) === item && app?.options?.name === attribute;
}

export async function openResistanceSelector(item, options, resistance) {
  let pending = PENDING_SELECTORS.get(item);
  if (!pending) PENDING_SELECTORS.set(item, (pending = new Map()));
  if (pending.has(options.name)) return pending.get(options.name);

  const existing = Object.values(item.apps ?? {}).find((app) => matchesSelector(app, item, options.name));
  if (existing) {
    await existing.render(true);
    existing.bringToFront();
    return existing;
  }

  const applications = globalThis.pf1?.applications;
  const Selector = applications?.DamageResistanceSelector;

  const bridge = applications?.actor?.ActorSheetPF?.prototype?._onResistanceSelector;
  if (typeof Selector !== "function" && typeof bridge !== "function") return null;

  const opening = (async () => {
    await item.update({ [options.name]: resistance }, { render: false });
    return new Promise((resolve, reject) => {
      let hookId;
      let timer;
      const finish = (error, app) => {
        Hooks.off("renderDamageResistanceSelector", hookId);
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(app);
      };

      hookId = Hooks.on("renderDamageResistanceSelector", (app) => {
        if (matchesSelector(app, item, options.name)) finish(null, app);
      });
      timer = setTimeout(() => finish(new Error("PF1 damage resistance selector did not finish opening.")), 10000);
      try {
        if (typeof Selector === "function") {
          const app = new Selector({ document: item, ...options });
          Promise.resolve(app.render(true)).catch((error) => finish(error));
        } else {
          bridge.call({ actor: item }, {
            preventDefault() {},
            currentTarget: {
              dataset: { for: options.name, fields: options.fields, dtypes: options.dtypes, options: options.options },
              innerText: options.title
            }
          });
        }
      } catch (error) {
        finish(error);
      }
    });
  })();
  pending.set(options.name, opening);
  try {
    return await opening;
  } finally {
    pending.delete(options.name);
  }
}
