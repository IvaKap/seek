/*
 * Seek — the single icon set, behind one wrapper.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * SF Symbols are licensed for Apple platforms only and cannot ship in a webview,
 * so Lucide stands in: closest common geometry to SF (24-unit grid, round caps
 * and joins, uniform stroke), tree-shakes per icon. One set, never mixed.
 *
 * THE STROKE ARITHMETIC, because it is easy to get wrong and looks wrong when
 * you do: Lucide's `strokeWidth` is in SVG USER UNITS on a 24×24 viewBox, not
 * in painted pixels. Rendered at `size` px, one user unit paints `size / 24` px,
 * so a strokeWidth of W paints  W × size / 24  px.
 *
 *   strokeWidth 1.5 at size 20  →  1.5 × 20/24  =  1.25px painted.  Too light.
 *
 * To PAINT a given stroke we must invert it:
 *
 *   strokeWidth = painted × 24 / size
 *
 * so 1.6px painted at 20px is strokeWidth 1.92, and the same 1.6px at 16px is
 * strokeWidth 2.4. Deriving it here is what keeps optical weight constant when
 * an icon is used at two sizes — hardcoding one number cannot do that.
 */

import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  Search, ArrowDownUp, Library, Settings, Music4, Folder, User, Check,
  ChevronDown, ChevronRight, ChevronUp, X, AlertTriangle, HelpCircle,
  Zap, Users, Download, ArrowUp, SlidersHorizontal, Circle, Inbox,
  MessageSquare, Star, Link2, Youtube, Disc3, Store, FolderOpen, Plus, Info,
  FolderCheck, Clover,
} from 'lucide-react';

/** Painted stroke, in CSS px. The brief's range is 1.5–1.75. */
const PAINTED_STROKE = 1.6;
/** Lucide's viewBox is 24 units square. */
const GRID = 24;

export function strokeFor(size: number, painted: number = PAINTED_STROKE): number {
  return (painted * GRID) / size;
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'width' | 'height' | 'strokeWidth'> {
  /** Rendered size in px. 20 is the app's default grid. */
  size?: number;
  /** Override the painted stroke, in px, for optical corrections. */
  painted?: number;
}

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;

function wrap(Component: LucideIcon, displayName: string) {
  function Wrapped({ size = 20, painted, ...rest }: IconProps) {
    return (
      <Component
        size={size}
        strokeWidth={strokeFor(size, painted)}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable={false}
        // Optical alignment: Lucide's glyphs sit on the geometric centre of the
        // grid, which reads a hair low next to text with a taller cap height.
        style={{ display: 'block', flex: 'none', ...(rest.style ?? {}) }}
        {...rest}
      />
    );
  }
  Wrapped.displayName = `Icon(${displayName})`;
  return Wrapped;
}

/*
 * FOUR ICONS TAKEN AS GEOMETRY RATHER THAN AS IMPORTS, for two reasons.
 *
 * `globe-off` and `list-clock` DO NOT EXIST in lucide-react 0.487.0 — they were
 * added upstream later. Bumping the package was the alternative, and the icon
 * set renames things between versions (`alert-triangle` became
 * `triangle-alert`, and this file imports `AlertTriangle`), so a bump is a diff
 * to read rather than a number to change. Two paths is the duller risk.
 *
 * `contact-round` and `mails` DO exist in 0.487.0 and ARE DRAWN DIFFERENTLY
 * there. Checked, not assumed: 0.487.0's contact-round sweeps its shoulder arc
 * the other way (`large-arc` 0 against 1, starting a unit lower), and its mails
 * is a different drawing altogether. These six glyphs were chosen by eye, so
 * rendering a near-miss because of a version pin would quietly discard the
 * choice.
 *
 * `folder-check` and `clover` are byte-identical in 0.487.0 and are imported
 * normally. The test in `vendored.test.tsx` pins ALL SIX against the supplied
 * SVGs, so which ones happen to be imported is not something a reader has to
 * keep track of — if a bump changes any of them, it fails there.
 *
 * The geometry below is copied verbatim from `./supplied/`, which is
 * Lucide's own output: same 24 grid, same `currentColor`, same round caps. So
 * `wrap()` treats these exactly like the imported ones and the stroke
 * arithmetic above applies unchanged.
 */
function vendored(name: string, paths: ReactNode): LucideIcon {
  function Vendored({ size = 24, strokeWidth = 2, ...rest }:
    SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...rest}
      >
        {paths}
      </svg>
    );
  }
  Vendored.displayName = name;
  return Vendored;
}

