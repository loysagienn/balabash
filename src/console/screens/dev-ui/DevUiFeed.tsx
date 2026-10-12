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
import { ActGroup, Xp } from '../../ui/Xp/Xp.tsx';
import { Caption, Code } from '../../ui/atoms/atoms.tsx';

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

const CODE = `Uniqueness is better enforced by a DB index than by a check in code: otherwise two parallel publishes can take the same slug.

\`\`\`ts
// the index, not the check
await prisma.$executeRaw\`CREATE UNIQUE INDEX apps_slug ON apps (slug) WHERE published\`;
const n = 42;
\`\`\`

\`\`\`bash
npm run types && npm run build  # both must pass
\`\`\``;

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


// The rail of a wide thread (design: ThreadRail), with static data.
function Rail() {
  return (
    <ThreadRail>
      <div className="th-rail-id">
        <div className="th-rail-who">
          <Avatar agent="engineer" />
          <span className="th-rail-who-main">
            <b className="th-rail-who-t">engineer</b>
            <span className="th-rail-who-m">
              from{' '}
              <a href="#" onClick={stop}>
                coordinator
              </a>
            </span>
          </span>
          <IconBtn icon="link" label="Copy link" size="sm" />
        </div>
        <h2 className="th-rail-t">Mini-apps: publishing by slug</h2>
        <div className="th-rail-st">
          <Badge state="run" label="running" />
        </div>
      </div>
      <div className="th-rail-acts">
        <Btn label="Stop turn" icon="pause" size="sm" block />
        <Btn label="Cancel thread" icon="circle-stop" variant="danger" size="sm" block />
      </div>
      <RailSection title="Session">
        <KeyValue
          items={[
            { key: 'model', value: <Code>claude-opus-5-5</Code> },
            { key: 'engine', value: 'Claude · effort high' },
          ]}
        />
      </RailSection>
      <RailSection title="Context">
        <RailGauge value={62}>
          124k of 200k tokens
          <br />
          compacted once
        </RailGauge>
      </RailSection>
      <RailSection title="Project and time">
        <KeyValue
          items={[
            {
              key: 'project',
              value: (
                <a href="#" onClick={stop}>
                  Balabash
                </a>
              ),
            },
            { key: 'started', value: 'today, 14:02' },
            { key: 'running', value: '2h 36m' },
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
        running
        onStop={() => undefined}
        onCancel={() => undefined}
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
                <Label>commands and a tool error</Label>
                <ActGroup>
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
