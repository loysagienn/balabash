// The design's "File Area" showcase in code: the workspace folder with the
// list and a Markdown preview side by side, a project folder with pinned
// files, files without a preview, the drop zone and the upload panel, the
// Markdown editor (wide and narrow), and the list and the preview at phone
// width. Store-free: a headless scene can mount it alone.

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Crumbs } from '../../ui/Crumbs/Crumbs.tsx';
import type { Crumb } from '../../ui/Crumbs/Crumbs.tsx';
import { Drop } from '../../ui/Drop/Drop.tsx';
import { FaBar, FaFoot, FaList, FaPreview, FaRows, FileArea, FileListHead } from '../../ui/FileArea/FileArea.tsx';
import { FileRow } from '../../ui/FileRow/FileRow.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { MdEditor } from '../../ui/MdEditor/MdEditor.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';
import { MetaCard } from '../../ui/MetaCard/MetaCard.tsx';
import { Pin, Pins } from '../../ui/Pins/Pins.tsx';
import { Pv, PvActBar, PvBody, PvHead, PvNote } from '../../ui/Pv/Pv.tsx';
import { Upload, UploadItem } from '../../ui/Upload/Upload.tsx';
import { Caption } from '../../ui/atoms/atoms.tsx';

const stop = (event: { preventDefault: () => void }) => event.preventDefault();
const crumbs = (...labels: string[]): Crumb[] => labels.map(label => ({ label, href: '#', onClick: stop }));

const BRIEF = `# Balabash — Web UI: a design brief from scratch

Design the entire Balabash web interface. A current interface exists, but **we don’t build on it**.

## What to do

1. Visual language: colors on semantic tokens, typography, grid, base components.
2. Every screen in two sizes: desktop 1440 and mobile ~390.
3. Key states: loading, empty, error, live updates.

> Priority: visual language → shell → home → thread → file area.`;

const INBOX = `## 2026-10-07 — contractors
- Estimate v3 arrived, 8% higher.
- Electrical work moves to **October 14**.
- To decide: bathroom tiles — matte or glossy?`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function RowMenu() {
  const [open, setOpen] = useState(false);

  return (
    <MenuAnchor
      open={open}
      onClose={() => setOpen(false)}
      menu={
        <Menu label="File actions">
          <MenuItem icon="download" label="Download" onClick={() => setOpen(false)} />
          <MenuItem icon="copy" label="Copy path" onClick={() => setOpen(false)} />
          <MenuSep />
          <MenuItem icon="trash-2" label="Delete" variant="danger" onClick={() => setOpen(false)} />
        </Menu>
      }
    >
      <IconBtn icon="ellipsis" label="File actions" size="sm" expanded={open} onClick={() => setOpen(!open)} />
    </MenuAnchor>
  );
}

function BriefPreview() {
  return (
    <Pv>
      <PvHead icon="file-text" name="web-redesign-brief.md" path="balabash/web-redesign-brief.md" meta={['6.2 KB', 'modified today, 13:02']}>
        <Btn label="Edit" icon="pencil" size="sm" />
        <IconBtn icon="download" label="Download" size="sm" />
        <IconBtn icon="copy" label="Copy path" size="sm" />
      </PvHead>
      <PvNote agent="coordinator" title="Web redesign task">
        for the designer agent: screens, principles, priorities. Left by coordinator, 13:02.
      </PvNote>
      <PvBody>
        <Md source={BRIEF} />
      </PvBody>
      <PvActBar>
        <Btn label="Edit" icon="pencil" />
        <Btn label="Download" icon="download" />
        <Btn label="Path" icon="copy" />
      </PvActBar>
    </Pv>
  );
}

