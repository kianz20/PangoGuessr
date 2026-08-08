/**
 * Verifies a Street View setup end to end without starting the game:
 *
 *   npm run check:imagery
 *
 * Uses only **metadata** calls, which are free — so running this cannot cost anything and
 * cannot eat into the panorama allowance (§7). It reports a per-zone hit rate, which is the
 * same signal the admin zone editor will show later: a zone under ~30% is mostly ocean and
 * should be tightened.
 */
import { loadDotEnv } from '../src/env';
import { googleMetadataFetcher, type SampleStats } from '../src/streetview';
import { ZONES, randomPointIn } from '../src/zones';

loadDotEnv();

const key = process.env.GOOGLE_MAPS_SERVER_KEY;
if (!key) {
  console.error('No GOOGLE_MAPS_SERVER_KEY found. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

/**
 * Metadata is free of *charge*, but it still consumes the Street View Static API's daily
 * quota — so this script is not free in quota terms. 4 per zone is enough to spot a dud
 * zone without eating a day's allowance.
 */
const SAMPLES_PER_ZONE = 4;
const stats: SampleStats = { metadataCalls: 0, misses: 0 };
const fetcher = googleMetadataFetcher(key, stats);

console.log(`Testing ${ZONES.length} zones, ${SAMPLES_PER_ZONE} samples each (metadata is free)\n`);

let totalHits = 0;
let totalTries = 0;

for (const zone of ZONES) {
  let hits = 0;
  for (let i = 0; i < SAMPLES_PER_ZONE; i++) {
    try {
      const hit = await fetcher(randomPointIn(zone), 5000);
      if (hit) hits++;
    } catch (err) {
      // A key or quota problem is fatal for every zone, so stop rather than printing it 14
      // times.
      console.error(`\n${zone.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('\nCheck: billing enabled, Street View Static API enabled, key not');
      console.error('referrer-restricted (the server key must have no application restriction).');
      process.exit(1);
    }
  }
  totalHits += hits;
  totalTries += SAMPLES_PER_ZONE;

  const rate = Math.round((hits / SAMPLES_PER_ZONE) * 100);
  const flag = rate < 30 ? '  <- mostly ocean, consider tightening' : '';
  const bar = '#'.repeat(hits).padEnd(SAMPLES_PER_ZONE, '.');
  console.log(`  ${zone.name.padEnd(22)} ${bar} ${String(rate).padStart(3)}%${flag}`);
}

console.log(
  `\nOverall hit rate ${Math.round((totalHits / totalTries) * 100)}% ` +
    `over ${stats.metadataCalls} free metadata calls.`,
);
console.log('Street View is configured correctly.');
