/// <reference types="google.maps" />

type Config = { mapsBrowserKey: string; imagery: 'streetview' | 'placeholder' };

let configPromise: Promise<Config> | null = null;

/** Fetched once per page load. The key is served at runtime, not baked into the bundle. */
export function getConfig(): Promise<Config> {
  configPromise ??= fetch('/api/config')
    .then((r) => r.json() as Promise<Config>)
    .catch(() => ({ mapsBrowserKey: '', imagery: 'placeholder' as const }));
  return configPromise;
}

let loaderPromise: Promise<typeof google.maps> | null = null;

/**
 * Loads the Maps JS API exactly once per page, no matter how many rounds are played.
 * Re-injecting the script — or letting two components each load it — is one of the ways a
 * bug turns into a bill (§7).
 */
export function loadMaps(apiKey: string): Promise<typeof google.maps> {
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.maps?.StreetViewPanorama) {
      resolve(google.maps);
      return;
    }
    const script = document.createElement('script');
    // No `libraries=` — the panorama is in core, and every extra library is more to download
    // on a phone network.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async`;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the Google Maps script'));
    script.onload = () => {
      if (google?.maps?.StreetViewPanorama) resolve(google.maps);
      else reject(new Error('Maps script loaded without StreetViewPanorama'));
    };
    document.head.appendChild(script);
  });

  return loaderPromise;
}
