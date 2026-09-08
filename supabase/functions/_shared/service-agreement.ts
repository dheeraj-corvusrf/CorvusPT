// The canonical CorvusPT Service Agreement. This is the source of truth for
// the text that gets STORED on acceptance (record-service-agreement). The
// client renders its own copy for display (src/lib/service-agreement.ts) —
// keep the two in sync by hand; bump SERVICE_AGREEMENT_VERSION whenever the
// wording changes so old acceptances stay pinned to what was actually shown.

export const SERVICE_AGREEMENT_VERSION = "2026-09-07";

// [CORVUSPT LEGAL ENTITY NAME] in the source spec — set to the real filing
// entity once it's registered.
export const CORVUSPT_LEGAL_ENTITY = "CorvusPT";
export const CORVUSPT_CONTACT = {
  address: "18740 Wainsborough Ln, Dallas, Texas",
  phone: "(469) 501-9362",
  email: "properties@srclandbuilding.com",
  venue: "Dallas County, Texas",
};

export type AgreementFields = {
  ownerName: string;
  propertyAddress: string;
  county: string | null;
  accountNumber: string | null;
  taxYear: number | string | null;
};

export type AgreementSection = { n: string; title: string; body: string[] };

export const SERVICE_AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    n: "1",
    title: "Service",
    body: [
      "CorvusPT will evaluate the property's current appraisal and available property information for potential errors, exemptions, valuation issues, and opportunities for reduction. CorvusPT may perform comparative market, equity, income, or other appropriate property tax analyses.",
      "If CorvusPT determines that a protest or other action is appropriate, CorvusPT may prepare and file the protest and supporting evidence, communicate and negotiate with the applicable appraisal district, and represent the Owner at informal conferences and appraisal review board (“ARB”) hearings, subject to applicable law and required authorization.",
      "CorvusPT does not guarantee that a protest will result in a reduction or any particular amount of tax savings.",
    ],
  },
  {
    n: "2",
    title: "Authorization to Represent Owner",
    body: [
      "The Owner authorizes CorvusPT and its appropriately registered, licensed, or otherwise authorized representatives, as required by applicable law, to: obtain property, ownership, appraisal, tax, exemption, and related information concerning the property; communicate with the applicable appraisal district, ARB, taxing authorities, and other relevant governmental entities; prepare and file protests, evidence, correspondence, and related property tax documents; negotiate regarding the property's appraised or taxable value; attend and represent the Owner at informal conferences and ARB hearings; and take other reasonable actions necessary to perform the property tax protest services described in this Agreement.",
      "Where required, the Owner agrees to execute the Texas Comptroller's Appointment of Agent for Property Tax Matters (Form 50-162) or another legally required authorization. CorvusPT may prepare and submit the authorization after it has been properly executed by the Owner.",
      "This Agreement does not itself replace any separate governmental appointment or authorization form required by law.",
    ],
  },
  {
    n: "3",
    title: "Owner Responsibilities",
    body: [
      "The Owner agrees to: provide accurate and complete property and ownership information; provide documents reasonably requested by CorvusPT; promptly review and sign required authorizations; notify CorvusPT of material changes affecting the property or protest; and cooperate reasonably with the protest process.",
      "CorvusPT may rely on information supplied by the Owner, appraisal districts, public records, and third-party data providers and cannot guarantee that all such information is complete or accurate.",
    ],
  },
  {
    n: "4",
    title: "Technology and AI",
    body: [
      "CorvusPT may use artificial intelligence, automated analysis, public records, third-party data, and proprietary technology to assist in analyzing the property and preparing the protest.",
      "AI-generated and automated analysis may contain errors or limitations and is used as a tool in providing the service. No valuation, analysis, comparable property, recommendation, or estimated savings constitutes a guarantee of the final result.",
    ],
  },
  {
    n: "5",
    title: "No Guarantee of Results",
    body: [
      "Property tax protests are determined by appraisal districts, appraisal review boards, arbitrators, courts, or other governmental authorities.",
      "CorvusPT does not guarantee: that the property's value will be reduced; that any particular evidence or argument will be accepted; that an exemption or correction will be approved; that a particular settlement value will be achieved; or any specific amount of property tax savings.",
    ],
  },
  {
    n: "6",
    title: "Term and Termination",
    body: [
      "This Agreement applies to the property and tax year identified above unless otherwise agreed in writing.",
      "The Owner may terminate CorvusPT's representation by providing written notice at least sixty (60) days before the applicable protest filing deadline.",
      "CorvusPT may withdraw from representation where permitted by law if the Owner fails to cooperate, provides materially inaccurate information, fails to execute required authorization, breaches this Agreement, or CorvusPT reasonably determines that continued representation is unlawful or impracticable.",
      "Any subscription, service charges, cancellation terms, or other payment obligations are governed separately by the applicable CorvusPT subscription or pricing terms.",
    ],
  },
  {
    n: "7",
    title: "Terms of Service and Privacy Policy",
    body: [
      "The Owner's use of the CorvusPT platform remains subject to the CorvusPT Terms of Service and Privacy Policy, each incorporated by reference.",
      "If there is a conflict concerning the managed property tax protest services for this property, this Service Agreement controls with respect to those services.",
    ],
  },
  {
    n: "8",
    title: "Texas Law",
    body: [
      "This Agreement is governed by the laws of the State of Texas.",
      `Subject to any applicable arbitration provision contained in the CorvusPT Terms of Service, venue for proceedings that may properly be brought in court will be in ${CORVUSPT_CONTACT.venue}, to the extent permitted by law.`,
    ],
  },
];

