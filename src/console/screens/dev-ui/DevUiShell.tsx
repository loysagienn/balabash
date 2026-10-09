// The design's "App Shell" showcase in code — the blocks of the shell that
// are not the frame itself: the bell, the "Running now" and "Notifications"
// popovers, the ⌘K palette (wide and at phone width). Store-free: a
// headless scene can mount it alone.

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Bell } from '../../ui/Bell/Bell.tsx';
import { ActionLink, Btn } from '../../ui/Btn/Btn.tsx';
import { Notification } from '../../ui/Notification/Notification.tsx';
import { Palette, PaletteFoot, PaletteGroup, PaletteInput, PaletteItem, PaletteKey, PaletteList } from '../../ui/Palette/Palette.tsx';
import { Pop, PopFoot, PopGroup, PopHead, PopItem } from '../../ui/Pop/Pop.tsx';
import { Caption } from '../../ui/atoms/atoms.tsx';

const stop = (event: { preventDefault: () => void }) => event.preventDefault();

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function RunningNow() {
  return (
    <Pop label="Running now">
      <PopHead title="Running now" count={4} countState="run" />
      <PopItem agent="engineer" title="Mini-apps: publishing by slug" meta="engineer · " metaCode="npm run build" state="run" time="2:36:12" href="#" onClick={stop} />
      <PopItem agent="browser" title="Yandex.Direct: September report export" meta="browser · waiting for 2FA code" state="act" time="58:04" href="#" onClick={stop} />
      <PopItem agent="designer" title="Design system: product patterns" meta="designer · awaiting message" state="wait" time="20:31" href="#" onClick={stop} />
      <PopItem agent="gardener" title="Inbox review: Renovation" meta="gardener · headless" state="run" time="7:12" href="#" onClick={stop} />
      <PopFoot>
        <span>Timers run live</span>
        <ActionLink label="All threads" href="#" onClick={stop} />
      </PopFoot>
    </Pop>
  );
}

function Notifications() {
  return (
    <Pop label="Notifications">
      <PopHead title="Notifications" count={3} countState="act" end={<Btn label="Mark all read" variant="ghost" size="sm" />} />
      <PopGroup>Waiting for you</PopGroup>
      <Notification icon="message-circle-question" state="act" title="Browser is waiting for a 2FA code" desc="“Yandex.Direct: September report export” needs the code from the SMS." action="Reply in thread" time="3 min" unread />
      <Notification icon="key-round" state="act" title="Yandex.Direct keys needed" desc="The “auth” agent asks for an API key." action="Enter" time="12 min" unread />
      <PopGroup>Errors</PopGroup>
      <Notification icon="circle-alert" state="err" title="Task “DB backup” didn’t start" desc="Exit code 127 · 04:00" time="12h" unread />
      <PopGroup>From agents</PopGroup>
      <Notification icon="bell" title="Estimate updated" desc="coordinator · Renovation" time="yesterday" />
    </Pop>
  );
}

function SearchPalette({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const hit = query.trim() || undefined;

  return (
    <Palette>
      <PaletteInput value={query} onChange={onQuery} listId="dev-pal-list" activeId="dev-pal-0" />
      <PaletteList id="dev-pal-list">
        <PaletteGroup>Threads</PaletteGroup>
        <PaletteItem id="dev-pal-0" agent="engineer" text="Mini-apps: publishing by slug" hit={hit} meta="engineer · Balabash" endState="run" end="running" kbd="↵" sel />
        <PaletteItem agent="architect" text="Public URL scheme (slug)" hit={hit} meta="architect" endState="done" end="3 days ago" />
        <PaletteGroup>Files</PaletteGroup>
        <PaletteItem icon="file-code" text="src/api/apps/slug.ts" hit={hit} end="4 KB · today" path />
        <PaletteItem icon="file-text" text="balabash/decisions/slug-policy.md" hit={hit} end="2 KB · yesterday" path />
        <PaletteGroup>Projects</PaletteGroup>
        <PaletteItem icon="folder" text="Balabash" hit={hit} meta="3 matches inside" />
      </PaletteList>
      <PaletteFoot>
        <PaletteKey keys={['↑', '↓']}>select</PaletteKey>
        <PaletteKey keys={['↵']}>open</PaletteKey>
        <PaletteKey keys={['⌘↵']} wide>
          in a new tab
        </PaletteKey>
      </PaletteFoot>
    </Palette>
  );
}

export function DevUiShell() {
  const [query, setQuery] = useState('slug');
  const [bellOpen, setBellOpen] = useState(false);

  return (
    <>
      <Section title="Bell: with new notifications · none · open (aria-expanded)">
        <div className="dev-row">
          <Bell count={3} />
          <Bell count={0} />
          <Bell count={12} expanded={bellOpen} onClick={() => setBellOpen(!bellOpen)} />
          <Caption>the count sits on the icon’s corner; the third toggles its expanded state</Caption>
        </div>
      </Section>

      <Section title="Popover: “Running now” (PopItem rows) · “Notifications” (groups, Notification rows, unread dots)">
        <div className="dev-row" style={{ alignItems: 'flex-start' }}>
          <RunningNow />
          <Notifications />
        </div>
      </Section>

      <Section title="Palette ⌘K: grouped results, the match highlighted, state or details on the right; at 390 the secondary columns hide">
        <div className="dev-col">
          <SearchPalette query={query} onQuery={setQuery} />
          <Caption>type in the field — the highlight follows the query</Caption>
        </div>
        <div className="dev-w" style={{ '--dev-w': '390px' } as CSSProperties}>
          <SearchPalette query={query} onQuery={setQuery} />
        </div>
      </Section>
    </>
  );
}
