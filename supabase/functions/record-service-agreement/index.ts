// Deploy via CLI: `supabase functions deploy record-service-agreement`.
//
// Records an Owner's acceptance of the CorvusPT Service Agreement (the
// "Agree & Continue" step in ProtestAuthorizationFlow). Writes happen here,
// not from the client, so the stored agreement text is the canonical
// server-side template filled with the property's real fields, and the IP /
// user-agent are captured from the request rather than trusted from the
// browser. Also files a downloadable HTML copy under the property's Documents.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SERVICE_AGREEMENT_VERSION,
  renderServiceAgreementText,
  renderServiceAgreementHtml,
  type AgreementFields,
} from "../_shared/service-agreement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { propertyId, protestId } = (await req.json()) as {
      propertyId?: string;
      protestId?: string | null;
    };
    if (typeof propertyId !== "string" || !propertyId) {
      return new Response(JSON.stringify({ error: "propertyId is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const {
      data: { user },
      error: userErr,
    } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Ownership check — the caller can only accept an agreement for their own
    // property.
    const { data: property } = await adminClient
      .from("properties")
      .select("id, address, cad, account_number, owner_name, tax_year")
      .eq("id", propertyId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!property) {
      return new Response(JSON.stringify({ error: "Property not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const { data: profile } = await adminClient
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", user.id)
      .maybeSingle();
    const ownerName =
      (property.owner_name as string | null)?.trim() ||
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() ||
      "(property owner)";

    // "cad" is the appraisal-district name (e.g. "Dallas Central Appraisal
    // District") — use it as the county label.
    const fields: AgreementFields = {
      ownerName,
      propertyAddress: property.address as string,
      county: (property.cad as string | null) ?? null,
      accountNumber: (property.account_number as string | null) ?? null,
      taxYear: (property.tax_year as number | null) ?? null,
    };

    const ipAddress =
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      req.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = req.headers.get("user-agent");
    const acceptedAt = new Date().toISOString();
    const agreementText = renderServiceAgreementText(fields);
    const html = renderServiceAgreementHtml(fields, { acceptedAt, ipAddress });

    // File a downloadable copy under the property's Documents. Best-effort:
    // the acceptance record is the legal artifact; the readable copy is a
    // convenience, so a storage hiccup must not fail the acceptance.
    let documentId: string | null = null;
    try {
      const storagePath = `${user.id}/${propertyId}/${Date.now()}-CorvusPT-Service-Agreement.html`;
      const { error: upErr } = await adminClient.storage
        .from("documents")
        .upload(storagePath, new Blob([html], { type: "text/html" }), {
          contentType: "text/html",
        });
      if (!upErr) {
        const { data: docRow } = await adminClient
          .from("documents")
          .insert({
            property_id: propertyId,
            user_id: user.id,
            file_name: `CorvusPT Service Agreement - ${SERVICE_AGREEMENT_VERSION}.html`,
            storage_path: storagePath,
            document_type: "Service Agreement",
            category: "signed_agreement",
            source: "signed",
          })
          .select("id")
          .single();
        documentId = (docRow?.id as string | undefined) ?? null;
      }
    } catch (e) {
      console.error("Service agreement copy not filed (acceptance still recorded):", e);
    }

    const { data: acceptance, error: insErr } = await adminClient
      .from("service_agreement_acceptances")
      .insert({
        user_id: user.id,
        property_id: propertyId,
        protest_id: typeof protestId === "string" ? protestId : null,
        owner_name: ownerName,
        property_address: fields.propertyAddress,
        county: fields.county,
        account_number: fields.accountNumber,
        tax_year: typeof fields.taxYear === "number" ? fields.taxYear : null,
        agreement_version: SERVICE_AGREEMENT_VERSION,
        agreement_text: agreementText,
        document_id: documentId,
        ip_address: ipAddress,
        user_agent: userAgent,
        accepted_at: acceptedAt,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    return new Response(
      JSON.stringify({
        id: acceptance!.id,
        version: SERVICE_AGREEMENT_VERSION,
        acceptedAt,
        documentId,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "unknown error" }),
      { status: 500, headers: corsHeaders },
    );
  }
});
