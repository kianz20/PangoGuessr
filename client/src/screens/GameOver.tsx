import { useEffect, useState } from 'react';
import type { LeaderboardRow } from '@pangoguessr/shared';

/** 3rd, then 2nd, then 1st — the payoff for the whole game should feel like an event (§4). */
const REVEAL_STEP_MS = 900;
const STEP_ORDER = [3, 2, 1] as const;

export function GameOver({
  leaderboard,
  youId,
  isHost,
  onPlayAgain,
}: {
  leaderboard: LeaderboardRow[];
  youId: string;
  isHost: boolean;
  onPlayAgain: () => void;
}) {
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    const timers = STEP_ORDER.map((_, i) =>
      window.setTimeout(() => setRevealed(i + 1), (i + 1) * REVEAL_STEP_MS),
    );
    return () => timers.forEach(window.clearTimeout);
  }, []);

  // Always three steps, no variable-height logic. Ties share a rank, so a step can hold more
  // than one player and a step can be empty — both are normal, not special cases (§4).
  const stepFor = (rank: number) => leaderboard.filter((row) => row.rank === rank);
  const rest = leaderboard.filter((row) => row.rank > 3);
  const revealedRanks = STEP_ORDER.slice(0, revealed);

  return (
    <main className="screen screen--over">
      <h1 className="over__title">Final standings</h1>

      <section className="podium" aria-label="Podium">
        {[2, 1, 3].map((rank) => {
          const occupants = stepFor(rank);
          const shown = revealedRanks.includes(rank as 1 | 2 | 3);
          return (
            <div
              key={rank}
              className={`step step--${rank}${shown ? ' step--shown' : ''}`}
              data-empty={occupants.length === 0}
            >
              <div className="step__players">
                {occupants.map((row) => (
                  <div
                    key={row.playerId}
                    className={`step__player${row.playerId === youId ? ' step__player--you' : ''}`}
                  >
                    <span className="step__name">{row.name}</span>
                    <span className="step__score">{row.score.toLocaleString()}</span>
                  </div>
                ))}
              </div>
              <div className="step__block">
                <span className="step__rank">{rank}</span>
              </div>
            </div>
          );
        })}
      </section>

      {rest.length > 0 && (
        <ul className="board__list over__rest">
          {rest.map((row) => (
            <li key={row.playerId} className={`row${row.playerId === youId ? ' row--you' : ''}`}>
              <span className="row__rank">{row.rank}</span>
              <span className="row__name">{row.name}</span>
              <span className="row__points">{row.score.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}

      <footer className="over__actions">
        {isHost ? (
          <button className="button button--primary" type="button" onClick={onPlayAgain}>
            Play again
          </button>
        ) : (
          <p className="hint">Waiting for the host to start another game.</p>
        )}
      </footer>
    </main>
  );
}
