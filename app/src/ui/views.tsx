/*
 * Seek — the non-search sections.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Phase 1 has no transfers and no library index, so these are designed empty
 * states rather than mock dashboards. An empty state that says what will appear
 * and why it is not here yet is honest; a fake progress bar is not, and would
 * make the app look finished in exactly the places it isn't.
 *
 * Settings moved to `SettingsView.tsx` when it grew a folder picker, a shared
 * folder list and six sections. What is left here is the empty states.
 */

import type { Section } from './Sidebar.tsx';
import { SettingsView } from './SettingsView.tsx';
import type { SidecarClient } from '../data/sidecarClient.ts';
import type { PrefsSession } from '../data/prefsStore.ts';
import type { EngineSession } from '../data/engineStore.ts';
import type { ConnectionsSession, ProfileSession } from '../data/profileStore.ts';
import { IconDownload, IconEmpty, IconLibrary, IconSearch, IconUsers } from '../icons/index.tsx';

function Empty({
  icon, title, body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="pane__scroll">
      <div className="empty empty--section">
        <span className="empty__icon">{icon}</span>
        <p className="empty__title">{title}</p>
        <p className="empty__body">{body}</p>
      </div>
    </div>
  );
}

function Head({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="header header--plain">
      <h1 className="pane__title">{title}</h1>
      {subtitle && <p className="pane__subtitle">{subtitle}</p>}
    </header>
  );
}

export function SectionView({
  section, client, serverState, prefs, engine, profile, connections,
}: {
  section: Section;
  client: SidecarClient | null;
  serverState: string | null;
  prefs: PrefsSession;
  engine: EngineSession;
  profile: ProfileSession;
  connections: ConnectionsSession;
}) {
  switch (section) {
    case 'downloads':
      return (
        <>
          <Head title="Downloads" subtitle="Active and queued transfers" />
          <Empty
            icon={<IconDownload size={28} painted={1.3} />}
            title="Nothing downloading"
            body="Downloads appear here as releases, with one progress bar each and per-file detail behind expansion. The transfer bridge arrives in Phase 3 — this screen is deliberately empty rather than showing a simulated queue."
          />
        </>
      );
    case 'completed':
      return (
        <>
          <Head title="Completed" />
          <Empty
            icon={<IconLibrary size={28} painted={1.3} />}
            title="No completed downloads yet"
            body="Finished releases collect here, with where each one landed on disk."
          />
        </>
      );
    case 'failed':
      return (
        <>
          <Head title="Failed" />
          <Empty
            icon={<IconEmpty size={28} painted={1.3} />}
            title="Nothing has failed"
            body="Transfers that error, stall past the timeout, or lose their peer show up here with the reason and a retry."
          />
        </>
      );
    case 'history':
      return (
        <>
          <Head title="Search History" />
          <Empty
            icon={<IconSearch size={28} painted={1.3} />}
            title="No history yet"
            body="Past searches are stored locally in SQLite via the Tauri side, never in the browser. That store lands with the real bridge."
          />
        </>
      );
    case 'saved':
      return (
        <>
          <Head title="Saved Searches" />
          <Empty
            icon={<IconSearch size={28} painted={1.3} />}
            title="No saved searches"
            body="A search plus its filter set can be saved and re-run. Filter presets already work on the Search screen."
          />
        </>
      );
    case 'followed':
      return (
        <>
          <Head title="Followed" />
          <Empty
            icon={<IconUsers size={28} painted={1.3} />}
            title="Not following anyone"
            body="Peers whose taste is worth watching. Following needs the real connection, so it is inert for now."
          />
        </>
      );
    case 'browsing':
      return (
        <>
          <Head title="Browsing" />
          <Empty
            icon={<IconUsers size={28} painted={1.3} />}
            title="No browse session open"
            body="Opening a peer's full share needs the live protocol."
          />
        </>
      );
    case 'settings':
      return (
        <SettingsView
          client={client}
          serverState={serverState}
          prefs={prefs}
          engine={engine}
          profile={profile}
          connections={connections}
        />
      );
    default:
      return null;
  }
}
