import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { LeaderboardRow, RoundSummary } from '@pangoguessr/shared';
import { Avatar } from '../components/Avatar';
import { Awards, type Award } from '../components/Awards';
import { SoundToggle } from '../components/Brand';
import { RecapMap } from '../components/RecapMap';
import { confetti } from '../confetti';
import { formatDistance, ordinal } from '../format';
import { prefersReducedMotion, useAfter } from '../motion';
import type { ColorOf } from '../players';
import { play } from '../sound';
import type { FinalView } from '../useRoom';

/**
 * 3rd, then 2nd, then a held breath, then 1st — the payoff for the whole game should feel like
 * an event (§4). Everything below the podium waits for the winner, so it can't give them away.
 */
const THIRD_AT = 900;
const SECOND_AT = 1_900;
const FIRST_AT = 4_000;
const REST_AT = FIRST_AT + 900;
const STEP_ORDER = [3, 2, 1] as const;

export function GameOver({
  final,
  youId,
  isHost,
  colorOf,
  onPlayAgain,
}: {
  final: FinalView;
  youId: string;
  isHost: boolean;
  colorOf: ColorOf;
  onPlayAgain: () => void;
}) {
  const { leaderboard, rounds } = final;
  const [revealed, setRevealed] = useState(() => (prefersReducedMotion() ? 3 : 0));
  const settled = useAfter(REST_AT);
  const winnerStepRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const you = leaderboard.find((row) => row.playerId === youId);
  const youWon = you?.rank === 1;

  useEffect(() => {
    const celebrate = () => {
      play('fanfare');
      // Everyone gets a burst from the top step; the winner's own phone gets the lot.
      const step = winnerStepRef.current?.getBoundingClientRect();
      const x = step ? (step.left + step.width / 2) / window.innerWidth : 0.5;
      const y = step ? step.top / window.innerHeight : 0.35;
      confetti(
        youWon
          ? [
              { x: 0, y: 1, count: 90, angle: 32, spread: 30, speed: 1_500 },
              { x: 1, y: 1, count: 90, angle: -32, spread: 30, speed: 1_500 },
              { x, y, count: 60, spread: 110 },
            ]
          : [{ x, y, count: 70, spread: 100 }],
        { durationMs: youWon ? 5_000 : 3_400 },
      );
    };

    if (prefersReducedMotion()) {
      play('fanfare');
      return;
    }
    const timers = [
      window.setTimeout(() => {
        setRevealed(1);
        play('step', { step: 0 });
      }, THIRD_AT),
      window.setTimeout(() => {
        setRevealed(2);
        play('step', { step: 1 });
      }, SECOND_AT),
      window.setTimeout(() => play('drumroll'), SECOND_AT + 500),
      window.setTimeout(() => {
        setRevealed(3);
        celebrate();
      }, FIRST_AT),
    ];
    return () => timers.forEach(window.clearTimeout);
    // Once per podium: the payload doesn't change underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Always three steps, no variable-height logic. Ties share a rank, so a step can hold more
  // than one player and a step can be empty — both are normal, not special cases (§4).
  const stepFor = (rank: number) => leaderboard.filter((row) => row.rank === rank);
  const rest = leaderboard.filter((row) => row.rank > 3);
  const revealedRanks: number[] = STEP_ORDER.slice(0, revealed);
  const suspense = revealed === 2;

  const awards = useMemo(() => gameAwards(rounds), [rounds]);

  return (
    <main className="screen screen--over">
      <header className="over__head">
        <div className="results__tools">
          <SoundToggle compact />
        </div>
        <h1 className="over__title">{suspense ? 'And the winner is…' : 'Final standings'}</h1>
      </header>

      <section className="podium" aria-label="Podium">
        {[2, 1, 3].map((rank) => {
          const occupants = stepFor(rank);
          const shown = revealedRanks.includes(rank);
          return (
            <div
              key={rank}
              ref={rank === 1 ? winnerStepRef : undefined}
              className={`step step--${rank}${shown ? ' step--shown' : ''}${
                rank === 1 && suspense ? ' step--suspense' : ''
              }`}
              data-empty={occupants.length === 0}
            >
              <div className="step__players">
                {occupants.map((row) => (
                  <div
                    key={row.playerId}
                    className={`step__player${row.playerId === youId ? ' step__player--you' : ''}`}
                  >
                    {rank === 1 && <Crown />}
                    <Avatar
                      name={row.name}
                      color={colorOf(row.playerId)}
                      size="lg"
                      you={row.playerId === youId}
                    />
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

      <div className={`over__after${settled ? ' is-shown' : ''}`}>
        {you && <YourFinish you={you} leaderboard={leaderboard} rounds={rounds} youId={youId} colorOf={colorOf} />}

        {rest.length > 0 && (
          <ul className="board__list over__rest">
            {rest.map((row, i) => (
              <li
                key={row.playerId}
                className={`row${row.playerId === youId ? ' row--you' : ''}`}
                style={{ '--i': i } as CSSProperties}
              >
                <span className="row__rank">{row.rank}</span>
                <Avatar name={row.name} color={colorOf(row.playerId)} size="sm" />
                <span className="row__name">{row.name}</span>
                <span className="row__points">{row.score.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}

        {awards.length > 0 && <h2 className="board__title over__subtitle">The game’s awards</h2>}
        <Awards awards={awards} youId={youId} colorOf={colorOf} shown={settled} label="The game’s awards" />

        {rounds.length > 0 && (
          <section className="recap" aria-label="Your game, round by round">
            <h2 className="board__title over__subtitle">Your game</h2>
            {/* Built once the podium is done, so it opens at its real size. */}
            {settled && <RecapMap rounds={rounds} youId={youId} focus={focus} />}
            <ol className="recap__list">
              {rounds.map((round) => {
                const mine = round.results.find((r) => r.playerId === youId);
                const selected = focus === round.roundIndex;
                return (
                  <li key={round.roundIndex}>
                    <button
                      type="button"
                      className={`recap__round${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => setFocus(selected ? null : round.roundIndex)}
                    >
                      <span className="recap__number">{round.roundIndex + 1}</span>
                      <span className="row__main">
                        <span className="row__name">{round.locationName}</span>
                        <span className="row__meta">
                          {mine?.distanceKm == null ? 'No guess' : `${formatDistance(mine.distanceKm)} off`}
                        </span>
                      </span>
                      <span className="row__points">+{(mine?.points ?? 0).toLocaleString()}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>

      <footer className="over__actions results__actions--sticky">
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

/**
 * Everyone's own line, so the screen isn't only about the top three: where you finished, and the
 * round you'll be telling people about.
 */
function YourFinish({
  you,
  leaderboard,
  rounds,
  youId,
  colorOf,
}: {
  you: LeaderboardRow;
  leaderboard: LeaderboardRow[];
  rounds: RoundSummary[];
  youId: string;
  colorOf: ColorOf;
}) {
  const tied = leaderboard.filter((row) => row.rank === you.rank).length > 1;
  const line =
    you.rank === 1
      ? tied
        ? 'You tied for the win!'
        : 'You won!'
      : `You ${tied ? 'tied for' : 'finished'} ${ordinal(you.rank)} of ${leaderboard.length}`;

  const best = rounds
    .map((round) => ({ round, result: round.results.find((r) => r.playerId === youId) }))
    .filter((entry) => (entry.result?.points ?? 0) > 0)
    .sort((a, b) => b.result!.points - a.result!.points)[0];

  return (
    <section className={`finish${you.rank === 1 ? ' finish--won' : ''}`}>
      <Avatar name={you.name} color={colorOf(you.playerId)} size="lg" you />
      <div className="finish__main">
        <p className="finish__line">{line}</p>
        <p className="finish__meta">
          {you.score.toLocaleString()} points
          {best &&
            ` · best round: ${best.round.locationName}, +${best.result!.points.toLocaleString()}`}
        </p>
      </div>
    </section>
  );
}

function Crown() {
  return (
    <svg className="crown" viewBox="0 0 24 16" aria-hidden>
      <path d="M2 14 L3.5 4 L8.5 9 L12 2 L15.5 9 L20.5 4 L22 14 Z" />
    </svg>
  );
}

/**
 * The game's stories, from every round at once. Like the round awards, only accuracy is ever
 * scored (§6) — "Quickest" is bragging rights.
 */
function gameAwards(rounds: RoundSummary[]): Award[] {
  const guesses = rounds.flatMap((round) =>
    round.results
      .filter((r) => r.distanceKm !== null && r.elapsedMs !== null)
      .map((r) => ({ ...r, distanceKm: r.distanceKm!, elapsedMs: r.elapsedMs!, round })),
  );
  // A game of one isn't a contest.
  if (new Set(guesses.map((g) => g.playerId)).size < 2) return [];

  // The earliest round wins a tie, so the award doesn't depend on sort order.
  const best = guesses.reduce((a, b) => (b.points > a.points ? b : a));
  const miss = guesses.reduce((a, b) => (b.distanceKm > a.distanceKm ? b : a));

  // An average over enough rounds to mean something: one fast guess isn't a habit.
  const times = new Map<string, { name: string; total: number; count: number }>();
  for (const g of guesses) {
    const entry = times.get(g.playerId) ?? { name: g.name, total: 0, count: 0 };
    entry.total += g.elapsedMs;
    entry.count++;
    times.set(g.playerId, entry);
  }
  const needed = Math.ceil(rounds.length / 2);
  const quickest = [...times.entries()]
    .filter(([, t]) => t.count >= needed)
    .map(([playerId, t]) => ({ playerId, name: t.name, average: t.total / t.count }))
    .sort((a, b) => a.average - b.average)[0];

  const awards: Award[] = [
    {
      id: 'best',
      icon: '🎯',
      title: 'Best round',
      playerId: best.playerId,
      name: best.name,
      detail: `+${best.points.toLocaleString()} · ${best.round.locationName}`,
    },
    {
      id: 'miss',
      icon: '🧭',
      title: 'Biggest miss',
      playerId: miss.playerId,
      name: miss.name,
      detail: `${formatDistance(miss.distanceKm)} off`,
    },
  ];
  if (quickest) {
    awards.push({
      id: 'quickest',
      icon: '⚡',
      title: 'Quickest',
      playerId: quickest.playerId,
      name: quickest.name,
      detail: `${(quickest.average / 1000).toFixed(1)}s a guess`,
    });
  }
  return awards;
}
