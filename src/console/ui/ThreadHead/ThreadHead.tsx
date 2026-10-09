// Thread header (design: ThreadHead): agent, title, details, state,
// context, links; the controls on the right. running — "Stop turn" and
// "Cancel thread" buttons (hidden in a narrow thread, where they live in
// the "⋯" menu); more — the "⋯" slot: a feature passes its MenuAnchor with
// an IconBtn of className "th-more". meta — detail items joined with "·"
// (a feature puts router Links inside). links — chips after the state:
// "2 children" as an anchor with the `link` class. loading — a skeleton.

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Badge } from '../Badge/Badge.tsx';
import { Btn } from '../Btn/Btn.tsx';
import { Ctx } from '../Ring/Ctx.tsx';
import type { CtxInput } from '../Ring/Ring.logic.ts';
import { Skel } from '../Skel/Skel.tsx';
import { Tag } from '../atoms/atoms.tsx';
import type { StateName } from '../atoms/state.ts';
import { threadStateLabel } from './ThreadHead.logic.ts';
import './ThreadHead.css';

export type ThreadHeadProps = {
  agent: string;
  title: string;
  state: StateName;
  label?: string;
  ctx?: CtxInput & { text?: string };
  links?: ReactNode;
  tag?: string;
  meta?: ReactNode[];
  running?: boolean;
  onStop?: () => void;
  stopBusy?: boolean;
  onCancel?: () => void;
  cancelBusy?: boolean;
  more?: ReactNode;
  loading?: boolean;
};

export function ThreadHead({
  agent,
  title,
  state,
  label,
  ctx,
  links,
  tag,
  meta,
  running,
  onStop,
  stopBusy,
  onCancel,
  cancelBusy,
  more,
  loading,
}: ThreadHeadProps) {
  if (loading) {
    return (
      <div className="th-head" aria-busy="true">
        <Skel shape="av" />
        <span className="skel-stack th-title">
          <Skel w={70} />
          <Skel shape="line-sm" w={40} />
        </span>
      </div>
    );
  }

  return (
    <div className="th-head">
      <Avatar agent={agent} size="lg" className="th-av" />
      <h2 className="th-title">{title}</h2>
      <div className="th-acts">
        {running ? (
          <>
            <Btn label="Stop turn" icon="pause" size="sm" className="th-act" busy={stopBusy} onClick={onStop} />
            <Btn
              label="Cancel thread"
              icon="circle-stop"
              variant="danger"
              size="sm"
              className="th-act"
              busy={cancelBusy}
              onClick={onCancel}
            />
          </>
        ) : null}
        {more}
      </div>
      {meta && meta.length > 0 ? (
        <div className="th-meta">
          {meta.map((item, i) => (
            <Fragment key={i}>
              {i > 0 ? '·' : null}
              <span className="th-meta-i">{item}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
      <div className="th-chips">
        <Badge state={state} label={threadStateLabel(state, label)} />
        {ctx ? <Ctx {...ctx} /> : null}
        {links}
        {tag ? <Tag>{tag}</Tag> : null}
      </div>
    </div>
  );
}
