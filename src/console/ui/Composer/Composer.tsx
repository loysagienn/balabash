// Thread composer (design: Composer): full-width text with "Attach", the
// ⌘↵ hint and "Send" below it; sticks to the bottom of the main column.
// Controlled: value / onChange (the store keeps a draft per thread);
// onSend gets the trimmed text on ⌘↵ / Ctrl+↵ or the button; busy — the
// message is on its way (the field stays editable, "Send" spins); onAttach
// absent — no "Attach" button. The field grows with the text up to eight
// lines (six in a narrow thread) through CSS field-sizing, with a measured
// height where the browser lacks it.

import { useEffect, useRef } from 'react';
import { IconBtn } from '../IconBtn/IconBtn.tsx';
import { Kbd } from '../atoms/atoms.tsx';
import { isSendKey, outgoingText } from './Composer.logic.ts';
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

export function Composer({ to, value, onChange, onSend, onAttach, busy, disabled, autoFocus }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const placeholder = `Message ${to}…`;
  const text = outgoingText(value);
  const canSend = text !== '' && !disabled;

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
            if (isSendKey(event.nativeEvent)) {
              event.preventDefault();
              send();
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
            <Kbd>⌘↵</Kbd>send
          </span>
          <IconBtn
            icon="arrow-up"
            label="Send"
            variant="primary"
            size="sm"
            className="composer-send"
            disabled={!canSend}
            busy={busy}
            onClick={send}
          />
        </div>
      </div>
    </div>
  );
}