export const OWNER_ACCEPTANCE_TEXT =
  "I confirm that I am the property owner or am legally authorized to act for the property owner. I have reviewed and agree to this CorvusPT Service Agreement, authorize CorvusPT to provide the property tax protest services described above, and understand that CorvusPT does not guarantee a property value reduction or tax savings.";

function headerLines(f: AgreementFields): string[] {
  return [
    `Property: ${f.propertyAddress || "(not provided)"}`,
    `Property Account/PID: ${f.accountNumber || "(not provided)"}`,
    `County: ${f.county || "(not provided)"}`,
    `Tax Year: ${f.taxYear ?? "(not provided)"}`,
    `Property Owner: ${f.ownerName || "(not provided)"}`,
  ];
}

export function renderServiceAgreementText(f: AgreementFields): string {
  const parts: string[] = [
    "CorvusPT Service Agreement",
    "",
    ...headerLines(f),
    "",
    'By checking the box and selecting "Agree & Continue," you ("Owner") authorize CorvusPT to provide property tax protest services for the property identified above, subject to the following terms.',
    "",
  ];
  for (const s of SERVICE_AGREEMENT_SECTIONS) {
    parts.push(`${s.n}. ${s.title}`);
    for (const p of s.body) parts.push(p, "");
  }
  parts.push(
    "Owner Acceptance",
    "",
    OWNER_ACCEPTANCE_TEXT,
    "",
    'By selecting "Agree & Continue," I electronically sign and enter into this Agreement.',
    "",
    "CorvusPT",
    CORVUSPT_LEGAL_ENTITY,
    CORVUSPT_CONTACT.address,
    CORVUSPT_CONTACT.phone,
    CORVUSPT_CONTACT.email,
    "",
    `Agreement version: ${SERVICE_AGREEMENT_VERSION}`,
  );
  return parts.join("\n");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderServiceAgreementHtml(
  f: AgreementFields,
  meta: { acceptedAt: string; ipAddress: string | null },
): string {
  const sections = SERVICE_AGREEMENT_SECTIONS.map(
    (s) =>
      `<section><h2>${s.n}. ${esc(s.title)}</h2>${s.body.map((p) => `<p>${esc(p)}</p>`).join("")}</section>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8" /><title>CorvusPT Service Agreement</title>
<style>
  body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#16233a;max-width:46rem;margin:2rem auto;padding:0 1.25rem}
  h1{font-size:1.4rem;margin:0 0 .25rem} h2{font-size:1rem;margin:1.5rem 0 .4rem}
  .meta{border:1px solid #e3e7e5;border-radius:8px;padding:.75rem 1rem;margin:1rem 0;font-size:13px}
  .meta div{display:flex;justify-content:space-between;gap:1rem;padding:.15rem 0}
  .meta span:first-child{color:#586a80}
  .accept{border:1px solid #e3e7e5;border-radius:8px;padding:1rem;margin-top:1.5rem;background:#f6f8f7}
  footer{margin-top:2rem;border-top:1px solid #e3e7e5;padding-top:1rem;font-size:12px;color:#586a80}
</style></head><body>
<h1>CorvusPT Service Agreement</h1>
<div class="meta">
  <div><span>Property</span><span>${esc(f.propertyAddress || "—")}</span></div>
  <div><span>Account / PID</span><span>${esc(f.accountNumber || "—")}</span></div>
  <div><span>County</span><span>${esc(f.county || "—")}</span></div>
  <div><span>Tax Year</span><span>${esc(String(f.taxYear ?? "—"))}</span></div>
  <div><span>Property Owner</span><span>${esc(f.ownerName || "—")}</span></div>
</div>
<p>By checking the box and selecting &ldquo;Agree &amp; Continue,&rdquo; you (&ldquo;Owner&rdquo;) authorized CorvusPT to provide property tax protest services for the property identified above, subject to the following terms.</p>
${sections}
<div class="accept">
  <p><strong>Owner Acceptance</strong></p>
  <p>${esc(OWNER_ACCEPTANCE_TEXT)}</p>
  <p>Accepted electronically on ${esc(new Date(meta.acceptedAt).toUTCString())}${meta.ipAddress ? ` from IP ${esc(meta.ipAddress)}` : ""}.</p>
</div>
<footer>
  ${esc(CORVUSPT_LEGAL_ENTITY)} &middot; ${esc(CORVUSPT_CONTACT.address)} &middot; ${esc(CORVUSPT_CONTACT.phone)} &middot; ${esc(CORVUSPT_CONTACT.email)}<br />
  Agreement version ${esc(SERVICE_AGREEMENT_VERSION)}
</footer>
</body></html>`;
}
