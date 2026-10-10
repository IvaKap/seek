/*
 * Seek — a yes/no question that has to be answered before anything happens.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Small on purpose: one sentence, Cancel and the action. Escape and the scrim
 * cancel; Return is the action because focus starts on it.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

export function ConfirmSheet({
  title, body, action, onConfirm, onCancel,
}: {
  title: string;
  body: string;
  action: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { actionRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="sheet__scrim" onPointerDown={onCancel} role="presentation">
      <div
        className="sheet sheet--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__head">
          <div className="sheet__heading">
            <h2 className="sheet__title">{title}</h2>
            <p className="sheet__sub">{body}</p>
          </div>
        </header>
        <div className="sheet__actions">
          <button type="button" className="btn pressable" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            ref={actionRef}
            className="btn btn--primary pressable"
            onClick={onConfirm}
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
