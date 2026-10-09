import { describe, expect, it } from "vitest";
import { detectLang, LANGS, MESSAGES, translate } from "../src/shared/i18n";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("every language has the same messages, with the same placeholders", () => {
    const keys = Object.keys(MESSAGES.en).sort();
    for (const lang of LANGS) {
      expect(Object.keys(MESSAGES[lang]).sort()).toEqual(keys);
      for (const key of keys) {
        const text = MESSAGES[lang][key as keyof typeof MESSAGES.en];
        expect(text.trim(), `${lang} ${key}`).not.toBe("");
        expect(placeholders(text), `${lang} ${key}`).toEqual(
          placeholders(MESSAGES.en[key as keyof typeof MESSAGES.en]),
        );
      }
    }
  });

  it("fills in placeholders and leaves unknown ones as written", () => {
    expect(translate("en", "error.unknown", { status: 502 })).toBe("Request failed (502).");
    expect(translate("zh", "error.unknown", { status: 502 })).toBe("请求失败（502）。");
    expect(translate("en", "error.unknown")).toBe("Request failed ({status}).");
    expect(translate("en", "error.unknown", { other: 1 })).toBe("Request failed ({status}).");
    expect(translate("en", "error.unknown", { toString: 1 })).toBe("Request failed ({status}).");
  });

  it("picks the browser's first preferred language it knows, English otherwise", () => {
    expect(detectLang(["zh-CN", "en-US"])).toBe("zh");
    expect(detectLang(["zh-Hant-TW"])).toBe("zh");
    expect(detectLang(["en-GB", "zh-CN"])).toBe("en");
    expect(detectLang(["fr-FR", "ZH"])).toBe("zh");
    expect(detectLang(["fr-FR"])).toBe("en");
    expect(detectLang([])).toBe("en");
  });
});
