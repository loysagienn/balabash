// The thread-feed part of the showcase (/dev/ui), after the design's
// "Thread Feed" showcase: a running thread with its rail, every feed item,
// a completed and a headless thread, the same thread at phone width. No
// store: the sections render on their own, so a headless check can mount
// them without the shell.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Att, AttThumb, Atts } from '../../ui/Att/Att.tsx';
import { AttDraft } from '../../ui/AttDraft/AttDraft.tsx';
import { Drop } from '../../ui/Drop/Drop.tsx';
import { ChildThread } from '../../ui/ChildThread/ChildThread.tsx';
import { Composer } from '../../ui/Composer/Composer.tsx';
import { ComposerLock } from '../../ui/Composer/ComposerLock.tsx';
import { ErrorBlock } from '../../ui/ErrorBlock/ErrorBlock.tsx';
import { EvLine } from '../../ui/EvLine/EvLine.tsx';
import { Feed } from '../../ui/Feed/Feed.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { Message } from '../../ui/Message/Message.tsx';
import { MsgQuiet } from '../../ui/Message/MsgQuiet.tsx';
import { Plan, PlanItem } from '../../ui/Plan/Plan.tsx';
import { Avatar } from '../../ui/Avatar/Avatar.tsx';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Subtask } from '../../ui/Subtask/Subtask.tsx';
import { Summary } from '../../ui/Summary/Summary.tsx';
import { SysLine } from '../../ui/SysLine/SysLine.tsx';
import { RailGauge, RailSection, Thread, ThreadBody, ThreadMain, ThreadRail } from '../../ui/Thread/Thread.tsx';
import { ThreadHead } from '../../ui/ThreadHead/ThreadHead.tsx';
import { ActGroup, Xp, actFold } from '../../ui/Xp/Xp.tsx';
import { Caption, Code, Tag } from '../../ui/atoms/atoms.tsx';
import type { StateName } from '../../ui/atoms/state.ts';

const stop = (event: { preventDefault: () => void }) => event.preventDefault();

// A gray 4:3 placeholder for image attachments.
const THUMB = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#2a2d33"/><rect x="24" y="22" width="112" height="56" rx="6" fill="#3a3e46"/></svg>')}`;

const TASK = `### Publishing mini-apps by slug

Let the user publish an app at \`/p/<slug>\` and unpublish it.

- the slug is set in the app settings and is unique across the system;
- unpublishing frees the slug;
- \`npm run types\` and \`npm run build\` must pass.

Agree on the URL scheme with the architect. Restart only through \`request_restart\`.

Follow-ups, so this message is long enough to fold:

1. the slug is validated as \`^[a-z][a-z0-9-]*$\`;
2. reserved words: \`api\`, \`p\`, \`login\`;
3. an old link to a freed slug returns 404 with the name of the app it used to point at.`;

const TABLE = `Done, the foundations are in the design system:

| file | what |
|---|---|
| \`tokens.css\` | all tokens |
| \`Foundations.dc.html\` | showcase |

A wide table scrolls inside the message instead of widening the feed:

| Commit | Status | Author | Date |
| --- | --- | --- | --- |
| \`981deb8f3e9f11a22acb6a19e2398d6a75c36abe\` | completed | engineer | 2026-10-09 |

- [x] tokens
- [ ] screens

~~Old plan~~ replaced. See https://example.com/design for the live version.`;

// A reasoning summary of Codex: one bold headline per section, the
// sections joined with single newlines by the CLI.
const SECTIONS = '**Refining review comments**\n**Locating current review thread**';

const REPORT = `Report on slugs. Only published apps need one: a draft is reached by its owner link, which stays private and never changes.

- The slug is unique across the apps domain — a database index, not a check in code, so two parallel publishes cannot take the same one.
- Unpublishing keeps the slug for 7 days, then frees it; during those days the old address answers with a redirect.
- Renaming an app does not change its slug; only the owner can change it, in Apps.

Open questions: reserved words (api, admin, static) and the length limit — I suggest 3 to 40 characters.`;

const CODE = `Uniqueness is better enforced by a DB index than by a check in code: otherwise two parallel publishes can take the same slug.

\`\`\`ts
// the index, not the check
await prisma.$executeRaw\`CREATE UNIQUE INDEX apps_slug ON apps (slug) WHERE published\`;
const n = 42;
\`\`\`

\`\`\`bash
npm run types && npm run build  # both must pass
\`\`\``;

