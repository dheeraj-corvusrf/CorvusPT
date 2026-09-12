// Version strings for the legal documents and acknowledgements. Bump one
// whenever the corresponding text materially changes — LegalGate compares a
// user's stored acceptance against these and re-prompts if it's behind.
export const TERMS_VERSION = "2026-09-07";
export const PRIVACY_VERSION = "2026-09-07";
// The signup "I understand and acknowledge that…" list.
export const SIGNUP_ACK_VERSION = "2026-09-07";
// The "Review Before Proceeding" pre-submission acknowledgement.
export const AI_ACK_VERSION = "2026-09-07";

export const LEGAL_CONTACT = {
  entity: "CorvusPT",
  address: "18740 Wainsborough Ln, Dallas, Texas",
  email: "properties@srclandbuilding.com",
  phone: "(469) 501-9362",
};

export type LegalSection = { heading: string; paragraphs: string[] };

// ── Signup acknowledgement ────────────────────────────────────────────────
export const SIGNUP_ACK_INTRO = "I understand and acknowledge that:";

export const SIGNUP_ACK_ITEMS: string[] = [
  "This platform uses artificial intelligence to provide property tax analysis, valuation estimates, comparable property information, protest strategies, estimated savings, document assistance, and related information.",
  "AI-generated information may contain errors, inaccuracies, omissions, outdated information, or incomplete information and should be independently reviewed and verified.",
  "The platform does not guarantee any reduction in appraised value, assessed value, property taxes, or any particular amount of savings.",
  "Unless I have separately entered into an agreement for managed or professional services, the platform provides general informational, analytical, technological, and administrative assistance only.",
  "The platform does not provide legal, tax, accounting, financial, licensed appraisal, or other professional advice or representation unless expressly agreed to under a separate written agreement.",
  "I am responsible for reviewing and verifying property information, values, comparable properties, documents, calculations, filing requirements, protest deadlines, hearing dates, and other important information with the applicable appraisal district, governmental authority, or appropriate professional.",
  "County appraisal districts, public records, third-party databases, vendors, integrations, and other external sources may contain inaccurate, incomplete, delayed, or outdated information.",
  "The platform may include beta or experimental features that may contain errors, change without notice, experience interruptions, or produce unexpected results.",
  "I remain responsible for decisions and actions I take based on information provided through the platform.",
  "Uploading or generating a protest document does not necessarily mean that the document has been successfully filed with an appraisal district or governmental authority.",
  "Governmental deadlines may continue to run even if the platform, a third-party service, or a notification system is unavailable.",
  "I agree not to copy, reproduce, reverse-engineer, scrape, disclose, commercially exploit, or misuse the platform's non-public technology, AI methods, workflows, algorithms, prompts, proprietary features, business methods/models, or confidential information.",
];

export const SIGNUP_ACK_CONFIRM =
  "By checking the box and selecting “Agree & Create Account,” I confirm that I have read, understood, and agree to the Terms of Service and Privacy Policy.";

// Same acknowledgement, worded for LegalGate's re-acceptance screen (an
// already-signed-in user whose stored acceptance is behind the current
// Terms/Privacy version) — that screen's button reads "Accept & Continue",
// not "Agree & Create Account", so it needs its own copy rather than reusing
// SIGNUP_ACK_CONFIRM verbatim.
export const TERMS_UPDATE_ACK_CONFIRM =
  "By checking the box and selecting “Accept & Continue,” I confirm that I have read, understood, and agree to the Terms of Service and Privacy Policy.";

// ── Pre-submission AI acknowledgement ─────────────────────────────────────
export const AI_ACK_CHECKBOX =
  "I have reviewed the information provided and understand that AI-generated analysis may contain errors and does not guarantee a successful protest, assessment reduction, or any particular tax savings.";

export const AI_ACK_BODY =
  "I confirm that I am responsible for verifying material property information, supporting evidence, filing requirements, and applicable protest or hearing deadlines before relying on or submitting this information.";

