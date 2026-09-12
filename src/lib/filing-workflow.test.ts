import { describe, it, expect } from "vitest";
import {
  requiredFilingSteps,
  describeFilingRequirements,
  type FilingStepInput,
} from "./filing-workflow";

function input(over: Partial<FilingStepInput> = {}): FilingStepInput {
  return {
    attendanceType: "Property Owner",
    hasAgentAuthorization: false,
    hearingAppearance: null,
    ...over,
  };
}

describe("requiredFilingSteps", () => {
  it("owner appears in person, no agent → Pre-Filing Check, File Protest, Evidence", () => {
    expect(requiredFilingSteps(input())).toEqual(["prefiling", "file", "evidence"]);
  });

  it("always starts with Pre-Filing Check then File, and ends with Evidence", () => {
    const s = requiredFilingSteps(
      input({ attendanceType: "Both", hearingAppearance: "By videoconference" }),
    );
    expect(s.slice(0, 2)).toEqual(["prefiling", "file"]);
    expect(s[s.length - 1]).toBe("evidence");
  });

  it("adds the Agent step when an agent will represent the owner", () => {
    expect(requiredFilingSteps(input({ attendanceType: "Authorized Agent" }))).toEqual([
      "prefiling",
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

  it("can require all five steps", () => {
    expect(
      requiredFilingSteps(
        input({ attendanceType: "Authorized Agent", hearingAppearance: "By videoconference" }),
      ),
    ).toEqual(["prefiling", "file", "agent", "affidavit", "evidence"]);
  });
});

describe("describeFilingRequirements", () => {
  it("says only the Notice of Protest is due now, regardless of which other steps apply", () => {
    const note = describeFilingRequirements(["prefiling", "file", "evidence"], null);
    expect(note.dueNow).toMatch(/Notice of Protest/i);
  });

  it("lists Evidence as something that can wait, with a generic hearing phrase when no date is set", () => {
    const note = describeFilingRequirements(["prefiling", "file", "evidence"], null);
    const evidence = note.canWaitUntil.find((i) => i.label === "Evidence");
    expect(evidence).toBeTruthy();
    expect(evidence?.detail).toMatch(/hearing or informal review/i);
  });

  it("uses the real hearing date when one is on record", () => {
    const note = describeFilingRequirements(["prefiling", "file", "evidence"], "2026-11-03");
    const evidence = note.canWaitUntil.find((i) => i.label === "Evidence");
    expect(evidence?.detail).toContain("November 3, 2026");
  });

  it("only lists Agent/Representative and Evidence Affidavit when this case's steps actually include them", () => {
    const simple = describeFilingRequirements(["prefiling", "file", "evidence"], null);
    expect(simple.canWaitUntil.map((i) => i.label)).toEqual(["Evidence"]);

    const full = describeFilingRequirements(
      ["prefiling", "file", "agent", "affidavit", "evidence"],
      null,
    );
    expect(full.canWaitUntil.map((i) => i.label)).toEqual([
      "Agent / Representative",
      "Evidence Affidavit",
      "Evidence",
    ]);
  });
});
