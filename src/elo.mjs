// Elo ratings. The team rule (average rating of each side, K = 32, the loser loses what the winner gains) is
// empire-league's recordVerifiedMatchResult (src/database.mjs, MIT, see LICENSE.empire-league); a 1v1 is the same rule
// with teams of one. FFA (not rated upstream) is rated pairwise by final placing, K scaled by 1 / (n - 1) so a whole
// FFA moves a rating about as much as one 1v1.

export const K_FACTOR = 32;
export const START_RATING = 1000;

export function expectedScore(rating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

const average = (ratings) => ratings.reduce((sum, value) => sum + value, 0) / ratings.length;

// winners / losers: arrays of ratings. Returns the change for every winner (the losers get the negative).
export function teamRatingChange(winners, losers, k = K_FACTOR) {
  if (!winners.length || !losers.length) throw new Error("both sides need at least one player");
  const expectedWinner = expectedScore(average(winners), average(losers));
  return Math.round(k * (1 - expectedWinner));
}

// players: [{ id, rating, place }] (place 1 = best; equal places draw). Returns Map id -> change.
export function ffaRatingChanges(players, k = K_FACTOR) {
  if (players.length < 2) throw new Error("an FFA needs at least two players");
  const kPair = k / (players.length - 1);
  const changes = new Map();
  for (const player of players) {
    let delta = 0;
    for (const other of players) {
      if (other === player) continue;
      const score = player.place < other.place ? 1 : player.place > other.place ? 0 : 0.5;
      delta += kPair * (score - expectedScore(player.rating, other.rating));
    }
    changes.set(player.id, Math.round(delta));
  }
  return changes;
}

// The divisions empire-league shows on a profile (auth.mjs divisionForRating).
export function divisionForRating(rating) {
  if (rating >= 2200) return "Grandmaster";
  if (rating >= 1800) return "Master";
  if (rating >= 1400) return "Diamond";
  if (rating >= 1200) return "Platinum";
  if (rating >= 1000) return "Gold";
  if (rating >= 800) return "Silver";
  if (rating >= 501) return "Bronze";
  return "Copper";
}
