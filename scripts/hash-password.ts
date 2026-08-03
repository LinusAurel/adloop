/**
 * Erzeugt einen Passwort-Hash für ADLOOP_ADMIN_PASSWORD_HASH oder für
 * app_user.password_hash.
 *
 *   pnpm hash-password
 *
 * Das Passwort wird über die Eingabe abgefragt, nicht als Argument übergeben —
 * Argumente stehen in der Shell-Historie und in der Prozessliste.
 */
import { createInterface } from "node:readline";
import { hashPassword } from "../src/auth/password";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const password = await prompt("Passwort (mindestens 12 Zeichen): ");
  const again = await prompt("Wiederholen: ");

  if (password !== again) {
    process.stderr.write("Die Eingaben stimmen nicht überein.\n");
    process.exit(1);
  }

  try {
    // Nur der Hash geht nach stdout, damit `pnpm hash-password >> .env` trägt.
    process.stdout.write(`${await hashPassword(password)}\n`);
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    process.stderr.write(
      code === "password_too_short"
        ? "Zu kurz — mindestens 12 Zeichen.\n"
        : `Fehlgeschlagen: ${code}\n`,
    );
    process.exit(1);
  }
}

void main();
