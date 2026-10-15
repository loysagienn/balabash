// Mini-app row (design: AppRow): published — the app's public address as a
// chip, not published — a quiet caption; a manifest error — a red line and
// a red object icon. The plain row is one link (the home page); actions —
// the full row of the "Apps" section: under the description the app's two
// links in one line — the owner link (a lock: only the signed-in owner,
// always there, <CONSOLE_DOMAIN>/apps/<folder>, so the folder is not
// repeated) and the public one (a globe: anyone, only while published;
// otherwise "not published"), both cut with an ellipsis — then "Open" and
// the "⋯" menu (more — a MenuAnchor from the feature), so the row itself is
// not a link. The plain row leads where the caller says: to the published
// app itself (external — a new tab) or to a console route.

import type { MouseEvent, ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import { Row } from '../List/List.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Code, ErrorLine, Quiet, Url } from '../atoms/atoms.tsx';

export type AppRowProps = {
  title: string;
  desc?: string;
  // The public address, shown as the chip's text ("balabash.app/kcal").
  url?: string;
  // Where "Open" leads — and the public chip, when the app opens there:
  // the public app, or the owner page of an unpublished one (lib/apps/appLink).
  appHref?: string;
  // The manifest error text.
  err?: string;
} & (
  | { actions?: false; href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; external?: boolean }
  | {
      actions: true;
      // The owner link: its text (the address without the scheme) and where it leads.
      owner: { text: string; href: string };
      // The public address as a link: the app opens there (a published app
      // with a valid manifest); absent — the chip is text only.
      urlHref?: string;
      more?: ReactNode;
    }
);

export function AppRow(props: AppRowProps) {
  const { title, desc, url, appHref, err } = props;
  const lead = <Obj icon={err ? 'triangle-alert' : 'layout-grid'} size="md" state={err ? 'err' : undefined} />;
  const errLine = err ? (
    <ErrorLine>
      Manifest error: <Code wrap>{err}</Code>
    </ErrorLine>
  ) : null;

  if (!props.actions) {
    const published = url ? <Url>{url}</Url> : <Quiet>not published</Quiet>;

    return <Row href={props.href} onClick={props.onClick} external={props.external} lead={lead} title={title} meta={desc} desc={errLine} end={published} />;
  }

  return (
    <Row
      lead={lead}
      title={title}
      meta={desc}
      desc={
        <>
          <span className="row-links">
            <Url variant="owner" href={props.owner.href} title="Owner link — only you, signed in; works whether the app is published or not">
              {props.owner.text}
            </Url>
            {url ? (
              <Url href={props.urlHref} title="Public link — anyone, while the app is published">
                {url}
              </Url>
            ) : (
              <Quiet>not published</Quiet>
            )}
          </span>
          {errLine}
        </>
      }
      end={
        <>
          {appHref ? <Btn label="Open" variant="ghost" size="sm" iconAfter="arrow-up-right" href={appHref} external /> : null}
          {props.more}
        </>
      }
    />
  );
}
