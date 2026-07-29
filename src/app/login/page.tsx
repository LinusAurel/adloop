"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Step = "email" | "code";

// Fehlercodes des Servers auf Übersetzungsschlüssel — der Server schickt Codes,
// nie fertigen Text (SPEC §8.2).
const ERROR_KEY: Readonly<Record<string, string>> = {
  validation_error: "errValidation",
  invalid_login_code: "errInvalidCode",
  login_rate_limited: "errRateLimited",
};

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "unknown_error";
}

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function describe(key: string): string {
    const mapped = ERROR_KEY[key];
    return mapped ? t(mapped) : t("errUnknown", { code: key });
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/email/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(describe(await errorCode(response)));
      return;
    }
    setStep("code");
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/email/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(describe(await errorCode(response)));
      return;
    }
    router.push("/connectors");
  }

  return (
    <main className="page" style={{ paddingTop: "12vh" }}>
      <div className="narrow">
        <div style={{ marginBottom: 18 }}>
          <span className="mark" style={{ fontSize: 20 }}>
            ad<span>loop</span>
          </span>
        </div>

        <div className="panel">
          <h2>{t("title")}</h2>

          {step === "email" ? (
            <form onSubmit={submitEmail}>
              <p style={{ color: "var(--dim)", fontSize: 12.5, margin: "0 0 14px" }}>{t("lead")}</p>
              <label className="field">
                <span>{t("email")}</span>
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="name@firma.de"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button className="btn pri" disabled={busy} type="submit">
                {busy ? t("requesting") : t("requestCode")}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <p style={{ color: "var(--dim)", fontSize: 12.5, margin: "0 0 14px" }}>
                {t("codeSent", { email })}
              </p>
              <label className="field">
                <span>{t("code")}</span>
                <input
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder="······"
                  // Der Code steht später in keiner Spalte, aber er ist eine
                  // Ziffernfolge, die man Zeichen für Zeichen abgleicht.
                  style={{ letterSpacing: "0.4em", fontSize: 15 }}
                  className="data"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <div className="acts">
                <button className="btn pri" disabled={busy} type="submit">
                  {busy ? t("verifying") : t("signIn")}
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                  }}
                >
                  {t("otherEmail")}
                </button>
              </div>
            </form>
          )}

          {error && (
            <div className="msgbox err" style={{ marginTop: 14, marginBottom: 0 }} role="alert">
              {error}
            </div>
          )}
        </div>

        <p style={{ color: "var(--dim)", fontSize: 11.5, fontFamily: "var(--font-data)" }}>
          {t("devHint")}
        </p>
      </div>
    </main>
  );
}
