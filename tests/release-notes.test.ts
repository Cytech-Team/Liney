import { describe, expect, test } from "bun:test";
import { releaseNotesText } from "../src/lib/release-notes";

describe("release notes", () => {
  test("turns GitHub release-note HTML into readable text", () => {
    const text = releaseNotesText(
      '<p><strong>Full Changelog</strong> <a class="commit-link" href="https://github.com/Cytech-Team/Liney/compare/v0.1.6...v0.1.7">v0.1.6...v0.1.7</a></p><ul><li>Fix <code>push</code></li><li>Update &amp; retry</li></ul>',
    );

    expect(text).toContain("Full Changelog");
    expect(text).toContain("https://github.com/Cytech-Team/Liney/compare/v0.1.6...v0.1.7");
    expect(text).toContain("• Fix push");
    expect(text).toContain("Update & retry");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&amp;");
  });

  test("drops script and style blocks", () => {
    const text = releaseNotesText('<style>body{color:red}</style><p>Safe</p><script>alert(1)</script>');
    expect(text).toBe("Safe");
  });

  test("handles empty and plain text notes", () => {
    expect(releaseNotesText("")).toBe("");
    expect(releaseNotesText("Plain note")).toBe("Plain note");
  });
});
