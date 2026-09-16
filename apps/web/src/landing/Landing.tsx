import { useEffect, type CSSProperties, type ReactNode } from "react";
import { HeaderLockup } from "../components/Wordmark.js";
import { LandingPrimary } from "./LandingPrimary.js";
import { HeroGraph } from "./TrendDrawing.js";
import { startLandingMotion } from "./landing-motion.js";
import { MAINTENANCE, MORNINGS, SETTLED_TREND } from "./seeded.js";
import { LandingFooter } from "./Footer.js";
import { siteConfig } from "../lib/site-config.js";

/**
 * The public landing page (D90, D99, D127, D173, D177).
 *
 * The page draws the product's argument before it states it: readings arrive, a
 * trend line draws through them, and only then does anything say "gör det
 * lättare". Somebody who scrolls no further has seen the difference between this
 * and the app that draws a jagged daily line.
 *
 * ## The rules it is built under (§5, D172)
 *
 * **Motion carries meaning.** Readings arrive one at a time because that is how
 * they are logged, and the line draws through them as they arrive because a
 * trend accumulates; the two maintenance figures count because they were
 * measured rather than chosen; and the fourteen mornings land one after another
 * because that is fourteen days passing. Nothing moves in reverse and nothing
 * loops: the drifting field that was the one exception is gone (D178), because
 * at hero size it read as dust rather than as noise, and the graph's own points
 * are the noise the page is about.
 *
 * **Restraint is the style.** Natt across the whole page, Skymning on the cards,
 * and no gradient, glow, glass or third dimension anywhere: D177 withdrew the
 * one 3D exception D173 had written for the phone frames.
 *
 * ## One container
 *
 * Every section, the hero's text included, sits in `Container`: one maximum
 * width and one gutter. The page used to mix `max-w-3xl` and `max-w-5xl`, so
 * paragraphs changed width between sections for no reason a reader could see.
 *
 * ## Colour
 *
 * Lingon is in two files and both are the rule rather than an exception:
 * `TrendDrawing.tsx`, whose lines are trend lines computed by the app's own EMA,
 * and `LandingPrimary.tsx`, profile page 4's carve-out for this page's single
 * action. The cards carry the area accents, each on the area it names.
 */

export function Landing() {
  useEffect(() => startLandingMotion(), []);

  return (
    <div className="min-h-dvh bg-paper">
      <Header />
      <span data-scroll-sentinel aria-hidden="true" className="block h-px" />

      <main>
        <Hero />
        <Noise />
        <Maintenance />
        <WhatItDoes />
        <AboutAi />
        <Screens />
        <YourData />
      </main>

      <LandingFooter />
    </div>
  );
}