function WorkspaceList() {
  return (
    <FaList>
      <FaBar
        end={
          <>
            <IconBtn icon="search" label="Search in folder" size="sm" />
            <Btn label="Upload" icon="upload" size="sm" />
            <IconBtn icon="ellipsis" label="More" size="sm" />
          </>
        }
      >
        <Crumbs items={crumbs('Files')} current="balabash" fa />
      </FaBar>
      <FileListHead />
      <FaRows>
        <FileRow name="design" dir caption="2 folders · 14 files" size="—" time="today" href="#" onClick={stop} />
        <FileRow name="decisions" dir caption="6 files" size="—" time="Oct 2" href="#" onClick={stop} />
        <FileRow name="AGENTS.md" caption="Project entry: folder map and rules" agent="gardener" size="1.1 KB" time="Oct 5" href="#" onClick={stop} more={<RowMenu />} />
        <FileRow name="inbox.md" caption="Inbox notes · 12 entries" agent="gardener" size="9.8 KB" time="16:51" href="#" onClick={stop} more={<RowMenu />} />
        <FileRow name="journal.md" caption="Project journal" agent="gardener" size="22 KB" time="yesterday" href="#" onClick={stop} more={<RowMenu />} />
        <FileRow name="web-redesign-brief.md" caption="Web redesign task" agent="coordinator" size="6.2 KB" time="13:02" selected href="#" onClick={stop} more={<RowMenu />} />
        <FileRow name="home-desktop-approved.png" icon="file-image" caption="Approved home reference" agent="designer" size="221 KB" time="14:31" href="#" onClick={stop} more={<RowMenu />} />
        <FileRow name="llm-usage-sept.csv" icon="file-spreadsheet" size="48 KB" time="Oct 1" href="#" onClick={stop} more={<RowMenu />} />
      </FaRows>
      <FaFoot>2 folders · 6 files · 307 KB</FaFoot>
    </FaList>
  );
}

function Editor({ narrow }: { narrow?: boolean }) {
  const [saved, setSaved] = useState(INBOX);
  const [value, setValue] = useState(INBOX);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    window.setTimeout(() => {
      setSaved(value);
      setBusy(false);
    }, 600);
  };

  return (
    <MdEditor
      path="renovation/inbox.md"
      value={value}
      onChange={setValue}
      dirty={value !== saved}
      busy={busy}
      onSave={save}
      onCancel={() => setValue(saved)}
      className={narrow ? 'dev-ed-narrow' : undefined}
    />
  );
}

