import { useCallback, useEffect, useState } from 'react';
import { ZoneMap, type Bbox } from './ZoneMap';

type Zone = { id: string; name: string; weight: number; bbox: Bbox };

type Loaded = {
  zones: Zone[];
  source: 'default' | 'env' | 'admin' | 'stored';
  persistence: string;
  imagery: 'streetview' | 'placeholder';
};

type TestResult = { hitRate: number; found: number; samples: number; hits: { lat: number; lng: number }[] };

const PASSWORD_KEY = 'pangoguessr.adminPassword';

async function api<T>(path: string, password: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': password,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

/**
 * Desktop-only zone editor (§7). Typing bounding boxes by hand is tedious and error-prone,
 * and the whole quality of the game lives in this list.
 */
export function Admin() {
  // Kept in sessionStorage, not localStorage: a shared password shouldn't outlive the tab.
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) ?? '');
  const [entry, setEntry] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async (pw: string) => {
    try {
      const data = await api<Loaded>('/api/admin/zones', pw);
      setLoaded(data);
      setZones(data.zones);
      setError(null);
      sessionStorage.setItem(PASSWORD_KEY, pw);
      setPassword(pw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(null);
    }
  }, []);

  useEffect(() => {
    if (password) void load(password);
  }, [password, load]);

  const selected = zones.find((z) => z.id === selectedId) ?? null;
  const dirty = loaded !== null && JSON.stringify(zones) !== JSON.stringify(loaded.zones);

  const update = (id: string, patch: Partial<Zone>) =>
    setZones((current) => current.map((z) => (z.id === id ? { ...z, ...patch } : z)));

  const addZone = (bbox: Bbox) => {
    const base = 'zone';
    let n = zones.length + 1;
    while (zones.some((z) => z.id === `${base}-${n}`)) n++;
    const zone: Zone = { id: `${base}-${n}`, name: `Zone ${n}`, weight: 2, bbox };
    setZones((current) => [...current, zone]);
    setSelectedId(zone.id);
    setTestResult(null);
  };

  const save = async () => {
    try {
      const result = await api<{ persisted: boolean; source: string }>('/api/admin/zones', password, {
        method: 'PUT',
        body: JSON.stringify({ zones }),
      });
      setStatus(
        result.persisted
          ? 'Saved. These zones will be used by every game from now on, including after a restart.'
          : 'Applied to this server, but NOT saved anywhere — it will revert when the server restarts. Copy the JSON below.',
      );
      setError(null);
      await load(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    }
  };

  const testZone = async () => {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<TestResult>('/api/admin/test-zone', password, {
        method: 'POST',
        body: JSON.stringify({ bbox: selected.bbox, samples: 12 }),
      });
      setTestResult(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  if (!loaded) {
    return (
      <main className="screen screen--home">
        <header className="brand">
          <h1>Zone editor</h1>
          <p className="brand__tag">Admin only.</p>
        </header>
        {error && <p className="notice" role="status">{error}</p>}
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void load(entry);
          }}
        >
          <span className="field__label">Password</span>
          <input
            className="input"
            type="password"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            autoFocus
          />
          <button className="button button--primary" type="submit">
            Unlock
          </button>
        </form>
        <a className="hint" href="/">
          Back to the game
        </a>
      </main>
    );
  }

  const totalWeight = zones.reduce((sum, z) => sum + Number(z.weight || 0), 0);

  return (
    <main className="admin">
      <header className="admin__head">
        <h1>Zone editor</h1>
        <p className="hint">
          <strong>Shift-drag</strong> the map to draw a zone. {zones.length} zones, source:{' '}
          <code>{loaded.source}</code>, store: <code>{loaded.persistence}</code>
        </p>
      </header>

      {status && <p className="notice" role="status">{status}</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loaded.persistence === 'none' && (
        <p className="hint hint--warn">
          No store configured, so saves live only until the server restarts. Set{' '}
          <code>ZONES_KV_URL</code> and <code>ZONES_KV_TOKEN</code> to make them permanent, or
          paste the JSON below into the <code>ZONES_JSON</code> environment variable.
        </p>
      )}

      <div className="admin__body">
        <ZoneMap
          zones={zones}
          selectedId={selectedId}
          testHits={testResult?.hits ?? []}
          onSelect={(id) => {
            setSelectedId(id);
            setTestResult(null);
          }}
          onDraw={addZone}
        />

        <section className="admin__side">
          <ul className="admin__list">
            {zones.map((zone) => {
              const share = totalWeight > 0 ? Math.round((zone.weight / totalWeight) * 100) : 0;
              return (
                <li
                  key={zone.id}
                  className={`admin__zone${zone.id === selectedId ? ' admin__zone--selected' : ''}`}
                  onClick={() => setSelectedId(zone.id)}
                >
                  <span className="admin__zone-name">{zone.name}</span>
                  <span className="admin__zone-share">{share}%</span>
                </li>
              );
            })}
          </ul>

          {selected && (
            <div className="admin__editor">
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="input"
                  value={selected.name}
                  onChange={(e) =>
                    update(selected.id, { name: e.target.value, id: slugify(e.target.value) || selected.id })
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">Weight — {selected.weight}</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={selected.weight}
                  onChange={(e) => update(selected.id, { weight: Number(e.target.value) })}
                />
              </label>
              <p className="hint">
                bbox {selected.bbox.map((n) => n.toFixed(2)).join(', ')}
              </p>

              <div className="admin__buttons">
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={testZone}
                  disabled={testing || loaded.imagery !== 'streetview'}
                >
                  {testing ? 'Testing…' : 'Test this zone'}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    setZones((c) => c.filter((z) => z.id !== selected.id));
                    setSelectedId(null);
                  }}
                >
                  Delete
                </button>
              </div>

              {testResult && (
                <p className={`hint${testResult.hitRate < 30 ? ' hint--warn' : ''}`}>
                  Found coverage at {testResult.found}/{testResult.samples} points (
                  {testResult.hitRate}%).
                  {testResult.hitRate < 30 && ' Mostly ocean — tighten this zone.'}
                </p>
              )}
              {loaded.imagery !== 'streetview' && (
                <p className="hint">Testing needs a server-side Maps key.</p>
              )}
            </div>
          )}

          <div className="admin__actions">
            <button className="button button--primary" type="button" onClick={save} disabled={!dirty}>
              {dirty ? 'Save zones' : 'Saved'}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(zones));
                setStatus('JSON copied — paste it into ZONES_JSON to make it permanent.');
              }}
            >
              Copy JSON
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
