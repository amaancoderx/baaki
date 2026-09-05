import { baaki } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const fmt = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "json";
  const body = await (await baaki()).auditExport(fmt);
  return new Response(body, {
    headers: {
      "Content-Type": fmt === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename="baaki-audit.${fmt}"`,
    },
  });
}
