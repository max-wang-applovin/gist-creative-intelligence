import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWindow, joinMetaAdjust } from "./join";
import { parseAdName } from "./naming";

describe("defaultWindow", () => {
  it("ends 8 days before today and spans 14 days", () => {
    const today = new Date("2026-10-15T12:00:00Z");
    const { since, until } = defaultWindow(today);
    assert.equal(until, "2026-10-07");
    assert.equal(since, "2026-09-24");
  });
});

describe("parseAdName", () => {
  it("parses convention names", () => {
    const p = parseAdName("260928_AMB_General_Janelle_ThisAppPaysYouToBe");
    assert.ok(p);
    assert.equal(p?.who, "Janelle");
    assert.equal(p?.hook, "ThisAppPaysYouToBe");
  });
});

describe("joinMetaAdjust", () => {
  it("joins on Meta ad id = Adjust creative_id_network", () => {
    const out = joinMetaAdjust(
      [
        {
          ad_id: "111",
          ad_name: "260901_IH_General_None_HookA",
          campaign_name: "Test",
          spend: 100,
          leads: 10,
        },
      ],
      [
        {
          creativeIdNetwork: "111",
          partnerName: "Facebook",
          installs: 8,
          d1: 4,
          d3: 2,
          d7: 1,
        },
      ],
      "2026-09-01",
      "2026-09-14",
      { source: "mock" },
    );
    assert.equal(out.creatives.length, 1);
    assert.equal(out.creatives[0].installs, 8);
    assert.equal(out.creatives[0].d7, 1);
    assert.equal(out.creatives[0].costPerD7, 100);
    assert.equal(out.creatives[0].tags.hook, "HookA");
  });
});
