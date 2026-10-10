/**
 * The currencies a group can use, with how many decimal places each has (ISO 4217). Amounts are
 * stored as whole numbers of the smallest unit: cents for USD, yen for JPY.
 */
export const CURRENCIES = {
  USD: 2,
  CNY: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  CAD: 2,
  AUD: 2,
  HKD: 2,
  SGD: 2,
} as const satisfies Record<string, number>;

export type Currency = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

export const isCurrency = (v: unknown): v is Currency => typeof v === "string" && Object.hasOwn(CURRENCIES, v);
