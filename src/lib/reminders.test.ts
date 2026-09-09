import { describe, it, expect } from "vitest";
import { looksLikeReminderRequest } from "./reminders";

describe("looksLikeReminderRequest", () => {
  it("matches genuine reminder phrasings", () => {
    for (const s of [
      "remind me to call the ARB on Friday",
      "Reminder: evidence packet due in two weeks",
      "don't let me forget the hearing",
      "save this date: May 3",
      "add a reminder for the tax payment",
      "note to self — file the rendition",
      "ping me the day before the deadline",
    ]) {
      expect(looksLikeReminderRequest(s), s).toBe(true);
    }
  });

  it("does not match plain questions", () => {
    for (const s of [
      "what is my protest deadline",
      "how much could I save on 123 Main St",
      "what's the status of my Denton case",
      "when is the hearing",
    ]) {
      expect(looksLikeReminderRequest(s), s).toBe(false);
    }
  });
});
