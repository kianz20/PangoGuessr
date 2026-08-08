import { RevealMap } from '../components/RevealMap';
import type { ResultsView } from '../useRoom';

/** Distances read better rounded to something a human would say out loud. */
function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

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

export function Results({
  results,
  youId,
  isHost,
  totalRounds,
  rankDeltas,
  onAdvance,
}: {
  results: ResultsView;
  youId: string;
  isHost: boolean;
  totalRounds: number;
  rankDeltas: Record<string, number>;
  onAdvance: () => void;
}) {
  const you = results.results.find((r) => r.playerId === youId);
  const yourRank = results.leaderboard.find((r) => r.playerId === youId);

  return (
    <main className="screen screen--results">
      <header className="results__head">
        <p className="results__round">
          Round {results.roundIndex + 1}/{totalRounds}
        </p>
        <h1 className="results__place">{results.locationName}</h1>
      </header>

      {/* The map is the dominant element, with the leaderboard scrolling beneath it (§4). */}
      <RevealMap actual={results.actual} results={results.results} youId={youId} />

      {you && (
        <section className="yours">
          <span className="yours__label">You</span>
          <span className="yours__distance">
            {you.distanceKm === null ? 'No guess' : formatDistance(you.distanceKm)}
          </span>
          <span className="yours__points">+{you.points}</span>
          {yourRank && (
            <span className="yours__rank">
              #{yourRank.rank}
              <RankDelta value={rankDeltas[youId] ?? 0} />
            </span>
          )}
        </section>
      )}

      {/* Side by side rather than stacked: 20 players is 40 rows in one column, which is
          three screens of scrolling on a phone before the host can reach "Next" (§8). */}
      <div className="boards">
        <section className="board">
          <h2 className="board__title">This round</h2>
          <ul className="board__list">
            {results.results.map((result) => (
              <li
                key={result.playerId}
                className={`row${result.playerId === youId ? ' row--you' : ''}`}
              >
                <span className="row__name">{result.name}</span>
                <span className="row__meta">
                  {result.distanceKm === null ? '—' : formatDistance(result.distanceKm)}
                </span>
                <span className="row__points">+{result.points}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="board">
          <h2 className="board__title">Overall</h2>
          <ul className="board__list">
            {results.leaderboard.map((row) => (
              <li key={row.playerId} className={`row${row.playerId === youId ? ' row--you' : ''}`}>
                <span className="row__rank">{row.rank}</span>
                <RankDelta value={rankDeltas[row.playerId] ?? 0} />
                <span className="row__name">{row.name}</span>
                <span className="row__points">{row.score.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Sticky: the whole room is waiting on this button, so the host must never have to
          scroll to find it. */}
      <footer className="results__actions results__actions--sticky">
        {isHost ? (
          // Only the host's client renders this, and the server re-checks isHost anyway (§4).
          <button className="button button--primary" type="button" onClick={onAdvance}>
            {results.isFinalRound ? 'See the podium' : 'Next round'}
          </button>
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
