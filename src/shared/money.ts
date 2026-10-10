import { CURRENCIES, type Currency } from "./currencies";
import type { Lang } from "./i18n";

/**
 * Money is always a whole number of the currency's smallest unit (cents for USD, yen for JPY):
 * these helpers turn what people type into that number and back.
 */

/** The largest amount one expense may have, in smallest units (100 million dollars, 10 billion yen). */
export const MAX_AMOUNT = 10_000_000_000;

export const decimalsOf = (currency: Currency) => CURRENCIES[currency];

/**
 * An amount as typed ("12", "12.5", "1,234.50", "１２.５"), in smallest units; null when it isn't
 * a positive amount of this currency (more decimals than it has, more than MAX_AMOUNT, or not a
 * number). Commas are read as thousands separators only where they group three digits, so "1,5"
 * is refused rather than guessed.
 */
export function parseAmount(text: string, currency: Currency): number | null {
  const decimals = decimalsOf(currency);
  // Full-width digits and point from a Chinese keyboard.
  const s = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/\s+/g, "");
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m) return null;
  const whole = (m[1] ?? "").replace(/,/g, "");
  const frac = m[2] ?? "";
  if (frac.length > decimals || whole.length > 15) return null;
  const units = Number(whole || "0") * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  return units > 0 && units <= MAX_AMOUNT ? units : null;
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

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

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