// Rows of the folded group above, for actFold: four top-level actions.
const FOLD_ROWS = [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="dev-row">
      <Caption>{children}</Caption>
    </div>
  );
}


const RAIL_LABEL: Record<StateName, string> = { run: 'running', wait: 'awaiting message', act: 'action needed', paused: 'paused', done: 'completed', err: 'crashed', off: 'cancelled' };

type RailProps = {
  agent?: string;
  title?: string;
  state?: StateName;
  // A remote thread: the tag, Pause beside Stop turn, no context, the notes.
  remote?: boolean;
  // A finish already asked: "Finish requested" and its note.
  finish?: boolean;
};

// The rail of a wide thread (design: ThreadRail), with static data: the
// controls in two groups — the turn (Stop turn; remote: Stop turn · Pause),
// the thread (Finish / Finish requested, Cancel) — the ones that do not
// apply disabled; a remote thread asleep or closed notes its session.
function Rail({ agent = 'engineer', title = 'Mini-apps: publishing by slug', state = 'run', remote, finish }: RailProps) {
  const active = state === 'run' || state === 'wait' || state === 'act' || state === 'paused';
  const note = remote && state === 'paused' ? 'Asleep: the session is checked every 15 minutes. A message, or activity in the external system, wakes it.' : remote && (state === 'done' || state === 'off') ? 'The session itself stays open in the external system — ending the thread doesn’t close it.' : null;
  const finishNote = remote
    ? 'Asked at 15:31 — the session writes a closing summary and the thread ends with it; with no summary by 15:41, it ends with the session’s last words.'
    : 'Asked at 15:31 — the agent finishes its turn, wraps up and ends the thread with its report. To stop at once, cancel the thread.';

  return (
    <ThreadRail>
      <div className="th-rail-id">
        <div className="th-rail-who">
          <Avatar agent={agent} />
          <span className="th-rail-who-main">
            <b className="th-rail-who-t">{agent}</b>
            <span className="th-rail-who-m">
              from{' '}
              <a href="#" onClick={stop}>
                coordinator
              </a>
            </span>
          </span>
          <IconBtn icon="link" label="Copy link" size="sm" />
        </div>
        <h2 className="th-rail-t">{title}</h2>
        <div className="th-rail-st">
          <Badge state={state} label={RAIL_LABEL[state]} />
          {remote ? <Tag>remote</Tag> : null}
        </div>
        {note ? <p className="th-rail-note">{note}</p> : null}
      </div>
      {active ? (
        <div className="th-rail-acts">
          <div className="th-rail-turn" data-split={remote ? '' : undefined}>
            <Btn label="Stop turn" icon="square" block disabled={state !== 'run'} />
            {remote ? <Btn label="Pause" icon="moon" block disabled={state !== 'wait' || finish} /> : null}
          </div>
          <div className="th-rail-end">
            {finish ? <Btn label="Finish requested" icon="hourglass" block disabled /> : <Btn label="Finish thread" icon="flag" block />}
            <Btn label="Cancel thread" icon="circle-stop" variant="danger-line" block />
            {finish ? <p className="th-rail-note">{finishNote}</p> : null}
          </div>
        </div>
      ) : null}
      <RailSection title="Session">
        <KeyValue
          items={[
            { key: 'model', value: <Code>{remote ? 'claude-code' : 'claude-opus-5-5'}</Code> },
            { key: 'engine', value: remote ? 'Remote' : 'Claude · effort high' },
          ]}
        />
      </RailSection>
      {remote ? null : (
        <RailSection title="Context">
          <RailGauge value={62}>
            124k of 200k tokens
            <br />
            compacted once
          </RailGauge>
        </RailSection>
      )}
      <RailSection title="Project and time">
        <KeyValue
          items={[
            {
              key: 'project',
              value: (
                <a href="#" onClick={stop}>
                  {remote ? 'Caloriu' : 'Balabash'}
                </a>
              ),
            },
            { key: 'started', value: remote ? 'today, 14:20' : 'today, 14:02' },
            { key: 'running', value: remote ? '1h 12m' : '2h 36m' },
          ]}
        />
      </RailSection>
    </ThreadRail>
  );
}

