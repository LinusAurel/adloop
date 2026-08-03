"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/LocaleSwitch";

type Method = "env" | "password" | "oidc" | "code";

// Fehlercodes des Servers auf Übersetzungsschlüssel — der Server schickt Codes,
// nie fertigen Text (SPEC §8.2).
const ERROR_KEY: Readonly<Record<string, string>> = {
  validation_error: "errValidation",
  invalid_credentials: "errInvalidCredentials",
  invalid_login_code: "errInvalidCode",
  login_rate_limited: "errRateLimited",
  method_not_enabled: "errMethodNotEnabled",
  oidc_state_mismatch: "errOidcState",
  oidc_no_email: "errOidcNoEmail",
  oidc_domain_not_allowed: "errOidcDomain",
};

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "unknown_error";
}

export default function LoginPage() {
  const t = useTranslations("login");
  const router = useRouter();
  const params = useSearchParams();

  const [methods, setMethods] = useState<Method[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"credentials" | "code">("credentials");
  const [delivery, setDelivery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function describe(value: string): string {
    const mapped = ERROR_KEY[value];
    return mapped ? t(mapped as never) : t("errUnknown", { code: value });
  }

  // Welche Wege es gibt, weiß nur der Server. Ein Bildschirm, der ein Verfahren
  // anbietet, das an einer fehlenden Variablen scheitert, ist schlimmer als
  // einer, der es gar nicht zeigt.
  useEffect(() => {
    void fetch("/api/auth/password", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { methods: [] }))
      .then((data: { methods: Method[] }) => setMethods(data.methods))
      .catch(() => setMethods([]));
  }, []);

  // Ein Fehler aus dem OIDC-Rücklauf steht in der Adresse, nicht in einer Antwort.
  const urlError = params.get("error");
  useEffect(() => {
    if (urlError) setError(describe(urlError));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlError]);

  function goNext() {
    const next = params.get("next");
    router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : "/chat");
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(describe(await errorCode(response)));
      return;
    }
    goNext();
  }

  async function requestCode(event: FormEvent) {
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
    const body = (await response.json().catch(() => null)) as { delivery?: string } | null;
    setDelivery(body?.delivery ?? null);
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
    goNext();
  }

  const hasPassword = methods?.some((m) => m === "env" || m === "password") ?? false;
  const hasOidc = methods?.includes("oidc") ?? false;
  const hasCode = methods?.includes("code") ?? false;
  const nextParam = params.get("next");

  return (
    <main className="page" style={{ paddingTop: "12vh" }}>
      <div className="narrow">
        <div style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mark" style={{ fontSize: "var(--fs-head)" }}>
            ad<span>loop</span>
          </span>
          {/* Wer die Seite nicht lesen kann, kommt nie an den Umschalter
              hinter der Anmeldung. */}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <LocaleSwitch />
          </span>
        </div>

        <div className="panel">
          <h2>{t("title")}</h2>

          {methods === null ? (
            <p style={{ color: "var(--dim)", fontSize: "var(--fs-small)", margin: 0 }}>
              {t("loading")}
            </p>
          ) : methods.length === 0 ? (
            // Kein Verfahren aktiv heißt: niemand kommt hinein. Das ist eine
            // Fehlkonfiguration und gehört benannt, nicht als leeres Formular
            // dargestellt.
            <div className="msgbox err" role="alert">
              {t("noMethods")}
            </div>
          ) : (
            <>
              {hasOidc && (
                <>
                  <a
                    className="btn pri"
                    style={{ width: "100%", justifyContent: "center" }}
                    href={`/api/auth/oidc/start${
                      nextParam ? `?next=${encodeURIComponent(nextParam)}` : ""
                    }`}
                  >
                    {t("continueWithSso")}
                  </a>
                  {(hasPassword || hasCode) && <div className="or">{t("or")}</div>}
                </>
              )}

              {hasPassword && (
                <form onSubmit={submitPassword}>
                  <label className="field">
                    <span>{t("email")}</span>
                    <input
                      type="email"
                      required
                      autoComplete="username"
                      spellCheck={false}
                      placeholder="name@firma.de"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{t("password")}</span>
                    <input
                      type="password"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <button className="btn pri" disabled={busy} type="submit">
                    {busy ? t("signingIn") : t("signIn")}
                  </button>
                </form>
              )}

              {hasCode && !hasPassword && step === "credentials" && (
                <form onSubmit={requestCode}>
                  <label className="field">
                    <span>{t("email")}</span>
                    <input
                      type="email"
                      required
                      autoComplete="username"
                      spellCheck={false}
                      placeholder="name@firma.de"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <button className="btn pri" disabled={busy} type="submit">
                    {busy ? t("requesting") : t("requestCode")}
                  </button>
                </form>
              )}

              {hasCode && step === "code" && (
                <form onSubmit={submitCode}>
                  <p style={{ color: "var(--dim)", fontSize: "var(--fs-small)", margin: "0 0 14px" }}>
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
                      spellCheck={false}
                      placeholder="······"
                      className="data"
                      style={{ letterSpacing: "0.4em", fontSize: "var(--fs-lead)" }}
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
                        setStep("credentials");
                        setCode("");
                        setError(null);
                      }}
                    >
                      {t("otherEmail")}
                    </button>
                  </div>
                </form>
              )}

              {/* Der Hinweis, wo der Code steht, gilt nur für die Log-Zustellung
                  und erst, nachdem einer angefordert wurde. */}
              {step === "code" && delivery === "log" && (
                <div className="msgbox warn data" style={{ marginTop: 14, marginBottom: 0 }}>
                  {t("devHint")}
                </div>
              )}
            </>
          )}

          {error && (
            <div className="msgbox err" style={{ marginTop: 14, marginBottom: 0 }} role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