// ── Terms of Service (DRAFT) ─────────────────────────────────────────────
// Plain-language first draft tailored to what this platform does. NOT legal
// advice — have counsel review and replace before relying on it.
export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "1. Acceptance of these Terms",
    paragraphs: [
      `These Terms of Service (“Terms”) are a binding agreement between you and ${LEGAL_CONTACT.entity} (“CorvusPT,” “we,” “us”) governing your access to and use of the CorvusPT website, applications, and services (the “Platform”).`,
      "You accept these Terms by checking the acceptance box during account creation and selecting “Agree & Create Account,” or by otherwise accessing or using the Platform after being presented with these Terms. If you do not agree, do not use the Platform.",
      "If you accept these Terms on behalf of an entity, you represent that you are authorized to bind that entity.",
    ],
  },
  {
    heading: "2. What the Platform Is (and Is Not)",
    paragraphs: [
      "The Platform provides software tools and information to help Texas property owners understand and, where appropriate, protest the appraised or assessed value of their property. This includes AI-assisted analysis, valuation estimates, comparable-property information, protest strategy suggestions, estimated-savings figures, document preparation assistance, deadline tracking, and related administrative features.",
      "Unless you have separately signed a CorvusPT Service Agreement or other written agreement for managed or professional representation, the Platform provides general informational, analytical, technological, and administrative assistance only.",
      "The Platform does not provide legal, tax, accounting, financial, licensed appraisal, or other professional advice, and using it does not create an attorney-client, agent, fiduciary, or other professional relationship.",
    ],
  },
  {
    heading: "3. Accounts",
    paragraphs: [
      "You must provide accurate, current, and complete information when you create an account and keep it updated. You are responsible for all activity under your account and for keeping your credentials secure.",
      "You must be at least 18 years old and legally able to enter into contracts. You may only use the Platform for a property you own or that you are legally authorized to act for.",
      "We may suspend or terminate accounts that violate these Terms, that we reasonably believe are being misused, or as otherwise permitted by law.",
    ],
  },
  {
    heading: "4. AI and Automated Analysis",
    paragraphs: [
      "The Platform uses artificial intelligence, machine learning, automated calculations, public records, and third-party data. AI-generated and automated output — including valuations, comparable properties, recommendations, strategies, drafted documents, and estimated savings — may contain errors, omissions, outdated information, or incomplete information.",
      "All AI output is a tool to assist you. It is not a guarantee, a professional opinion, or a substitute for your own review. You are responsible for independently verifying any material information before relying on or acting on it.",
    ],
  },
  {
    heading: "5. No Guarantee of Results",
    paragraphs: [
      "Property tax outcomes are decided by appraisal districts, appraisal review boards, arbitrators, courts, and other governmental authorities — not by CorvusPT.",
      "We do not guarantee that your property's value will be reduced, that any particular evidence or argument will be accepted, that an exemption or correction will be approved, that any settlement will be reached, or that you will achieve any particular amount of tax savings.",
    ],
  },
  {
    heading: "6. Your Responsibilities",
    paragraphs: [
      "You are responsible for reviewing and verifying property information, values, comparable properties, uploaded and generated documents, calculations, filing requirements, protest deadlines, hearing dates, and other important information with the applicable appraisal district, governmental authority, or an appropriate professional.",
      "Uploading or generating a protest document through the Platform does not by itself mean the document has been filed with, or accepted by, any appraisal district or governmental authority. Governmental deadlines continue to run even if the Platform, a third-party service, or a notification is delayed or unavailable.",
      "You are responsible for the decisions and actions you take based on information from the Platform.",
    ],
  },
  {
    heading: "7. Third-Party Data and Services",
    paragraphs: [
      "The Platform relies on county appraisal districts, tax offices, public records, mapping and geospatial providers, and other third-party databases, vendors, and integrations. That information may be inaccurate, incomplete, delayed, or outdated, and third-party services may change or become unavailable.",
      "CorvusPT is not responsible for third-party content or services, and your use of them may be subject to their own terms.",
    ],
  },
  {
    heading: "8. Subscriptions, Fees, and Billing",
    paragraphs: [
      "Some features require a paid subscription. Pricing, billing cycles, taxes, renewals, and cancellation terms are described at the point of purchase and in any applicable subscription terms, which are incorporated into these Terms.",
      "Unless stated otherwise, subscriptions renew automatically until canceled, and payments are non-refundable except as required by law.",
    ],
  },
  {
    heading: "9. Acceptable Use and Intellectual Property",
    paragraphs: [
      "The Platform, including its software, models, prompts, workflows, algorithms, interfaces, and content, is owned by CorvusPT or its licensors and is protected by intellectual-property and other laws.",
      "You agree not to copy, reproduce, reverse-engineer, decompile, scrape, disclose, sublicense, commercially exploit, or misuse the Platform's non-public technology, AI methods, workflows, algorithms, prompts, proprietary features, business methods or models, or confidential information, and not to use the Platform to build a competing product.",
      "You retain ownership of documents and information you upload. You grant CorvusPT a license to host, process, and use that content to provide and improve the Platform, consistent with the Privacy Policy.",
    ],
  },
  {
    heading: "10. Beta Features",
    paragraphs: [
      "The Platform may include beta, preview, or experimental features. These are provided “as is,” may contain errors, may change or be withdrawn without notice, may be interrupted, and may produce unexpected results.",
    ],
  },
  {
    heading: "11. Disclaimers",
    paragraphs: [
      "The Platform is provided “as is” and “as available.” To the fullest extent permitted by law, CorvusPT disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement, accuracy, and uninterrupted or error-free operation.",
    ],
  },
  {
    heading: "12. Limitation of Liability",
    paragraphs: [
      "To the fullest extent permitted by law, CorvusPT will not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost savings, lost tax reductions, missed deadlines, or loss of data, arising out of or relating to the Platform.",
      "CorvusPT's total liability for all claims relating to the Platform will not exceed the greater of the amounts you paid to CorvusPT for the Platform in the twelve months before the claim, or one hundred U.S. dollars ($100).",
    ],
  },
  {
    heading: "13. Indemnification",
    paragraphs: [
      "You agree to indemnify and hold CorvusPT harmless from claims, losses, and expenses (including reasonable attorneys' fees) arising out of your use of the Platform, your content, or your violation of these Terms or applicable law.",
    ],
  },
  {
    heading: "14. Changes to the Terms",
    paragraphs: [
      "We may update these Terms from time to time. If a change is material, we will present the updated Terms and require your acceptance before you can continue to use the Platform. The “Version” shown on this page identifies the current Terms.",
    ],
  },
  {
    heading: "15. Governing Law and Venue",
    paragraphs: [
      "These Terms are governed by the laws of the State of Texas, without regard to conflict-of-laws rules. Subject to any applicable arbitration provision, venue for court proceedings that may properly be brought will be in Dallas County, Texas, to the extent permitted by law.",
    ],
  },
  {
    heading: "16. Contact",
    paragraphs: [
      `${LEGAL_CONTACT.entity} · ${LEGAL_CONTACT.address} · ${LEGAL_CONTACT.email} · ${LEGAL_CONTACT.phone}`,
    ],
  },
];

