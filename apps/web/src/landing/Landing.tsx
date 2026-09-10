import { useState, type FormEvent, type ReactNode } from "react";
import { solveChallenge } from "altcha-lib/v1";
import { HeaderLockup, Mark } from "../components/Wordmark.js";
import { LandingPrimary } from "./LandingPrimary.js";
import {
  CalendarIcon,
  CoinIcon,
  ForkIcon,
  GitHubMark,
  ServerIcon,
  TapIcon,
  TrophyIcon,
} from "./icons.js";
import { LandingFooter } from "./Footer.js";
import { RuledHeading } from "./PageShell.js";
import { siteConfig } from "../lib/site-config.js";

/**
 * The public landing page (D90, D97, D99).
 *
 * Structure borrowed from postliminalsystems.com: a header, a hero with one
 * headline and one action, a row of figure cards, one section per capability
 * with a screenshot, an honest section about cost, and a small footer.
 *
 * The tone is not borrowed. This speaks to one person who has tried the apps
 * that draw a jagged daily line, call a two-kilo water swing progress, and turn
 * a missed Tuesday into a broken streak. Everything below is written to somebody
 * who is tired of that, which is why it says what the app does not do about as
 * often as what it does.
 *
 * ## Two rules the copy follows, and one it inherits
 *
 * **Every paragraph is a bold lead-in and then the sentence.** The lead-in
 * states the point and the sentence supports it, so the page can be read by
 * lead-ins alone and still say the same thing. It began as the shape of the
 * "Så räknar den" section and turned out to be the shape the whole page wanted.
 *
 * **No emphasis anywhere else.** A bold phrase in the middle of a paragraph is
 * a second voice arguing with the first, and once there are two the reader
 * trusts neither. Emphasis is the lead-in's job and nothing else's.
 *
 * The inherited rule is §5's: no en dashes or em dashes, sentence case, no
 * shouting. `copy-style.test.ts` now reads this file as well as the app's
 * dictionary, because the landing page is interface copy too and was the one
 * surface those rules were never checked against.
 *
 * It uses the app's tokens and components and nothing that needs a session. The
 * only endpoint it touches is `POST /api/invite-requests`, which is public,
 * rate limited, honeypotted, and only exists where `LANDING_ENABLED` is on.
 */



export function Landing() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main>
        <Hero />
        <Figures />
        <Capabilities />
        <HowItCounts />
        <Ai />
        <FreeForever />
        <InviteForm />
      </main>
      <LandingFooter />
    </div>
  );
}

/**
 * A section heading, separated from what came before it exactly once (D114).
 *
 * A heading with an icon is already set apart: a tinted square at the start of
 * the line does the whole job. Adding a rule underneath gave those four
 * headings two separators and made the page look like it was trying twice. The
 * three headings with no icon keep the rule, because without it they are body
 * text in a slightly larger size.
 *
 * A rule rather than an underline in either case: an underline on a heading
 * reads as a link, which is the one thing it must not be.
 */
function Heading({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={icon === undefined ? "mb-6" : "mb-4"}>
      <RuledHeading size="text-metric-sm" icon={icon} rule={icon === undefined}>
        {children}
      </RuledHeading>
    </div>
  );
}

/**
 * The tinted square a capability heading's icon sits in.
 *
 * Same treatment as the figure cards, and coloured from the profile's semantic
 * map rather than from what looks good beside the screenshot: the mark itself
 * for the trend section, since Lingon belongs to the trend line and the
 * wordmark and this heading is about the line; Blåbär for food, because Blåbär
 * is nutrition; Gran for the day, because Gran is logging; Honung for
 * milestones, because Honung is the pot and the rewards.
 */
