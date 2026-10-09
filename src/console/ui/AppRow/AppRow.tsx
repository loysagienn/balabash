// Mini-app row (design: AppRow): published — the app's URL as a chip, not
// published — a quiet caption; a manifest error — a red line and a red
// object icon. The plain row is one link (the home page); actions — the
// full row of the "Apps" section: the folder, the URL as a link, "Open"
// and the "⋯" menu (more — a MenuAnchor from the feature), so the row
// itself is not a link. The plain row leads where the caller says: to the
// published app itself (external — a new tab) or to a console route.

import type { MouseEvent, ReactNode } from 'react';
import { Btn } from '../Btn/Btn.tsx';
import { Row } from '../List/List.tsx';
import { Obj } from '../Obj/Obj.tsx';
import { Code, ErrorLine, Quiet, Url } from '../atoms/atoms.tsx';

export type AppRowProps = {
  title: string;
  desc?: string;
  // The published address, shown as the chip's text ("/p/kcal" or a host).
  url?: string;
  // Where the published app opens; the chip and "Open" lead there.
  appHref?: string;
  // The manifest error text.
  err?: string;
} & (
  | { actions?: false; href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; external?: boolean }
  | { actions: true; folder: string; more?: ReactNode }
);

export function AppRow(props: AppRowProps) {
  const { title, desc, url, appHref, err } = props;
  const lead = <Obj icon={err ? 'triangle-alert' : 'layout-grid'} size="md" state={err ? 'err' : undefined} />;
  const errLine = err ? (
    <ErrorLine>
      Manifest error: <Code wrap>{err}</Code>
    </ErrorLine>
  ) : null;
  const published = url ? <Url href={props.actions ? appHref : undefined}>{url}</Url> : <Quiet>not published</Quiet>;

  if (!props.actions) {
    return <Row href={props.href} onClick={props.onClick} external={props.external} lead={lead} title={title} meta={desc} desc={errLine} end={published} />;
  }

  return (
    <Row
      lead={lead}
      title={title}
      meta={desc}
      desc={
        <>
          <Code>{props.folder}/</Code>
          {errLine}
        </>
      }
      end={
        <>
          {published}
          {appHref ? <Btn label="Open" variant="ghost" size="sm" iconAfter="arrow-up-right" href={appHref} external /> : null}
          {props.more}
        </>
      }
    />
  );
}
