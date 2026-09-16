import { useEffect, type CSSProperties, type ReactNode } from "react";
import { HeaderLockup } from "../components/Wordmark.js";
import { LandingPrimary } from "./LandingPrimary.js";
import { DriftField, HeroGraph, NoiseGraph } from "./TrendDrawing.js";
import { startLandingMotion } from "./landing-motion.js";
import { MAINTENANCE, SETTLED_TREND } from "./seeded.js";
import { LandingFooter } from "./Footer.js";
import { siteConfig } from "../lib/site-config.js";

/**
 * The public landing page (D90, D99, D127, D173).
 *
 * Rebuilt around one idea: **the page draws the product's argument before it
 * states it.** A cloud of daily readings appears, a trend line draws through
 * them, and only then does anything say "gör det lättare". Somebody who scrolls
 * no further has already seen the difference between this and the app that
 * draws a jagged daily line.
 *
 * ## The two rules it is built under (§5, D172)
 *
 * **Motion carries meaning.** Every animation here says something a still frame
 * cannot: readings arrive one at a time because that is how they are logged, the
 * line draws because a trend accumulates, the two maintenance figures count
 * because they were measured rather than chosen, and in "En dagsvikt är mest
 * brus" the reader draws the trend through the noise with their own scrolling.
 * Nothing moves because moving is modern, nothing loops except the field behind
 * the hero, which is background rather than subject and pauses with the tab.
 *
 * **Restraint is the style.** Natt is matte: no gradients, no glow, no glass.
 * One three-dimensional move exists on the whole page, the phone frames coming
 * level as they scroll in, and it flattens and stays flat.
 *
 * ## Colour
 *
 * Lingon appears in exactly two places, and both are the rule rather than an
 * exception to it: the trend lines in `TrendDrawing.tsx`, and the single
 * primary action in `LandingPrimary.tsx`, which is profile page 4's own
 * carve-out for this page. The cards in "Det du loggar" carry the four area
 * accents, each on the area it names, which is what they are for.
 *
 * ## Copy
 *
 * The lead-in-and-sentence shape D111 removed is still gone. No emphasis inside
 * a paragraph, no dashes, no semicolons, sentence case throughout, and
 * `copy-style.test.ts` reads this file rather than the dictionary, because the
 * landing bundle ships without one.
 */

export function Landing() {
  /**
   * The behaviour, started once and cleaned up on unmount so the render tests
   * do not leave observers behind. Everything it does is additive: the page is
   * complete and readable before it runs, and under reduced motion it does
   * almost nothing at all.
   */
  useEffect(() => startLandingMotion(), []);

  return (
    <div className="min-h-dvh bg-paper">
      <Header />
      <span data-scroll-sentinel aria-hidden="true" className="block h-px" />

      <main>
        <Hero />
        <Noise />
        <Maintenance />
        <WhatYouLog />
        <AboutAi />
        <Screens />
        <YourData />
      </main>

      <LandingFooter />
    </div>
  );
}

/* ------------------------------------------------------------- the header -- */

/**
 * The lockup at 20 pt, two text links and one filled action.
 *
 * The lockup is the profile's (page 7): mark and wordmark together at 20 pt,
 * in the header and not repeated in the hero. It never moves, which page 7 also
 * says and which §5 repeats because this is the page where the temptation is
 * strongest.
 *
 * **Nothing here links to `/kod`** (D127). Asking for a code is a separate
 * deployment mode at an unlinked path, off by default, and a link to it from
 * the one page strangers read would undo the whole separation.
 *
 * "Logga in" is a filled Snö button rather than a second Lingon one. The page
 * has one primary action and it is in the hero, in the accent, and a second
 * button in the same colour would spend the emphasis that makes the first one
 * mean anything.
 */
