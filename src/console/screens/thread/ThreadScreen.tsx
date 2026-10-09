// Thread page — the feed arrives with stage 5; for now the shell knows the
// thread (title from the store, back to the list) and reports what the
// store already holds for it.

import { useAppSelector } from '../../store/hooks.ts';
import { selectThreadFeed } from '../../store/feed/selectors.ts';
import { selectThread } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';

export function ThreadScreen({ id }: { id: string }) {
  const thread = useAppSelector(state => selectThread(state, id));
  const feed = useAppSelector(state => selectThreadFeed(state, id));
  const title = thread?.title ?? (thread ? thread.agent : 'Thread');

  return (
    <Shell current="threads" title={title} crumb={{ label: 'Threads', route: { key: 'threads' } }} back={{ key: 'threads' }} detail compact>
      <Screen>
        <Empty icon="messages-square" title="The thread feed is not built yet">
          {thread ? (
            <>
              <Code>{thread.agent}</Code> · {thread.status} · {feed.seqs.length} events in the store
              {feed.request ? ' · loading…' : feed.exhausted ? ' · complete' : ''}
            </>
          ) : (
            <>
              Thread <Code wrap>{id}</Code> is not in the snapshot window.
            </>
          )}
        </Empty>
      </Screen>
    </Shell>
  );
}
