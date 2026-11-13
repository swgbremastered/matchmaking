// The map pool: maps grouped by category, each player's queue entry enables groups and toggles single maps. Adapted
// from empire-league's src/map-catalog.mjs (normalizeQueueMapPreferences, selectMapForMatch; MIT, see
// LICENSE.empire-league): the catalog is SWGB's random maps, and the match pick takes any number of players.
import { readFileSync } from "node:fs";

export function loadMapCatalog(file = new URL("../data/maps.json", import.meta.url), { includeTest = false } = {}) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return createMapCatalog(raw, { includeTest });
}

export function createMapCatalog(raw, { includeTest = false } = {}) {
  const groups = raw.groups.filter((group) => includeTest || !group.testOnly);
  const groupIds = new Set(groups.map((group) => group.id));
  const maps = raw.maps.filter((map) => map.enabled !== false && groupIds.has(map.groupId));
  const mapsById = new Map(maps.map((map) => [map.id, map]));

  // A queue entry's map preferences: { groups: [groupId], maps: [mapId] (the toggled-on maps), favorites: {groupId: mapId} }.
  // Missing groups = the groups of the given maps; missing maps = every map of the enabled groups.
  function normalize(preferences = {}) {
    const enabledGroupIds = preferences.groups === undefined
      ? [...new Set((preferences.maps ?? maps.map((map) => map.id)).map((id) => mapsById.get(id)?.groupId).filter(Boolean))]
      : preferences.groups;
    if (!Array.isArray(enabledGroupIds) || enabledGroupIds.some((id) => !groupIds.has(id))
        || new Set(enabledGroupIds).size !== enabledGroupIds.length) {
      throw new Error("enabled map groups are invalid");
    }
    const requested = preferences.maps ?? maps.filter((map) => enabledGroupIds.includes(map.groupId)).map((map) => map.id);
    if (!Array.isArray(requested)) throw new Error("maps must be a list");
    const selected = [];
    const ignored = [];
    for (const id of requested) {
      const map = mapsById.get(String(id));
      if (!map) {
        ignored.push(String(id));
        continue;
      }
      if (!enabledGroupIds.includes(map.groupId)) throw new Error("selected maps must belong to enabled groups");
      if (!selected.includes(map.id)) selected.push(map.id);
    }
    if (!selected.length) throw new Error("at least one selected map is required");
    const favorites = {};
    for (const [groupId, mapId] of Object.entries(preferences.favorites ?? {})) {
      const map = mapsById.get(mapId);
      if (!map || map.groupId !== groupId || !selected.includes(mapId)) throw new Error(`favorite map for ${groupId} is invalid`);
      favorites[groupId] = mapId;
    }
    return { groups: enabledGroupIds, maps: selected, favorites, ignored };
  }

  function shared(preferenceList) {
    if (!preferenceList.length) return [];
    let pool = preferenceList[0].maps;
    for (const p of preferenceList.slice(1)) pool = pool.filter((id) => p.maps.includes(id));
    return pool;
  }

  // Every player's pool intersected; a map every player marked favourite wins outright, else the shared maps weighted by
  // 1 + the number of players who favour each (empire-league's rule, for n players).
  function select(preferenceList, random = Math.random) {
    const pool = shared(preferenceList);
    if (!pool.length) return undefined;
    const favourites = preferenceList.map((p) => new Set(Object.values(p.favorites ?? {})));
    const mutual = pool.filter((id) => favourites.every((set) => set.has(id)));
    if (mutual.length) return mapsById.get(mutual[Math.floor(random() * mutual.length)]);
    const weighted = pool.flatMap((id) => Array.from({ length: 1 + favourites.filter((set) => set.has(id)).length }, () => id));
    return mapsById.get(weighted[Math.floor(random() * weighted.length)]);
  }

  return {
    version: raw.version,
    groups,
    maps,
    get: (id) => mapsById.get(id),
    normalize,
    shared,
    select,
    public: () => ({ version: raw.version, groups, maps })
  };
}
