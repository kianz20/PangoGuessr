import { useEffect, useState } from 'react';

/**
 * Something to read while nothing is happening: the server waking up, or a game running that
 * they'll join when it ends. Tips that make you better at this game, and facts about the planet
 * you're about to be dropped somewhere on.
 */
const FACTS: { kind: 'Tip' | 'Did you know?'; text: string }[] = [
  { kind: 'Tip', text: 'Which side of the road are they driving on? Left-hand traffic narrows it down fast — the UK, Japan, Australia, India, southern Africa.' },
  { kind: 'Did you know?', text: 'Pangolins are the only mammals covered in scales.' },
  { kind: 'Tip', text: 'Yellow centre lines are the norm across the Americas. Most of Europe paints them white.' },
  { kind: 'Did you know?', text: 'Russia spans 11 time zones.' },
  { kind: 'Tip', text: 'If the midday sun is in the north, you’re probably in the southern hemisphere.' },
  { kind: 'Did you know?', text: 'Chimborazo in Ecuador, not Everest, is the point farthest from the centre of the Earth.' },
  { kind: 'Tip', text: 'Look past the road: bollards, power poles and number plates all change from country to country.' },
  { kind: 'Did you know?', text: 'Australia is wider than the Moon.' },
  { kind: 'Tip', text: 'Shop signs are a gift. Even just the alphabet rules out most of the world.' },
  { kind: 'Did you know?', text: '“Pangolin” comes from the Malay pengguling: “one who rolls up”.' },
  { kind: 'Did you know?', text: 'Canada has the longest coastline of any country.' },
  { kind: 'Did you know?', text: 'Lake Baikal holds about a fifth of the world’s unfrozen fresh water.' },
  { kind: 'Did you know?', text: 'Nepal’s is the only national flag that isn’t a rectangle.' },
  { kind: 'Did you know?', text: 'Istanbul sits on two continents.' },
  { kind: 'Did you know?', text: 'Vatican City is the world’s smallest country, at under half a square kilometre.' },
  { kind: 'Did you know?', text: 'The nearest people to Point Nemo, the most remote spot in the ocean, are often astronauts on the ISS.' },
  { kind: 'Did you know?', text: 'Alaska is the most northern, western and eastern state in the USA.' },
  { kind: 'Did you know?', text: 'Africa is the only continent in all four hemispheres.' },
];

/** Long enough to read the longest one twice over, not so long it feels stuck. */
const FACT_MS = 7_000;

export function FunFacts() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * FACTS.length));
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % FACTS.length), FACT_MS);
    return () => window.clearInterval(timer);
  }, []);
  const fact = FACTS[index]!;

  return (
    // Re-keyed per fact, so each one fades in rather than swapping under the reader's eyes.
    <aside key={index} className="fun-fact" aria-live="polite">
      <p className="fun-fact__kind">{fact.kind}</p>
      <p className="fun-fact__text">{fact.text}</p>
    </aside>
  );
}

/** How long a cold start usually takes on the free tier (§9). */
const EXPECTED_MS = 30_000;

/**
 * An estimate, not a measurement — there's no way to know how far along a waking server is. It
 * eases towards the end and never quite gets there, so a slow wake looks slow rather than stuck
 * at 100%. `alreadyMs` is the wait before anyone called it a cold start.
 */
export function WakeProgress({ alreadyMs }: { alreadyMs: number }) {
  const [startedAt] = useState(() => Date.now() - alreadyMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = now - startedAt;
  // About 85% at the usual 30 seconds, still creeping at a minute.
  const fraction = 0.96 * (1 - Math.exp((-2 * elapsed) / EXPECTED_MS));
  const seconds = Math.round(elapsed / 1000);

  return (
    <div className="wake">
      <div
        className="wake__bar"
        role="progressbar"
        aria-label="Waking the server"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div className="wake__fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="wake__time">
        {seconds < 45 ? `${seconds}s — usually about 30` : `${seconds}s — a slow one, hang on`}
      </p>
    </div>
  );
}
