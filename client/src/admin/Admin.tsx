import { useCallback, useEffect, useState } from 'react';
import { ZoneMap, type Bbox } from './ZoneMap';

type Zone = { id: string; name: string; weight: number; bbox: Bbox };
type Group = { id: string; name: string; weight: number; zones: Zone[] };

type Loaded = {
  groups: Group[];
  source: 'default' | 'env' | 'admin' | 'stored';
  persistence: string;
  imagery: 'streetview' | 'placeholder';
};

type TestResult = {
  hitRate: number;
  found: number;
  samples: number;
  hits: { lat: number; lng: number }[];
};

const PASSWORD_KEY = 'pangoguessr.adminPassword';

async function api<T>(path: string, password: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password, ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/**
 * Desktop-only zone editor (§7). Typing bounding boxes by hand is tedious and error-prone,
 * and the whole quality of the game lives in this list.
 *
 * Two levels: a **group** is what competes for a round ("New Zealand", 13% of rounds), and
 * its **zones** are the boxes one of which is then drawn. So a country made of five tight
 * boxes doesn't get five times the odds.
 */
export function Admin() {
  // sessionStorage, not localStorage: a shared password shouldn't outlive the tab.
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) ?? '');
  const [entry, setEntry] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async (pw: string) => {
    try {
      const data = await api<Loaded>('/api/admin/zones', pw);
      setLoaded(data);
      setGroups(data.groups);
      setGroupId((current) => current ?? data.groups[0]?.id ?? null);
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

  const group = groups.find((g) => g.id === groupId) ?? null;
  const zone = group?.zones.find((z) => z.id === zoneId) ?? null;
  const dirty = loaded !== null && JSON.stringify(groups) !== JSON.stringify(loaded.groups);
  const totalWeight = groups.reduce((sum, g) => sum + Number(g.weight || 0), 0);

  const patchGroup = (id: string, patch: Partial<Group>) =>
    setGroups((current) => current.map((g) => (g.id === id ? { ...g, ...patch } : g)));

  const patchZone = (gid: string, zid: string, patch: Partial<Zone>) =>
    setGroups((current) =>
      current.map((g) =>
        g.id === gid ? { ...g, zones: g.zones.map((z) => (z.id === zid ? { ...z, ...patch } : z)) } : g,
      ),
    );

  const uniqueId = (base: string) => {
    const taken = new Set(groups.flatMap((g) => [g.id, ...g.zones.map((z) => z.id)]));
    let n = 1;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  const addGroup = () => {
    const id = uniqueId('group');
    const created: Group = { id, name: `Group ${groups.length + 1}`, weight: 2, zones: [] };
    setGroups((current) => [...current, created]);
    setGroupId(id);
    setZoneId(null);
  };

  // Drawing always adds to the selected group — the map is how you build a group up.
  const addZone = (bbox: Bbox) => {
    if (!group) {
      setError('Pick a group first, or create one — a zone has to live in a group.');
      return;
    }
    const id = uniqueId('zone');
    const created: Zone = { id, name: `Box ${group.zones.length + 1}`, weight: 1, bbox };
    patchGroup(group.id, { zones: [...group.zones, created] });
    setZoneId(id);
    setTestResult(null);
    setError(null);
  };

  const save = async () => {
    try {
      const result = await api<{ persisted: boolean }>('/api/admin/zones', password, {
        method: 'PUT',
        body: JSON.stringify({ groups }),
      });
      setStatus(
        result.persisted
          ? 'Saved. Every game from now on uses these, including after a restart.'
          : 'Applied to this server only — it reverts on restart. Copy the JSON and set ZONES_JSON.',
      );
      setError(null);
      await load(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    }
  };

  const testZone = async () => {
    if (!zone) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api<TestResult>('/api/admin/test-zone', password, {
          method: 'POST',
          body: JSON.stringify({ bbox: zone.bbox, samples: 12 }),
        }),
      );
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

  const groupShare = (g: Group) => (totalWeight > 0 ? (g.weight / totalWeight) * 100 : 0);
  const zoneShare = (g: Group, z: Zone) => {
    const inner = g.zones.reduce((sum, item) => sum + Number(item.weight || 0), 0);
    return inner > 0 ? (groupShare(g) * z.weight) / inner : 0;
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <h1>Zone editor</h1>
        <p className="hint">
          A <strong>group</strong> competes for a round; one of its <strong>boxes</strong> is then
          drawn. <strong>Shift-drag</strong> the map to add a box to the selected group.{' '}
          {groups.length} groups, source: <code>{loaded.source}</code>, store:{' '}
          <code>{loaded.persistence}</code>
        </p>
      </header>

      {status && <p className="notice" role="status">{status}</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loaded.persistence === 'none' && (
        <p className="hint hint--warn">
          No store configured — saves last only until the server restarts. Set{' '}
          <code>ZONES_KV_URL</code> and <code>ZONES_KV_TOKEN</code> to make them permanent.
        </p>
      )}

      <div className="admin__body">
        <ZoneMap
          zones={groups.flatMap((g) =>
            g.zones.map((z) => ({ id: z.id, name: `${g.name} — ${z.name}`, bbox: z.bbox, groupId: g.id })),
          )}
          selectedGroupId={groupId}
          selectedZoneId={zoneId}
          testHits={testResult?.hits ?? []}
          onSelect={(zid, gid) => {
            setGroupId(gid);
            setZoneId(zid);
            setTestResult(null);
          }}
          onDraw={addZone}
        />

        <section className="admin__side">
          <div className="admin__groups">
            {groups.map((g) => (
              <div key={g.id} className={`admin__group${g.id === groupId ? ' admin__group--open' : ''}`}>
                <button
                  className="admin__group-head"
                  type="button"
                  onClick={() => {
                    setGroupId(g.id);
                    setZoneId(null);
                  }}
                >
                  <span className="admin__group-name">{g.name}</span>
                  <span className="admin__zone-share">{groupShare(g).toFixed(0)}%</span>
                </button>

                {g.id === groupId && (
                  <div className="admin__group-body">
                    <label className="field">
                      <span className="field__label">Group name</span>
                      <input
                        className="input"
                        value={g.name}
                        // Name only — never the id. Ids are internal handles that selection,
                        // the map and the zone list are all keyed by; re-deriving one from the
                        // name meant every keystroke renamed the group out from under them.
                        onChange={(e) => patchGroup(g.id, { name: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">
                        Group weight — {g.weight} ({groupShare(g).toFixed(0)}% of rounds)
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={g.weight}
                        onChange={(e) => patchGroup(g.id, { weight: Number(e.target.value) })}
                      />
                    </label>

                    {g.zones.length === 0 ? (
                      <p className="hint hint--warn">
                        No boxes yet — shift-drag the map to add one.
                      </p>
                    ) : (
                      <ul className="admin__list">
                        {g.zones.map((z) => (
                          <li
                            key={z.id}
                            className={`admin__zone${z.id === zoneId ? ' admin__zone--selected' : ''}`}
                            onClick={() => {
                              setZoneId(z.id);
                              setTestResult(null);
                            }}
                          >
                            <span className="admin__zone-name">{z.name}</span>
                            <span className="admin__zone-share">{zoneShare(g, z).toFixed(0)}%</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {zone && zone.id === zoneId && (
                      <div className="admin__editor">
                        <label className="field">
                          <span className="field__label">Box name</span>
                          <input
                            className="input"
                            value={zone.name}
                            onChange={(e) => patchZone(g.id, zone.id, { name: e.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">
                            Weight within the group — {zone.weight}
                          </span>
                          <input
                            type="range"
                            min={1}
                            max={10}
                            value={zone.weight}
                            onChange={(e) => patchZone(g.id, zone.id, { weight: Number(e.target.value) })}
                          />
                        </label>
                        <p className="hint">bbox {zone.bbox.map((n) => n.toFixed(2)).join(', ')}</p>
                        <div className="admin__buttons">
                          <button
                            className="button button--ghost"
                            type="button"
                            onClick={testZone}
                            disabled={testing || loaded.imagery !== 'streetview'}
                          >
                            {testing ? 'Testing…' : 'Test box'}
                          </button>
                          <button
                            className="button button--ghost"
                            type="button"
                            onClick={() => {
                              patchGroup(g.id, { zones: g.zones.filter((x) => x.id !== zone.id) });
                              setZoneId(null);
                            }}
                          >
                            Delete box
                          </button>
                        </div>
                        {testResult && (
                          <p className={`hint${testResult.hitRate < 30 ? ' hint--warn' : ''}`}>
                            Coverage at {testResult.found}/{testResult.samples} points (
                            {testResult.hitRate}%).
                            {testResult.hitRate < 30 && ' Mostly ocean — tighten it.'}
                          </p>
                        )}
                      </div>
                    )}

                    <button
                      className="button button--ghost admin__delete-group"
                      type="button"
                      onClick={() => {
                        setGroups((current) => current.filter((x) => x.id !== g.id));
                        setGroupId(null);
                        setZoneId(null);
                      }}
                    >
                      Delete group
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="admin__actions">
            <button className="button button--ghost" type="button" onClick={addGroup}>
              New group
            </button>
            <button className="button button--primary" type="button" onClick={save} disabled={!dirty}>
              {dirty ? 'Save zones' : 'Saved'}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(groups));
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
