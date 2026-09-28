import { useMemo, useRef, type CSSProperties } from 'react';
import { rankByScore } from '@pangoguessr/shared';
import type { GuessResult, LeaderboardRow } from '@pangoguessr/shared';
import { Avatar } from '../components/Avatar';
import { Awards, type Award } from '../components/Awards';
import { SoundToggle } from '../components/Brand';
import { CancelGame } from '../components/CancelGame';
import { RevealMap, revealSchedule } from '../components/RevealMap';
import { formatDistance } from '../format';
import { useAfter, useCountUp, useFlip } from '../motion';
import type { ColorOf } from '../players';
import type { ResultsView } from '../useRoom';

/** For someone with no pin on the map, whose points (0) have nothing to wait for. */
const YOURS_WITHOUT_PIN_MS = 600;

/**
 * Direction only, no number: the question between rounds is "am I climbing or sliding",
 * and a bare chevron answers it without adding a column to read.
 */
function RankDelta({ value }: { value: number }) {
  if (!value) return null;
  const up = value > 0;
  return (
    <span
      className={`delta delta--${up ? 'up' : 'down'}`}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(value)} since last round`}
      aria-label={`${up ? 'up' : 'down'} ${Math.abs(value)} places`}
    >
      {up ? '▲' : '▼'}
    </span>
  );
}

/**
 * Something for the room to cheer or jeer. Guess time finally gets a job here — it is recorded
 * and shown, but never scored (§6), so "Quickest" is bragging rights and nothing more.
 */
function roundAwards(results: GuessResult[]): Award[] {
  const guessed = results.filter(
    (r): r is GuessResult & { distanceKm: number; elapsedMs: number } =>
      r.distanceKm !== null && r.elapsedMs !== null,
  );
  // One guess isn't a contest.
  if (guessed.length < 2) return [];

  const byDistance = [...guessed].sort((a, b) => a.distanceKm - b.distanceKm);
  const closest = byDistance[0]!;
  const lost = byDistance[byDistance.length - 1]!;
  const quickest = [...guessed].sort((a, b) => a.elapsedMs - b.elapsedMs)[0]!;

  return [
    {
      id: 'closest',
      icon: '🎯',
      title: 'Closest',
      playerId: closest.playerId,
      name: closest.name,
      detail: formatDistance(closest.distanceKm),
    },
    {
      id: 'lost',
      icon: '🧭',
      title: 'Most lost',
      playerId: lost.playerId,
      name: lost.name,
      detail: `${formatDistance(lost.distanceKm)} off`,
    },
    {
      id: 'quickest',
      icon: '⚡',
      title: 'Quickest',
      playerId: quickest.playerId,
      name: quickest.name,
      detail: `${(quickest.elapsedMs / 1000).toFixed(1)}s`,
    },
  ];
}

export function Results({
  results,
  youId,
  isHost,
  totalRounds,
  rankDeltas,
  colorOf,
  onAdvance,
  onCancelGame,
}: {
  results: ResultsView;
  youId: string;
  isHost: boolean;
  totalRounds: number;
  rankDeltas: Record<string, number>;
  colorOf: ColorOf;
  onAdvance: () => void;
  onCancelGame: () => void;
}) {
  const you = results.results.find((r) => r.playerId === youId);
  const yourRank = results.leaderboard.find((r) => r.playerId === youId);
  const awards = useMemo(() => roundAwards(results.results), [results]);

  /**
   * Everything below the map waits for it: your points count up as your pin lands, and the
   * awards and the new standings appear once the last pin is in. Otherwise the boards would
   * give away the ending the map is building up to.
   */
  const schedule = useMemo(() => revealSchedule(results.results), [results]);
  const revealed = useAfter(schedule.doneAt);
  const yourPoints = useCountUp(you?.points ?? 0, {
    delayMs: schedule.landsAt.get(youId) ?? YOURS_WITHOUT_PIN_MS,
    durationMs: 1_000,
  });

  return (
    <main className="screen screen--results">
      <header className="results__head">
        <div className="results__tools">
          <SoundToggle compact />
        </div>
        <p className="results__round">
          Round {results.roundIndex + 1}/{totalRounds}
        </p>
        <h1 className="results__place">{results.locationName}</h1>
      </header>

      {/* The map is the dominant element, with the leaderboard scrolling beneath it (§4). */}
      <RevealMap
        actual={results.actual}
        results={results.results}
        youId={youId}
        colorOf={colorOf}
      />

      {you && (
        <section className="yours">
          <span className="yours__label">You</span>
          <span className="yours__distance">
            {you.distanceKm === null ? 'No guess' : formatDistance(you.distanceKm)}
            {you.elapsedMs !== null && (
              <span className="yours__time"> in {Math.round(you.elapsedMs / 1000)}s</span>
            )}
          </span>
          <span className="yours__points">+{yourPoints.toLocaleString()}</span>
          {yourRank && (
            <span className={`yours__rank${revealed ? ' is-shown' : ''}`}>
              #{yourRank.rank}
              <RankDelta value={rankDeltas[youId] ?? 0} />
            </span>
          )}
        </section>
      )}

      <Awards
        awards={awards}
        youId={youId}
        colorOf={colorOf}
        shown={revealed}
        label="This round’s awards"
      />

      {/* Side by side rather than stacked: 20 players is 40 rows in one column, which is
          three screens of scrolling on a phone before the host can reach "Next" (§8). */}
      <div className="boards">
        <section className="board">
          <h2 className="board__title">This round</h2>
          <ul className={`board__list board__list--staggered${revealed ? ' is-shown' : ''}`}>
            {results.results.map((result, i) => (
              <li
                key={result.playerId}
                className={`row${result.playerId === youId ? ' row--you' : ''}`}
                style={{ '--i': i } as CSSProperties}
              >
                <Avatar name={result.name} color={colorOf(result.playerId)} size="sm" />
                {/* Stacked: half a phone's width can't fit a name beside the distance. */}
                <span className="row__main">
                  <span className="row__name">{result.name}</span>
                  <span className="row__meta">
                    {result.distanceKm === null ? 'No guess' : formatDistance(result.distanceKm)}
                  </span>
                </span>
                <span className="row__points">+{result.points}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="board">
          <h2 className="board__title">Overall</h2>
          <OverallBoard
            leaderboard={results.leaderboard}
            results={results.results}
            youId={youId}
            colorOf={colorOf}
            rankDeltas={rankDeltas}
            settled={revealed}
          />
        </section>
      </div>

      <p className="attribution">
        Place names ©{' '}
        <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
          GeoNames
        </a>{' '}
        (CC BY 4.0)
      </p>

      {/* Sticky: the whole room is waiting on this button, so the host must never have to
          scroll to find it. */}
      <footer className="results__actions results__actions--sticky">
        {isHost ? (
          // Only the host's client renders these, and the server re-checks isHost anyway (§4).
          <div className="results__buttons">
            <button className="button button--primary" type="button" onClick={onAdvance}>
              {results.isFinalRound ? 'See the podium' : 'Next round'}
            </button>
            <CancelGame onCancel={onCancelGame} />
          </div>
        ) : (
          <p className="hint">
            Waiting for the host to
            {results.isFinalRound ? ' show the podium.' : ' start the next round.'}
          </p>
        )}
      </footer>
    </main>
  );
}

/**
 * The standings as they were before this round, until the reveal finishes — then each row
 * slides to its new place while its total counts up by what it just scored.
 */
function OverallBoard({
  leaderboard,
  results,
  youId,
  colorOf,
  rankDeltas,
  settled,
}: {
  leaderboard: LeaderboardRow[];
  results: GuessResult[];
  youId: string;
  colorOf: ColorOf;
  rankDeltas: Record<string, number>;
  settled: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Worked out from this round's payload alone, so a reload onto this screen still animates.
  const before = useMemo(() => {
    const scored = new Map(results.map((r) => [r.playerId, r.points]));
    const previous = leaderboard.map((row) => ({
      ...row,
      score: row.score - (scored.get(row.playerId) ?? 0),
    }));
    // The sort is stable, so equal totals keep today's order — after round 1, when everyone
    // was level on 0, nothing moves at all.
    return rankByScore(previous, (row) => row.score).map(({ rank, entry }) => ({ ...entry, rank }));
  }, [leaderboard, results]);
  const scoreBefore = useMemo(() => new Map(before.map((r) => [r.playerId, r.score])), [before]);

  const rows = settled ? leaderboard : before;
  useFlip(listRef, rows.map((row) => row.playerId).join(' '));

  return (
    <ul ref={listRef} className="board__list">
      {rows.map((row) => (
        <li
          key={row.playerId}
          data-flip-id={row.playerId}
          className={`row${row.playerId === youId ? ' row--you' : ''}`}
        >
          <span className="row__rank">{row.rank}</span>
          {settled && <RankDelta value={rankDeltas[row.playerId] ?? 0} />}
          <Avatar name={row.name} color={colorOf(row.playerId)} size="sm" />
          <span className="row__main">
            <span className="row__name">{row.name}</span>
            <Total from={scoreBefore.get(row.playerId) ?? 0} to={row.score} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Total({ from, to }: { from: number; to: number }) {
  const value = useCountUp(to, { from, durationMs: 900 });
  return <span className="row__total">{value.toLocaleString()}</span>;
}