function Header() {
  return (
    <header
      data-landing-header
      className="landing-header sticky top-0 z-50 w-full"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3">
        <a href="/" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">
          <HeaderLockup />
          <span className="sr-only">Vikt, till startsidan</span>
        </a>

        <nav className="flex items-center gap-4 sm:gap-6">
          <a className="text-note text-muted transition-colors hover:text-ink" href="#sa-funkar-det">
            Så funkar det
          </a>
          <a
            className="text-note text-muted transition-colors hover:text-ink"
            href={siteConfig().repo}
            target="_blank"
            rel="noopener noreferrer"
          >
            Källkod
          </a>
          <a
            className="inline-flex min-h-9 items-center justify-center rounded-lg bg-ink px-4 py-1.5
                       text-note font-medium text-paper transition-opacity hover:opacity-90"
            href="/app"
          >
            Logga in
          </a>
        </nav>
      </div>
    </header>
  );
}

/* --------------------------------------------------------------- the hero -- */

/**
 * A full viewport of Natt, a graph that draws itself, and then the words.
 *
 * The sequence runs on load and owes nothing to scrolling: somebody who lands
 * here and does not move sees the whole argument. Thirty readings arrive over
 * 1,5 s, the line draws through them over 2 s and ends in its endpoint, and the
 * tagline follows it. The timings are in `landing.css`, as delays on plain CSS
 * animations, so there is no timer in JavaScript to drift or to leak.
 */