export function DevUiFiles() {
  return (
    <>
      <Section title="File area: the workspace folder, both panels (split), a Markdown preview with the agent’s note; row actions on hover, focus and selection">
        <div className="dev-frame" style={{ height: 640 }}>
          <FileArea view="preview" split style={{ height: '100%' }}>
            <WorkspaceList />
            <FaPreview>
              <BriefPreview />
            </FaPreview>
          </FileArea>
        </div>
      </Section>

      <Section title="Inside a project: the path starts at the project, the three main files pinned above the list">
        <div className="dev-box">
          <FileArea view="list">
            <FaList>
              <FaBar end={<Btn label="Upload" icon="upload" size="sm" />}>
                <Crumbs items={[]} current="Renovation" lead="folder" fa />
              </FaBar>
              <Pins>
                <Pin icon="pin" name="AGENTS.md" desc="project entry · folder map" href="#" onClick={stop} />
                <Pin icon="inbox" name="inbox.md" desc="inbox · 3 new entries" href="#" onClick={stop} />
                <Pin icon="history" name="journal.md" desc="journal · updated yesterday" href="#" onClick={stop} />
              </Pins>
              <FaRows>
                <FileRow name="estimates" dir caption="4 files" size="—" time="today" href="#" onClick={stop} />
                <FileRow name="estimate-v3.xlsx" icon="file-spreadsheet" caption="Contractor estimate, version 3" agent="coordinator" size="84 KB" time="16:20" href="#" onClick={stop} more={<RowMenu />} />
                <FileRow name="work-schedule.md" caption="Stages and deadlines" agent="manager" size="3.4 KB" time="yesterday" href="#" onClick={stop} more={<RowMenu />} />
              </FaRows>
            </FaList>
          </FileArea>
        </div>
      </Section>

      <Section title="No preview: the metadata card with “Download” (an archive · a text file too large)">
        <div className="dev-grid">
          <div className="dev-box">
            <Pv>
              <PvHead icon="file-archive" name="backup-2026-10-06.zip" meta={['112 MB', 'modified yesterday, 04:00']}>
                <IconBtn icon="download" label="Download" size="sm" />
              </PvHead>
              <PvBody>
                <MetaCard icon="file-archive" name="backup-2026-10-06.zip" actions={<Btn label="Download" icon="download" size="sm" href="#" onClick={stop} />}>
                  Archive · 112 MB · modified yesterday, 04:00 · created by the “DB backup” task. No preview for this type.
                </MetaCard>
              </PvBody>
            </Pv>
          </div>
          <div className="dev-box">
            <Pv>
              <PvHead icon="file-text" name="server.log" path="data/server.log" meta={['48 MB']}>
                <IconBtn icon="download" label="Download" size="sm" />
              </PvHead>
              <PvBody>
                <MetaCard icon="file-text" name="server.log" actions={<Btn label="Download" icon="download" size="sm" href="#" onClick={stop} />}>
                  A 48 MB text file is too large to preview in the browser. Download it or ask an agent to find what you need.
                </MetaCard>
              </PvBody>
            </Pv>
          </div>
        </div>
      </Section>

      <Section title="Upload: the drop zone over the list while files are dragged · the progress panel (done, in progress, an error)">
        <div className="dev-grid">
          <div className="dev-box">
            <FileArea view="list">
              <FaList>
                <FaBar>
                  <Crumbs items={crumbs('Renovation')} current="estimates" fa />
                </FaBar>
                <FaRows>
                  <FileRow name="estimate-v2.xlsx" icon="file-spreadsheet" caption="80 KB · Sep 30" size="80 KB" time="Sep 30" href="#" onClick={stop} />
                  <FileRow name="estimate-v3.xlsx" icon="file-spreadsheet" caption="84 KB · today" size="84 KB" time="16:20" href="#" onClick={stop} />
                  <FileRow name="contractor-agreement.pdf" icon="file-type" caption="380 KB · yesterday" size="380 KB" time="yesterday" href="#" onClick={stop} />
                </FaRows>
              </FaList>
              <Drop path="Renovation/estimates" sub="3 files · 2.4 MB" />
            </FileArea>
          </div>
          <div className="dev-col">
            <Upload path="Renovation/estimates" onHide={() => undefined}>
              <UploadItem state="done" icon="file-image" name="kitchen-photo-1.jpg" status="done" />
              <UploadItem icon="file-image" name="kitchen-photo-2.jpg" status="1.3 of 2.1 MB" progress={62} />
              <UploadItem state="err" icon="file-archive" name="measurements-video.mov" status="over 100 MB" progress={100} />
            </Upload>
          </div>
        </div>
      </Section>

      <Section title="MdEditor: source and live preview side by side; “unsaved” appears on a change, ⌘S saves; narrower than 640 — one pane and the Edit / Preview switch">
        <Editor />
        <div className="dev-w" style={{ '--dev-w': '560px' } as CSSProperties}>
          <Editor narrow />
        </div>
        <Caption>edit the source — the preview follows, “Save” spins for a moment</Caption>
      </Section>

      <Section title="Files on the phone (390): the list keeps the tabs; the preview is a detail screen — the name is in the shell header, actions at the bottom">
        <div className="dev-row" style={{ alignItems: 'flex-start' }}>
          <div className="dev-phone">
            <div className="dev-shell">
              <FileArea view="list" style={{ flex: 1 }}>
                <FaList>
                  <FaBar end={<IconBtn icon="upload" label="Upload" size="sm" />}>
                    <Crumbs items={crumbs('Files', 'balabash')} current="design" fa />
                  </FaBar>
                  <FileListHead />
                  <FaRows>
                    <FileRow name="design-system" dir caption="9 files · today" href="#" onClick={stop} />
                    <FileRow name="style-direction" dir caption="8 files · today" href="#" onClick={stop} />
                    <FileRow name="web-redesign-brief.md" caption="Redesign task · 6.2 KB" agent="coordinator" size="6.2 KB" time="13:02" href="#" onClick={stop} more={<RowMenu />} />
                    <FileRow name="home-desktop-approved.png" icon="file-image" caption="Home reference · 221 KB" agent="designer" size="221 KB" time="14:31" href="#" onClick={stop} more={<RowMenu />} />
                    <FileRow name="tokens.css" icon="file-code" caption="7.6 KB" size="7.6 KB" time="16:40" href="#" onClick={stop} more={<RowMenu />} />
                  </FaRows>
                </FaList>
              </FileArea>
            </div>
          </div>
          <div className="dev-phone">
            <div className="dev-shell">
              <FileArea view="preview" style={{ flex: 1 }}>
                <FaPreview>
                  <BriefPreview />
                </FaPreview>
              </FileArea>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
