import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "./auth/session";

/**
 * Node-Runtime, weil die Sitzungssignatur über node:crypto läuft. Ohne diese
 * Zeile lädt Next die Middleware in der Edge-Runtime und das Modul bricht.
 */
export const runtime = "nodejs";

/** Erreichbar ohne Sitzung. Alles andere nicht. */
const PUBLIC_PATHS = ["/login"];

/**
 * Ein einziges Tor statt zehn Meinungen.
 *
 * Vorher prüfte jede Seite für sich — drei taten es, sieben nicht, und die
 * drei erst, nachdem ein Aufruf mit 401 zurückkam. Wer die Sitzung verlor, sah
 * je nach Seite mal die Anmeldung, mal eine leere Oberfläche, mal einen
 * Rückwurf mitten in der Arbeit. Das ist der Mischzustand, den niemand
 * versteht.
 *
 * Jetzt gilt: ohne Sitzung führt jeder Weg zur Anmeldung, mit Sitzung ist
 * alles offen. Geprüft wird nur die Signatur — ob der Mensch dahinter noch
 * Rechte hat, entscheidet die API-Schicht bei jedem Aufruf erneut.
 */
export default function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((path) => pathname.startsWith(path));
  const session = getSession(request);

  if (!session && !isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = "/login";
    // Wohin es zurückgehen soll, sobald die Anmeldung steht — sonst landet
    // jeder nach dem Anmelden auf derselben Startseite, egal was er wollte.
    target.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(target);
  }

  // Angemeldet auf der Anmeldeseite: es gibt nichts mehr zu tun.
  if (session && isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = "/chat";
    target.search = "";
    return NextResponse.redirect(target);
  }

  // Keine i18n-Middleware: Die Oberfläche hat keine Sprachpräfixe in den
  // Adressen, die Sprache kommt aus dem Cookie (src/i18n/request.ts). Ließe man
  // next-intl hier laufen, würde es Präfixe erwarten und jede Seite auf 404
  // schicken — genau das ist beim ersten Versuch passiert.
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
