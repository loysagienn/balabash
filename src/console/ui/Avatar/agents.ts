// Who is who in the avatar (design README, rule 6): the letter and the
// identity color are fixed per agent of the catalog (agents/index.ts in
// the repository; the coordinator is the secretary of the main thread,
// "you" is the user — named, it keeps the user's color under its own
// initial). An agent outside the table gets its initial and the neutral
// color.

export type AvatarId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'you';

export const AGENT_AVATARS: Record<string, readonly [letter: string, id: AvatarId]> = {
  coordinator: ['C', 5],
  manager: ['M', 6],
  engineer: ['E', 1],
  architect: ['A', 8],
  designer: ['D', 3],
  browser: ['B', 2],
  scheduler: ['S', 7],
  gardener: ['G', 4],
  auth: ['A', 6],
  power_point: ['P', 3],
  codex: ['C', 1],
  you: ['Y', 'you'],
};

export type AvatarVals = { letter: string; id: AvatarId | undefined; title: string };

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}

export function avatarVals(agent: string, you?: string): AvatarVals {
  if (agent === 'you' && you && initialOf(you)) {
    return { letter: initialOf(you), id: 'you', title: you };
  }

  const known = AGENT_AVATARS[agent];

  if (known) {
    return { letter: known[0], id: known[1], title: agent };
  }

  return { letter: initialOf(agent) || '?', id: undefined, title: agent };
}
