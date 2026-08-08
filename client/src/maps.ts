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

const CALLBACK_NAME = '__pangoMapsReady';

let bootstrapPromise: Promise<void> | null = null;
let libraryPromise: Promise<google.maps.StreetViewLibrary> | null = null;

/**
 * Loads the Maps JS API exactly once per page, no matter how many rounds are played.
 * Re-injecting the script — or letting two components each load it — is one of the ways a
 * bug turns into a bill (§7).
 *
 * `loading=async` puts the API in its modern bootstrap mode, where the script's `onload`
 * fires **before** `google.maps.StreetViewPanorama` exists: libraries arrive via
 * `importLibrary()`. Checking for the constructor at onload therefore always failed. The
 * `callback` parameter is the documented signal that the bootstrap is ready.
 */
export function loadStreetView(apiKey: string): Promise<google.maps.StreetViewLibrary> {
  bootstrapPromise ??= new Promise<void>((resolve, reject) => {
    // Typed loosely on purpose: the ambient types declare `importLibrary` as always
    // present, but at runtime it only exists once the bootstrap script has run.
    const existing = (globalThis as { google?: { maps?: { importLibrary?: unknown } } }).google;
    if (typeof existing?.maps?.importLibrary === 'function') {
      resolve();
      return;
    }

    (window as unknown as Record<string, unknown>)[CALLBACK_NAME] = () => resolve();

    const script = document.createElement('script');
    // No `libraries=` — importLibrary fetches what we ask for, and every extra library is
    // more to download on a phone network.
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&v=weekly&loading=async&callback=${CALLBACK_NAME}`;
    script.async = true;
    script.onerror = () =>
      reject(new Error('Could not load the Google Maps script — check the key restrictions'));
    document.head.appendChild(script);
  });

  libraryPromise ??= bootstrapPromise.then(
    () => google.maps.importLibrary('streetView') as Promise<google.maps.StreetViewLibrary>,
  );

  return libraryPromise;
}
