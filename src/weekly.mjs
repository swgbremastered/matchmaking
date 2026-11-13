// The weekly unranked queue. One featured format and map pool a week (Golden Age's weekly events; the
// rotation is ours), unranked: paired by the hidden casual rating, no change to the shown rating, kept in the match
// history. The week is the ISO week (UTC); the rotation index is the week count since 2026-01-05 (a Monday).
export const WEEKLY_ROTATION = Object.freeze([
  { id: "open-duel", name: "Open Duel", queue: "1v1", groups: ["land-open"] },
  { id: "fortress-ffa", name: "Fortress Free for All", queue: "ffa", groups: ["land-closed"] },
  { id: "naval-teams", name: "Naval Teams", queue: "team", teamSizes: [2], groups: ["water"] },
  { id: "arena-duel", name: "Arena Duel", queue: "1v1", maps: ["arena"] }
]);

const EPOCH = Date.UTC(2026, 0, 5);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function weekIndex(now = Date.now()) {
  return Math.floor((now - EPOCH) / WEEK_MS);
}

// ISO week label, e.g. 2026-W46.
export function weekLabel(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// This week's queue: { week, id, name, queue, teamSizes?, groups?, maps?, endsAt }.
export function weeklyQueue(now = Date.now(), rotation = WEEKLY_ROTATION) {
  const i = weekIndex(now);
  const entry = rotation[((i % rotation.length) + rotation.length) % rotation.length];
  return { week: weekLabel(now), ...entry, endsAt: EPOCH + (i + 1) * WEEK_MS };
}