function RunningThread({ phone }: { phone?: boolean }) {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  return (
    <Thread style={phone ? { height: '100%' } : undefined}>
      <ThreadHead
        title="Mini-apps: publishing by slug"
        state="run"
        ctx={{ percentage: 62, usedTokens: 124_000, maxTokens: 200_000 }}
        controls={{ stop: { onClick: () => undefined }, pause: null, finish: { onClick: () => undefined } }}
        onMore={() => undefined}
      />
      <ThreadBody>
        <ThreadMain>
          <Feed align={phone ? 'end' : undefined}>
            {phone ? <SysLine>Earlier · 23 events</SysLine> : null}
            {!phone ? (
              <>
                <Message agent="coordinator" to="engineer" variant="task" time="14:02" tag="task" fold>
                  <Md source={TASK} />
                </Message>
                <ActGroup>
                  <Xp state="done" icon="brain" end="14s" text="Thought" />
                  <Xp state="done" icon="files" end="6 calls · 1.2s" text="Read 6 files in" textArg="src/api/apps" />
                </ActGroup>
                <MsgQuiet>
                  <Md
                    quiet
                    source="Publishing partly exists in `apps.ts` already; the slug uniqueness check is missing. I’ll ask the architect to review the URL scheme."
                  />
                </MsgQuiet>
                <ChildThread
                  agent="architect"
                  title="Public URL scheme (slug)"
                  sub="architect agent started · 14:09 → 14:31"
                  state="done"
                  href="#"
                  onOpen={stop}
                >
                  <strong>Summary:</strong> the slug is globally unique; <Code>api</Code>, <Code>p</Code>,{' '}
                  <Code>login</Code> are reserved. On unpublish the slug is not freed right away — the user decides.
                </ChildThread>
                <Message agent="engineer" to="coordinator" time="14:33">
                  <Md source="Scheme agreed with the architect, starting implementation. About 40 minutes." />
                </Message>
                <Plan done={2} total={5}>
                  <PlanItem state="done">Review current publishing</PlanItem>
                  <PlanItem state="done">Agree on the URL scheme</PlanItem>
                  <PlanItem state="run">Uniqueness check and delayed slug release</PlanItem>
                  <PlanItem>Migration: unique index</PlanItem>
                  <PlanItem>
                    <Code>npm run types</Code> and <Code>build</Code>
                  </PlanItem>
                </Plan>
                <SysLine icon="minimize-2">Context compacted: 182k → 41k tokens</SysLine>
                <Subtask
                  kind="subagent"
                  state="done"
                  meta={['18k tokens', '12 calls', '0:41']}
                  lastCode="Grep publishedSlug"
                >
                  Find all references to <Code>publishedSlug</Code>
                </Subtask>
                <EvLine icon="rotate-ccw" state="act">
                  API error 529 · retry 2 of 5 in 8s
                </EvLine>
              </>
            ) : null}
            <Message
              agent="engineer"
              to="you"
              you="Vladimir"
              variant="ask"
              time="15:12"
              quick={['Right away', 'Hold 7 days']}
              onQuick={reply => setDraft(reply)}
            >
              <Md source="Decision needed: on unpublish, free the slug right away or hold it for the app for 7 days, so old links don’t pass to someone else?" />
            </Message>
            <Message agent="you" to="engineer" you="Vladimir" variant="user" time="15:20">
              <Md source="Hold it for 7 days, then free it automatically." />
            </Message>
            <MsgQuiet>
              <Md quiet source="Got it. Adding a `released_at` field and a background cleanup." />
            </MsgQuiet>
            <ActGroup>
              <Xp
                state="done"
                icon="file-pen-line"
                add="+38"
                del="−6"
                end="0.1s"
                tool="Edit"
                arg="src/api/apps/slug.ts"
              >
                <Md
                  quiet
                  source={'```diff\n- const slug = input.slug;\n+ const slug = normalizeSlug(input.slug);\n```'}
                />
              </Xp>
              <Xp
                state="done"
                icon="file-pen-line"
                add="+14"
                end="0.1s"
                tool="Write"
                arg="migrations/0042_slug_release.sql"
              />
              <Xp state="run" endState="run" end="0:12" tool="Bash" arg="npm run types" />
            </ActGroup>
            {phone ? (
              <Plan done={2} total={5}>
                <PlanItem state="run">Delayed slug release</PlanItem>
                <PlanItem>Migration: unique index</PlanItem>
              </Plan>
            ) : null}
            {sent ? (
              <SysLine icon="check" state="done">
                Sent from the showcase: {sent}
              </SysLine>
            ) : null}
          </Feed>
          <Composer
            to="engineer"
            value={draft}
            onChange={setDraft}
            onFiles={() => undefined}
            onSend={text => {
              setSent(text);
              setDraft('');
            }}
          />
        </ThreadMain>
        <Rail />
      </ThreadBody>
    </Thread>
  );
}

