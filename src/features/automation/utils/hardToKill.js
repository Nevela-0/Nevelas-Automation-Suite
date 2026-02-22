import { MODULE } from "../../../common/module.js";
import { resolveEnglishName } from "./compendiumNameResolver.js";

export const HTK_FEATURES = Object.freeze({
  akitonianFerocity: {
    englishName: "Akitonian Ferocity (Akiton)",
    compendiumSources: ["Compendium.pf-content.pf-traits.Item.aPm692dsgpp0h4JV"],
    bundle: "B",
  },
  diehard: {
    englishName: "Diehard",
    compendiumSources: ["Compendium.pf1.feats.Item.O0e0UCim27GPKFuW"],
    bundle: "A",
  },
  ferocityUmr: {
    englishName: "Ferocity",
    compendiumSources: ["Compendium.pf-content.pf-universal-monster-rules.Item.itiLDlB5BHlUB8os"],
    bundle: "C",
  },
  ferocityOrc: {
    englishName: "Ferocity (Orc)",
    compendiumSources: ["Compendium.pf-content.pf-racial-traits.Item.oKbTIUKJkGwFDHXu"],
    bundle: "C",
  },
  fightOn: {
    englishName: "Fight On",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.zvGUIrZrYog7vxUC"],
    bundle: "E",
  },
  honorableStand: {
    englishName: "Honorable Stand",
    compendiumSources: ["Compendium.pf1.class-abilities.Item.t2XEI2AKkv1CY8to"],
    bundle: "F",
  },
  lastStand: {
    englishName: "Last Stand",
    compendiumSources: ["Compendium.pf1.class-abilities.Item.k2CQRwlyblNHuius"],
    bundle: "F",
  },
  orcFerocityOrc: {
    englishName: "Orc Ferocity",
    compendiumSources: ["Compendium.pf-content.pf-racial-traits.Item.LAxucaDDMsbYmW6G"],
    bundle: "B",
  },
  orcFerocityHalfOrc: {
    englishName: "Orc Ferocity",
    compendiumSources: ["Compendium.pf-content.pf-racial-traits.Item.OyIvyI3x7V5HIzZL"],
    bundle: "B",
  },
  orcFerocityGrachukk: {
    englishName: "Orc Ferocity (Grachukk)",
    compendiumSources: ["Compendium.pf-content.pf-collab-content.Item.prikw1l8MWQaSD03"],
    bundle: "B",
  },
  resolve: {
    englishName: "Resolve",
    compendiumSources: ["Compendium.pf1.class-abilities.Item.fdEn4hZJkIhJEwrQ"],
    bundle: "F",
  },
  unstoppableRavager: {
    englishName: "Unstoppable Ravager",
    compendiumSources: ["Compendium.pf1.class-abilities.Item.W4g6gnmylQwneVUm"],
    bundle: "F",
  },
  unyieldingFerocity: {
    englishName: "Unyielding Ferocity",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.1taW8qvQsEjvvVSv"],
    bundle: "D",
  },
  deathsHost: {
    englishName: "Death's Host",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.ICI9T0jc4437bxFH"],
    bundle: "F",
  },
  deathlessInitiate: {
    englishName: "Deathless Initiate",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.J0OrSFwDOvp2XNgJ"],
    bundle: "A",
  },
  deathlessMaster: {
    englishName: "Deathless Master",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.uutpCVadAutfuCHi"],
    bundle: "A",
  },
  ferociousResolve: {
    englishName: "Ferocious Resolve",
    compendiumSources: ["Compendium.pf-content.pf-feats.Item.fPaVcekVqNZiQN2d"],
    bundle: "C",
  },
});

function isEnglishLanguage() {
  return (game?.i18n?.lang ?? "en").toLowerCase().startsWith("en");
}

function getBabeleOriginalName(item) {
  const direct = item?.flags?.babele?.originalName;
  if (direct) return direct;

  const canUseBabele = game?.modules?.get?.("babele")?.active === true;
  if (!canUseBabele) return null;
  if (typeof item?.getFlag !== "function") return null;
  try {
    return item.getFlag("babele", "originalName") ?? null;
  } catch (_err) {
    return null;
  }
}

function getCompendiumSource(item) {
  return item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? null;
}

function isFeatLikeItem(item) {
  if (item?.type !== "feat") return false;
  const subType = item?.subType ?? item?.system?.subType;
  return ["feat", "racial", "trait", "misc", "classFeat"].includes(subType);
}

export async function detectHardToKillItems(actor) {
  const out = {};
  if (!actor?.items) return out;

  const items = Array.from(actor.items).filter(isFeatLikeItem);
  if (!items.length) return out;

  const bySource = new Map();
  for (const it of items) {
    const src = getCompendiumSource(it);
    if (src) bySource.set(src, it);
  }

  for (const [key, spec] of Object.entries(HTK_FEATURES)) {
    const sources = spec.compendiumSources ?? [];
    for (const src of sources) {
      const match = bySource.get(src);
      if (match) {
        out[key] = match;
        break;
      }
    }
  }

  for (const [key, spec] of Object.entries(HTK_FEATURES)) {
    if (out[key]) continue;
    const needle = spec.englishName;
    if (!needle) continue;
    const match = items.find((it) => getBabeleOriginalName(it) === needle);
    if (match) out[key] = match;
  }

  if (isEnglishLanguage()) {
    for (const [key, spec] of Object.entries(HTK_FEATURES)) {
      if (out[key]) continue;
      const needle = (spec.englishName ?? "").trim();
      if (!needle) continue;
      const match = items.find((it) => (it?.name ?? "").trim() === needle);
      if (match) out[key] = match;
    }
    return out;
  }

  const missing = Object.entries(HTK_FEATURES).filter(([k]) => !out[k]);
  if (!missing.length) return out;

  const sorted = [...items].sort((a, b) => {
    const aHas = Boolean(getBabeleOriginalName(a));
    const bHas = Boolean(getBabeleOriginalName(b));
    return Number(bHas) - Number(aHas);
  });

  for (const it of sorted) {
    const resolved = await resolveEnglishName(it?.name, { documentName: "Item", deepScanMode: "off" });
    if (!resolved) continue;
    for (const [key, spec] of missing) {
      if (out[key]) continue;
      if (resolved === spec.englishName) out[key] = it;
    }
    if (Object.entries(HTK_FEATURES).every(([k]) => out[k])) break;
  }

  return out;
}

export function getHtkFlag(actor) {
  return actor?.getFlag?.(MODULE.ID, "htk") ?? {};
}

