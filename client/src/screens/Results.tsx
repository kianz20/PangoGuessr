import { RevealMap } from '../components/RevealMap';
import type { ResultsView } from '../useRoom';

/** Distances read better rounded to something a human would say out loud. */
function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function Results({
  results,
  youId,
  isHost,
  totalRounds,
  onAdvance,
}: {
  results: ResultsView;
  youId: string;
  isHost: boolean;
  totalRounds: number;
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
          {yourRank && <span className="yours__rank">#{yourRank.rank}</span>}
        </section>
      )}

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
                {result.distanceKm === null ? 'no guess' : formatDistance(result.distanceKm)}
              </span>
              <span className="row__points">+{result.points}</span>
            </li>
          ))}
        </ul>

        <h2 className="board__title">Overall</h2>
        <ul className="board__list">
          {results.leaderboard.map((row) => (
            <li key={row.playerId} className={`row${row.playerId === youId ? ' row--you' : ''}`}>
              <span className="row__rank">{row.rank}</span>
              <span className="row__name">{row.name}</span>
              <span className="row__points">{row.score.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="results__actions">
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
