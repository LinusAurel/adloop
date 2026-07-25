// Public landing page per angle (SPEC §2 LP routes, Should scope).
// Message match is the whole point: the H1 is the ad headline VERBATIM, the
// primary text is the intro, the static is the hero image. One CTA. The copy
// comes from the critic-checked asset, so guardrails are already enforced
// upstream. Publisher stays untouched — this is a demo feature (ad and LP
// side by side), the ad link target remains as configured.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { CopyVariant } from "@/engine/schemas";
import { ensureBrandSeed, readCollection } from "@/engine/store";
import type { Asset } from "@/engine/types";

export const dynamic = "force-dynamic";

interface CopyPayload {
  variants?: CopyVariant[];
  chosenIndex?: number;
}

interface StaticPayload {
  imageUrl?: string;
}

function loadLp(angleId: string) {
  const angle = readCollection("angles").find((a) => a.id === angleId);
  if (!angle) return null;
  const brand = ensureBrandSeed(angle.brandSlug);
  if (!brand) return null;
  const assets = readCollection("assets").filter((a: Asset) => a.angleId === angleId);
  const copyPayload = (assets.findLast((a) => a.kind === "ad_copy")?.payload ?? {}) as CopyPayload;
  const variant = copyPayload.variants?.[copyPayload.chosenIndex ?? 0];
  if (!variant) return null;
  const imageUrl = ((assets.findLast((a) => a.kind === "static")?.payload ?? {}) as StaticPayload)
    .imageUrl;
  return { angle, brand, variant, imageUrl };
}

export async function generateMetadata(
  { params }: { params: Promise<{ angleId: string }> },
): Promise<Metadata> {
  const { angleId } = await params;
  const lp = loadLp(angleId);
  if (!lp) return { title: "Seite nicht gefunden" };
  return {
    title: `${lp.variant.headline} · ${lp.brand.name}`,
    description: lp.variant.hook,
  };
}

export default async function LandingPage(
  { params }: { params: Promise<{ angleId: string }> },
) {
  const { angleId } = await params;
  const lp = loadLp(angleId);
  if (!lp) notFound();
  const { brand, variant, imageUrl } = lp;
  const tokens = brand.designTokens;
  const bg = tokens.bgDark ?? "#07181B";
  const mint = tokens.mint ?? "#00FF7F";
  const ink = tokens.inkDark ?? "#002429";
  const ctaHref = brand.whatsappUrl ?? brand.url;

  return (
    <main
      className="min-h-screen px-6 py-12 text-zinc-100"
      style={{ backgroundColor: bg }}
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
        <header className="text-sm font-semibold tracking-tight text-zinc-400">
          {brand.name}
        </header>

        {/* H1 == Ad-Headline, wörtlich (Message-Match). */}
        <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {variant.headline}
        </h1>

        {imageUrl ? (
          <div className="overflow-hidden rounded-2xl border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={variant.headline}
              className="aspect-[4/5] w-full object-cover"
            />
          </div>
        ) : null}

        <p className="whitespace-pre-line text-base leading-relaxed text-zinc-300">
          {variant.primary}
        </p>

        <div className="flex flex-col items-start gap-3">
          <a
            href={ctaHref}
            className="rounded-xl px-6 py-3 text-base font-semibold transition-opacity hover:opacity-90"
            style={{ backgroundColor: mint, color: ink }}
          >
            Kostenlosen Tarif-Check starten
          </a>
          <p className="text-xs text-zinc-500">
            Unverbindlicher Erst-Check. Kostet nichts, wenn Du nicht sparst.
          </p>
        </div>

        <footer className="mt-8 border-t border-white/10 pt-6 text-xs text-zinc-500">
          {brand.name} · {brand.url.replace(/^https?:\/\//, "")}
        </footer>
      </div>
    </main>
  );
}
