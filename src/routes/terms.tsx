import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument } from "@/components/LegalDocument";
import { TERMS_SECTIONS, TERMS_VERSION } from "@/lib/legal";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — CorvusPT" },
      { name: "description", content: "The CorvusPT Terms of Service." },
    ],
  }),
  component: Terms,
});

function Terms() {
  return (
    <LegalDocument
      title="Terms of Service"
      version={TERMS_VERSION}
      updated={TERMS_VERSION}
      intro="These Terms govern your use of the CorvusPT platform. Please read them carefully; by creating an account or using the platform you agree to them."
      sections={TERMS_SECTIONS}
    />
  );
}
