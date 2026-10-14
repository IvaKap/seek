/*
 * Seek — the saved views beside Collector's results: a whole way of looking at
 * a search, one click away. domain/savedViews.ts holds the rules.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Yours are kept on this machine, like the table's columns: a view is a
 * preference about this window, not something the sidecar has any use for.
 */

import { useState } from 'react';
import type { Filters, GroupBy } from '../domain/types.ts';
import type { SavedView } from '../domain/savedViews.ts';
import { BUILT_IN_VIEWS, currentView, parseViews, storeViews, withView } from '../domain/savedViews.ts';

const VIEWS_KEY = 'seek.searchViews';

function stored(): SavedView[] {
  try {
    return parseViews(localStorage.getItem(VIEWS_KEY));
  } catch {
    return [];
  }
}

export function SavedViews({ filters, groupBy, onApply }: {
  filters: Filters;
  groupBy: GroupBy;
  onApply(view: SavedView): void;
}) {
  const [mine, setMine] = useState(stored);
  const [naming, setNaming] = useState(false);
  const all = [...BUILT_IN_VIEWS, ...mine];
  const current = currentView(all, filters, groupBy);

  const keep = (next: SavedView[]) => {
    setMine(next);
    try { localStorage.setItem(VIEWS_KEY, storeViews(next)); } catch { /* not remembered */ }
  };

  return (
    <div className="views">
      <div className="views__tabs" role="tablist" aria-label="Saved views">
        {all.map((v) => {
          const own = mine.includes(v);
          return (
            <span key={`${own ? 'mine' : 'seek'}:${v.name}`} className="views__tab" data-on={v === current ? 'true' : undefined}>
              <button type="button" role="tab" aria-selected={v === current} className="views__label" onClick={() => onApply(v)}>
                {v.name}
              </button>
              {own && (
                <button
                  type="button"
                  className="views__remove"
                  aria-label={`Remove the view ${v.name}`}
                  title="Remove this view"
                  onClick={() => keep(mine.filter((m) => m !== v))}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      {naming ? (
        <form
          className="views__name"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
            if (name) keep(withView(mine, { name, groupBy, filters: { ...filters, formats: new Set(filters.formats) } }));
            setNaming(false);
          }}
        >
          <input
            name="name"
            className="views__input"
            aria-label="Name this view"
            placeholder="Name this view"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Escape') setNaming(false); }}
            onBlur={(e) => { if (!e.currentTarget.value.trim()) setNaming(false); }}
          />
          <button type="submit" className="views__save">Save</button>
        </form>
      ) : (
        <button
          type="button"
          className="views__save"
          disabled={current !== undefined}
          title={current
            ? `This is the ${current.name} view. Change a filter or the grouping to make a new one.`
            : 'Keep these filters and this grouping as a view'}
          onClick={() => setNaming(true)}
        >
          + Save view
        </button>
      )}
    </div>
  );
}
