"use client";

// Brand-Profil (Personalisieren): all brand data, editable. Saving goes to
// PATCH /api/brands/[slug] — the route lands with the engine stream, so it
// is bound defensively: a 404/405/501 switches the form to read-only with a
// note. A mount-time probe (empty PATCH) detects that without a user click.

import { useEffect, useMemo, useState } from "react";
import type { Brand, BrandState } from "@/engine/types";
import { ErrorNote, PillButton, ViewHeader } from "@/components/bits";

// Fields the Scout may add beyond the base Brand type (defensive read).
interface BrandExtras {
  audience?: string;
  tone?: string;
  cta?: string;
}

interface FormValues {
  name: string;
  url: string;
  audience: string;
  product: string;
  tone: string;
  cta: string;
  budgetDailyEuro: string;
  targetCpa: string;
}

const FIELDS: {
  key: keyof FormValues;
  label: string;
  multiline?: boolean;
  numeric?: boolean;
}[] = [
  { key: "name", label: "Name" },
  { key: "url", label: "URL" },
  { key: "audience", label: "Zielgruppe", multiline: true },
  { key: "product", label: "Nutzenversprechen", multiline: true },
  { key: "tone", label: "Tonalität", multiline: true },
  { key: "cta", label: "CTA" },
  { key: "budgetDailyEuro", label: "Budget-Default (€ pro Tag)", numeric: true },
  { key: "targetCpa", label: "Ziel-Default (Ziel-CPA in €)", numeric: true },
];

function valuesFromBrand(brand: Brand): FormValues {
  const extras = brand as Brand & BrandExtras;
  return {
    name: brand.name ?? "",
    url: brand.url ?? "",
    audience: extras.audience ?? "",
    product: brand.product ?? "",
    tone: extras.tone ?? "",
    cta: extras.cta ?? "",
    budgetDailyEuro:
      brand.meta.fixedDailyBudgetCents != null
        ? String(brand.meta.fixedDailyBudgetCents / 100)
        : "",
    targetCpa: brand.targetCpa != null ? String(brand.targetCpa) : "",
  };
}

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
  const initial = useMemo(
    () => (brand ? valuesFromBrand(brand) : null),
    [brand],
  );

  const [values, setValues] = useState<FormValues | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [readOnly, setReadOnly] = useState<boolean | null>(null);

  // Take fresh polled values as long as the user has not started editing.
  useEffect(() => {
    if (!dirty && initial) setValues(initial);
  }, [initial, dirty]);

  // Probe whether the PATCH route exists (engine stream). Empty body: a
  // validating route answers 200/400, a missing one 404/405.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/brands/${brandSlug}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!cancelled) setReadOnly([404, 405, 501].includes(res.status));
      } catch {
        if (!cancelled) setReadOnly(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandSlug]);

  if (!brand || !values) {
    return <ViewHeader title="Brand-Profil" lead="lädt …" />;
  }

  const save = async () => {
    setBusy(true);
    setFailed(null);
    setSaved(false);
    try {
      const payload: Record<string, unknown> = {
        name: values.name,
        url: values.url,
        audience: values.audience,
        product: values.product,
        tone: values.tone,
        cta: values.cta,
        targetCpa:
          values.targetCpa.trim() === "" ? null : Number(values.targetCpa),
        fixedDailyBudgetCents:
          values.budgetDailyEuro.trim() === ""
            ? null
            : Math.round(Number(values.budgetDailyEuro) * 100),
      };
      const res = await fetch(`/api/brands/${brandSlug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if ([404, 405, 501].includes(res.status)) {
        setReadOnly(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setDirty(false);
      setSaved(true);
      onSaved();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ViewHeader
        title="Brand-Profil"
        lead="Die Daten, aus denen jeder Agent seinen Kontext zieht."
        action={
          readOnly === false ? (
            <PillButton
              label={saved && !dirty ? "Gespeichert" : "Speichern"}
              busyLabel="speichert …"
              busy={busy}
              disabled={!dirty}
              onClick={save}
            />
          ) : undefined
        }
      />

      {readOnly ? (
        <p className="mb-6 rounded-xl bg-sink px-4 py-3 text-[0.8125rem] leading-relaxed text-ink-soft">
          Bearbeiten ist noch nicht angeschlossen (PATCH-Route folgt). Die
          Felder sind bis dahin schreibgeschützt.
        </p>
      ) : null}

      <div className="surface divide-y divide-rule">
        {FIELDS.map((field) => {
          const value = values[field.key];
          const common =
            "w-full bg-transparent text-[0.9375rem] text-ink placeholder:text-ink-faint focus:outline-none disabled:text-ink-soft";
          return (
            <label
              key={field.key}
              className="flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-baseline sm:gap-6"
            >
              <span className="w-[220px] shrink-0 text-[0.8125rem] font-medium text-ink-soft">
                {field.label}
              </span>
              {field.multiline ? (
                <textarea
                  value={value}
                  rows={value.length > 120 ? 4 : 2}
                  disabled={readOnly !== false}
                  placeholder="—"
                  onChange={(e) => {
                    setValues({ ...values, [field.key]: e.target.value });
                    setDirty(true);
                  }}
                  className={`${common} resize-none leading-relaxed`}
                />
              ) : (
                <input
                  type="text"
                  inputMode={field.numeric ? "decimal" : undefined}
                  value={value}
                  disabled={readOnly !== false}
                  placeholder="—"
                  onChange={(e) => {
                    setValues({ ...values, [field.key]: e.target.value });
                    setDirty(true);
                  }}
                  className={`${common} ${field.numeric ? "tnum" : ""}`}
                />
              )}
            </label>
          );
        })}
      </div>

      {brand.guardrails.length > 0 ? (
        <section className="mt-10">
          <p className="group-heading mb-3 px-1">
            Guardrails
            <span className="ml-1.5 tnum text-ink-faint/70">
              {brand.guardrails.length}
            </span>
          </p>
          <div className="surface px-6 py-4">
            <ul className="list-disc space-y-1.5 pl-4 text-[0.875rem] leading-relaxed text-ink-soft">
              {brand.guardrails.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {failed ? <ErrorNote text={`Konnte nicht speichern: ${failed}`} /> : null}
    </>
  );
}
