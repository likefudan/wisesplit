import { CURRENCIES, type Currency } from "./currencies";
import type { Lang } from "./i18n";

/**
 * Money is always a whole number of the currency's smallest unit (cents for USD, yen for JPY):
 * these helpers turn what people type into that number and back.
 */

/** The largest amount one expense may have, in smallest units (100 million dollars, 10 billion yen). */
export const MAX_AMOUNT = 10_000_000_000;

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

export const decimalsOf = (currency: Currency) => CURRENCIES[currency];

/** What was typed, with full-width digits, point, signs and percent from a Chinese keyboard made plain, and no spaces. */
function plain(text: string): string {
  return text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/[－−]/g, "-")
    .replace(/＋/g, "+")
    .replace(/％/g, "%")
    .replace(/\s+/g, "");
}

/**
 * A plain number with at most `decimals` decimals, scaled to a whole number (12.5 with 2 → 1250);
 * null when it isn't one. Commas are read as thousands separators only where they group three
 * digits, so "1,5" is refused rather than guessed.
 */
function scaled(s: string, decimals: number): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m) return null;
  const whole = (m[1] ?? "").replace(/,/g, "");
  const frac = m[2] ?? "";
  if (frac.length > decimals || whole.length > 15) return null;
  return Number(whole || "0") * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
}

/**
 * An amount as typed ("12", "12.5", "1,234.50", "１２.５"), in smallest units; null when it isn't
 * a positive amount of this currency (more decimals than it has, more than MAX_AMOUNT, or not a
 * number).
 */
export function parseAmount(text: string, currency: Currency): number | null {
  const units = scaled(plain(text), decimalsOf(currency));
  return units !== null && units > 0 && units <= MAX_AMOUNT ? units : null;
}

/**
 * How much more ("5", "+5") or less ("-5") someone pays, in smallest units; 0 for "0". Null when it
 * isn't an amount of this currency up to MAX_AMOUNT either way.
 */
export function parseAdjustment(text: string, currency: Currency): number | null {
  const s = plain(text);
  const sign = s.startsWith("-") ? -1 : 1;
  const units = scaled(/^[+-]/.test(s) ? s.slice(1) : s, decimalsOf(currency));
  return units !== null && units <= MAX_AMOUNT ? sign * units || 0 : null;
}

/** A percentage as typed ("25", "33.33", "12.5%"), in hundredths of a percent; null unless above 0 and at most 100. */
export function parsePercent(text: string): number | null {
  const units = scaled(plain(text).replace(/%$/, ""), 2);
  return units !== null && units > 0 && units <= 10_000 ? units : null;
}

/** A whole number as typed ("2", "２"), from 1 to `max`; null otherwise. */
export function parseCount(text: string, max: number): number | null {
  const s = plain(text);
  const n = /^\d{1,6}$/.test(s) ? Number(s) : 0;
  return n >= 1 && n <= max ? n : null;
}

/** A percentage in hundredths of a percent for people to read: 3333 → "33.33%", 2500 → "25%". */
export function formatPercent(hundredths: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang), { style: "percent", maximumFractionDigits: 2 }).format(
    hundredths / 10_000,
  );
}

/** An amount in smallest units as a plain number for a form field: 1250 USD → "12.50", 500 JPY → "500". */
export function amountInput(units: number, currency: Currency): string {
  const decimals = decimalsOf(currency);
  const sign = units < 0 ? "-" : "";
  const abs = Math.abs(units);
  if (decimals === 0) return `${sign}${abs}`;
  const scale = 10 ** decimals;
  return `${sign}${Math.floor(abs / scale)}.${String(abs % scale).padStart(decimals, "0")}`;
}

/** An amount for people to read, with the currency's symbol: 1250 USD → "$12.50", 500 JPY → "¥500". */
export function formatAmount(units: number, currency: Currency, lang: Lang): string {
  const decimals = decimalsOf(currency);
  return new Intl.NumberFormat(locale(lang), {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(units / 10 ** decimals);
}
