/**
 * Builds the bundled place-name dataset:
 *
 *   node server/scripts/build-cities.mjs
 *
 * Downloads GeoNames' cities1000 (every settlement over 1,000 people, ~140k of them) plus the
 * admin-region and country name tables, trims them to the four fields the reveal needs, and
 * writes a gzipped table (name, lat, lng, country, region, population) to server/data/. That file is committed, so the running server never
 * makes a network call to name a location — no key, no quota, no rate limit, no latency.
 *
 * Data © GeoNames, CC BY 4.0 (https://www.geonames.org/). Attribution is required and shown
 * on the reveal screen.
 */
import { gzipSync, inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(fileURLToPath(import.meta.url), '../../data');
const OUT_FILE = path.join(OUT_DIR, 'places.tsv.gz');

/** Minimal single-entry ZIP reader — GeoNames only ships .zip, and Node has no unzip. */
function unzipSingleFile(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip file');
  const method = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  if (method === 0) return buffer.subarray(start);
  // Z_SYNC_FLUSH so the trailing central directory doesn't count as a corrupt stream.
  return inflateRawSync(buffer.subarray(start), { finishFlush: 2 });
}

async function fetchText(url, { zipped = false } = {}) {
  process.stdout.write(`  fetching ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return (zipped ? unzipSingleFile(buffer) : buffer).toString('utf8');
}

// countryInfo: ISO code -> country name.
const countryText = await fetchText('https://download.geonames.org/export/dump/countryInfo.txt');
const countries = new Map();
for (const line of countryText.split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split('\t');
  if (cols[0] && cols[4]) countries.set(cols[0], cols[4]);
}

// admin1: "NZ.OTA" -> "Otago".
const adminText = await fetchText('https://download.geonames.org/export/dump/admin1CodesASCII.txt');
const admins = new Map();
for (const line of adminText.split('\n')) {
  const cols = line.split('\t');
  if (cols[0] && cols[1]) admins.set(cols[0], cols[1]);
}

const citiesText = await fetchText('https://download.geonames.org/export/dump/cities1000.zip', {
  zipped: true,
});

// GeoNames column order: geonameid, name, asciiname, alternatenames, lat, lng, feature class,
// feature code, country code, cc2, admin1, admin2, ...
const rows = [];
const countryIndex = new Map();
const adminIndex = new Map();
const countryList = [];
const adminList = [];

const intern = (value, index, list) => {
  if (value === '') return -1;
  let id = index.get(value);
  if (id === undefined) {
    id = list.length;
    list.push(value);
    index.set(value, id);
  }
  return id;
};

let skipped = 0;
for (const line of citiesText.split('\n')) {
  if (!line) continue;
  const cols = line.split('\t');
  const name = cols[1];
  const lat = Number(cols[4]);
  const lng = Number(cols[5]);
  const cc = cols[8] ?? '';
  const admin1 = cols[10] ?? '';
  // Population is what separates "Tokyo" from the suburb 900m away.
  const population = Number(cols[14]) || 0;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    skipped++;
    continue;
  }
  const countryId = intern(countries.get(cc) ?? cc, countryIndex, countryList);
  const regionId = intern(admins.get(`${cc}.${admin1}`) ?? '', adminIndex, adminList);
  // 3 decimal places is ~100m — far finer than "which town is this".
  rows.push(
    `${name}\t${lat.toFixed(3)}\t${lng.toFixed(3)}\t${countryId}\t${regionId}\t${population}`,
  );
}

const header = JSON.stringify({ countries: countryList, regions: adminList });
const body = `${header}\n${rows.join('\n')}\n`;

mkdirSync(OUT_DIR, { recursive: true });
const gzipped = gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
writeFileSync(OUT_FILE, gzipped);

console.log(`\n  ${rows.length.toLocaleString()} places (${skipped} skipped)`);
console.log(`  ${countryList.length} countries, ${adminList.length} regions`);
console.log(`  raw ${(body.length / 1e6).toFixed(1)} MB -> gzipped ${(gzipped.length / 1e6).toFixed(1)} MB`);
console.log(`  wrote ${OUT_FILE}`);
