/*
 * Seek — the notice a failed action leaves. See data/failures.ts.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { dismissFailure, useFailures } from '../data/failures.ts';
import { IconClose } from '../icons/index.tsx';

export function Failures() {
  const failures = useFailures();
  if (failures.length === 0) return null;
  return (
    <div className="failures" role="alert" aria-live="assertive">
      {failures.map((f) => (
        <p key={f.id} className="failures__item">
          <span>{f.text}</span>
          <button
            type="button"
            className="failures__close pressable"
            aria-label="Dismiss"
            onClick={() => dismissFailure(f.id)}
          >
            <IconClose size={12} painted={1.7} />
          </button>
        </p>
      ))}
    </div>
  );
}
