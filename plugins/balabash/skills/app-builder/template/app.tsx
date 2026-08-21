import { useState } from 'react';
import { call } from 'balabash/data';

export function App() {
  const [count, setCount] = useState(0);
  const [tables, setTables] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function showTables() {
    try {
      const rows = (await call('listTables')) as { name: string }[];

      setTables(rows.map(row => row.name));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>Template App</h1>
      <p>Local state works:</p>
      <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
      <p>Workspace data works:</p>
      <button onClick={showTables}>List workspace tables</button>
      {tables && (
        <ul>
          {tables.length === 0 && <li className="muted">no tables yet</li>}
          {tables.map(name => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
