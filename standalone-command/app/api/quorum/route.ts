import { NextResponse } from "next/server";

const QUORUM_ORIGIN = "http://127.0.0.1:4747";

export async function GET() {
  try {
    const [healthResponse, stateResponse, catalogResponse, operationsResponse] = await Promise.all([
      fetch(`${QUORUM_ORIGIN}/health`, { signal: AbortSignal.timeout(1200), cache: "no-store" }),
      fetch(`${QUORUM_ORIGIN}/api/state`, { signal: AbortSignal.timeout(1200), cache: "no-store" }),
      fetch(`${QUORUM_ORIGIN}/api/catalog`, { signal: AbortSignal.timeout(1200), cache: "no-store" }),
      fetch(`${QUORUM_ORIGIN}/api/operations`, { signal: AbortSignal.timeout(1200), cache: "no-store" }),
    ]);

    if (!healthResponse.ok) throw new Error("Quorum health check failed");
    const health = await healthResponse.json();
    const state = stateResponse.ok ? await stateResponse.json() : {};
    const catalog = catalogResponse.ok ? await catalogResponse.json() : null;
    const operations = operationsResponse.ok ? await operationsResponse.json() : null;
    return NextResponse.json({ available: true, health, state, catalog, operations });
  } catch {
    return NextResponse.json({
      available: false,
      message: "Quorum is not running locally. Start it on 127.0.0.1:4747 to connect live operator state.",
    });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const response = await fetch(`${QUORUM_ORIGIN}/api/command`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), signal:AbortSignal.timeout(2500), cache:"no-store" });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ available:false, error:"Quorum is offline; no action was attempted." }, { status:503 });
  }
}