function HeadingIcon({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg ${tint}`}
    >
      {children}
    </span>
  );
}

/**
 * The header: the lockup and one link.
 *
 * Profile v1.2 settles what D91 and page 7 disagreed about. The compact
 * mark-and-wordmark lockup at 20 pt *is* the header, in the app and here, and
 * the landing page does not repeat it in the hero. So the hero below opens on
 * the slogan rather than on a second copy of the logo, which also means the
 * first thing on the page is the sentence rather than the branding.
 */
function TopBar() {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5">
      <HeaderLockup />
      <a
        className="inline-flex items-center gap-2 text-note text-muted transition-colors hover:text-ink"
        href={siteConfig().repo}
        target="_blank"
        rel="noopener noreferrer"
      >
        <GitHubMark />
        GitHub
      </a>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto w-full max-w-3xl px-5 pb-16 pt-10 text-center sm:pt-16">
      <h1 className="text-figure-sm text-ink">Gör det lättare</h1>
      <p className="mx-auto mt-4 max-w-prose text-body text-muted">
        Lättare att logga, och lättare att läsa. En trendlinje i
        stället för dagens siffra, och en underhållsnivå räknad ur det du
        faktiskt gjort.
      </p>

      {/*
        One primary action, which is what lets it be Lingon at all. See
        LandingPrimary for the exception and its boundary.
      */}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <LandingPrimary href="/app">Öppna appen</LandingPrimary>
        <a className="btn-secondary inline-flex w-auto px-6" href="#kod">
          Be om en kod
        </a>
      </div>
    </section>
  );
}

/**
 * Three cards, each with a measured number.
 *
 * The tap figure is the one from STATE.md's fast-path table, taken on the
 * production build under throttling, not an estimate: a landing page that
 * rounds its own measurements down is the same genre of thing as an app that
 * calls a water swing progress. `landing-figures.test.ts` pins it there.
 *
 * The icon colours come from the profile's semantic map and not from what looks
 * good together. Gran is logging, so it carries the taps. Honung is money and
 * rewards, so it carries the price. Is is secondary data, so it carries the one
 * about who sees anything. A fourth card would need a fourth area to belong to,
 * and there is not one, which is the map doing its job.
 *
 * The third card has been wrong twice, in two different ways.
 *
 * It read "100 % av din data ligger på din egen server", which is true when
 * somebody self-hosts and false when they use an instance somebody else runs,
 * and the page cannot know which reader it has (D111). Replacing it with "0
 * tredje parter som ser dina mätvärden" fixed the truth and broke the form: the
 * strip is three number-and-unit pairs, "2 tryck" and "0 kr" read as one, and a
 * bare 0 with a clause after it did not (D114).
 *
 * "1 server" is both. It parses like its neighbours, and it is true whether the
 * server is the reader's own or the owner's, which is the property the first
 * version lacked. `source` pins the claim to the sentence on /integritet it
 * condenses, so the strip cannot go on saying something the privacy page has
 * stopped saying.
 */
function Figures() {
  const figures = [
    {
      icon: <TapIcon className="size-5" />,
      tint: "bg-logged/15 text-logged",
      value: "2",
      unit: "tryck",
      label: "för att logga något du ätit förut",
    },
    {
      icon: <CoinIcon className="size-5" />,
      tint: "bg-reward/15 text-reward",
      value: "0",
      unit: "kr",
      label: "att använda, och källkoden är öppen",
    },
    {
      icon: <ServerIcon className="size-5" />,
      tint: "bg-data/15 text-data",
      value: "1",
      unit: "server",
      label: "Där stannar allt du loggar.",
      source: "Ingenting annat lämnar servern.",
    },
  ];

  return (
    <section className="border-y border-edge bg-card">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-4 px-5 py-12 sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.label} className="rounded-card border border-edge bg-paper p-5">
            <span
              className={`inline-flex size-10 items-center justify-center rounded-lg ${figure.tint}`}
            >
              {figure.icon}
            </span>

            <p className="num mt-4 text-figure-sm text-ink">
              {figure.value}
              {figure.unit === "" ? null : (
                <span className="ml-2 align-baseline text-metric-sm font-normal text-muted">
                  {figure.unit}
                </span>
              )}
            </p>
            <p className="mt-2 max-w-[24ch] text-note text-muted">{figure.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A phone-shaped frame around a real screenshot.
 *
 * CSS rather than a photograph or a stock mockup: a rounded rectangle with the
 * app's own edge colour and a notch, holding a genuine 360 px capture from
 * `shoot2.mjs`. A device photograph would put someone else's hardware and
 * someone else's lighting between the reader and the thing being shown.
 */
function Phone({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="relative rounded-[2rem] border border-edge bg-card p-2 shadow-2xl">
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-2 z-10 h-4 w-20 -translate-x-1/2 rounded-full bg-paper"
        />
        <img src={src} alt={alt} loading="lazy" className="w-full rounded-[1.6rem]" />
      </div>
    </div>
  );
}

function Capability({
  title,
  icon,
  children,
  src,
  alt,
  flip = false,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  src: string;
  alt: string;
  flip?: boolean;
}) {
  return (
    <section className="mx-auto w-full max-w-5xl px-5 py-14">
      <div
        className={`flex flex-col items-center gap-10 sm:flex-row ${
          flip ? "sm:flex-row-reverse" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <Heading icon={icon}>{title}</Heading>
          <div className="space-y-3 text-body text-muted">{children}</div>
        </div>
        <div className="w-full sm:w-auto sm:flex-1">
          <Phone src={src} alt={alt} />
        </div>
      </div>
    </section>
  );
}

function Capabilities() {
  return (
    <>
      <Capability
        title="Linjen, inte dagens siffra"
        icon={
          <HeadingIcon tint="bg-card">
            <Mark size={24} />
          </HeadingIcon>
        }
        src="/screens/oversikt.png"
        alt="Översikten med trendlinjen och dagens kalorier"
      >
        <p>
          Vikten svänger. Ett kilo över en natt på salt, sömn och
          vatten, och en graf över råa vägningar visar just den svängningen.
        </p>
        <p>
          Trenden är det du tittar på. Vikt ritar en utjämnad linje
          genom alla dina vägningar och lägger de råa punkterna bakom den, blekt.
          De göms inte, de är bara inte huvudsaken.
        </p>
      </Capability>

      <Capability
        title="Logga mat med ett tryck"
        icon={
          <HeadingIcon tint="bg-nutrition/15 text-nutrition">
            <ForkIcon className="size-5" />
          </HeadingIcon>
        }
        src="/screens/mat.png"
        alt="Matloggen med sökning, skanning och senast loggade rader"
        flip
      >
        <p>
          Det du åt i går ligger överst. Ett tryck loggar samma sak
          igen, i samma portion.
        </p>
        <p>
          Resten finns också. Streckkod, sökning mot Open Food Facts
          och Livsmedelsverket, eller skriv in själv när maten inte finns i någon
          databas, som pizzerian nere på gatan.
        </p>
        <p>
          Allt sparas lokalt först. Det synkar när du är uppkopplad
          igen, så en måltid i en butikskällare blir loggad ändå.
        </p>
      </Capability>

      <Capability
        title="Dagen, om du vill"
        icon={
          <HeadingIcon tint="bg-logged/15 text-logged">
            <CalendarIcon className="size-5" />
          </HeadingIcon>
        }
        src="/screens/dag.png"
        alt="Dagen med energi, humör, sömn och steg"
      >
        <p>
          Sju saker på ett ställe. Energi, humör, sömn, steg,
          alkohol, rörelse och mått.
        </p>
        <p>
          Hoppa över det du inte vill svara på. En dag utan loggning
          är ett hål i data, inte ett underkännande.
        </p>
        <p>
          Appen har inget misslyckandetillstånd. Ingenting blir rött
          för att det gick dåligt.
        </p>
      </Capability>

      <Capability
        title="Milstolpar och sparpott"
        icon={
          <HeadingIcon tint="bg-reward/15 text-reward">
            <TrophyIcon className="size-5" />
          </HeadingIcon>
        }
        src="/screens/framsteg.png"
        alt="Framsteg med milstolpar, streck och sparpotten"
        flip
      >
        <p>
          Sätt mål i det du faktiskt mäter. Midjemått, nyktra dagar
          och dagar i rad med loggning, inte bara kilo.
        </p>
        <p>
          Potten räknar ihop det du inte köpte. En belöning går att
          ta ut även om potten inte täcker den, för den är en räknare och inte en
          spärr.
        </p>
      </Capability>
    </>
  );
}

/**
 * The arithmetic, said plainly.
 *
 * This is where somebody who has been lied to by a fitness app decides whether
 * to trust this one, so it names its sources and its limits rather than
 * asserting accuracy. The Open Food Facts and Livsmedelsverket attribution
 * lives here rather than in the footer for the same reason: it belongs with the
 * claim it supports.
 */
function HowItCounts() {
  return (
    <section className="border-y border-edge bg-card">
      <div className="mx-auto w-full max-w-3xl px-5 py-14">
        <Heading>Så räknar den</Heading>
        <div className="space-y-4 text-body text-muted">
          <p>
            Trendvikt före dagsvikt. Ett exponentiellt glidande
            medelvärde med tio dagars konstant, räknat per dag och inte per
            vägning, så en vecka mellan två vägningar inte gör linjen trög.
          </p>
          <p>
            Underhållsnivån räknas ur dina egna siffror. Över de
            senaste fyra veckorna tas vad du ätit mot vad trenden gjort, och ur
            det faller den nivå som förklarar båda. En formel används bara de
            första två veckorna, och appen säger vilken av dem du tittar på och
            hur säker den är.
          </p>
          <p>
            Makromål från NNR 2023. Så som Livsmedelsverket
            publicerar dem, jämförda mot ett rullande sjudagarssnitt eftersom det
            är så rekommendationerna är skrivna. Inte en fördelning som en app
            hittat på.
          </p>
          <p>
            Ingen siffra hittas på. En dag utan loggning står som
            "inte än", aldrig som noll. En summa som saknar uppgifter säger
            "minst". En uppskattning är märkt som uppskattning överallt där den
            syns.
          </p>
        </div>

        <p className="mt-6 text-micro text-muted">
          Livsmedelsdata kommer från Open Food Facts, som är licensierad under
          ODbL, och från Livsmedelsverket. Båda hämtas när du söker och
          mellanlagras lokalt.
        </p>
      </div>
    </section>
  );
}

/**
 * The AI section, written to be the reason someone trusts the rest.
 *
 * Every app the reader has tried has an AI feature that guesses calories. This
 * one says, in a lead-in they cannot miss, that it does not. That is the actual
 * difference and it is worth more than any claim about accuracy.
 */
function Ai() {
  return (
    <section className="mx-auto w-full max-w-3xl px-5 py-14">
      <Heading>Om AI</Heading>
      <div className="space-y-3 text-body text-muted">
        <p>
          Det är valfritt. Lagret kör på hårdvara du själv styr
          över, hemma eller på din egen server, och ingenting skickas till någon
          molntjänst.
        </p>
        <p>
          Det gör två saker. Det tolkar vad du skrivit att du ätit,
          och föreslår vad du kan laga av det du har hemma.
        </p>
        <p>
          Det räknar aldrig ut en kalori eller ett makrovärde själv.{" "}
          Modellen namnger maten och gissar mängden, och siffrorna kommer ur
          livsmedelsdatabasen varje gång.
        </p>
        <p>
          Det är skillnaden mot apparna du provat. En språkmodell
          som ombeds gissa kalorier gissar självsäkert och fel, och den siffran
          hamnar sedan i underlaget för allt annat appen räknar ut.
        </p>
        <p>
          Vill du inte ha det stänger du av det. Då finns knapparna
          inte där, de blir inte gråa.
        </p>
      </div>
    </section>
  );
}

/** The cost section, and why it can afford to be free. */
function FreeForever() {
  return (
    <section className="border-y border-edge bg-card">
      <div className="mx-auto w-full max-w-3xl px-5 py-14">
        <Heading>Gratis</Heading>
        <div className="space-y-3 text-body text-muted">
          <p>
            Det finns ingen betalversion. Ingen prenumeration, och
            inget som är låst bakom en uppgradering.
          </p>
          <p>
            Det kommer inte heller att dyka upp. Koden är öppen
            under AGPL, så om det någonsin skulle ske kan vem som helst köra
            versionen innan.
          </p>
          <p>
            Det går för att appen inte kostar något att driva. En
            liten server, ingen annonsförsäljning, ingen data att sälja och ingen
            tillväxtplan. Kör du den själv kostar den dig en container på en
            maskin du redan har.
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The invite form.
 *
 * Registration is invite-only and always has been. It says plainly that a person
 * reads the request, because an automatic-sounding form that then takes a week
 * is worse than a slow one that said so.
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
    <section id="kod" className="mx-auto w-full max-w-3xl px-5 py-14">
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
        {/* No `Heading`: this one has no rule, and a card is not a section. */}
        <h2 className="text-metric-sm text-ink">Be om en kod</h2>

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