function Hero() {
  return (
    <section
      data-hero
      className="relative flex min-h-[100svh] flex-col justify-center overflow-hidden px-5 py-16"
    >
      {/* Texture, not content: the field is at an opacity where it reads as
          grain, and it is the one thing on the page with no end state. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-25">
        <DriftField />
      </div>

      <div className="relative mx-auto w-full max-w-3xl">
        <HeroGraph />

        <h1 className="hero-tagline mt-10 text-figure text-ink">Gör det lättare</h1>

        <p className="hero-sentence mt-5 max-w-prose text-body text-ink">
          Trendvikt i stället för dagsvikt, en underhållsnivå räknad ur din egen data, och ingen
          siffra som hittas på.
        </p>

        <div className="hero-actions mt-8 flex flex-wrap items-center gap-5">
          <LandingPrimary href="/app">Logga in</LandingPrimary>
          <a className="text-note text-muted transition-colors hover:text-ink" href="#sa-funkar-det">
            Så funkar det
          </a>
        </div>

        {/*
          The sentence that replaced the second button (D127). There is no
          action here that is true for every reader: somebody with a code opens
          the app, somebody without one cannot get one from this page, and both
          can run their own copy. So it is a sentence rather than a control, and
          it is still the one offer this page can make to anybody at all.
        */}
        <p className="hero-actions mt-6 max-w-prose text-note text-muted">
          Appen kräver en inbjudan, och den här installationen delar inte ut några. Vill du ha en
          egen kan du köra den på en egen server. Koden är öppen och ligger på{" "}
          <a
            className="underline underline-offset-4 hover:text-ink"
            href={siteConfig().repo}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------- a daily weight is noise -- */

/**
 * The reader draws the trend through the noise.
 *
 * The number flickers through six mornings of the same body and settles on what
 * the trend says, and the line beside it follows the scroll. Both are the same
 * sentence said twice, in the two ways a page can say something: a figure that
 * will not hold still, and a line that does.
 *
 * Every figure here is a fixture from `seeded.ts`, never an account.
 */
function Noise() {
  return (
    <section id="sa-funkar-det" className="noise-section scroll-mt-20 border-y border-edge bg-card">
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-5 py-16 sm:grid-cols-2 sm:items-center">
        <div className="reveal">
          <SectionHeading>En dagsvikt är mest brus</SectionHeading>

          <p className="num mt-6 text-figure tabular-nums text-ink" data-flicker>
            {SETTLED_TREND.replace(".", ",")}
            <span className="ml-2 align-baseline text-metric-sm font-normal text-muted">kg</span>
          </p>

          <p className="mt-5 max-w-prose text-body text-muted">
            Ett kilo upp eller ner över en natt är salt, sömn och vatten. Linjen är vad veckan
            säger, och den är den enda av de två som går att fatta ett beslut på.
          </p>
        </div>

        <div className="reveal" style={{ "--i": 1 } as CSSProperties}>
          <NoiseGraph />
          <p className="mt-3 text-micro text-muted">
            Fjorton dagar, samma kropp. Punkterna är vägningarna, linjen är trenden.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- maintenance, measured -- */

/**
 * Two figures, one Sten and one Snö, and the difference between them is the
 * product.
 *
 * They count up when they are reached because they were arrived at rather than
 * chosen, and they are tabular so that nothing shifts while they do. The labels
 * carry the coverage, because a measured figure without the days behind it is
 * an assertion.
 */
function Maintenance() {
  return (
    <section className="mx-auto w-full max-w-5xl px-5 py-16">
      <SectionHeading>Underhåll mäts, inte räknas</SectionHeading>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <figure className="reveal rounded-card border border-edge bg-card p-6">
          <p className="num text-figure-sm tabular-nums text-uncertain" data-count-to={MAINTENANCE.formula}>
            {MAINTENANCE.formula.toLocaleString("sv-SE")}
          </p>
          <figcaption className="mt-2 text-note text-muted">{MAINTENANCE.formulaLabel}</figcaption>
        </figure>

        <figure
          className="reveal rounded-card border border-edge bg-card p-6"
          style={{ "--i": 1 } as CSSProperties}
        >
          <p className="num text-figure-sm tabular-nums text-ink" data-count-to={MAINTENANCE.measured}>
            {MAINTENANCE.measured.toLocaleString("sv-SE")}
          </p>
          <figcaption className="mt-2 text-note text-muted">{MAINTENANCE.measuredLabel}</figcaption>
        </figure>
      </div>

      <p className="mt-6 max-w-prose text-body text-muted">
        En formel gissar vad en kropp av din storlek gör av med. Appen löser i stället ut den enda
        siffra som förklarar både vad du ätit och vad trenden gjort under samma period, och räknar
        om den varje dag. Den säger alltid vilken av de två du tittar på och hur säker den är.
      </p>
    </section>
  );
}

/* --------------------------------------------------------- what you log -- */

/**
 * One card per area, each in its own accent, one idea each.
 *
 * The accents come from the profile's table rather than from what looks good in
 * a row: Blåbär is nutrition, Gran is logging, Honung is the pot and the
 * rewards, Is is secondary data. The last two cards have no accent, because
 * reminders and the coach are not areas: profile page 4 says the answer to
 * "which area is this" being "none" means no accent, and that is usually right.
 */
function WhatYouLog() {
  const cards = [
    {
      title: "Mat",
      tint: "text-nutrition",
      body: "Streckkod, en mening eller ett foto. Det du åt i går ligger överst och loggas igen med två tryck.",
    },
    {
      title: "Dagen",
      tint: "text-logged",
      body: "Energi, humör, sömn och vanor. Hoppa över det du inte vill svara på.",
    },
    {
      title: "Framsteg",
      tint: "text-reward",
      body: "Milstolpar i det du mäter, och en sparpott som räknar ihop det du inte köpte.",
    },
    {
      title: "Samband",
      tint: "text-data",
      body: "Dina serier bredvid varandra. Appen räknar inget samband åt dig och påstår ingen orsak.",
    },
    {
      title: "Påminnelser",
      tint: "text-ink",
      body: "En knuff på morgonen om du vill ha en, och tystnad om du inte vill.",
    },
    {
      title: "Coachen",
      tint: "text-uncertain",
      body: "Ser dina siffror och hittar aldrig på en. Den kan bara berätta vad som står i appen.",
    },
  ];

  return (
    <section className="border-y border-edge bg-card">
      <div className="mx-auto w-full max-w-5xl px-5 py-16">
        <SectionHeading>Det du loggar</SectionHeading>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card, index) => (
            <article
              key={card.title}
              className="reveal rounded-card border border-edge bg-paper p-5"
              style={{ "--i": index } as CSSProperties}
            >
              <h3 className={`text-title ${card.tint}`}>{card.title}</h3>
              <p className="mt-2 text-note text-muted">{card.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- about AI -- */

/**
 * One column, no accent, and the claim that matters said plainly: the model
 * names, the database prices, and nothing a language model produced becomes a
 * number in your history (D5, D143).
 */
function AboutAi() {
  return (
    <section className="mx-auto w-full max-w-3xl px-5 py-16">
      <SectionHeading>Om AI</SectionHeading>

      <div className="mt-6 space-y-4 text-body text-muted">
        <p>
          Det läser vad du ätit, ur en mening eller ur ett foto av tallriken, och föreslår vad du
          kan laga av det du har hemma. Coachen ser dina egna siffror och skriver veckans
          sammanfattning ur dem.
        </p>
        <p>
          Det producerar aldrig en siffra. Modellen namnger maten och gissar mängden, och varje
          kalori och makrovärde kommer ur livsmedelsdatabasen. En språkmodell som ombeds gissa
          kalorier gissar självsäkert och fel, och den siffran hamnar sedan i underlaget för allt
          annat appen räknar ut.
        </p>
        <p>
          Lagret kör på hårdvara den som driver servern styr över. Det du loggar lämnar aldrig
          servern, och vill du inte ha lagret alls stängs det av. Då finns knapparna inte där, de
          blir inte gråa.
        </p>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- screens -- */

/**
 * Three real screens, from the seeded demo account.
 *
 * Captured by `scripts/landing-shots.mjs` at the frame's own size, so they are
 * regenerated whenever the sweep runs and cannot quietly become a picture of an
 * older app. A photograph of a phone would put somebody else's hardware and
 * lighting between the reader and the thing being shown.
 *
 * The frames rest at a slight tilt and come level as they scroll in. That is
 * the only three-dimensional move on the page, it ends flat, and with reduced
 * motion it never happens.
 */
function Screens() {
  const screens = [
    { src: "/screens/oversikt.png", alt: "Översikten med trendlinjen och dagens siffror", tilt: "7deg" },
    { src: "/screens/mat.png", alt: "Matloggen med sökning och senast loggade rader", tilt: "0deg" },
    { src: "/screens/framsteg.png", alt: "Framsteg med milstolpar och sparpotten", tilt: "-7deg" },
  ];

  return (
    <section className="border-y border-edge bg-card">
      <div className="mx-auto w-full max-w-5xl px-5 py-16">
        <SectionHeading>Så ser det ut</SectionHeading>

        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {screens.map((screen) => (
            <div
              key={screen.src}
              className="phone-frame mx-auto w-full max-w-[280px]"
              style={{ "--tilt": screen.tilt } as CSSProperties}
            >
              <div className="relative rounded-[2rem] border border-edge bg-paper p-2">
                <div
                  aria-hidden="true"
                  className="absolute left-1/2 top-3 z-10 h-3.5 w-16 -translate-x-1/2 rounded-full bg-card"
                />
                <img
                  src={screen.src}
                  alt={screen.alt}
                  width={360}
                  height={780}
                  loading="lazy"
                  decoding="async"
                  className="w-full rounded-[1.6rem]"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- your data -- */

/**
 * What a reader can do about their own data, with the link to the page that
 * says it in full (D106). Every right names the thing in the app that fulfils
 * it, which is the rule that page is built on.
 */
function YourData() {
  return (
    <section className="mx-auto w-full max-w-3xl px-5 py-16">
      <SectionHeading>Dina data</SectionHeading>

      <div className="mt-6 space-y-4 text-body text-muted">
        <p>
          Appen körs på en server. Kör du den själv är det din, och kör någon annan den är det
          deras, och båda fallen står på integritetssidan. Ingenting säljs, ingenting mäts för
          annonser, och det finns ingen analysskript på den här sidan heller.
        </p>
        <p>
          Du kan ta med dig allt. Hela kontot som JSON, en fil per tabell som CSV, och en
          Excel-fil med en rad per dag. Du kan också radera kontot själv, direkt i appen, utan att
          fråga någon.
        </p>
        <p>
          Koden är öppen under AGPL. Den som kör en ändrad version åt andra ska släppa sina
          ändringar, vilket är hela poängen med den licensen.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap gap-5 text-note">
        <a className="text-muted underline underline-offset-4 hover:text-ink" href="/integritet">
          Integritet
        </a>
        <a
          className="text-muted underline underline-offset-4 hover:text-ink"
          href={siteConfig().repo}
          target="_blank"
          rel="noopener noreferrer"
        >
          Källkod
        </a>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- shared -- */

/**
 * A section heading: one separator, and it is the rule (D114). An underline
 * would read as a link, which is the one thing a heading must not be.
 */
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="border-t border-edge pt-4 text-metric-sm text-ink">{children}</h2>
  );
}
