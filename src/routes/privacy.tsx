import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument } from "@/components/LegalDocument";
import { PRIVACY_SECTIONS, PRIVACY_VERSION } from "@/lib/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — CorvusPT" },
      { name: "description", content: "The CorvusPT Privacy Policy." },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <LegalDocument
      title="Privacy Policy"
      version={PRIVACY_VERSION}
      updated={PRIVACY_VERSION}
      intro="This Policy explains what information CorvusPT collects, how it is used, and how it is shared."
      sections={PRIVACY_SECTIONS}
    />
  );
}
