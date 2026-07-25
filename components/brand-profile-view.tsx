"use client";

// Brand Profile (Personalize): the brand identity every agent draws its
// context from — presented as card sections, not a form desert. Budget and
// goals deliberately do NOT live here (budget belongs to the Ads Manager,
// goals to the campaign). Editing goes through PATCH /api/brands/[slug]
// with an optimistic local update; only fields the strict brandPatchSchema
// accepts are editable (name, url, product, CTA, guardrails). Audience and
// tone are Scout-provided extras beyond the base Brand type and render
// read-only until the patch schema learns them.

import { useMemo, useState } from "react";
import type { Brand, BrandState } from "@/engine/types";
import { ErrorNote, PillButton, ViewHeader } from "@/components/bits";

// Fields the Scout may add beyond the base Brand type (defensive read).
interface BrandExtras {
  audience?: string;
  tone?: string;
}

interface FormValues {
  name: string;
  url: string;
  product: string;
  ctaLabel: string;
  ctaSubline: string;
  guardrails: string;
}

function valuesFromBrand(brand: Brand): FormValues {
  return {
    name: brand.name ?? "",
    url: brand.url ?? "",
    product: brand.product ?? "",
    ctaLabel: brand.cta?.label ?? "",
    ctaSubline: brand.cta?.subline ?? "",
    guardrails: brand.guardrails.join("\n"),
  };
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-ink-800 p-6">
      <p className="group-heading mb-3">{title}</p>
      {children}
    </section>
  );
}

const inputClass =
  "w-full rounded-xl bg-ink-750 px-3.5 py-2 text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none";

