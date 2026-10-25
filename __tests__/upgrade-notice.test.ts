import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showUpgradeNotice } from "../upgrade-notice.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

### Highlights

- Not released yet

## [2.0.0] - 2026-10-20

### Highlights

- Two, see [the docs](https://example.com/docs)

### Fixed

- A fix that is not a highlight

## [1.1.0] - 2026-10-10

### Fixed

- No highlights in this release

## [1.0.0] - 2026-10-01

### Highlights

- One
`;

describe("showUpgradeNotice", () => {
  let dir: string;
  let stateDir: string;
  let changelog: string;
  let notices: string[];
  const ctx = (hasUI = true) => ({ hasUI, ui: { notify: (message: string) => { notices.push(message); } } });
  const recordVersion = (version: string) => writeFileSync(join(stateDir, "last-seen-version.json"), JSON.stringify({ version }));
  const seen = () => JSON.parse(readFileSync(join(stateDir, "last-seen-version.json"), "utf-8")).version;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-upgrade-notice-"));
    stateDir = join(dir, "state");
    changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, CHANGELOG);
    notices = [];
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stays quiet without a UI, on first install and on the same version", async () => {
    await showUpgradeNotice(ctx(false), stateDir, changelog, "2.0.0");
    expect(existsSync(stateDir)).toBe(false);

    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    expect(seen()).toBe("2.0.0");
    expect(notices).toEqual([]);
  });

  it("shows the skipped releases' highlights once after an upgrade", async () => {
    await showUpgradeNotice(ctx(), stateDir, changelog, "1.0.0");
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");

    expect(notices).toEqual([[
      "pi-mcp-adapter updated from 1.0.0 to 2.0.0",
      "- Two, see the docs",
      "Changelog: https://github.com/nicobailon/pi-mcp-adapter/blob/main/CHANGELOG.md",
    ].join("\n")]);
  });

  it("caps the list at five highlights", async () => {
    const many = Array.from({ length: 7 }, (_, index) => `- Item ${index + 1}`).join("\n");
    writeFileSync(changelog, `## [3.0.0] - 2026-10-30\n\n### Highlights\n\n${many}\n\n${CHANGELOG}`);
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    await showUpgradeNotice(ctx(), stateDir, changelog, "3.0.0");

    expect(notices[0]!.split("\n").slice(1, -1)).toEqual(["- Item 1", "- Item 2", "- Item 3", "- Item 4", "- Item 5", "...and 2 more"]);
  });

  it("stays quiet on a downgrade or a corrupt record, and records the version", async () => {
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    await showUpgradeNotice(ctx(), stateDir, changelog, "1.0.0");
    expect(seen()).toBe("1.0.0");

    writeFileSync(join(stateDir, "last-seen-version.json"), "{not json");
    await showUpgradeNotice(ctx(), stateDir, changelog, "2.0.0");
    expect(seen()).toBe("2.0.0");
    expect(notices).toEqual([]);
  });

  it("stays quiet when the version cannot be recorded", async () => {
    const file = join(dir, "file");
    writeFileSync(file, "");
    await showUpgradeNotice(ctx(), join(file, "state"), changelog, "2.0.0");
    expect(notices).toEqual([]);
  });

  it("reads the changelog that ships with the package", async () => {
    await showUpgradeNotice(ctx(), stateDir, undefined, "1.0.0");
    recordVersion("0.0.1");
    await showUpgradeNotice(ctx(), stateDir, undefined, "6.0.0");
    expect(notices[0]).toMatch(/^pi-mcp-adapter updated from 0\.0\.1 to 6\.0\.0\n- /);
  });
});
