// The thread's composer with its draft (design: Composer, AttDraft, rule
// 23): the text of the store's draft, the files attached to it — each
// uploading the moment it is picked (the paperclip, a paste, a drop on the
// thread — the page hands those in through attachFiles), Send waiting while
// any uploads, a message of files alone — and the refusal of the last send
// above the box. A closed thread is the lock plate, unless a send was just
// refused for it: then the draft stays on screen with the reason and "Copy
// text" (the files are kept in storage).

import type { Thread } from '../../../core/contract.ts';
import { useCopy } from '../../features/clipboard/useCopy.ts';
import { fileSize } from '../../lib/format/index.ts';
import { pick } from '../../lib/upload/pick.ts';
import { attachFiles, removeAttachment, uploadAttachment } from '../../store/attachments/actions.ts';
import { draftFiles, selectDraftAttachments, selectSendRefusal } from '../../store/attachments/selectors.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { sendMessage } from '../../store/threads/actions.ts';
import { openViewer, setComposerDraft } from '../../store/ui/actions.ts';
import { selectComposerDraft, selectComposerSending } from '../../store/ui/selectors.ts';
import { AttDraft } from '../../ui/AttDraft/AttDraft.tsx';
import { Composer } from '../../ui/Composer/Composer.tsx';
import type { ComposerRefusal } from '../../ui/Composer/Composer.tsx';
import { outgoingText } from '../../ui/Composer/Composer.logic.ts';
import { ComposerLock } from '../../ui/Composer/ComposerLock.tsx';
import { fileIcon } from '../../ui/atoms/fileIcon.ts';
import { chipWords, refusalWords, waitWords } from './composer.logic.ts';
import type { ComposerLockWords } from './ThreadScreen.logic.ts';

// Files into the draft of a thread: kept in the upload registry, an image's
// preview made, each uploading at once.
export function useAttach(threadId: string): (files: File[], how?: { pasted: boolean }) => void {
  const dispatch = useAppDispatch();

  return (files, how) => dispatch(attachFiles(threadId, pick(files, { pasted: how?.pasted ?? false, preview: true })));
}

export function ThreadComposer({ thread, lock }: { thread: Thread; lock: ComposerLockWords | null }) {
  const dispatch = useAppDispatch();
  const id = thread.id;
  const draft = useAppSelector(s => selectComposerDraft(s, id));
  const sending = useAppSelector(s => selectComposerSending(s, id));
  const atts = useAppSelector(s => selectDraftAttachments(s, id));
  const refusal = useAppSelector(s => selectSendRefusal(s, id));
  const attach = useAttach(id);
  const copy = useCopy();
  const { uploading, ready } = draftFiles(atts);
  const text = outgoingText(draft);
  const send = () => dispatch(sendMessage(id, text, ready));

  if (lock && refusal?.kind !== 'closed') {
    return (
      <ComposerLock icon={lock.icon}>
        {lock.strong ? <strong>{lock.strong}</strong> : null}
        {lock.text}
      </ComposerLock>
    );
  }

  let strip: ComposerRefusal | null = null;

  if (refusal) {
    const words = refusalWords(refusal, thread.status, { text: text !== '', files: atts.length > 0 });

    strip = {
      text: words.text,
      ...(words.action === 'copy' ? { action: 'Copy text', actionIcon: 'copy' as const, onAction: () => void copy(text, { done: 'Text copied', fail: 'Couldn’t copy the text' }) } : {}),
      ...(words.action === 'retry' ? { action: 'Retry', actionIcon: 'rotate-ccw' as const, onAction: send } : {}),
    };
  }

  const chips = atts.map(att => {
    const words = chipWords(att);

    return (
      <AttDraft
        key={att.id}
        name={att.name}
        preview={att.preview}
        icon={fileIcon(att.name)}
        status={words.status}
        progress={words.progress}
        state={words.state}
        retry={words.retry}
        onOpen={() => (att.preview ? dispatch(openViewer([{ src: att.preview, name: att.name, meta: [fileSize(att.size)], download: null }], 0)) : undefined)}
        onRetry={() => dispatch(uploadAttachment(id, att.id))}
        onRemove={() => dispatch(removeAttachment(id, att.id))}
      />
    );
  });

  return (
    <Composer
      to={thread.agent}
      value={draft}
      onChange={value => dispatch(setComposerDraft(id, value))}
      onSend={() => send()}
      onFiles={lock ? undefined : attach}
      attachments={chips.length ? chips : undefined}
      ready={ready.length > 0}
      wait={waitWords(uploading)}
      refusal={strip}
      busy={sending}
      disabled={lock !== null}
    />
  );
}
