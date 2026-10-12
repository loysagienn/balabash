// Thread composer (design: Composer): full-width text with "Attach", the
// ↵ hint and "Send" below it; sticks to the bottom of the main column.
// Controlled: value / onChange (the store keeps a draft per thread);
// onSend gets the text without the surrounding blank lines on Enter or the
// button (Shift+Enter, ⌘↵, Ctrl+↵ — a new line; on a phone Enter is a new
// line too); busy — the message is on its way: the field stays
// editable for the next draft, "Send" spins and nothing is sent until the
// message is through; onAttach absent — no "Attach" button. The field
// grows with the text up to eight lines (six in a narrow thread) through
// CSS field-sizing, with a measured height where the browser lacks it.

import { useEffect, useRef } from 'react';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Kbd } from '../atoms/atoms.tsx';
import { PHONE_MEDIA } from '../../lib/touch/pinch.ts';
import { composerKeyAction, outgoingText } from './Composer.logic.ts';
import './Composer.css';

export type ComposerProps = {
  to: string;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onAttach?: () => void;
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

export function Composer({ to, value, onChange, onSend, onAttach, busy, disabled, autoFocus }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const placeholder = `Message ${to}…`;
  const text = outgoingText(value);
  const canSend = text !== '' && !disabled && !busy;

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

  return (
    <div className="composer">
      <div className="composer-box">
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
          {onAttach ? (
            <IconBtn
              icon="paperclip"
              label="Attach file"
              size="sm"
              className="composer-attach"
              disabled={disabled}
              onClick={onAttach}
            />
          ) : null}
          <span className="composer-hint">
            <Kbd>↵</Kbd>send
          </span>
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
