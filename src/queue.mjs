// Ranked queue matching, without sockets or storage. The rules are empire-league's
// (src/matchmaker.mjs tryMatch, balancedTeamAssignments, the rating range schedules, the weekly FFA grouping
// nextWeeklyGroup; MIT, see LICENSE.empire-league), without its civilisation rolls and AoE2 lobby automation:
//  - a ticket waits at least minQueueMs; its acceptable rating gap widens with its time in the queue;
//  - both sides must accept each other's rating (each ticket's own spread) and share at least one map;
//  - the closest rating comes first, then the longest waiting;
//  - team games try the largest team size first (4v4, 3v3, 2v2 of the sizes the tickets allow) and split the players
//    into the two teams whose rating totals differ least (the host's team is enumerated);
//  - FFA groups ffaPlayers tickets whose ratings are pairwise in range (spread doubled, as the weekly FFA queue);
//  - the host is the participant who joined first.
// Tickets carry a lane ("ranked" by default, "unranked", "weekly:<week>"); lanes never mix. A ticket can
// be a party (members: [{ playerId, name, rating }], its rating the members' average): it is matched as one unit, its
// members always on one team (team queue only; empire-league's party tickets), and the team split balances whole units.

export const SOLO_RANGE = [
  { afterMs: 0, spread: 50 },
  { afterMs: 20_000, spread: 75 },
  { afterMs: 40_000, spread: 100 },
  { afterMs: 60_000, spread: 150 },
  { afterMs: 90_000, spread: 250 }
];
export const TEAM_RANGE = [
  { afterMs: 0, spread: 100 },
  { afterMs: 20_000, spread: 150 },
  { afterMs: 40_000, spread: 225 },
  { afterMs: 60_000, spread: 325 },
  { afterMs: 90_000, spread: 500 }
];
export const FFA_RANGE = TEAM_RANGE.map((step) => ({ afterMs: step.afterMs, spread: step.spread * 2 }));

export function rangeSchedule(queueId) {
  return queueId === "1v1" ? SOLO_RANGE : queueId === "team" ? TEAM_RANGE : FFA_RANGE;
}

export function spreadFor(ticket, now) {
  const elapsed = Math.max(0, now - ticket.joinedAt);
  const schedule = rangeSchedule(ticket.queueId);
  return [...schedule].reverse().find((step) => elapsed >= step.afterMs)?.spread ?? schedule[0].spread;
}

export function ratingsInRange(a, b, now) {
  const difference = Math.abs(a.rating - b.rating);
  return (a.findAnyone === true || difference <= spreadFor(a, now)) && (b.findAnyone === true || difference <= spreadFor(b, now));
}

// The two teams whose rating totals differ least, the host on team one (empire-league balancedTeamAssignments).
export function balancedTeams(participants, host, teamSize) {
  const ranked = [...participants].sort((l, r) => r.rating - l.rating || l.id.localeCompare(r.id));
  if (teamSize === 1) return [[host], ranked.filter((p) => p.id !== host.id)];
  const candidates = ranked.filter((p) => p.id !== host.id);
  let best = null;
  let bestDifference = Number.POSITIVE_INFINITY;
  const total = (team) => team.reduce((sum, p) => sum + p.rating, 0);
  const choose = (start, selected) => {
    if (selected.length === teamSize - 1) {
      const one = [host, ...selected];
      const ids = new Set(one.map((p) => p.id));
      const two = ranked.filter((p) => !ids.has(p.id));
      const difference = Math.abs(total(one) - total(two));
      if (difference < bestDifference) bestDifference = difference, best = [one, two];
      return;
    }
    for (let i = start; i <= candidates.length - (teamSize - 1 - selected.length); i += 1) choose(i + 1, [...selected, candidates[i]]);
  };
  choose(0, []);
  return best;
}

const laneOf = (t) => t.lane ?? "ranked";
const sizeOf = (t) => t.members?.length ?? 1;
const totalOf = (t) => (t.members ? t.members.reduce((sum, m) => sum + m.rating, 0) : t.rating);

// Team split for units of any size (parties): the subsets of units holding the host's unit with teamSize players,
// the one whose rating totals differ least. Units of one player give balancedTeams' answer.
export function balancedUnitTeams(units, host, teamSize) {
  if (units.every((u) => sizeOf(u) === 1)) return balancedTeams(units, host, teamSize);
  const ranked = [...units].sort((l, r) => totalOf(r) - totalOf(l) || l.id.localeCompare(r.id));
  const others = ranked.filter((u) => u !== host);
  const sum = (team) => team.reduce((acc, u) => acc + totalOf(u), 0);
  let best = null;
  let bestDifference = Number.POSITIVE_INFINITY;
  const choose = (start, selected, players) => {
    if (players === teamSize) {
      const one = [host, ...selected];
      const two = ranked.filter((u) => !one.includes(u));
      const difference = Math.abs(sum(one) - sum(two));
      if (difference < bestDifference) bestDifference = difference, best = [one, two];
      return;
    }
    for (let i = start; i < others.length; i += 1)
      if (players + sizeOf(others[i]) <= teamSize) choose(i + 1, [...selected, others[i]], players + sizeOf(others[i]));
  };
  choose(0, [], sizeOf(host));
  return best;
}

