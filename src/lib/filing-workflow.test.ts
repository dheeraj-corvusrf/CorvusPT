import { describe, it, expect } from "vitest";
import { requiredFilingSteps, type FilingStepInput } from "./filing-workflow";

function input(over: Partial<FilingStepInput> = {}): FilingStepInput {
  return {
    attendanceType: "Property Owner",
    hasAgentAuthorization: false,
    hearingAppearance: null,
    ...over,
  };
}

describe("requiredFilingSteps", () => {
  it("owner appears in person, no agent → File Protest + Evidence only", () => {
    expect(requiredFilingSteps(input())).toEqual(["file", "evidence"]);
  });

  it("always starts with File and ends with Evidence", () => {
    const s = requiredFilingSteps(
      input({ attendanceType: "Both", hearingAppearance: "By videoconference" }),
    );
    expect(s[0]).toBe("file");
    expect(s[s.length - 1]).toBe("evidence");
  });

  it("adds the Agent step when an agent will represent the owner", () => {
    expect(requiredFilingSteps(input({ attendanceType: "Authorized Agent" }))).toEqual([
      "file",
      "agent",
      "evidence",
    ]);
    expect(requiredFilingSteps(input({ hasAgentAuthorization: true }))).toContain("agent");
  });

  it("adds the Affidavit step only when the owner won't appear in person", () => {
    expect(requiredFilingSteps(input({ hearingAppearance: "In person" }))).not.toContain(
      "affidavit",
    );
    expect(requiredFilingSteps(input({ hearingAppearance: null }))).not.toContain("affidavit");
    expect(
      requiredFilingSteps(
        input({ hearingAppearance: "On written affidavit submitted with evidence" }),
      ),
    ).toContain("affidavit");
    expect(
      requiredFilingSteps(
        input({ hearingAppearance: " By telephone conference call and will submit evidence" }),
      ),
    ).toContain("affidavit");
  });

  it("can require all four steps", () => {
    expect(
      requiredFilingSteps(
        input({ attendanceType: "Authorized Agent", hearingAppearance: "By videoconference" }),
      ),
    ).toEqual(["file", "agent", "affidavit", "evidence"]);
  });
});
