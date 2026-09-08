import { invokeEdgeFunction } from "./edge-functions";

// Display copy of the CorvusPT Service Agreement. The STORED text on
// acceptance comes from the server (supabase/functions/_shared/service-
// agreement.ts) — keep the wording and SERVICE_AGREEMENT_VERSION identical
// between the two by hand. This module is only what the owner reads in the
// "agreement" step of ProtestAuthorizationFlow.

export const SERVICE_AGREEMENT_VERSION = "2026-09-07";

export const CORVUSPT_LEGAL_ENTITY = "CorvusPT";
export const CORVUSPT_CONTACT = {
  address: "18740 Wainsborough Ln, Dallas, Texas",
  phone: "(469) 501-9362",
  email: "properties@srclandbuilding.com",
  venue: "Dallas County, Texas",
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

export type ServiceAgreementAcceptance = {
  id: string;
  version: string;
  acceptedAt: string;
  documentId: string | null;
};

// Records the acceptance server-side (canonical text + real IP) and files a
// downloadable copy under the property's Documents.
export async function recordServiceAgreement(input: {
  propertyId: string;
  protestId?: string | null;
}): Promise<ServiceAgreementAcceptance> {
  return invokeEdgeFunction<ServiceAgreementAcceptance>("record-service-agreement", input);
}
