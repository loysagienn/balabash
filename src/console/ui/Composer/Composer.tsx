// Thread composer (design: Composer): full-width text with "Attach", the
// ↵ hint and "Send" below it; the bottom glass bar of the frame (ui/Glass),
// sticky at the bottom of the main column — the feed melts into it, and
// the box is see-through.
// Controlled: value / onChange (the store keeps a draft per thread);
// onSend gets the text without the surrounding blank lines on Enter or the
// button (Shift+Enter, ⌘↵, Ctrl+↵ — a new line; on a phone Enter is a new
// line too); busy — the message is on its way: the field stays
// editable for the next draft, "Send" spins and nothing is sent until the
// message is through. Attachments (design rule 23): onFiles — the
// paperclip opens the system's file picker and a paste of files hands them
// over (pasted: true); the draft's chips (AttDraft) come as `attachments`,
// above the text; `ready` — some attached file can go, so a message of
// files alone may be sent; `wait` — something still uploads: Send is
// disabled and the text says why in place of the hint; `refusal` — why the
// last send was refused, a strip above the box (the draft stays whole).
// onFiles absent — no "Attach" button. The field grows with the text up to
// eight lines (six in a narrow thread) through CSS field-sizing, with a
// measured height where the browser lacks it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Note } from '../Note/Note.tsx';
import { Kbd } from '../atoms/atoms.tsx';
import { PHONE_MEDIA } from '../../lib/touch/pinch.ts';
import { composerKeyAction, focusesField, outgoingText } from './Composer.logic.ts';
import '../Glass/Glass.css';
import './Composer.css';

export type ComposerRefusal = { text: string; action?: string; actionIcon?: IconName; onAction?: () => void };

export type ComposerProps = {
  to: string;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onFiles?: (files: File[], how: { pasted: boolean }) => void;
  attachments?: ReactNode;
  ready?: boolean;
  wait?: string;
  refusal?: ComposerRefusal | null;
  busy?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
};

const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

const isPhone = () => typeof window !== 'undefined' && window.matchMedia(PHONE_MEDIA).matches;

// ⌘↵ / Ctrl+↵ insert nothing on their own: put the break at the caret
// through insertText — it keeps the browser's undo and fires the input
// event that reaches onChange; setRangeText where insertText is refused.
function insertLineBreak(node: HTMLTextAreaElement, onChange: (value: string) => void) {
  if (document.execCommand('insertText', false, '\n')) {
    return;
  }

  node.setRangeText('\n', node.selectionStart, node.selectionEnd, 'end');
  onChange(node.value);
}

export function Composer({ to, value, onChange, onSend, onFiles, attachments, ready, wait, refusal, busy, disabled, autoFocus }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const atts = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const placeholder = `Message ${to}…`;
  const text = outgoingText(value);
  const canSend = (text !== '' || ready === true) && !wait && !disabled && !busy;

  // The phone's row of chips scrolls sideways and fades at the right edge
  // only while more chips are past it.
  useLayoutEffect(() => {
    const row = atts.current;

    if (!row) {
      setMore(false);

      return undefined;
    }

    const read = () => setMore(row.scrollWidth - row.scrollLeft - row.clientWidth > 1);
    const observer = new ResizeObserver(read);

    observer.observe(row);
    read();
    row.addEventListener('scroll', read, { passive: true });

    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', read);
    };
  }, [attachments]);

  // Fallback for browsers without field-sizing: the height follows the
  // content, the CSS max-height still caps it.
  useEffect(() => {
    const node = input.current;

    if (FIELD_SIZING || !node) {
      return;
    }

    node.style.height = '0';
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);

  // Every path (Enter, the button, Enter on the focused button) goes through
  // this guard — the busy button is not disabled, so the spinner keeps the
  // design's busy look; the guard is what stops a repeated send.
  const send = () => {
    if (canSend) {
      onSend(text);
    }
  };

  // The box is the field (focusesField): a press on its own surface keeps
  // the focus where it is (no blur — on a phone the keyboard would start
  // sliding away) and the click that follows puts it into the textarea.
  const onBoxPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (focusesField(event.target as Element)) {
      event.preventDefault();
    }
  };
  const onBoxClick = (event: MouseEvent<HTMLDivElement>) => {
    if (focusesField(event.target as Element)) {
      input.current?.focus();
    }
  };

  return (
    <div className="composer glass" data-edge="bottom">
      {refusal ? (
        <div className="composer-note">
          <Note state="err" icon="circle-alert" role="alert" action={refusal.action} actionIcon={refusal.actionIcon} actionVariant="ghost" onAction={refusal.onAction}>
            {refusal.text}
          </Note>
        </div>
      ) : null}
      <div className="composer-box" onPointerDown={onBoxPointerDown} onClick={onBoxClick}>
        {attachments ? (
          <div ref={atts} className="composer-atts" data-more={more ? '' : undefined}>
            {attachments}
          </div>
        ) : null}
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={event => onChange(event.target.value)}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files);

            if (onFiles && files.length > 0) {
              event.preventDefault();
              onFiles(files, { pasted: true });
            }
          }}
          onKeyDown={event => {
            const action = composerKeyAction(event.nativeEvent, isPhone());

            if (action === 'send') {
              event.preventDefault();
              send();
            } else if (action === 'newline') {
              event.preventDefault();
              insertLineBreak(event.currentTarget, onChange);
            }
          }}
        />
        <div className="composer-f">
          {onFiles ? (
            <>
              <IconBtn icon="paperclip" label="Attach file" size="sm" className="composer-attach" disabled={disabled} onClick={() => picker.current?.click()} />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={event => {
                  const files = Array.from(event.currentTarget.files ?? []);

                  event.currentTarget.value = '';

                  if (files.length > 0) {
                    onFiles(files, { pasted: false });
                  }
                }}
              />
            </>
          ) : null}
          {wait ? (
            <span className="composer-wait" role="status">
              {wait}
            </span>
          ) : (
            <span className="composer-hint">
              <Kbd>↵</Kbd>send
            </span>
          )}
          <IconBtn
            icon="arrow-up"
            label="Send"
            variant="primary"
            size="sm"
            className="composer-send"
            disabled={!busy && !canSend}
            busy={busy}
            onClick={send}
          />
        </div>
      </div>
    </div>
  );
}
