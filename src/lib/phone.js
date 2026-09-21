// Phone numbers for identity records — every country's, through
// libphonenumber-js (Google's numbering metadata; the `min` build: formatting
// and validity by length/pattern, which is all a record needs).
//
// A record holds a phone number in ONE written form: international, with its
// prefix — "+40 721 234 567" — so the same number typed as 0721234567, read
// off a contract as (0721) 234-567 or pasted with its +40 all end up the same
// string. The form shows it as a country prefix (flag + "+40") and, beside it,
// the REST of that same international form — "721 234 567", grouped the way the
// country groups it and without the trunk "0", which the prefix replaces. (A
// typed "0721…" is understood; the zero simply isn't shown after "+40".)
import {
  AsYouType, getCountries, getCountryCallingCode, parsePhoneNumberFromString,
} from 'libphonenumber-js/min';

export const DEFAULT_PHONE_COUNTRY = 'RO';

// Every country the metadata knows, as `{ code, dial, name }`, by name — the
// default first, because that is the one nearly every record uses.
let countriesMemo = null;
export function phoneCountries() {
  if (countriesMemo) return countriesMemo;
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { names = null; }
  const list = getCountries().map((code) => {
    let name = code;
    try { name = names?.of(code) || code; } catch { name = code; }
    return { code, dial: `+${getCountryCallingCode(code)}`, name };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const at = list.findIndex((c) => c.code === DEFAULT_PHONE_COUNTRY);
  if (at > 0) list.unshift(list.splice(at, 1)[0]);
  countriesMemo = list;
  return list;
}

// A prefix several countries share names its MAIN one until the number itself
// settles which (+1 is the US until the area code says Canada or Jamaica).
const MAIN_FOR_DIAL = {
  1: 'US', 7: 'RU', 39: 'IT', 44: 'GB', 47: 'NO', 61: 'AU', 212: 'MA', 262: 'RE',
  290: 'SH', 358: 'FI', 590: 'GP', 599: 'CW',
};
function countryForDial(dial) {
  if (!dial) return null;
  if (MAIN_FOR_DIAL[dial]) return MAIN_FOR_DIAL[dial];
  return phoneCountries().find((c) => c.dial === `+${dial}`)?.code || null;
}

export function dialCodeOf(country) {
  try { return `+${getCountryCallingCode(country)}`; } catch { return ''; }
}

// Whatever was written → the record's form, or '' when it isn't a phone number
// this can make sense of (the caller keeps the original then).
export function formatPhoneIntl(raw, country = DEFAULT_PHONE_COUNTRY) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const parsed = parsePhoneNumberFromString(text, country);
  return parsed && parsed.isPossible() ? parsed.formatInternational() : '';
}

// A stored value taken apart for the form: which country, and the national
// number as that country writes it. `country` is null when the value doesn't
// say (no prefix, or a prefix shared by several countries with a number that
// doesn't settle which).
export function splitPhone(raw, fallbackCountry = DEFAULT_PHONE_COUNTRY) {
  const text = String(raw ?? '').trim();
  if (!text) return { country: null, national: '' };
  const parsed = parsePhoneNumberFromString(text, fallbackCountry);
  if (!parsed) return { country: null, national: text };
  return {
    country: parsed.country || countryForDial(parsed.countryCallingCode) || null,
    national: afterPrefix(parsed.formatInternational(), parsed.countryCallingCode),
  };
}

// "+40 721 234 567" → "721 234 567".
function afterPrefix(international, dial) {
  const text = String(international || '');
  const head = `+${dial}`;
  return text.startsWith(head) ? text.slice(head.length).trim() : text;
}

// The national number as it is being typed, formatted the way `country` writes
// it. A number typed WITH a prefix ("+44…") names its own country: that comes
// back as `country` so the form's prefix can follow it.
export function typePhone(text, country = DEFAULT_PHONE_COUNTRY) {
  const raw = String(text ?? '');
  const typer = new AsYouType(raw.trim().startsWith('+') ? undefined : country);
  const formatted = typer.input(raw);
  const number = typer.getNumber();
  const detected = raw.trim().startsWith('+')
    ? (typer.getCountry() || number?.country || countryForDial(number?.countryCallingCode) || null)
    : null;
  // The number so far, grouped as it would be written internationally — also
  // while it is still being typed, which `formatInternational` alone doesn't do.
  const international = number ? new AsYouType().input(number.number) : '';
  return {
    formatted,
    country: detected,
    // What goes into the record: international once there is a number at all.
    stored: international,
    // …and what the box beside the prefix shows: the same, minus the prefix.
    national: number ? afterPrefix(international, number.countryCallingCode) : formatted,
    possible: number ? number.isPossible() : false,
  };
}

// ── Flags ────────────────────────────────────────────────────────────────
// Real SVGs, not emoji: Windows ships no flag glyphs, so "🇷🇴" paints as the
// letters RO there. They are ~600 kB of strings for every country, so they are
// imported lazily — the first record opened pays for them, nothing else does.
let flagsPromise = null;
const flagUrls = new Map();
export function loadPhoneFlags() {
  if (!flagsPromise) {
    flagsPromise = import('country-flag-icons/string/3x2')
      .then((mod) => (code) => {
        if (flagUrls.has(code)) return flagUrls.get(code);
        const svg = mod[code];
        const url = typeof svg === 'string' ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : null;
        flagUrls.set(code, url);
        return url;
      })
      .catch(() => { flagsPromise = null; return () => null; });
  }
  return flagsPromise;
}
