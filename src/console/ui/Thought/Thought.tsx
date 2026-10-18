// The agent's thought as text in the feed (design: Thought): a caption —
// brain, "Thought", how long it took (`time`; none for an unmeasured one)
// — and the thought itself (`source`, Markdown), whole, in the quiet tone:
// the design's `.md.thought-b` is one element, so the block renders the Md
// itself with the class (a wrapper could not recolor the Md's own quiet
// color). The thought keeps its line breaks: a Codex reasoning summary of
// several sections comes joined with single newlines (one headline per
// section), which Markdown alone would run into one line. Not an action:
// the feed ends one action group before it and starts the next after it.

import { Icon } from '../Icon/Icon.tsx';
import { Md } from '../Md/Md.tsx';
import './Thought.css';

export function Thought({ time, source }: { time?: string; source: string }) {
  return (
    <div className="thought">
      <div className="thought-h">
        <Icon name="brain" />
        Thought
        {time ? <span className="thought-time">{time}</span> : null}
      </div>
      <Md quiet breaks className="thought-b" source={source} />
    </div>
  );
}
