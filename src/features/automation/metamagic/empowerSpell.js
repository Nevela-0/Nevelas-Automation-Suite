export const METAMAGIC_DEFINITION = {
  key: "empowerSpell",
  name: "Empower Spell",
  prefix: "Empower",
};

function wrapEmpowerFormula(formula) {
  const raw = (formula ?? "").toString().trim();
  if (!raw) return raw;
  return `floor((${raw}) * 1.5)`;
}

function getCurrentFormula(context, index, fallback) {
  const overrides = context?.damageOverrides?.parts;
  if (Array.isArray(overrides)) {
    for (let i = overrides.length - 1; i >= 0; i -= 1) {
      const entry = overrides[i];
      if (entry?.index === index && entry?.formula) return entry.formula;
    }
  }
  return fallback;
}

export function applyEmpowerSpell(context) {
  if (!context?.damage?.parts || !Array.isArray(context.damage.parts)) return false;

  const overrides = [];
  context.damage.parts.forEach((part, index) => {
    if (!part || typeof part !== "object") return;
    const baseFormula = part.formula ?? part[0];
    const formula = getCurrentFormula(context, index, baseFormula);
    if (!formula) return;
    overrides.push({
      index,
      isArray: Array.isArray(part),
      formula: wrapEmpowerFormula(formula),
    });
  });

  if (!overrides.length) return false;
  context.damageOverrides ??= { parts: [] };
  context.damageOverrides.parts = [
    ...(context.damageOverrides.parts ?? []),
    ...overrides,
  ];

  if (!context.metamagic) {
    context.metamagic = { applied: [], slotIncrease: 0 };
  }

  if (!context.metamagic.applied.includes(METAMAGIC_DEFINITION.name)) {
    context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
    context.metamagic.slotIncrease += 2;
  }

  return true;
}

function decodeRollData(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    try {
      return JSON.parse(unescape(raw));
    } catch {
      return null;
    }
  }
}

function isEmpoweredFormula(formula) {
  if (!formula || typeof formula !== "string") return false;
  const normalized = formula.replace(/\s+/g, "").toLowerCase();
  return normalized.includes("floor((") && normalized.includes("*1.5)");
}

function findInnerTotal(node) {
  if (!node || typeof node !== "object") return null;
  const formula = node.formula ?? node.term ?? "";
  const hasEmpower = typeof formula === "string" && formula.replace(/\s+/g, "").includes("*1.5");
  if (!hasEmpower && Number.isFinite(node.total)) return node.total;

  if (Array.isArray(node.terms)) {
    for (const term of node.terms) {
      const inner = findInnerTotal(term);
      if (Number.isFinite(inner)) return inner;
    }
  }
  if (Array.isArray(node.rolls)) {
    for (const roll of node.rolls) {
      const inner = findInnerTotal(roll);
      if (Number.isFinite(inner)) return inner;
    }
  }
  if (node.roll && typeof node.roll === "object") {
    const inner = findInnerTotal(node.roll);
    if (Number.isFinite(inner)) return inner;
  }
  return null;
}

export function applyEmpowerTooltipOverrides(html) {
  const root = html?.[0] ?? html;
  if (!root?.querySelectorAll) return;
  const rolls = root.querySelectorAll(".inline-roll[data-roll]");
  rolls.forEach((rollEl) => {
    const rollData = decodeRollData(rollEl.dataset.roll);
    const formula = rollData?.formula;
    if (!isEmpoweredFormula(formula)) return;

    if (rollEl.dataset?.tooltipText) {
      rollEl.dataset.tooltipText = formula;
    }

    const updateTooltip = () => {
      const tooltipFormula = rollEl.querySelector(".dice-tooltip .part-formula");
      const tooltipTotal = rollEl.querySelector(".dice-tooltip .part-total");
      let didUpdate = false;
      if (tooltipFormula) {
        tooltipFormula.textContent = formula;
        didUpdate = true;
      }
      if (tooltipTotal) {
        const finalTotal = Number(rollData?.total ?? tooltipTotal.textContent ?? 0);
        const innerTotal = findInnerTotal(rollData);
        const baseValue = Number.isFinite(innerTotal)
          ? innerTotal
          : Number.isFinite(finalTotal)
            ? Math.floor(finalTotal / 1.5)
            : Number(tooltipTotal.textContent ?? 0);
        if (Number.isFinite(baseValue)) {
          const totalValue = Number.isFinite(finalTotal)
            ? finalTotal
            : Math.floor(baseValue * 1.5);
          tooltipTotal.textContent = `${baseValue} * 1.5 = ${totalValue}`;
          didUpdate = true;
        }
      }
      return didUpdate;
    };

    updateTooltip();

    if (rollEl.dataset?.nasEmpowerObserver === "true") return;
    rollEl.dataset.nasEmpowerObserver = "true";

    const observer = new MutationObserver(() => {
      updateTooltip();
    });

    observer.observe(rollEl, { childList: true, subtree: true });
  });
}