const GlobeOff = vendored('GlobeOff', (
  <>
    <path d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643" />
    <path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929" />
    <path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687" />
    <path d="M17.656 12H22" />
    <path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45" />
    <path d="M2 12h10" />
    <path d="m2 2 20 20" />
  </>
));

const ContactRound = vendored('ContactRound', (
  <>
    <path d="M16 2v2" />
    <path d="M17.915 21a6 6 0 10-12 0" />
    <path d="M8 2v2" />
    <circle cx="12" cy="11" r="4" />
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </>
));

const Mails = vendored('Mails', (
  <>
    <path d="M17 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 1-1.732" />
    <path d="m22 5.5-6.419 4.179a2 2 0 0 1-2.162 0L7 5.5" />
    <rect x="7" y="3" width="15" height="12" rx="2" />
  </>
));

const ListClock = vendored('ListClock', (
  <>
    <path d="M16 13v2.2l1.6 1" />
    <path d="M3 12h3.458" />
    <path d="M3 19h3.832" />
    <path d="M3 5h18" />
    <circle cx="16" cy="15" r="6" />
  </>
));

export const IconSearch = wrap(Search, 'Search');
export const IconTransfers = wrap(ArrowDownUp, 'Transfers');
export const IconLibrary = wrap(Library, 'Library');
export const IconSettings = wrap(Settings, 'Settings');
export const IconTrack = wrap(Music4, 'Track');
export const IconRelease = wrap(Folder, 'Release');
export const IconUser = wrap(User, 'User');
export const IconUsers = wrap(Users, 'Users');
export const IconChat = wrap(MessageSquare, 'Chat');
export const IconCheck = wrap(Check, 'Check');
export const IconChevronDown = wrap(ChevronDown, 'ChevronDown');
export const IconChevronRight = wrap(ChevronRight, 'ChevronRight');
export const IconChevronUp = wrap(ChevronUp, 'ChevronUp');
export const IconClose = wrap(X, 'Close');
export const IconWarning = wrap(AlertTriangle, 'Warning');
export const IconUnknown = wrap(HelpCircle, 'Unknown');
export const IconUnchecked = wrap(Circle, 'Unchecked');
export const IconSpeed = wrap(Zap, 'Speed');
export const IconDownload = wrap(Download, 'Download');
export const IconArrowUp = wrap(ArrowUp, 'ArrowUp');
export const IconFilters = wrap(SlidersHorizontal, 'Filters');
export const IconStar = wrap(Star, 'Star');
export const IconEmpty = wrap(Inbox, 'Empty');
export const IconFolderOpen = wrap(FolderOpen, 'FolderOpen');
export const IconPlus = wrap(Plus, 'Plus');
/* Distinct from IconUnknown, which is the quality indicator's "we don't know".
 * This one opens an explanation that exists. */
export const IconInfo = wrap(Info, 'Info');

/* Discovery sources. Lucide has a YouTube glyph but nothing for Bandcamp or
 * Discogs, and mixing in a brand-icon set to get them would break the one rule
 * this file exists to enforce. A shop front and a record stand in: the label
 * beside them says which service it is, so the icon only has to distinguish. */
export const IconLink = wrap(Link2, 'Link');
export const IconYouTube = wrap(Youtube, 'YouTube');
export const IconBandcamp = wrap(Store, 'Bandcamp');
export const IconDiscogs = wrap(Disc3, 'Discogs');

/* SIDEBAR SECTIONS, supplied as Lucide SVGs and mapped by name.
 *
 * These replace six reused glyphs. Two of those reuses were a real defect
 * rather than a shortage: Followed and Private chats both rendered IconUsers,
 * so the nav drew the same picture for "people you follow" and "messages from
 * one person". Search History shared IconSearch with Search itself and with
 * Wishlist, and Completed shared IconLibrary with three other entries.
 *
 * The generic exports above are untouched — they are still used by rows,
 * headers and empty states, where the surrounding label disambiguates. */
export const IconCompleted = wrap(FolderCheck, 'Completed');
export const IconFailed = wrap(GlobeOff, 'Failed');
export const IconFollowed = wrap(ContactRound, 'Followed');
export const IconMessages = wrap(Mails, 'Messages');
export const IconWant = wrap(Clover, 'Want');
export const IconHistory = wrap(ListClock, 'History');