/** One width and one gutter, everywhere on the page. */
function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-5xl px-5 ${className}`}>{children}</div>;
}

/**
 * A section heading: one separator, and it is the rule (D114). An underline
 * would read as a link, which is the one thing a heading must not be.
 */
function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="border-t border-edge pt-4 text-metric-sm text-ink">{children}</h2>;
}

/**
 * A figure with its unit, which is always smaller and in Sten (profile, page 5:
 * "Enheten är alltid mindre än talet och i Sten").
 */
function Figure({
  value,
  unit,
  className = "",
  flicker = false,
  countTo,
}: {
  value: string;
  unit: string;
  className?: string;
  flicker?: boolean;
  countTo?: number;
}) {
  return (
    <p
      className={`num tabular-nums ${className}`}
      {...(flicker ? { "data-flicker": "" } : {})}
      {...(countTo === undefined ? {} : { "data-count-to": countTo })}
    >
      <span data-figure-value>{value}</span>
      <span className="ml-2 align-baseline text-metric-sm font-normal text-muted">{unit}</span>
    </p>
  );
}

/* ------------------------------------------------------------- the header -- */

/**
 * The lockup at 20 pt, one text link and one filled action.
 *
 * The lockup is the profile's (page 7): mark and wordmark at 20 pt, in the
 * header and not repeated in the hero, and it never moves.
 *
 * **Two items, not three.** "Så funkar det" was in the header and in the hero,
 * and the header is not where somebody decides to read an explanation. It stays
 * in the hero, beside the action it is the alternative to.
 *
 * **Nothing links to `/kod`** (D127).
 */
function Header() {
  return (
    <header data-landing-header className="landing-header sticky top-0 z-50 w-full">
      <Container className="flex items-center justify-between gap-4 py-3">
        <a
          href="/"
          className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          <HeaderLockup />
          <span className="sr-only">Vikt, till startsidan</span>
        </a>

        <nav className="flex items-center gap-4 sm:gap-6">
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
      </Container>
    </header>
  );
}

/* --------------------------------------------------------------- the hero -- */

/**
 * A full viewport of Natt, a graph that draws itself, and then the words.
 *
 * The sequence runs on load and owes nothing to scrolling: the readings and the
 * line advance together, left to right, across two seconds, and the endpoint
 * lands **when the line reaches it** rather than a moment before (D177, D178).
 *
 * **The hero block is centred and the rest of the page is not.** It is the one
 * section that is a single column of its own: a picture, a claim, a sentence and
 * one action, with nothing beside it to align to. Every section below has a
 * heading with a rule across the container, and a centred heading over a
 * left-aligned paragraph is the shape of a page that has not decided.
 */
function Hero() {
  return (
    <section
      data-hero
      className="relative flex min-h-[100svh] flex-col justify-center overflow-hidden py-16"
    >
      <Container className="relative">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <HeroGraph />

          <Tagline />

          <p className="hero-sentence mt-5 max-w-prose text-body text-ink">
            Lättare att reglera din vikt, lättare att ta bra beslut, lättare att se vad du får i
            dig. Appen använder trendvikt i stället för dagsvikt, en underhållsnivå räknad ur din
            egen data och ingen siffra som hittas på.
          </p>

          <div className="hero-actions mt-8 flex flex-wrap items-center justify-center gap-5">
            <LandingPrimary href="/app">Logga in</LandingPrimary>
            <a className="text-note text-muted transition-colors hover:text-ink" href="#sa-funkar-det">
              Så funkar det
            </a>
          </div>

          {/*
            The sentence that replaced the second button (D127). There is no
            action here true for every reader: somebody with a code opens the
            app, somebody without one cannot get one from this page, and both
            can run their own copy.
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
      </Container>
    </section>
  );
}

/**
 * The claim, a word at a time, once the line has finished drawing (D179).
 *
 * Each word fades in and rises eight pixels, 120 ms after the one before it. No
 * scale and no bounce: a word that overshoots and settles is a word performing,
 * and §5's question is what the movement tells the reader that the finished
 * state does not. What this one says is that the sentence is being said, after
 * the picture has already made the same point without words.
 *
 * **The full stop is part of the last word**, so the sentence ends the way a
 * sentence does. There is no exclamation mark on this page and
 * `copy-style.test.ts` holds that.
 *
 * One `<h1>` with three spans inside it, so a screen reader reads one heading
 * and the page has one first-level heading rather than three.
 */
function Tagline() {
  return (
    <h1 className="mt-10 text-figure text-ink">
      {/*
        Written out rather than mapped over an array. `copy-style.test.ts` reads
        the strings out of this file's JSX, and copy that lives in a JavaScript
        array is copy the guards cannot see: the page would have kept its rules
        about dashes, shouting and exclamation marks only by luck.
      */}
      <span className="hero-word" style={{ "--i": 0 } as CSSProperties}>
        Gör
      </span>{" "}
      <span className="hero-word" style={{ "--i": 1 } as CSSProperties}>
        det
      </span>{" "}
      <span className="hero-word" style={{ "--i": 2 } as CSSProperties}>
        lättare.
      </span>
    </h1>
  );
}

/* -------------------------------------------------- a daily weight is noise -- */

/**
 * Fourteen mornings, and the one figure the app makes of them (D179).
 *
 * **No second graph.** This section used to draw the same picture as the hero,
 * with the same marks, by scrolling: noise and a trend line through it. A page
 * that draws its thesis twice has made the second drawing decoration, and §5's
 * question for any motion is what it tells the reader that the finished state
 * does not. So the argument is stated in figures here instead, which is also
 * the form it takes on a bathroom scale.
 *
 * **Nothing in it responds to scroll.** The fourteen readings arrive when the
 * section is reached and the figure settles when the last of them has landed,
 * and that is the whole of it. The monotonic scroll driver that used to power
 * the line is gone with the line.
 *
 * Every figure is a fixture whose trend is computed by the app's own EMA, and
 * never an account.
 */
function Noise() {
  return (
    <section id="sa-funkar-det" className="scroll-mt-20 pt-16">
      <Container>
        <SectionHeading>En dagsvikt är mest brus</SectionHeading>

        <div className="mt-10 grid gap-10 sm:grid-cols-2 sm:items-center">
          {/*
            Seven across and two down, which is a fortnight the way a calendar
            shows one. Tabular figures, so fourteen numbers in a grid line up
            instead of jittering column to column.
          */}
          <ol className="reveal grid grid-cols-7 gap-x-2 gap-y-3 sm:gap-x-3">
            {MORNINGS.map((morning, index) => (
              <li
                key={morning.localDate}
                className="morning num tabular-nums text-center text-note text-muted sm:text-metric-sm"
                style={{ "--i": index } as CSSProperties}
              >
                {morning.reading}
              </li>
            ))}
          </ol>

          <div className="reveal">
            <Figure value={SETTLED_TREND} unit="kg" className="text-figure text-ink" flicker />
          </div>
        </div>

        <p className="mt-6 text-micro text-muted">Fjorton morgnar, en siffra.</p>

        <p className="mt-6 max-w-prose text-body text-muted">
          Ett kilo upp eller ner över en natt kan bero på salt, sömn och vatten. Trenden visar i
          stället vad som hänt under veckan och ger dig en bättre fingervisning som du kan fatta
          beslut på.
        </p>
      </Container>
    </section>
  );
}

/* ----------------------------------------------------- maintenance, measured -- */

/**
 * Two figures, one Sten and one Snö, and the difference between them is the
 * product. They count up when they are reached because they were arrived at
 * rather than chosen, and they are tabular so nothing shifts while they do.
 */
function Maintenance() {
  return (
    <section className="pt-16">
      <Container>
        <SectionHeading>Förbränning mäts utifrån det du loggar</SectionHeading>

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <figure className="reveal rounded-card border border-edge bg-card p-6">
            <Figure
              value={MAINTENANCE.formula.toLocaleString("sv-SE")}
              unit="kcal"
              className="text-figure-sm text-uncertain"
              countTo={MAINTENANCE.formula}
            />
            <figcaption className="mt-2 text-note text-muted">{MAINTENANCE.formulaLabel}</figcaption>
          </figure>

          <figure
            className="reveal rounded-card border border-edge bg-card p-6"
            style={{ "--i": 1 } as CSSProperties}
          >
            <Figure
              value={MAINTENANCE.measured.toLocaleString("sv-SE")}
              unit="kcal"
              className="text-figure-sm text-ink"
              countTo={MAINTENANCE.measured}
            />
            <figcaption className="mt-2 text-note text-muted">
              {MAINTENANCE.measuredLabel}
            </figcaption>
          </figure>
        </div>

        <p className="mt-6 max-w-prose text-body text-muted">
          En formel gissar vad en kropp av din storlek förbränner. Appen räknar i stället ut den
          siffra som förklarar både vad du ätit och vad trenden gjort under samma period, och räknar
          om den varje dag. Den säger alltid vilken av de två du tittar på och hur säker den är.
        </p>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------ what it does -- */

/**
 * One card per area, each in its own accent, one idea each.
 *
 * The accents come from the profile's table rather than from what looks good in
 * a row: Blåbär is nutrition, Gran is logging, Honung is the pot and the
 * rewards, Is is secondary data. The last two have no accent, because reminders
 * and the coach are not areas, and page 4 says the answer to "which area is
 * this" being "none" means no accent.
 */
function WhatItDoes() {
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
    <section className="pt-16">
      <Container>
        <SectionHeading>Vad appen gör</SectionHeading>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card, index) => (
            <article
              key={card.title}
              className="reveal rounded-card border border-edge bg-card p-5"
              style={{ "--i": index } as CSSProperties}
            >
              <h3 className={`text-title ${card.tint}`}>{card.title}</h3>
              <p className="mt-2 text-note text-muted">{card.body}</p>
            </article>
          ))}
        </div>
      </Container>
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
    <section className="pt-16">
      <Container>
        <SectionHeading>Om AI</SectionHeading>

        <div className="mt-6 max-w-prose space-y-4 text-body text-muted">
          <p>
            Det läser vad du ätit, från en förklarande mening eller ett foto av tallriken. Det
            föreslår vad du kan laga av det du har hemma. Coachen ser dina siffror och skriver en
            veckovis sammanfattning från dem.
          </p>
          <p>
            Det producerar aldrig en siffra. Modellen namnger maten och gissar mängden. Varje kalori
            och makrovärde kommer ur livsmedelsdatabasen.
          </p>
          <p>
            Lagret kör på hårdvara den som driver servern styr över. Det du loggar lämnar aldrig
            servern, och vill du inte ha lagret alls stängs det av. Då finns knapparna inte där, de
            blir inte gråa.
          </p>
        </div>
      </Container>
    </section>
  );
}

/* ----------------------------------------------------------------- screens -- */

/**
 * Three pictures of the app on a phone, one screen to a row.
 *
 * **Made by hand** (D177): framed screenshots of the demo account, produced by
 * the owner from `pnpm shots:phone`'s raw captures and kept in `docs/screens`.
 * `scripts/landing-screens.mjs` resizes them for the web, and the README shows
 * the same three files, so there is one hand-maintained set rather than two
 * (D178). They go stale silently, so the rule to take them again whenever
 * Översikt, Mat or Framsteg changes visibly is in STATE.md and in the runbook.
 *
 * ## The layout
 *
 * A row each rather than three abreast: at a third of the container a phone is
 * 280 px wide and its content is unreadable, which makes the pictures
 * decoration. One to a row gives each a sentence beside it saying what the
 * screen is for, and the side alternates so the eye has somewhere to go.
 *
 * ## The one movement that means nothing
 *
 * Each frame turns with its own position in the viewport: about twelve degrees
 * to the right as it comes up from below, square on at the middle, twelve to
 * the left as it leaves. It is a **position**, not a drawing, so unlike
 * everything else here it follows the scroll in both directions, which is
 * exactly what `animation-timeline: view()` is for and why the fortnight's line
 * does not use it.
 *
 * This is decoration, and D173's addendum says so rather than dressing it up:
 * it tells the reader nothing the still frame does not. It is the only one on
 * the page and it stays the only one.
 */
function Screens() {
  const screens = [
    {
      src: "/screens/oversikt.png",
      alt: "Översikten med trendlinjen och dagens siffror",
      title: "Trenden och dagens siffror på ett ställe.",
      meta: "Trendvikt, senaste vägningen, ätit i dag och den uppmätta underhållsnivån.",
    },
    {
      src: "/screens/mat.png",
      alt: "Matloggen med sökning och senast loggade rader",
      title: "Mat loggas med streckkod, en mening eller ett foto.",
      meta: "Sökning i livsmedelsdatabasen, sparade måltider och favoriter du använder ofta.",
    },
    {
      src: "/screens/framsteg.png",
      alt: "Framsteg med milstolpar och sparpotten",
      title: "Milstolpar, streck och potten du fyller på.",
      meta: "Sparregler du sätter själv, nykterhetsräknare och belöningar du valt i förväg.",
    },
  ];

  return (
    <section className="pt-16">
      <Container>
        <SectionHeading>Appen i telefonen</SectionHeading>

        <div className="mt-10 space-y-16">
          {screens.map((screen, index) => (
            <div
              key={screen.src}
              className="grid items-center gap-8 sm:grid-cols-2 sm:gap-12"
            >
              {/*
                The picture comes first in the document on every row, so a phone
                reads picture then sentence throughout. On two columns the odd
                rows send it to the second column instead, which alternates the
                side without reordering anything a screen reader follows.
              */}
              <div className={index % 2 === 1 ? "sm:order-2" : ""}>
                <img
                  className="phone-frame mx-auto w-full max-w-[268px]"
                  src={screen.src}
                  alt={screen.alt}
                  width={640}
                  height={1336}
                  loading="lazy"
                  decoding="async"
                />
              </div>

              <div className="max-w-prose">
                {/* The profile's own two rows: body 15/22 in Snö, meta 12/16 in Sten. */}
                <p className="text-body text-ink">{screen.title}</p>
                <p className="mt-3 text-meta text-muted">{screen.meta}</p>
              </div>
            </div>
          ))}
        </div>
      </Container>
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
    <section className="py-16">
      <Container>
        <SectionHeading>Dina data</SectionHeading>

        <div className="mt-6 max-w-prose space-y-4 text-body text-muted">
          <p>
            Appen körs på en server. Kör du den själv är det din, och kör någon annan den är det
            deras, och båda fallen förklaras på integritetssidan. Ingenting säljs, ingenting mäts för
            annonser, och det finns inget analysskript heller.
          </p>
          <p>
            Du kan ta med dig allt. Hela kontot som JSON-, CSV- eller Excel-fil. Du kan också radera
            kontot själv direkt i appen, utan att fråga någon.
          </p>
          <p>
            Koden är öppen under AGPL. Hela poängen med den licensen är att den som modifierar koden
            och kör den som en tjänst för andra också måste dela med sig av sina ändringar.
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
      </Container>
    </section>
  );
}
