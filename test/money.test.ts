import { describe, expect, it } from "vitest";
import { amountInput, formatAmount, MAX_AMOUNT, parseAmount } from "../src/shared/money";

describe("parseAmount", () => {
  it("reads amounts in the currency's smallest unit", () => {
    expect(parseAmount("12", "USD")).toBe(1200);
    expect(parseAmount("12.5", "USD")).toBe(1250);
    expect(parseAmount("12.50", "USD")).toBe(1250);
    expect(parseAmount("12.", "USD")).toBe(1200);
    expect(parseAmount(".05", "USD")).toBe(5);
    expect(parseAmount(" 1,234.56 ", "USD")).toBe(123456);
    expect(parseAmount("1,234,567", "JPY")).toBe(1234567);
    expect(parseAmount("１２．５", "CNY")).toBe(1250);
    expect(parseAmount("500", "JPY")).toBe(500);
    expect(parseAmount("007", "KRW")).toBe(7);
  });

  it("refuses anything that isn't a positive amount of the currency", () => {
    for (const [text, currency] of [
      ["", "USD"],
      [".", "USD"],
      ["0", "USD"],
      ["0.00", "USD"],
      ["-5", "USD"],
      ["1.234", "USD"],
      ["1.5", "JPY"],
      ["1,5", "EUR"],
      ["1,23", "USD"],
      ["12,34.5", "USD"],
      ["1e3", "USD"],
      ["$5", "USD"],
      ["abc", "USD"],
      ["1.2.3", "USD"],
      ["9".repeat(20), "USD"],
    ] as const)
      expect(parseAmount(text, currency), `${text} ${currency}`).toBeNull();
  });

  it("stops at the largest amount", () => {
    expect(parseAmount("100000000", "USD")).toBe(MAX_AMOUNT);
    expect(parseAmount("100000000.01", "USD")).toBeNull();
    expect(parseAmount(String(MAX_AMOUNT), "JPY")).toBe(MAX_AMOUNT);
    expect(parseAmount(String(MAX_AMOUNT + 1), "JPY")).toBeNull();
  });
});

describe("amountInput and formatAmount", () => {
  it("writes an amount back as typed", () => {
    expect(amountInput(1250, "USD")).toBe("12.50");
    expect(amountInput(5, "USD")).toBe("0.05");
    expect(amountInput(-1205, "EUR")).toBe("-12.05");
    expect(amountInput(500, "JPY")).toBe("500");
    for (const units of [1, 99, 100, 123456, MAX_AMOUNT])
      expect(parseAmount(amountInput(units, "USD"), "USD")).toBe(units);
  });

  it("shows amounts with the currency, in either language", () => {
    expect(formatAmount(123456, "USD", "en")).toBe("$1,234.56");
    expect(formatAmount(500, "JPY", "en")).toBe("¥500");
    expect(formatAmount(-1250, "USD", "en")).toBe("-$12.50");
    expect(formatAmount(1250, "CNY", "zh")).toBe("¥12.50");
    expect(formatAmount(1200, "EUR", "en")).toBe("€12.00");
  });
});