export class QueueEngine {
  constructor({ catalog, minQueueMs = 15_000, ffaPlayers = 4, random = Math.random } = {}) {
    this.catalog = catalog;
    this.minQueueMs = minQueueMs;
    this.ffaPlayers = Math.min(8, Math.max(2, ffaPlayers));
    this.random = random;
    this.tickets = new Map();  // playerId -> ticket
  }

  // ticket: { id, playerId, name, queueId, rating, joinedAt, prefs (catalog.normalize), teamSizes?, findAnyone?, lane?,
  //          members? (a party: the leader is playerId) }
  join(ticket) {
    if (!["1v1", "team", "ffa"].includes(ticket.queueId)) throw new Error(`unknown queue ${ticket.queueId}`);
    if (sizeOf(ticket) > 1 && ticket.queueId !== "team") throw new Error("a party queues for team games only");
    if (ticket.queueId === "team") {
      const sizes = (ticket.teamSizes ?? [2, 3, 4]).filter((size) => [2, 3, 4].includes(size) && size >= sizeOf(ticket));
      if (!sizes.length) throw new Error("team sizes must be 2, 3 or 4");
      ticket.teamSizes = sizes;
    }
    this.tickets.set(ticket.playerId, { ...ticket, matchId: null });
    return this.tickets.get(ticket.playerId);
  }

  // The ticket a player is on (its own, or its party's).
  ticketOf(playerId) {
    if (this.tickets.has(playerId)) return this.tickets.get(playerId);
    for (const t of this.tickets.values()) if (t.members?.some((m) => m.playerId === playerId)) return t;
    return null;
  }

  // Leaving takes the whole ticket out (a party member leaving takes the party out).
  leave(playerId) {
    const t = this.ticketOf(playerId);
    return t ? this.tickets.delete(t.playerId) : false;
  }

  waiting(now) {
    return [...this.tickets.values()].filter((t) => !t.matchId && now - t.joinedAt >= this.minQueueMs);
  }

  // Every match that can be made now (each ticket at most once). A match: { queueId, participants, host, teams, map }.
  matchAll(now = Date.now()) {
    const out = [];
    const order = this.waiting(now).sort((l, r) => l.joinedAt - r.joinedAt || l.id.localeCompare(r.id));
    for (const ticket of order) {
      if (ticket.matchId) continue;
      const match = ticket.queueId === "ffa" ? this.tryFfa(ticket, now) : this.tryTeams(ticket, now);
      if (!match) continue;
      for (const p of match.participants) p.matchId = true;
      out.push(match);
    }
    return out;
  }

  tryTeams(ticket, now) {
    const candidates = this.waiting(now).filter((c) =>
      c.playerId !== ticket.playerId && !c.matchId && c.queueId === ticket.queueId && laneOf(c) === laneOf(ticket) && ratingsInRange(ticket, c, now)
        && this.catalog.shared([ticket.prefs, c.prefs]).length > 0)
      .sort((l, r) => Math.abs(l.rating - ticket.rating) - Math.abs(r.rating - ticket.rating) || l.joinedAt - r.joinedAt
        || l.id.localeCompare(r.id));
    const sizes = ticket.queueId === "team" ? [4, 3, 2].filter((s) => ticket.teamSizes.includes(s)) : [1];
    for (const size of sizes) {
      const required = size * 2;
      if (sizeOf(ticket) > size) continue;
      const group = [ticket];
      let players = sizeOf(ticket);
      for (const c of candidates) {
        if (ticket.queueId === "team" && !c.teamSizes.includes(size)) continue;
        if (sizeOf(c) > size || players + sizeOf(c) > required) continue;
        if (!group.every((p) => ratingsInRange(p, c, now))) continue;
        if (this.catalog.shared([...group, c].map((p) => p.prefs)).length === 0) continue;
        group.push(c);
        players += sizeOf(c);
        if (players === required) break;
      }
      if (players !== required) continue;
      const host = [...group].sort((l, r) => l.joinedAt - r.joinedAt || l.id.localeCompare(r.id))[0];
      const teams = balancedUnitTeams(group, host, size);
      if (!teams) continue;  // the parties do not split into two even teams
      const map = this.catalog.select(group.map((p) => p.prefs), this.random);
      if (!map) continue;
      return { queueId: ticket.queueId, lane: laneOf(ticket), teamSize: size, participants: group, host, teams, map };
    }
    return null;
  }

  tryFfa(ticket, now) {
    const candidates = this.waiting(now).filter((c) => c.playerId !== ticket.playerId && !c.matchId && c.queueId === "ffa" && laneOf(c) === laneOf(ticket))
      .sort((l, r) => Math.abs(l.rating - ticket.rating) - Math.abs(r.rating - ticket.rating) || l.joinedAt - r.joinedAt);
    const group = [ticket];
    for (const c of candidates) {
      if (!group.every((p) => ratingsInRange(p, c, now))) continue;
      if (this.catalog.shared([...group, c].map((p) => p.prefs)).length === 0) continue;
      group.push(c);
      if (group.length === this.ffaPlayers) break;
    }
    if (group.length !== this.ffaPlayers) return null;
    const host = [...group].sort((l, r) => l.joinedAt - r.joinedAt || l.id.localeCompare(r.id))[0];
    const map = this.catalog.select(group.map((p) => p.prefs), this.random);
    if (!map) return null;
    const ordered = [host, ...group.filter((p) => p !== host)];
    return { queueId: "ffa", lane: laneOf(ticket), teamSize: 1, participants: group, host, teams: ordered.map((p) => [p]), map };
  }
}
