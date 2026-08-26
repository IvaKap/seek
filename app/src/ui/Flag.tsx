/*
 * Seek — the country flag beside a peer's name.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Nicotine+ shows one of these next to every user and Iva wants the same. It
 * says something real: a peer three time zones away is a peer whose upload
 * slots free up while you sleep, and a peer on a continent with a fast route
 * to you is a peer you will actually finish a 400MB FLAC rip from.
 *
 * DRAWN WITH REGIONAL INDICATOR CHARACTERS, not with images. Two letters map
 * onto two code points in the Unicode regional-indicator block, and macOS
 * renders that pair as a flag natively — so there is no sprite sheet, no 250
 * SVGs, nothing to fetch, and the glyph scales and re-colours with the text
 * around it. The alternative would be the app's first bundled image asset for
 * a decoration.
 *
 * THE NAME COMES FROM `Intl.DisplayNames`, which every modern engine ships. A
 * hand-written code-to-name table would be 250 rows of data to maintain and
 * would be in English only; this is localised to the user's own language for
 * free.
 *
 * A MISSING FLAG MUST NEVER BECOME A WRONG ONE. `country` is documented as
 * "when known" and is null for a great many peers — anyone on a private
 * address, and anyone whose response arrived before their address did. Every
 * path here renders nothing rather than guessing, and nothing is also what an
 * unrecognised code gets: a two-letter code that is not a real region would
 * otherwise paint two letters in boxes, which reads as a rendering bug.
 */

const A = 0x41;
/** Unicode REGIONAL INDICATOR SYMBOL LETTER A. */
const REGIONAL_A = 0x1f1e6;

/**
 * Region names, resolved once. Constructing an Intl formatter is not free and
 * this is called once per rendered row.
 *
 * Wrapped because `Intl.DisplayNames` throws on an environment that lacks it
 * rather than returning undefined, and a settings screen is not worth a blank
 * app.
 */
let namer: Intl.DisplayNames | null | undefined;

function regionNamer(): Intl.DisplayNames | null {
  if (namer === undefined) {
    try {
      namer = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      namer = null;
    }
  }
  return namer;
}

/** Uppercase ISO-3166-1 alpha-2, or null for anything that is not one. */
export function normaliseCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

/**
 * The country's name in the user's language.
 *
 * The fallback is defensive only, and measured to be so: pynicotine's
 * `ip_country_data.csv` holds 245 distinct codes plus the empty string for the
 * gaps between assigned ranges, and `Intl.DisplayNames` names ALL 245. It
 * returns the input unchanged for a region it does not know (`QQ` -> "QQ")
 * rather than throwing, so an unexpected code degrades to itself, which still
 * reads correctly beside a flag.
 */
export function countryName(code: string): string {
  try {
    return regionNamer()?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The two regional-indicator code points for a country code. */
export function flagEmoji(code: string): string {
  return String.fromCodePoint(
    ...[...code].map((c) => REGIONAL_A + (c.charCodeAt(0) - A)),
  );
}

export function Flag({ code, className }: { code: string | null | undefined; className?: string }) {
  const iso = normaliseCountry(code);
  if (iso === null) return null;

  const name = countryName(iso);
  return (
    <span
      className={className ? `flag ${className}` : 'flag'}
      /* The emoji is decorative here — a screen reader announcing "flag of
       * Germany" before every username would be noise — so the accessible
       * name is on the wrapper and the glyph itself is hidden. */
      role="img"
      aria-label={name}
      title={name}
    >
      <span aria-hidden="true">{flagEmoji(iso)}</span>
    </span>
  );
}
