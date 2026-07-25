// Boot hook (Next.js instrumentation): deployments carry an ephemeral store,
// so every restart would lose the demo brand. With ADLOOP_DEMO_AUTOSEED=1 the
// fixture state is restored automatically whenever it is missing.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ADLOOP_DEMO_AUTOSEED !== "1") return;
  const { demoBrandSeeded, seedDemoBrand } = await import("./engine/demo-seed");
  if (!demoBrandSeeded()) {
    const result = seedDemoBrand();
    console.log(`[demo-seed] auto-seeded on boot: ${JSON.stringify(result)}`);
  }
}
