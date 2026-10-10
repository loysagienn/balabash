// Editing a Markdown file in place of its preview (design: FilesScreen,
// "editing .md — full width"; the editor at the full panel height). The
// content comes through the same Query as the preview — the text with the
// ETag of that read; the draft is this component's, keyed by the path
// alone, so a new version under it (an agent wrote, the node refetched)
// does not drop what was typed: the write names the version the draft
// started from, and a 412 is shown as a choice — overwrite, or cancel and
// see theirs. A save keeps the editor open over the new version, set from
// the answer (the node and the text — no second read); the folder's
// listing is invalidated for the new size and time. Cancel asks about a
// dirty draft, then leaves to the preview (the route without `edit`); the
// browser asks before unloading a dirty draft. The owner keeps this
// component mounted while the route says `edit`, whatever became of the
// file meanwhile (FileBrowser): a file gone or grown past the editable
// size under a draft is reported by the save that fails, not by dropping
// the draft.

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceFileMeta, WorkspaceNodeResponse } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import type { EtaggedText } from '../../lib/api/index.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { MdEditor } from '../../ui/MdEditor/MdEditor.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Pv, PvBody } from '../../ui/Pv/Pv.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { editorText, isDirty, saveFailure, saved, typed } from './editor.logic.ts';
import type { Draft, SaveFailure } from './editor.logic.ts';
import { parentOf } from './node.ts';
import { useWorkspaceText } from './queries.ts';
import './FileEditor.css';

const SKELETON = [90, 70, 80, 40];

export function FileEditor({ file, exitRoute }: { file: WorkspaceFileMeta; exitRoute: AppRoute }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const loaded = useWorkspaceText(file.path, file.modifiedAt, true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const text = editorText(draft, loaded.data?.text);
  const dirty = isDirty(draft, loaded.data?.text);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', ask);

    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  // etag — the content the write replaces; null overwrites whatever is there.
  const save = async (etag: string | null) => {
    if (!draft || saving) {
      return;
    }

    setSaving(true);
    setFailure(null);

    try {
      const answer = await api.workspace.write(file.path, draft.text, etag);
      const content: EtaggedText = { text: draft.text, etag: answer.etag };
      const node: WorkspaceNodeResponse = { kind: 'file', path: file.path, file: answer.file };

      queryClient.setQueryData(['workspace-text', file.path, answer.file.modifiedAt], content);
      queryClient.setQueryData(['workspace', file.path], node);
      void queryClient.invalidateQueries({ queryKey: ['workspace', parentOf(file.path)], exact: true });
      setDraft(current => saved(current, draft.text, answer.etag));
      dispatch(pushToast({ title: 'Saved', desc: file.path, state: 'done' }));
    } catch (error) {
      setFailure(saveFailure(error));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) {
      return;
    }

    // The preview shows the file as it is now — theirs, after a conflict:
    // the node and the text both, since the text is keyed by the node's
    // modification time and a replacement that kept it (cp -p, rsync -a)
    // would otherwise be shown from the cache, under its old ETag.
    void queryClient.invalidateQueries({ queryKey: ['workspace', file.path], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['workspace-text', file.path] });
    dispatch(routeTo(exitRoute, { replace: true }));
  };

  let body;

  if (loaded.data !== undefined) {
    body = (
      <MdEditor
        path={file.path}
        value={text}
        onChange={value => setDraft(current => typed(current, value, loaded.data?.etag ?? null))}
        onSave={() => void save(draft?.etag ?? null)}
        onCancel={cancel}
        dirty={dirty}
        busy={saving}
        autoFocus
        className="fil-ed"
      />
    );
  } else if (loaded.error) {
    body = (
      <PvBody>
        <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={() => void loaded.refetch()}>
          Couldn’t load the file: {loaded.error.message}
        </Note>
      </PvBody>
    );
  } else {
    body = (
      <PvBody>
        <div aria-busy="true">
          <SkelStack widths={SKELETON} />
        </div>
      </PvBody>
    );
  }

  return (
    <Pv>
      {failure ? (
        <div className="fil-ed-note">
          {failure.kind === 'conflict' ? (
            <Note state="err" icon="triangle-alert" role="alert" action="Overwrite" actionBusy={saving} onAction={() => void save(null)}>
              This file changed on disk since you opened it. Overwrite it with your text, or cancel to see the new content.
            </Note>
          ) : (
            <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={saving} onAction={() => void save(draft?.etag ?? null)}>
              Couldn’t save: {failure.message}
            </Note>
          )}
        </div>
      ) : null}
      {body}
    </Pv>
  );
}
