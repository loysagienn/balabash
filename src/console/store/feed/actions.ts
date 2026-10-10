// Eviction of thread feeds (lib/feed-eviction): the bodies of the named
// threads' events leave the store. A feed evicted is a feed never loaded —
// the thread's next opening asks for its chunk from the head again.
export const evictFeeds = (threadIds: string[]) => ({ type: 'FEED_EVICT', threadIds }) as const;
