// The one canonical writing-style rule for every user-facing AI text field
// on the platform (health score, report modules, document reviews, hearing /
// informal-review guidance, protest-reason drafts). Import it and splice it
// into each function's system prompt so the tone is identical everywhere:
// precise, plain, no filler.
//
// Deliberately does NOT quote a long "bad" example — priming a model with a
// verbose paragraph makes it more likely to reproduce it. It gets the good
// target and a list of banned openers instead.
export const PROSE_STYLE = `WRITING STYLE — applies to every text field you return:
- Lead with the concrete fact: the number, the finding, the missing item. No wind-up.
- Use plain words a property owner with no appraisal background understands. Short sentences.
- Every sentence must carry a new fact. If deleting a sentence loses no information, delete it.
- State a limitation once, plainly, then the specific next step. No hedging, no soft qualifiers.
- Never begin a sentence with: "The provided record", "Based on the", "Based on this", "It should be noted", "It is important to note", "Please note", "As mentioned", "In summary". Never use "warrants a detailed review", "a formal analysis should be performed", "further investigation is needed", "it is worth noting" as filler.
- Write it the way you would say it to the owner across a table: direct and brief.
Target density: "The record only shows a 2026 assessed value of $3,100,000, with no land/improvement breakdown, property details, or historical data. There's not enough information to confirm a strong protest opportunity. A full CAD and market/equity analysis is needed."`;

// Additional formatting rule for the document-review text fields only
// (review-document's explanation, ask-about-document's answers). Those render
// as markdown, so a scannable structure beats a paragraph. Splice this in
// AFTER PROSE_STYLE in those two prompts — nowhere else (the report modules
// etc. render structured UI, not markdown).
export const BULLET_STYLE = `FORMAT — the caller renders your answer as markdown:
- Answer in short markdown bullet points ("- "), not paragraphs. One fact per bullet.
- When you are presenting 3 or more parallel facts, or comparing this document against the property's known values, use a markdown table (| Field | Value | ...). Keep tables to the columns that matter.
- Bold the single most important number or finding with **…**.
- No preamble, no closing summary line. Start with the first bullet or the table.
- Keep the whole answer under ~120 words unless a table genuinely needs more rows.`;
