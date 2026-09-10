import { useState, type FormEvent } from "react";
import { solveChallenge } from "altcha-lib/v1";
import { HeaderLockup } from "../components/Wordmark.js";
import { LandingFooter } from "./Footer.js";

/**
 * `/kod`: the one page that asks a stranger for something (D127).
 *
 * Unlinked, and behind `REQUEST_ENABLED`, which is off by default. Nothing on
 * the landing page points here; the owner sends the address to somebody they
 * have already decided to let in, or the path simply does not exist.
 *
 * Why it left the landing page: the landing page may be read by anybody, and a
 * form on it invites requests from people the owner has no reason to accept.
 * Every approved code makes whoever runs the installation responsible for
 * another person's weight, meals and address, under their own name in
 * /integritet. That is a decision worth making one person at a time, and a
 * form on a public page is the opposite of that.
 *
 * Everything that guarded the form came with it: the human check (D112), the
 * honeypot, and the per-IP rate limit on the endpoint. Off is off at the
 * server, not only in the markup - nginx 404s this path and the API does not
 * register the route - so a hidden page is not the security boundary. This one
 * is unlinked because it is not for browsing, not because being unfindable
 * protects it.
 */
export function RequestCode() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-5">
        <a href="/" aria-label="Vikt">
          <HeaderLockup />
        </a>
        <a
          className="text-note text-muted underline underline-offset-4 hover:text-ink"
          href="/"
        >
          Tillbaka
        </a>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-4">
        <InviteForm />
      </main>

      <LandingFooter />
    </div>
  );
}

/**
 * The form itself.
 *
 * Registration is invite-only and always has been. It says plainly that a
 * person reads the request, because an automatic-sounding form that then takes
 * a week is worse than a slow one that said so.
 */
/**
 * The human check, solved while the form is being submitted (D112).
 *
 * ALTCHA, self-hosted: the challenge comes from this server, the answer is
 * checked by this server, and nothing is fetched from anywhere else. That
 * matters here specifically, because the page two links below promises that
 * nothing leaves the server, and a widget from Google or Cloudflare would make
 * that a lie on the one page where it is being asserted.
 *
 * Nothing to click. There is no checkbox and no puzzle: the browser spends a
 * few tens of milliseconds finding the number that hashes to the challenge,
 * which happens inside the submit the visitor already pressed. Someone with
 * JavaScript turned off cannot pass it, which is the trade being made and is
 * why the honeypot and the rate limit are still there behind it.
 */
async function solveHumanCheck(): Promise<string> {
  const response = await fetch("/api/invite-requests/challenge");
  if (!response.ok) throw new Error(String(response.status));

  const challenge = (await response.json()) as {
    algorithm: string;
    challenge: string;
    salt: string;
    signature: string;
    maxnumber: number;
  };

  const started = Date.now();
  const solution = await solveChallenge(
    challenge.challenge,
    challenge.salt,
    challenge.algorithm,
    challenge.maxnumber,
  ).promise;

  if (solution === null) throw new Error("unsolved");

  // The payload shape ALTCHA verifies: the challenge as issued, plus the answer.
  return btoa(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      number: solution.number,
      salt: challenge.salt,
      signature: challenge.signature,
      took: Date.now() - started,
    }),
  );
}

function InviteForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  /** The honeypot. Never shown, never focusable, never filled by a person. */
  const [website, setWebsite] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("sending");

    try {
      const altcha = await solveHumanCheck();

      const response = await fetch("/api/invite-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          altcha,
          ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
          ...(website === "" ? {} : { website }),
        }),
      });

      if (response.ok) {
        setState("done");
        return;
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setMessage(body?.message ?? "Det gick inte just nu. Försök igen om en stund.");
      setState("error");
    } catch {
      setMessage("Det gick inte att nå servern. Försök igen om en stund.");
      setState("error");
    }
  }

  return (
    <section className="py-6">
      {/*
        One card, centred, holding the whole ask (D114).

        The heading, the explanation, the form and the sentence about what
        happens to the address were four blocks stacked down a full-width
        column, and the form itself was a narrower panel inside that, so the
        reader had to work out which of the four things belonged to it. They all
        do. A card is the shape that says so, and this is the one place on the
        page that asks the reader for something rather than telling them
        something.

        No rule under the heading: the card's own edge is the separator, and a
        rule inside a bordered box is the same "trying twice" the capability
        headings had.

        Same treatment as the figure cards, inverted for its ground. Those sit
        on a Skymning band and are Natt; this sits on the page's Natt and is
        Skymning. `rounded-card` and the Dis border are the constant, and the
        surface is whichever of the two the ground is not.

        `max-w-md` and `mx-auto`, so it is one column at 360 px because it is
        one column everywhere.
      */}
      <div className="mx-auto max-w-md rounded-card border border-edge bg-card p-6">
        {/*
          `h1`, not `h2`. On the landing page this card was one section among
          eight and took a subheading; here it is the page, and a document
          whose only heading is an h2 has a hole where its title should be.

          No `Heading`: this one has no rule, and a card is not a section.
        */}
        <h1 className="text-metric-sm text-ink">Be om en kod</h1>

        {state === "done" ? (
          <p className="mt-4 text-body text-muted" aria-live="polite">
            Tack, din förfrågan har kommit fram. Den läses av en
            människa, så det kan dröja. Du får ett mejl antingen med en kod eller
            inte alls.
          </p>
        ) : (
          <>
            <p className="mt-3 text-body text-muted">
              Registrering sker med kod. Det håller det litet. Skriv
              ditt namn och din adress så läser jag förfrågan för hand och hör av mig.
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
              <label className="block text-micro text-muted">
                Namn
                <input
                  id="invite-name"
                  className="field mt-1 w-full"
                  type="text"
                  autoComplete="name"
                  maxLength={120}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <label className="block text-micro text-muted">
                E-post
                <input
                  id="invite-email"
                  className="field mt-1 w-full"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label className="block text-micro text-muted">
                Varför, om du vill säga något (frivilligt)
                <textarea
                  id="invite-reason"
                  className="field mt-1 min-h-20 w-full"
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>

              {/*
                The honeypot: off-screen rather than `display:none`, because some
                bots skip fields they can see are hidden. Aria-hidden and
                tabIndex -1 so no assistive technology or keyboard reaches it.
              */}
              <div className="absolute left-[-9999px]" aria-hidden="true">
                <label>
                  Webbplats
                  <input
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(event) => setWebsite(event.target.value)}
                  />
                </label>
              </div>

              {state === "error" ? (
                <p role="status" className="text-micro text-muted">
                  {message}
                </p>
              ) : null}

              {/*
                The check is worth one line rather than none. There is nothing to
                do about it, but a page whose whole argument is that nothing
                leaves the server should say what the thing it just ran was.
              */}
              <p className="text-micro text-muted">
                Formuläret gör en kort kontroll i din webbläsare för att hålla
                robotar borta. Du behöver inte göra något, och ingenting skickas
                till någon annan än den här servern.
              </p>

              <button
                className="btn w-auto px-6"
                type="submit"
                disabled={name.trim() === "" || email.trim() === "" || state === "sending"}
              >
                {state === "sending" ? "Skickar…" : "Skicka förfrågan"}
              </button>
            </form>
          </>
        )}

        {/*
          Inside the card, and shown in both states (D114). It is the answer to
          "what happens to what I just typed", which is a question somebody has
          after sending as much as before. It used to sit outside and below,
          where it read as a footnote about the page rather than a term of the
          thing being asked.

          The address block it replaced is now /integritet (D106): it was true
          and covered about a third of what a service other people use has to
          say, and a fold-out under a form is the wrong shape for a document
          somebody may need to read carefully or link to.
        */}
        <p className="mt-6 border-t border-edge pt-4 text-micro text-muted">
          Adressen används bara för att svara på förfrågan och skicka koden. Säger
          jag nej raderas raden.{" "}
          <a className="underline underline-offset-4 hover:text-ink" href="/integritet">
            Så hanteras dina uppgifter
          </a>
          .
        </p>
      </div>
    </section>
  );
}
