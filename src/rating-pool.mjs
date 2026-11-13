// Separate Elo per kind of game, as empire-league keeps a solo and a team rating (src/rating-pool.mjs upstream, MIT, see
// LICENSE.empire-league); FFA gets a pool of its own here.
//
// The unranked queues (the same matching and map pool, no change to the shown rating) pair players by a
// hidden casual rating per format: the pools casual_solo / casual_team / casual_ffa, never shown on a profile or a
// leaderboard.
export const QUEUES = Object.freeze({
  "1v1": { id: "1v1", pool: "solo", format: "solo", teamSizes: [1] },
  team: { id: "team", pool: "team", format: "team", teamSizes: [2, 3, 4] },
  ffa: { id: "ffa", pool: "ffa", format: "ffa" }
});
export const POOLS = Object.freeze(["solo", "team", "ffa"]);
export const CASUAL_POOLS = Object.freeze(["casual_solo", "casual_team", "casual_ffa"]);

export function queueInfo(queueId) {
  const queue = QUEUES[queueId];
  if (!queue) throw new Error(`unknown queue ${queueId}`);
  return queue;
}

export function ratingPoolForQueue(queueId) {
  return queueInfo(queueId).pool;
}

// The hidden pool an unranked game of that queue pairs by and updates.
export function casualPoolForQueue(queueId) {
  return `casual_${ratingPoolForQueue(queueId)}`;
}

export const isCasualPool = (pool) => String(pool ?? "").startsWith("casual_");
