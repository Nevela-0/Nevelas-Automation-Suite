import { MODULE } from "../../../common/module.js";

const DEFAULT_OPTIONS = {
  matchMode: "includes",
  deepScanMode: "auto",
  maxDeepDocsTotal: 1500,
  maxDeepDocsPerPack: 400,
};

const NAME_CACHE = new Map();
let persistentCache = null;
const DEFAULT_LANGUAGE = "en";

function getCurrentLanguage() {
  return game?.i18n?.lang ?? DEFAULT_LANGUAGE;
}

function shouldUseReverseLookup() {
  return !getCurrentLanguage().toLowerCase().startsWith(DEFAULT_LANGUAGE);
}

function getProp(obj, path) {
  if (foundry?.utils?.getProperty) return foundry.utils.getProperty(obj, path);
  return path.split(".").reduce((current, key) => (current ? current[key] : undefined), obj);
}

function isMatch(text, needle, matchMode) {
  const haystack = (text ?? "").toString().toLowerCase();
  return matchMode === "exact" ? haystack === needle : haystack.includes(needle);
}

function normalizeCacheKey(search, documentName) {
  const lang = getCurrentLanguage().toLowerCase();
  const name = (search ?? "").toString().toLowerCase();
  return `${lang}::${documentName ?? "any"}::${name}`;
}

function loadPersistentCache() {
  if (persistentCache !== null) return persistentCache;
  if (!game?.settings) {
    persistentCache = {};
    return persistentCache;
  }
  try {
    persistentCache = game.settings.get(MODULE.ID, "metamagicNameCache") ?? {};
  } catch (error) {
    console.warn("Failed to load metamagic name cache.", error);
    persistentCache = {};
  }
  return persistentCache;
}

function getCachedName(cacheKey) {
  if (NAME_CACHE.has(cacheKey)) return NAME_CACHE.get(cacheKey);
  const cache = loadPersistentCache();
  if (cacheKey in cache) {
    NAME_CACHE.set(cacheKey, cache[cacheKey]);
    return cache[cacheKey];
  }
  return null;
}

function setCachedName(cacheKey, value) {
  if (!value) return;
  NAME_CACHE.set(cacheKey, value);
  const cache = loadPersistentCache();
  if (cache[cacheKey] === value) return;
  cache[cacheKey] = value;
  if (game?.settings) {
    void game.settings.set(MODULE.ID, "metamagicNameCache", cache);
  }
}

/**
 * Search all compendia for documents whose name or babele originalName matches.
 * @param {string} search
 * @param {object} [options]
 * @param {"includes"|"exact"} [options.matchMode]
 * @param {"off"|"auto"|"on"} [options.deepScanMode]
 * @param {number} [options.maxDeepDocsTotal]
 * @param {number} [options.maxDeepDocsPerPack]
 * @returns {Promise<Array<{uuid: string, packLabel: string, packCollection: string, documentName: string, id: string, name: string, originalName: string|null, matchedBy: string}>>}
 */
export async function searchCompendiumNames(search, options = {}) {
  const needle = (search ?? "").trim().toLowerCase();
  if (!needle || !game?.packs) return [];

  const config = { ...DEFAULT_OPTIONS, ...options };
  const packs = Array.from(game.packs);
  const results = [];
  const seen = new Set();
  const packHasOriginalName = new Map();

  for (const pack of packs) {
    try {
      const index = await pack.getIndex({ fields: ["name", "flags.babele.originalName"] });
      const hasOriginalName = index.some((entry) => {
        const value = getProp(entry, "flags.babele.originalName") ?? entry["flags.babele.originalName"];
        return value !== undefined && value !== null && `${value}`.length > 0;
      });

      packHasOriginalName.set(pack.collection, hasOriginalName);

      for (const entry of index) {
        const shownName = (entry.name ?? "").toString();
        const originalName = (
          getProp(entry, "flags.babele.originalName") ??
          entry["flags.babele.originalName"] ??
          ""
        ).toString();

        const matchedBy = isMatch(shownName, needle, config.matchMode)
          ? "name"
          : originalName && isMatch(originalName, needle, config.matchMode)
            ? "flags.babele.originalName"
            : null;

        if (!matchedBy) continue;

        const uuid = `Compendium.${pack.collection}.${entry._id}`;
        if (seen.has(uuid)) continue;
        seen.add(uuid);

        results.push({
          packLabel: pack.metadata?.label ?? pack.collection,
          packCollection: pack.collection,
          documentName: pack.documentName,
          id: entry._id,
          name: shownName,
          originalName: originalName || null,
          uuid,
          matchedBy,
        });
      }
    } catch (error) {
      console.warn(`Failed indexing pack: ${pack.collection}`, error);
    }
  }

  const shouldDeepScanPack = (pack) => {
    if (config.deepScanMode === "off") return false;
    if (config.deepScanMode === "on") return true;
    return packHasOriginalName.get(pack.collection) === false;
  };

  let deepLoadedTotal = 0;
  if (config.deepScanMode !== "off") {
    for (const pack of packs) {
      if (!shouldDeepScanPack(pack)) continue;
      if (deepLoadedTotal >= config.maxDeepDocsTotal) break;

      let deepLoadedPack = 0;

      try {
        const index = await pack.getIndex({ fields: ["name"] });

        for (const entry of index) {
          if (deepLoadedTotal >= config.maxDeepDocsTotal) break;
          if (deepLoadedPack >= config.maxDeepDocsPerPack) break;

          const uuid = `Compendium.${pack.collection}.${entry._id}`;
          if (seen.has(uuid)) continue;

          const doc = await pack.getDocument(entry._id);
          deepLoadedTotal++;
          deepLoadedPack++;

          const shownName = doc?.name ?? entry.name ?? "";
          const originalName =
            doc?.getFlag?.("babele", "originalName") ??
            getProp(doc, "flags.babele.originalName") ??
            "";

          const matchedBy = isMatch(shownName, needle, config.matchMode)
            ? "name (deep)"
            : originalName && isMatch(originalName, needle, config.matchMode)
              ? "flags.babele.originalName (deep)"
              : null;

          if (!matchedBy) continue;

          seen.add(uuid);
          results.push({
            packLabel: pack.metadata?.label ?? pack.collection,
            packCollection: pack.collection,
            documentName: pack.documentName,
            id: entry._id,
            name: shownName.toString(),
            originalName: originalName ? originalName.toString() : null,
            uuid,
            matchedBy,
          });
        }
      } catch (error) {
        console.warn(`Deep scan failed for pack: ${pack.collection}`, error);
      }
    }
  }

  return results;
}

/**
 * Resolve an English name by searching compendia for babele originalName.
 * @param {string} search
 * @param {object} [options]
 * @param {string} [options.documentName]
 * @returns {Promise<string>}
 */
export async function resolveEnglishName(search, options = {}) {
  const trimmed = (search ?? "").toString().trim();
  if (!trimmed) return trimmed;
  if (!shouldUseReverseLookup()) return trimmed;

  const cacheKey = normalizeCacheKey(trimmed, options.documentName);
  const cached = getCachedName(cacheKey);
  if (cached) return cached;

  const matches = await searchCompendiumNames(trimmed, {
    matchMode: "exact",
    deepScanMode: options.deepScanMode ?? "auto",
  });
  const filtered = options.documentName
    ? matches.filter((match) => match.documentName === options.documentName)
    : matches;
  const bestMatch = filtered.find((match) => match.originalName) ?? filtered[0];
  const resolved = bestMatch?.originalName ?? bestMatch?.name ?? trimmed;

  setCachedName(cacheKey, resolved);
  return resolved;
}
