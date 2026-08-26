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

import type { ComponentType, SVGProps } from 'react';
import {
  Search, ArrowDownUp, Library, Settings, Music4, Folder, User, Check,
  ChevronDown, ChevronRight, ChevronUp, X, AlertTriangle, HelpCircle,
  Zap, Users, Download, ArrowUp, SlidersHorizontal, Circle, Inbox,
  MessageSquare, Star, Link2, Youtube, Disc3, Store, FolderOpen, Plus, Info,
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