// ── Privacy Policy (DRAFT) ──────────────────────────────────────────────
export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "1. Overview",
    paragraphs: [
      `This Privacy Policy explains how ${LEGAL_CONTACT.entity} (“CorvusPT,” “we,” “us”) collects, uses, and shares information in connection with the CorvusPT website, applications, and services (the “Platform”).`,
      "By using the Platform you agree to this Policy. If you do not agree, do not use the Platform.",
    ],
  },
  {
    heading: "2. Information We Collect",
    paragraphs: [
      "Account information: name, email address, phone number, company name, and password.",
      "Property and case information: property addresses, appraisal-district account numbers, ownership details, values, tax years, uploaded documents (such as appraisal notices, tax bills, deeds, and evidence), and information you provide about your property or protest.",
      "Acceptance records: the date, time, versions, and — where technically appropriate — the IP address and browser information associated with your acceptance of the Terms of Service, Privacy Policy, and in-product acknowledgements.",
      "Usage and device information: log data, IP address, browser and device type, pages viewed, and actions taken on the Platform, collected through cookies and similar technologies.",
      "Payment information: handled by our payment processor; we receive limited details such as card brand, last four digits, and subscription status, not full card numbers.",
    ],
  },
  {
    heading: "3. How We Use Information",
    paragraphs: [
      "To provide, operate, secure, and improve the Platform, including AI-assisted analysis, document handling, deadline tracking, and account management.",
      "To communicate with you about your account, cases, deadlines, and service updates.",
      "To process payments and manage subscriptions.",
      "To maintain records of your acceptance of legal terms and acknowledgements.",
      "To detect, prevent, and respond to fraud, abuse, security incidents, and violations of our Terms.",
      "To comply with legal obligations and to establish, exercise, or defend legal claims.",
    ],
  },
  {
    heading: "4. AI Processing",
    paragraphs: [
      "To generate analysis and assist with documents, the Platform sends relevant property and document information to AI and automated-analysis providers acting as our processors. We instruct those providers to use the information to perform the requested processing and not for their own unrelated purposes, subject to their terms.",
    ],
  },
  {
    heading: "5. How We Share Information",
    paragraphs: [
      "Service providers and processors: hosting, database, storage, AI, email delivery, payment processing, analytics, and mapping providers, under contracts that limit their use of the information.",
      "Appraisal districts and governmental authorities: where you ask us to prepare, file, or support a protest or related matter, or where required by law.",
      "Legal and safety: to comply with law, legal process, or lawful requests, and to protect the rights, property, and safety of CorvusPT, our users, and the public.",
      "Business transfers: in connection with a merger, acquisition, financing, or sale of assets, subject to this Policy.",
      "We do not sell your personal information.",
    ],
  },
  {
    heading: "6. Data Retention",
    paragraphs: [
      "We retain information for as long as your account is active and as needed to provide the Platform, and afterward as needed to comply with legal obligations, resolve disputes, maintain acceptance and case records, and enforce our agreements.",
    ],
  },
  {
    heading: "7. Security",
    paragraphs: [
      "We use administrative, technical, and organizational measures designed to protect information, including access controls, encryption in transit, and row-level access restrictions in our database. No method of transmission or storage is completely secure, and we cannot guarantee absolute security.",
    ],
  },
  {
    heading: "8. Your Choices and Rights",
    paragraphs: [
      "You can review and update account information in your settings, request a copy or deletion of your information, and delete your account. Some information may be retained as described in “Data Retention.”",
      "Depending on where you live, you may have additional rights under applicable law; contact us to exercise them.",
    ],
  },
  {
    heading: "9. Cookies",
    paragraphs: [
      "We use cookies and similar technologies to keep you signed in, remember preferences, secure the Platform, and understand usage. You can control cookies through your browser, though some features may not work without them.",
    ],
  },
  {
    heading: "10. Children",
    paragraphs: [
      "The Platform is not directed to children under 18, and we do not knowingly collect information from them.",
    ],
  },
  {
    heading: "11. Changes to this Policy",
    paragraphs: [
      "We may update this Policy from time to time. If a change is material, we will present the updated Policy and require your acceptance before you can continue to use the Platform. The “Version” shown on this page identifies the current Policy.",
    ],
  },
  {
    heading: "12. Contact",
    paragraphs: [
      `${LEGAL_CONTACT.entity} · ${LEGAL_CONTACT.address} · ${LEGAL_CONTACT.email} · ${LEGAL_CONTACT.phone}`,
    ],
  },
];