function CompletedThread() {
  return (
    <Thread>
      <ThreadHead title="Web redesign: choosing a style" state="done" ctx={{ percentage: 71, usedTokens: 142_000, maxTokens: 200_000 }} onMore={() => undefined} />
      <ThreadBody>
        <ThreadMain>
          <Feed>
            <Summary time="13:59">
              <Md source="The overall visual style is approved: shell G1 + layout M, neutral gray palette, rings, Inter +0.012em. The style is recorded in `balabash/design/style-direction/`; rejected variants are removed." />
              <Atts>
                <AttThumb src={THUMB} alt="home-desktop.png" href="#" onClick={stop} />
                <Att icon="file-text" file="README.md" size="4 KB" href="#" onClick={stop} />
                <Att icon="file-code" file="tokens.css" size="2 KB" href="#" onClick={stop} />
              </Atts>
            </Summary>
            <SysLine>Feed · 48 events</SysLine>
            <Message agent="coordinator" to="designer" variant="task" time="13:17" tag="task">
              <Md source="Make the home screen in five styles with the same content…" />
            </Message>
            <ActGroup>
              <Xp state="done" icon="brain" end="9s" text="Thought" />
            </ActGroup>
          </Feed>
          <ComposerLock icon="lock">
            Thread completed. To continue, ask the coordinator to start a new thread.
          </ComposerLock>
        </ThreadMain>
      </ThreadBody>
    </Thread>
  );
}