export function BrandProfileView({
  state,
  brandSlug,
  onSaved,
}: {
  state: BrandState | null;
  brandSlug: string;
  onSaved: () => void;
}) {
  const brand = state?.brand;
  // Optimistic override: shown instead of polled data right after a save.
  const [override, setOverride] = useState<Brand | null>(null);
  const shown = override ?? brand;

  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<FormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const extras = (shown ?? {}) as BrandExtras;
  const accent =
    shown?.designTokens.accent ?? shown?.designTokens.primary ?? undefined;

  // Color swatches: every designTokens entry that is a hex color.
  const colors = useMemo(
    () =>
      Object.entries(shown?.designTokens ?? {}).filter(([, v]) =>
        /^#[0-9a-f]{3,8}$/i.test(v.trim()),
      ),
    [shown],
  );

  // Segments the strategist works: unique angle segments.
  const segments = useMemo(
    () => [...new Set((state?.angles ?? []).map((a) => a.segment).filter(Boolean))],
    [state],
  );

  if (!shown) {
    return <ViewHeader title="Brand Profile" lead="loading…" />;
  }

  const startEditing = () => {
    setValues(valuesFromBrand(shown));
    setFailed(null);
    setEditing(true);
  };

  const save = async () => {
    if (!values) return;
    setBusy(true);
    setFailed(null);
    try {
      const payload = {
        name: values.name.trim(),
        url: values.url.trim(),
        product: values.product.trim(),
        cta: {
          label: values.ctaLabel.trim(),
          ...(values.ctaSubline.trim() !== ""
            ? { subline: values.ctaSubline.trim() }
            : {}),
        },
        guardrails: values.guardrails
          .split("\n")
          .map((g) => g.trim())
          .filter((g) => g.length > 0),
      };
      const res = await fetch(`/api/brands/${brandSlug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        brand?: Brand;
        error?: string;
        issues?: { path: string; message: string }[];
      };
      if (!res.ok) {
        const detail = body.issues?.[0]
          ? `${body.issues[0].path}: ${body.issues[0].message}`
          : (body.error ?? `status ${res.status}`);
        throw new Error(detail);
      }
      // Optimistic: show the confirmed brand immediately, refresh in the back.
      if (body.brand) setOverride(body.brand);
      setEditing(false);
      onSaved();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ViewHeader
        title="Brand Profile"
        lead="The identity every agent draws its context from."
        action={
          editing ? (
            <span className="inline-flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="text-[0.8125rem] font-medium text-text-soft hover:text-foreground"
              >
                Cancel
              </button>
              <PillButton
                label="Save"
                busyLabel="saving…"
                busy={busy}
                onClick={() => void save()}
              />
            </span>
          ) : (
            <PillButton label="Edit" onClick={startEditing} />
          )
        }
      />

      <div className="flex flex-col gap-4">
        {/* Identity */}
        <section className="rounded-2xl bg-ink-800 p-6">
          {editing && values ? (
            <div className="flex flex-col gap-3">
              <input
                className={`${inputClass} text-[1.25rem] font-semibold`}
                value={values.name}
                placeholder="Brand name"
                onChange={(e) => setValues({ ...values, name: e.target.value })}
              />
              <input
                className={inputClass}
                value={values.url}
                placeholder="https://…"
                onChange={(e) => setValues({ ...values, url: e.target.value })}
              />
            </div>
          ) : (
            <>
              <p
                className="text-[1.5rem] font-semibold tracking-[-0.02em]"
                style={accent ? { color: accent } : undefined}
              >
                {shown.name}
              </p>
              <a
                href={shown.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[0.875rem] text-text-soft hover:text-foreground"
              >
                {shown.url}
              </a>
            </>
          )}
        </section>

        {/* Product / value proposition */}
        <Section title="Product & value proposition">
          {editing && values ? (
            <textarea
              className={`${inputClass} resize-none leading-relaxed`}
              rows={4}
              value={values.product}
              onChange={(e) => setValues({ ...values, product: e.target.value })}
            />
          ) : (
            <p className="text-[0.9375rem] leading-relaxed text-foreground">
              {shown.product}
            </p>
          )}
        </Section>

        {/* Audience & segments (Scout extras + strategist angles) */}
        {(extras.audience || segments.length > 0) && (
          <Section title="Audience & segments">
            {extras.audience ? (
              <p className="text-[0.9375rem] leading-relaxed text-foreground">
                {extras.audience}
              </p>
            ) : null}
            {segments.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {segments.map((s) => (
                  <span
                    key={s}
                    className="rounded-lg bg-ink-750 px-2.5 py-1 text-[0.75rem] font-medium text-text-soft"
                  >
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
          </Section>
        )}

        {/* Tone of voice */}
        {extras.tone ? (
          <Section title="Tone of voice">
            <p className="text-[0.9375rem] leading-relaxed text-foreground">
              {extras.tone}
            </p>
          </Section>
        ) : null}

        {/* CTA */}
        <Section title="Call to action">
          {editing && values ? (
            <div className="flex flex-col gap-3">
              <input
                className={inputClass}
                value={values.ctaLabel}
                placeholder="CTA label"
                onChange={(e) =>
                  setValues({ ...values, ctaLabel: e.target.value })
                }
              />
              <input
                className={inputClass}
                value={values.ctaSubline}
                placeholder="Subline (optional)"
                onChange={(e) =>
                  setValues({ ...values, ctaSubline: e.target.value })
                }
              />
            </div>
          ) : (
            <>
              <p className="text-[0.9375rem] font-medium text-foreground">
                {shown.cta?.label ?? "—"}
              </p>
              {shown.cta?.subline ? (
                <p className="mt-1 text-[0.8125rem] text-text-soft">
                  {shown.cta.subline}
                </p>
              ) : null}
            </>
          )}
        </Section>

        {/* Guardrails */}
        <Section title={`Guardrails${editing ? " (one per line)" : ""}`}>
          {editing && values ? (
            <textarea
              className={`${inputClass} resize-none leading-relaxed`}
              rows={Math.max(4, values.guardrails.split("\n").length + 1)}
              value={values.guardrails}
              onChange={(e) =>
                setValues({ ...values, guardrails: e.target.value })
              }
            />
          ) : shown.guardrails.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {shown.guardrails.map((g) => (
                <li
                  key={g}
                  className="rounded-xl bg-ink-750 px-3.5 py-2 text-[0.8125rem] leading-relaxed text-text-soft"
                >
                  {g}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-text-faint">—</p>
          )}
        </Section>

        {/* Brand colors from designTokens */}
        {colors.length > 0 ? (
          <Section title="Brand colors">
            <div className="flex flex-wrap gap-4">
              {colors.map(([token, hex]) => (
                <div key={token} className="flex items-center gap-2.5">
                  <span
                    className="size-8 rounded-lg border border-rule"
                    style={{ backgroundColor: hex }}
                  />
                  <span className="flex flex-col">
                    <span className="text-[0.8125rem] font-medium text-foreground">
                      {token}
                    </span>
                    <span className="tnum text-[0.75rem] uppercase text-text-faint">
                      {hex}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Section>
        ) : null}
      </div>

      {failed ? <ErrorNote text={`Could not save: ${failed}`} /> : null}
    </>
  );
}
