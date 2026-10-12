// Thread header strip (design: ThreadHead) — shown in a narrow thread
// (≤ 900; a wide thread carries everything in its rail, ThreadRail). Pinned
// to the top of the scrolling body on glass; stuck — the feed has scrolled
// under it (the hairline shows). State, context and the tag; on the right
// "Stop turn" and "Cancel thread" of an active thread (hidden ≤ 560, the
// details sheet has them) and "⋯" — the thread details as a bottom sheet.
// On the phone the strip is the screen header: "back" and the title over
// the state and the context. loading — a skeleton.

import { Btn } from '../Btn/Btn.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Ctx } from '../Ring/Ctx.tsx';
import type { CtxInput } from '../Ring/Ring.logic.ts';
import { Skel } from '../Skel/Skel.tsx';
import { Status } from '../Status/Status.tsx';
import { Tag } from '../atoms/atoms.tsx';
import type { StateName } from '../atoms/state.ts';
import { threadStateLabel } from './ThreadHead.logic.ts';
import './ThreadHead.css';

export type ThreadHeadProps = {
  title: string;
  state: StateName;
  label?: string;
  ctx?: CtxInput;
  tag?: string;
  stuck?: boolean;
  onBack?: () => void;
  running?: boolean;
  onStop?: () => void;
  stopBusy?: boolean;
  // No turn in flight to stop (the session waits) — the button stays, inert.
  stopDisabled?: boolean;
  onCancel?: () => void;
  cancelBusy?: boolean;
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

export function ThreadHead({ title, state, label, ctx, tag, stuck, onBack, running, onStop, stopBusy, stopDisabled, onCancel, cancelBusy, onMore, moreOpen, loading }: ThreadHeadProps) {
  if (loading) {
    return (
      <div className="th-head" aria-busy="true">
        <Back onBack={onBack} />
        <span className="skel-stack th-id">
          <Skel w={60} />
          <Skel shape="line-sm" w={35} />
        </span>
      </div>
    );
  }

  return (
    <div className="th-head" data-stuck={stuck ? '' : undefined}>
      <Back onBack={onBack} />
      <div className="th-id">
        <h2 className="th-title">{title}</h2>
        <div className="th-chips">
          <Status state={state} label={threadStateLabel(state, label)} />
          {ctx ? <Ctx {...ctx} /> : null}
          {tag ? <Tag>{tag}</Tag> : null}
        </div>
      </div>
      <div className="th-acts">
        {running ? (
          <>
            <Btn label="Stop turn" icon="pause" size="sm" className="th-act" busy={stopBusy} disabled={stopDisabled} onClick={onStop} />
            <Btn label="Cancel thread" icon="circle-stop" variant="danger" size="sm" className="th-act" busy={cancelBusy} onClick={onCancel} />
          </>
        ) : null}
        <IconBtn icon="ellipsis" label="Thread details" size="sm" className="th-more" expanded={moreOpen} onClick={onMore} />
      </div>
    </div>
  );
}