export function DevUiFeed() {
  const [stopped, setStopped] = useState('Leave the migrations alone, show me the plan first');

  return (
    <>
      <Section title="Thread · running (feed, composer, rail; ≤ 900 px the glass strip replaces the rail, ≤ 560 Stop/Cancel leave the strip)">
        <div className="dev-frame">
          <RunningThread />
        </div>
      </Section>

      <Section title="Thread · loading header">
        <div className="dev-frame">
          <Thread>
            <ThreadHead title="" state="run" loading />
          </Thread>
        </div>
      </Section>

      <Section title="Ending a thread · remote agents (design: Thread Feed §06) — the rail in four states, a remote agent’s questions, the feed lines">
        <div className="dev-grid" data-wide="">
          <div className="dev-frame dev-rail">
            <Label>rail · running</Label>
            <Rail />
          </div>
          <div className="dev-frame dev-rail">
            <Label>rail · finish requested</Label>
            <Rail state="wait" finish />
          </div>
          <div className="dev-frame dev-rail">
            <Label>rail · remote, awaiting message</Label>
            <Rail agent="cloud_agent" title="Flaky e2e: checkout timeout" state="wait" remote />
          </div>
          <div className="dev-frame dev-rail">
            <Label>rail · remote, paused</Label>
            <Rail agent="cloud_agent" title="Flaky e2e: checkout timeout" state="paused" remote />
          </div>
        </div>
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>approval — options as quick replies, a link into the system</Label>
                <Message agent="cloud_agent" to="you" you="Vladimir" variant="ask" tag="approval" time="15:44" quick={['Approve', 'Reject']} link={{ href: '#', label: 'Open in the external system' }}>
                  <Md source="Apply the migration `0042_slug_release` to the staging database?" />
                </Message>
                <Label>sign-in — only by its link</Label>
                <Message agent="cloud_agent" to="you" you="Vladimir" variant="ask" tag="sign-in" time="15:46" link={{ href: '#', label: 'Sign in', variant: 'primary' }}>
                  <Md source="The GitHub token of the workspace has expired — sign in again to continue." />
                </Message>
                <Label>decided here</Label>
                <Message agent="cloud_agent" to="you" you="Vladimir" variant="ask" tag="approval" time="15:44" decided="Decided: Approve · Vladimir, 15:45">
                  <Md source="Apply the migration `0042_slug_release` to the staging database?" />
                </Message>
                <Label>closed in the external system</Label>
                <Message agent="cloud_agent" to="you" you="Vladimir" variant="ask" tag="question" time="15:50" decided="Closed in the external system: skip flaky test">
                  <Md source="Quarantine the test or keep retrying it?" />
                </Message>
              </Feed>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>a reply written in the external system</Label>
                <Message agent="marta" to="cloud_agent" tag="external" time="15:52">
                  <Md source="Use the retry helper from `e2e/utils`, don’t add sleeps." />
                </Message>
                <Label>system lines</Label>
                <SysLine icon="flag" level="normal">
                  Vladimir asked the agent to finish the thread — it wraps up and ends with its report
                </SysLine>
                <SysLine icon="square" level="normal">
                  Vladimir stopped the turn — the agent halted and is awaiting a message
                </SysLine>
                <SysLine icon="moon" level="normal">
                  Vladimir paused the thread
                </SysLine>
                <SysLine icon="info" level="normal">
                  The thread was not paused: the session is working — stop the turn first.
                </SysLine>
                <SysLine icon="triangle-alert" level="urgent">
                  Needs your decision: apply the migration to staging?
                </SysLine>
                <SysLine icon="eye-off" level="urgent">
                  The session cannot be watched: the external system answers 503
                </SysLine>
                <SysLine icon="eye" level="normal">
                  The session is watched again.
                </SysLine>
                <SysLine icon="info" level="normal">
                  The thread is finishing — the message was not passed on.
                </SysLine>
                <Label>the session is gone</Label>
                <ErrorBlock icon="unplug" title="The remote session is gone">
                  The external system no longer has this session, so the thread ended. The parent thread was notified.
                </ErrorBlock>
              </Feed>
            </Thread>
          </div>
        </div>
      </Section>

      <Section title="Action groups fold (design: Thread Feed §02) — a group of two or more actions folds to its last one; the counter shows the earlier ones">
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>folded — the default: the last action, the earlier ones in the counter</Label>
                <ActGroup fold={actFold(FOLD_ROWS)}>
                  <Xp state="done" icon="brain" end="9s" text="Thought" />
                  <Xp state="done" icon="files" end="3 calls · 0.4s" text="Read 3 files in" textArg="src/api/apps" />
                  <Xp state="done" icon="file-pen-line" add="+38" del="−6" end="0.1s" tool="Edit" arg="src/api/apps/slug.ts" />
                  <Xp state="done" icon="square-terminal" end="exit 0 · 4.2s" tool="Bash" arg="npm run build" />
                </ActGroup>
                <Label>folded, running — the running action is the row; each finished one moves into the counter</Label>
                <ActGroup fold={{ at: 3, earlier: 3, failed: 0 }}>
                  <Xp state="done" icon="brain" end="6s" text="Thought" />
                  <Xp state="done" icon="file-pen-line" add="+12" end="0.1s" tool="Edit" arg="prisma/schema.prisma" />
                  <Xp state="done" icon="file-pen-line" add="+14" end="0.1s" tool="Write" arg="migrations/0042_slug_release.sql" />
                  <Xp state="run" endState="run" end="0:12" tool="Bash" arg="npm run types" />
                </ActGroup>
                <Label>folded — a folded action failed: the counter says so</Label>
                <ActGroup fold={{ at: 2, earlier: 2, failed: 1 }}>
                  <Xp state="err" icon="square-terminal" endState="err" end="exit 1 · 12.0s" tool="Bash" arg="npm test -- publish" />
                  <Xp state="done" icon="file-pen-line" add="+3" del="−1" end="0.1s" tool="Edit" arg="publish.test.ts" />
                  <Xp state="done" icon="square-terminal" end="exit 0 · 11.4s" tool="Bash" arg="npm test -- publish" />
                </ActGroup>
              </Feed>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>batch summary last — its nested calls stay with it; the counter counts top-level actions</Label>
                <ActGroup fold={{ at: 2, earlier: 2, failed: 0 }}>
                  <Xp state="done" icon="brain" end="9s" text="Thought" />
                  <Xp state="done" icon="square-terminal" end="exit 0 · 4.2s" tool="Bash" arg="npm run build" />
                  <Xp state="done" icon="files" end="3 calls · 0.4s" text="Read 3 files in" textArg="src/api/apps" />
                  <Xp state="done" icon="file-text" end="0.1s" depth={1} tool="Read" arg="index.ts" />
                  <Xp state="done" icon="file-text" end="0.1s" depth={1} tool="Read" arg="publish.ts" />
                </ActGroup>
                <Label>folded — the last action’s details open; the counter keeps to its row</Label>
                <ActGroup fold={{ at: 3, earlier: 3, failed: 0 }}>
                  <Xp state="done" icon="brain" end="9s" text="Thought" />
                  <Xp state="done" icon="files" end="3 calls · 0.4s" text="Read 3 files in" textArg="src/api/apps" />
                  <Xp state="done" icon="file-pen-line" add="+38" del="−6" end="0.1s" tool="Edit" arg="src/api/apps/slug.ts" />
                  <Xp state="done" icon="square-terminal" end="exit 0 · 4.2s" defaultOpen tool="Bash" arg="npm run build">
                    <Md quiet source="Build finished: 3 bundles, no warnings." />
                  </Xp>
                </ActGroup>
                <Label>one action — no counter</Label>
                <ActGroup fold={actFold([{ state: 'done' }])}>
                  <Xp state="done" icon="brain" end="9s" text="Thought" />
                </ActGroup>
              </Feed>
            </Thread>
          </div>
        </div>
      </Section>

      <Section title="System lines — one line always (design: Thread Feed §02): a longer text ends in an ellipsis and the line is a button that shows it whole">
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>fits — a plain separator</Label>
                <SysLine icon="flag" level="normal">
                  Stage 2 of 3 — database migration
                </SysLine>
                <SysLine icon="key-round" state="act">
                  Yandex.Direct: sign-in required
                </SysLine>
                <Label>a longer text — one line, an ellipsis; the line is a button, pressed it shows the whole text under the rule</Label>
                <SysLine icon="circle-slash" level="normal">
                  Thread cancelled by Vladimir — a duplicate of the publishing thread; the work moved to “Mini-apps v2”, where the slug table and the
                  public route are already done
                </SysLine>
                <SysLine icon="triangle-alert" level="urgent">
                  Needs your decision: apply the migration 0042_slug_release to the staging database, or wait for the review of the slug table first?
                </SysLine>
              </Feed>
            </Thread>
          </div>
        </div>
      </Section>

      <Section title="Feed items">
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>agent reply to you · tables (one wide), task list, strikethrough, autolink, attachments (one long name)</Label>
                <Message agent="designer" to="you" time="16:02">
                  <Md source={TABLE} />
                  <Atts>
                    <AttThumb src={THUMB} alt="screenshot 1440" href="#" onClick={stop} />
                    <Att icon="file-text" file="README.md" size="7 KB" href="#" onClick={stop} />
                    <Att
                      icon="file-text"
                      file="balabash-console-thread-feed-review-981deb8f3e9f11a22acb6a19e2398d6a75c36abe.md"
                      size="12 KB"
                      href="#"
                      onClick={stop}
                    />
                  </Atts>
                </Message>
                <Label>from a child agent · question</Label>
                <Message agent="architect" to="engineer" variant="task" time="14:18">
                  <Md source="Do unpublished apps need a slug, or only published ones?" />
                </Message>
                <Label>a child agent’s report · folded behind “Show more” — on the page, no card: the body fades to transparent</Label>
                <Message agent="architect" to="engineer" time="14:31" fold>
                  <Md source={REPORT} />
                </Message>
                <Label>interim text — quieter, no header</Label>
                <MsgQuiet>
                  <Md quiet source="Checking where else the old field is used…" />
                </MsgQuiet>
              </Feed>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>thinking — expanded, with highlighted code</Label>
                <ActGroup>
                  <Xp state="done" icon="brain" end="14s" defaultOpen text="Thought">
                    <Md quiet breaks source={CODE} />
                  </Xp>
                </ActGroup>
                <Label>thinking — Codex, two sections on their own lines</Label>
                <ActGroup>
                  <Xp state="done" icon="brain" end="6.0s" defaultOpen text="Thought">
                    <Md quiet breaks source={SECTIONS} />
                  </Xp>
                </ActGroup>
                <Label>batch summary — expanded</Label>
                <ActGroup>
                  <Xp state="done" icon="files" end="3 calls · 0.4s" text="Read 3 files in" textArg="src/api/apps" />
                  <Xp state="done" icon="file-text" end="0.1s" depth={1} tool="Read" arg="index.ts" />
                  <Xp state="done" icon="file-text" end="0.1s" depth={1} tool="Read" arg="publish.ts" />
                  <Xp state="done" icon="file-text" end="0.2s" depth={1} tool="Read" arg="manifest.ts" />
                </ActGroup>
                <Label>commands and a tool error — open</Label>
                <ActGroup fold={{ at: 3, earlier: 3, failed: 2 }}>
                  <Xp state="done" icon="square-terminal" end="exit 0 · 4.2s" tool="Bash" arg="npm run build" />
                  <Xp
                    state="err"
                    icon="square-terminal"
                    endState="err"
                    end="exit 1 · 12.0s"
                    tool="Bash"
                    arg="npm test -- publish"
                  >
                    <Md quiet source={'```\n$ npm test -- publish\n✖ publish › frees the slug after 7 days\n```'} />
                  </Xp>
                  <Xp
                    state="err"
                    icon="globe"
                    endState="err"
                    end="403 · 0.8s"
                    tool="WebFetch"
                    arg="direct.yandex.ru/reports"
                  />
                  <Xp state="off" icon="square-terminal" endState="off" end="cancelled" tool="Bash" arg="sleep 600" />
                </ActGroup>
                <Label>subagent — running</Label>
                <Subtask
                  kind="background task"
                  state="run"
                  meta={['6k tokens', '4 calls', '1:12']}
                  lastCode="Bash npm test"
                >
                  Run the publishing e2e tests
                </Subtask>
                <Label>child thread — just started</Label>
                <ChildThread
                  agent="browser"
                  title="Checking /p/kcal in the browser"
                  sub="browser agent started · 15:40"
                  state="wait"
                  href="#"
                  onOpen={stop}
                />
              </Feed>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>system lines: a divider is a thread event, an indented line is an event inside a turn</Label>
                <SysLine icon="flag" level="normal">
                  Stage 2 of 3 — database migration
                </SysLine>
                <SysLine icon="bell-off">Quiet · agent appended to journal.md</SysLine>
                <SysLine icon="bell" level="normal">
                  Normal · estimate updated
                </SysLine>
                <SysLine icon="bell-ring" level="urgent">
                  Urgent · contractor awaits a reply by 18:00
                </SysLine>
                <SysLine icon="minimize-2">Context compacted: 182k → 41k tokens</SysLine>
                <SysLine icon="clock">Task “Morning digest” fired · 09:00</SysLine>
                <SysLine icon="plug">Gmail · loysagienn connected</SysLine>
                <SysLine icon="key-round" state="act">
                  Yandex.Direct: sign-in required
                </SysLine>
                <EvLine icon="rotate-ccw" state="act">
                  API error 529 · retry 2 of 5 in 8s
                </EvLine>
                <EvLine icon="message-square-reply">Message from coordinator delivered mid-turn</EvLine>
              </Feed>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <Label>errors: a tinted block, no solid fill</Label>
                <ErrorBlock icon="circle-alert" title="Turn stopped by an error" action="Retry turn" action2="Details">
                  Session exited with code 1: <Code wrap>ECONNRESET</Code> on an API request. The agent is awaiting a
                  message.
                </ErrorBlock>
                <ErrorBlock icon="shield-x" title="Permission denied">
                  <Code>Bash</Code> · <Code wrap>rm -rf data/workspace</Code> — command outside the allowed scope.
                </ErrorBlock>
                <ErrorBlock icon="octagon-x" title="Model refused to answer">
                  stop_reason: <Code>refusal</Code>. Rephrase the task or switch agents.
                </ErrorBlock>
                <ErrorBlock icon="triangle-alert" title="System exception">
                  <Code wrap>TypeError: Cannot read properties of undefined (reading 'slug')</Code> in{' '}
                  <Code>apps/publish.ts:118</Code>
                </ErrorBlock>
              </Feed>
            </Thread>
          </div>
        </div>
      </Section>

      <Section title="Completed thread: the summary first; the composer is a plate">
        <div className="dev-frame">
          <CompletedThread />
        </div>
      </Section>

      <Section title="Headless thread · turn stopped">
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <ComposerLock icon="eye-off">
                <strong>Headless thread</strong> — the gardener talks only to its parent thread. You can’t write here,
                but everything is visible.
              </ComposerLock>
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Feed>
                <SysLine icon="pause" level="normal">
                  You stopped the turn at 15:31 — the agent halted and is awaiting a message
                </SysLine>
              </Feed>
              <Composer to="engineer" value={stopped} onChange={setStopped} onSend={() => setStopped('')} busy />
            </Thread>
          </div>
        </div>
      </Section>

      <Section title="Attachments (rule 23): your messages with files — with text and files only; the draft uploading (Send waits), a pasted image, a refused send, files dropped on the thread, the phone">
        <div className="dev-frame">
          <Thread>
            <ThreadBody>
              <ThreadMain>
                <Feed align="end">
                  <Message agent="you" to="manager" variant="user" time="17:04">
                    <Md source="Here are the walls and the tile invoice" />
                    <Atts>
                      <AttThumb src={THUMB} alt="kitchen-wall-a.jpg" href="#" onClick={stop} />
                      <AttThumb src={THUMB} alt="kitchen-wall-b.jpg" href="#" onClick={stop} />
                      <Att icon="file-type" file="tile-invoice.pdf" size="120 KiB" href="#" onClick={stop} />
                    </Atts>
                  </Message>
                  <Message agent="you" to="manager" variant="user" time="17:06">
                    <Atts>
                      <AttThumb src={THUMB} alt="kitchen-wall-c.jpg" href="#" onClick={stop} />
                    </Atts>
                  </Message>
                </Feed>
                <Composer
                  to="manager"
                  value="And the old tile layout, in case it helps"
                  onChange={() => undefined}
                  onSend={() => undefined}
                  onFiles={() => undefined}
                  wait="Uploading 1 file…"
                  attachments={
                    <>
                      <AttDraft name="old-layout-scan.jpg" preview={THUMB} status="1.3 of 2.1 MiB" progress={62} onRemove={() => undefined} />
                      <AttDraft name="tile-catalog-2026.pdf" icon="file-type" status="4.8 MiB" state="done" onRemove={() => undefined} />
                      <AttDraft name="site-survey.zip" icon="file-archive" status="Connection lost" state="err" onRetry={() => undefined} onRemove={() => undefined} />
                    </>
                  }
                />
              </ThreadMain>
            </ThreadBody>
          </Thread>
        </div>
        <div className="dev-grid" data-wide="">
          <div className="dev-frame">
            <Thread>
              <Composer
                to="manager"
                value=""
                onChange={() => undefined}
                onSend={() => undefined}
                onFiles={() => undefined}
                wait="Uploading 2 files…"
                attachments={
                  <>
                    <AttDraft name="pasted-17-08.png" preview={THUMB} status="0.2 of 0.4 MiB" progress={45} onRemove={() => undefined} />
                    <AttDraft name="a-very-long-name-of-the-old-layout-scan-from-the-archive.jpg" preview={THUMB} status="0.4 of 2.1 MiB" progress={18} onRemove={() => undefined} />
                  </>
                }
              />
            </Thread>
          </div>
          <div className="dev-frame">
            <Thread>
              <Composer
                to="manager"
                value="Wall C again, from the window side"
                onChange={() => undefined}
                onSend={() => undefined}
                onFiles={() => undefined}
                ready
                refusal={{ text: 'Not sent — 1 file was not accepted. Remove it and send again.' }}
                attachments={
                  <>
                    <AttDraft name="kitchen-wall-c2.jpg" preview={THUMB} status="2.4 MiB" state="done" onRemove={() => undefined} />
                    <AttDraft name="tile-invoice.pdf" icon="file-type" status="Not accepted" state="err" retry={false} onRemove={() => undefined} />
                  </>
                }
              />
            </Thread>
          </div>
          <div className="dev-frame" style={{ minHeight: 220 }}>
            <Thread>
              <ThreadBody>
                <ThreadMain>
                  <Feed>
                    <SysLine icon="check">Files dragged over the thread</SysLine>
                  </Feed>
                  <Composer to="manager" value="" onChange={() => undefined} onSend={() => undefined} onFiles={() => undefined} ready attachments={<AttDraft name="kitchen-window-wall.jpg" preview={THUMB} status="2.3 MiB" state="done" onRemove={() => undefined} />} />
                  <Drop label="Drop to attach to your message" sub="2 files · to manager" />
                </ThreadMain>
              </ThreadBody>
            </Thread>
          </div>
        </div>
        <div className="dev-phone">
          <Thread>
            <Feed align="end">
              <SysLine icon="check">Phone: the chips are one row that scrolls sideways</SysLine>
            </Feed>
            <Composer
              to="manager"
              value="And the old tile layout, in case it helps"
              onChange={() => undefined}
              onSend={() => undefined}
              onFiles={() => undefined}
              wait="Uploading 1 file…"
              refusal={{ text: 'Not sent — the thread has completed. Your text and files are kept.', action: 'Copy text', actionIcon: 'copy', onAction: () => undefined }}
              attachments={
                <>
                  <AttDraft name="site-survey.zip" icon="file-archive" status="Connection lost" state="err" onRetry={() => undefined} onRemove={() => undefined} />
                  <AttDraft name="old-layout-scan.jpg" preview={THUMB} status="1.3 of 2.1 MiB" progress={62} onRemove={() => undefined} />
                  <AttDraft name="tile-catalog-2026.pdf" icon="file-type" status="4.8 MiB" state="done" onRemove={() => undefined} />
                </>
              }
            />
          </Thread>
        </div>
      </Section>

      <Section title="Thread at phone width (390): compact header, no avatars, feed at the bottom, round “Send”">
        <div className="dev-phone">
          <RunningThread phone />
        </div>
      </Section>
    </>
  );
}
