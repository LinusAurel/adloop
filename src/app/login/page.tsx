"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Step = "email" | "code";

const ERROR_TEXT: Readonly<Record<string, string>> = {
  validation_error: "Bitte prüfe deine Eingabe.",
  invalid_login_code: "Der Code ist ungültig oder abgelaufen.",
  login_rate_limited: "Zu viele Versuche. Bitte warte 15 Minuten.",
};

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "unknown_error";
}

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("user@example.com");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const key = await errorCode(response);
      setError(ERROR_TEXT[key] ?? `Anmeldung fehlgeschlagen (${key}).`);
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
      const key = await errorCode(response);
      setError(ERROR_TEXT[key] ?? `Anmeldung fehlgeschlagen (${key}).`);
      return;
    }
    router.push("/connectors");
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 420, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Anmelden</h1>
      {step === "email" ? (
        <form onSubmit={submitEmail}>
          <label>
            E-Mail
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{ display: "block", width: "100%", padding: "0.6rem", margin: "0.5rem 0 1rem" }}
            />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Wird angefordert…" : "Code anfordern"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <p>Der sechsstellige Code wurde für {email} angefordert.</p>
          <label>
            Code
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              style={{ display: "block", width: "100%", padding: "0.6rem", margin: "0.5rem 0 1rem" }}
            />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Wird geprüft…" : "Anmelden"}
          </button>
        </form>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <p style={{ color: "var(--dim)", marginTop: "2rem" }}>
        In der Entwicklung steht der Code im Web-Log.
      </p>
    </main>
  );
}
