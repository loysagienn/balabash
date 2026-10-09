// Apps — every mini-app of the workspace from the snapshot: name,
// description, folder, the public address or "not published", the manifest
// error; "Open" and the "⋯" menu. The segment (All · Published · With
// errors) and the search are the route. Nothing is requested: the list is
// the snapshot and its tail.

import type { AppsFilter, AppsRoute } from '../../lib/router/routes.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { snapshotLoad } from '../../store/stream/actions.ts';
import { selectStream, snapshotStage } from '../../store/stream/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { appLink, appTitle, appUrlText } from '../../features/apps/appLink.ts';
import { AppRow } from '../../ui/AppRow/AppRow.tsx';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List } from '../../ui/List/List.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { AppMenu } from './AppMenu.tsx';
import { appsCounts, hasAppsFilters, visibleApps, withAppsFilters } from './AppsScreen.logic.ts';

const SEGMENTS: { label: string; filter: AppsFilter | undefined; count: keyof ReturnType<typeof appsCounts> }[] = [
  { label: 'All', filter: undefined, count: 'all' },
  { label: 'Published', filter: 'published', count: 'published' },
  { label: 'With errors', filter: 'errors', count: 'errors' },
];
const SKELETON = [[55, 70], [40, 62], [48, 75]];

export function AppsScreen({ route }: { route: AppsRoute }) {
  const dispatch = useAppDispatch();
  const stream = useAppSelector(selectStream);
  const apps = useAppSelector(s => s.apps.items);
  const base = useAppSelector(s => s.apps.publicAppsBase);
  const stage = snapshotStage(stream);
  const counts = appsCounts(apps);
  const visible = visibleApps(apps, route);
  const go = (patch: Parameters<typeof withAppsFilters>[1]) => dispatch(routeTo(withAppsFilters(route, patch), { replace: true }));

  let body;

  if (stage === 'loading') {
    body = (
      <List narrow="tiles" busy>
        {SKELETON.map((w, i) => (
          <SkelRow key={i} widths={w} />
        ))}
      </List>
    );
  } else if (stage === 'failed') {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the apps" action="Retry" actionIcon="refresh-cw" onAction={() => dispatch(snapshotLoad())}>
        {stream.snapshot.error?.message}
      </Empty>
    );
  } else if (apps.length === 0) {
    body = (
      <Empty icon="layout-grid" title="No apps yet">
        Ask an agent to build a tracker, dashboard or form — it will show up here, and its code in the <Code>apps/</Code> folder.
      </Empty>
    );
  } else if (visible.length === 0) {
    body = (
      <Empty icon="layout-grid" title="No apps match" action="Reset filters" onAction={() => dispatch(routeTo({ key: 'apps' }, { replace: true }))}>
        {route.q ? `Nothing is named, described or stored like “${route.q}”` : 'Nothing is in this segment'}
        {route.filter === 'published' ? ' among the published apps.' : route.filter === 'errors' ? ' among the apps with errors.' : '.'}
      </Empty>
    );
  } else {
    body = (
      <List narrow="tiles">
        {visible.map(app => {
          const { address, href } = appLink(app, base);

          return (
            <AppRow
              key={app.path}
              actions
              title={appTitle(app)}
              desc={app.description ?? undefined}
              url={address === null ? undefined : appUrlText(address)}
              appHref={href ?? undefined}
              err={app.manifestError ?? undefined}
              folder={app.path}
              more={<AppMenu app={app} address={address} href={href} />}
            />
          );
        })}
      </List>
    );
  }

  return (
    <Shell current="apps" title="Apps">
      <Screen>
        <FBar
          filters={
            <Seg label="Apps">
              {SEGMENTS.map(segment => (
                <SegItem key={segment.label} label={segment.label} n={stage === 'ready' ? counts[segment.count] : undefined} sel={route.filter === segment.filter} onClick={() => go({ filter: segment.filter })} />
              ))}
            </Seg>
          }
          search={
            <Input
              value={route.q ?? ''}
              onChange={q => go({ q })}
              placeholder="Search apps"
              lead="search"
              ariaLabel="Search apps"
              end={route.q ? <IconBtn icon="x" label="Clear" size="sm" onClick={() => go({ q: undefined })} /> : undefined}
            />
          }
        />
        <Card narrow="bare">{body}</Card>
      </Screen>
    </Shell>
  );
}
