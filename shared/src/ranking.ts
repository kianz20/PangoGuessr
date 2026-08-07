export type Ranked<T> = { rank: number; entry: T };

/**
 * Standard competition ranking (§4): equal totals share a rank, the next rank skips by the
 * number tied. Two tied for 1st means the next player is rank 3, and the podium's step 2
 * renders empty.
 *
 * One function for both the leaderboard and the podium, so they can never disagree.
 */
export function rankByScore<T>(entries: readonly T[], scoreOf: (e: T) => number): Ranked<T>[] {
  const sorted = [...entries].sort((a, b) => scoreOf(b) - scoreOf(a));

  const ranked: Ranked<T>[] = [];
  let rank = 0;
  let previousScore: number | null = null;

  sorted.forEach((entry, index) => {
    const score = scoreOf(entry);
    if (previousScore === null || score !== previousScore) {
      rank = index + 1; // skips by however many tied above
      previousScore = score;
    }
    ranked.push({ rank, entry });
  });

  return ranked;
}
