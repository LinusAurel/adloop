import { notFound } from "next/navigation";

// Deck temporarily offline while it is being reworked — the route stays so
// the URL can come back without a redeploy dance. Restore from git history:
// git show HEAD~1:app/pitch/page.tsx
export default function PitchPage() {
  notFound();
}
