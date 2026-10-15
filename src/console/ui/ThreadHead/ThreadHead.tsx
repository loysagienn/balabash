// Thread header strip (design: ThreadHead) — shown in a narrow thread
// (≤ 900; a wide thread carries everything in its rail, ThreadRail). A glass
// bar of the frame (ui/Glass) pinned on top; the feed melts into its soft
// edge. State, context and the tags; on the right
// only the controls that apply right now (hidden ≤ 560, the details sheet
// has them all): "Stop turn" while a turn runs, "Pause" for a remote
// thread awaiting a message, "Finish thread" (or "Finish requested",
// disabled); "Cancel thread" lives in "⋯" — the thread details as a bottom
// sheet. On the phone the strip is the screen header: "back" and the title
// over the state and the context. loading — a skeleton.

import { Btn } from '../Btn/Btn.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Ctx } from '../Ring/Ctx.tsx';
import type { CtxInput } from '../Ring/Ring.logic.ts';
import { Skel } from '../Skel/Skel.tsx';
import { Status } from '../Status/Status.tsx';
import { Tag } from '../atoms/atoms.tsx';
import type { StateName } from '../atoms/state.ts';
import { threadStateLabel } from './ThreadHead.logic.ts';
import '../Glass/Glass.css';
import './ThreadHead.css';

export type ThreadHeadControl = { onClick: () => void; busy?: boolean };

// The controls that apply right now; null — not this one.
export type ThreadHeadControls = {
  stop: ThreadHeadControl | null;
  pause: ThreadHeadControl | null;
  finish: ThreadHeadControl | 'requested' | null;
};

export type ThreadHeadProps = {
  title: string;
  state: StateName;
  label?: string;
  ctx?: CtxInput;
  tag?: string;
  // A remote agent's thread: the "remote" tag.
  remote?: boolean;
  onBack?: () => void;
  controls?: ThreadHeadControls;
  // "⋯": the details sheet.
  onMore?: () => void;
  moreOpen?: boolean;
  loading?: boolean;
};

function Back({ onBack }: { onBack?: () => void }) {
  return (
    <span className="th-ph">
      <IconBtn icon="arrow-left" label="Back" size="sm" className="th-back" onClick={onBack} />
    </span>
  );
}

export function ThreadHead({ title, state, label, ctx, tag, remote, onBack, controls, onMore, moreOpen, loading }: ThreadHeadProps) {
  if (loading) {
    return (
      <div className="th-head glass" data-edge="top" aria-busy="true">
        <Back onBack={onBack} />
        <span className="skel-stack th-id">
          <Skel w={60} />
          <Skel shape="line-sm" w={35} />
        </span>
      </div>
    );
  }

  return (
    <div className="th-head glass" data-edge="top">
      <Back onBack={onBack} />
      <div className="th-id">
        <h2 className="th-title">{title}</h2>
        <div className="th-chips">
          <Status state={state} label={threadStateLabel(state, label)} />
          {ctx ? <Ctx {...ctx} /> : null}
          {tag ? <Tag>{tag}</Tag> : null}
          {remote ? <Tag>remote</Tag> : null}
        </div>
      </div>
      <div className="th-acts">
        {controls?.stop ? <Btn label="Stop turn" icon="square" size="sm" className="th-act" busy={controls.stop.busy} onClick={controls.stop.onClick} /> : null}
        {controls?.pause ? <Btn label="Pause" icon="moon" size="sm" className="th-act" busy={controls.pause.busy} onClick={controls.pause.onClick} /> : null}
        {controls?.finish === 'requested' ? (
          <Btn label="Finish requested" icon="hourglass" size="sm" className="th-act" disabled />
        ) : controls?.finish ? (
          <Btn label="Finish thread" icon="flag" size="sm" className="th-act" busy={controls.finish.busy} onClick={controls.finish.onClick} />
        ) : null}
        <IconBtn icon="ellipsis" label="Thread details" size="sm" className="th-more" expanded={moreOpen} onClick={onMore} />
      </div>
    </div>
  );
}
