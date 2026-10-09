// The showcase (/dev/ui): every ported block in its variants and states,
// side by side with the design's showcases for checking by eye. Grows with
// each block that lands in ui/.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Shell } from '../../features/shell/Shell.tsx';
import { ActivityChip } from '../../ui/ActivityChip/ActivityChip.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { ICONS } from '../../ui/Icon/icons.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Attn, Caption, Code, Count, Kbd, Pulse, Quiet, Tag } from '../../ui/atoms/atoms.tsx';
import type { StateName } from '../../ui/atoms/atoms.tsx';
import './DevUi.css';

const STATES: StateName[] = ['run', 'wait', 'act', 'done', 'err', 'off'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="dev-row">
      {children}
      {label ? <Caption>{label}</Caption> : null}
    </div>
  );
}

export function DevUi() {
  const [text, setText] = useState('K7QM2X');
  const [area, setArea] = useState('');

  return (
    <Shell current={null} title="UI kit" sub="/dev/ui · blocks of the design system in code">
      <Screen>
        <Section title="Foundations · state context">
          <Row>
            {STATES.map(state => (
              <span key={state} className="dev-state" data-state={state}>
                {state}
              </span>
            ))}
          </Row>
          <Row label="identifiers 1–8 and you">
            {[1, 2, 3, 4, 5, 6, 7, 8, 'you'].map(id => (
              <span key={id} className="dev-id" data-id={id}>
                {id}
              </span>
            ))}
          </Row>
        </Section>

        <Section title="Icon">
          <Row label="xs · sm · default · md · lg · xl · spin">
            <Icon name="play" size="xs" />
            <Icon name="play" size="sm" />
            <Icon name="play" />
            <Icon name="play" size="md" />
            <Icon name="play" size="lg" />
            <Icon name="play" size="xl" />
            <Icon name="loader-circle" spin />
          </Row>
          <Row>
            {(Object.keys(ICONS) as IconName[]).map(name => (
              <span key={name} className="dev-icon" title={name}>
                <Icon name={name} />
                <Caption>{name}</Caption>
              </span>
            ))}
          </Row>
        </Section>

        <Section title="Btn · IconBtn">
          <Row label="regular · primary · ghost · danger">
            <Btn label="Save" />
            <Btn label="Save" variant="primary" />
            <Btn label="Save" variant="ghost" />
            <Btn label="Delete" variant="danger" icon="trash-2" />
          </Row>
          <Row label="sm · default · lg · with icon · icon after · kbd">
            <Btn label="Run" size="sm" icon="play" />
            <Btn label="Run" icon="play" />
            <Btn label="Run" size="lg" icon="play" />
            <Btn label="All threads" iconAfter="chevron-right" variant="ghost" />
            <Btn label="Search" icon="search" kbd="⌘K" />
          </Row>
          <Row label="busy · disabled · link">
            <Btn label="Signing in" variant="primary" busy />
            <Btn label="Save" disabled />
            <Btn label="Open" href="#" icon="external-link" />
          </Row>
          <Row label="icon buttons: ghost (default) · regular · sm">
            <IconBtn icon="ellipsis" label="More" />
            <IconBtn icon="x" label="Close" variant="regular" />
            <IconBtn icon="arrow-left" label="Back" size="sm" />
          </Row>
          <Row label="block">
            <div style={{ width: 280 }}>
              <Btn label="Sign in" variant="primary" block />
            </div>
          </Row>
        </Section>

        <Section title="Input · Field">
          <div className="dev-grid">
            <Field label="One-time code" fid="dev-code" hint="Mono input">
              <Input id="dev-code" value={text} onChange={setText} mono autoComplete="off" />
            </Field>
            <Field label="Search" fid="dev-search" opt="optional">
              <Input id="dev-search" value="" onChange={() => undefined} lead="search" placeholder="Search" end={<Kbd>⌘K</Kbd>} />
            </Field>
            <Field label="Slug" fid="dev-slug" err="Already taken">
              <Input id="dev-slug" value="balabash" onChange={() => undefined} pre="/p/" mono invalid />
            </Field>
            <Field label="Disabled" fid="dev-dis">
              <Input id="dev-dis" value="cannot edit" onChange={() => undefined} disabled />
            </Field>
            <Field label="Description" fid="dev-area" hintCode="Markdown">
              <Input as="textarea" id="dev-area" value={area} onChange={setArea} placeholder="A few lines" />
            </Field>
          </div>
        </Section>

        <Section title="Atoms">
          <Row label="count: plain · run · act · err · sm">
            <Count>12</Count>
            <Count state="run">4</Count>
            <Count state="act">3</Count>
            <Count state="err">1</Count>
            <Count size="sm" state="run">
              4
            </Count>
          </Row>
          <Row label="attn · pulse · pulse off · kbd · code · tag · quiet">
            <Attn />
            <Pulse />
            <Pulse off />
            <Kbd>⌘K</Kbd>
            <Code>npm run build</Code>
            <Tag>task</Tag>
            <Quiet>not published</Quiet>
          </Row>
        </Section>

        <Section title="Obj">
          <Row label="sm · md · default · lg · xl · state · dir">
            <Obj icon="file-text" size="sm" />
            <Obj icon="file-text" size="md" />
            <Obj icon="file-text" />
            <Obj icon="file-text" size="lg" />
            <Obj icon="file-text" size="xl" />
            {STATES.map(state => (
              <Obj key={state} icon="circle-alert" state={state} />
            ))}
            <Obj icon="folder" kind="dir" />
          </Row>
        </Section>

        <Section title="ActivityChip">
          <Row label="4 running · expanded · compact · all quiet">
            <ActivityChip running={4} />
            <ActivityChip running={4} expanded />
            <ActivityChip running={4} compact />
            <ActivityChip running={0} />
          </Row>
        </Section>

        <Section title="Empty">
          <div className="dev-grid">
            <div className="dev-box">
              <Empty icon="messages-square" title="Nothing running right now">
                Agents start threads when there is work.
              </Empty>
            </div>
            <div className="dev-box">
              <Empty icon="circle-alert" state="err" title="Couldn’t load threads" action="Try again" actionIcon="refresh-cw">
                HTTP 502 · the server did not answer.
              </Empty>
            </div>
          </div>
        </Section>
      </Screen>
    </Shell>
  );
}
