import { PageShell, TextSection as Section } from "./PageShell.js";
import { siteConfig } from "../lib/site-config.js";

/**
 * The terms page (D106), at `/villkor`.
 *
 * Short on purpose. This is a hobby project run by one person on one small
 * server, and a page of clauses borrowed from a company with a legal department
 * would be both untrue and unreadable. What it has to say is the handful of
 * things somebody deserves to know before they put a year of their own data in:
 * that it may go away, that it is not medical advice, that they can leave with
 * everything, and that the owner may close an account.
 *
 * Like the privacy page, it is the owner's text and not legal advice, and D106
 * says so rather than leaving the reader to assume otherwise.
 */



export function Terms() {
  const { contact } = siteConfig();

  return (
    <PageShell title="Villkor" updated="6 september 2026">
      <Section title="Vad det här är">
        <P>
          Ett fritidsprojekt, som det är. Vikt drivs av en privatperson på en liten server. Det finns ingen garanti
          för att tjänsten är uppe, ingen supporttid och inget avtal om
          tillgänglighet. Fungerar något inte, skriv till {contact}, så fixas det
          när det går.
        </P>
        <P>
          Det kostar ingenting. Det finns ingen betalversion och inget som är låst. Koden är öppen under
          AGPL, så du kan när som helst köra din egen.
        </P>
      </Section>

      <Section title="Det är inte medicinsk rådgivning">
        <P>
          Vikt är en logg, inte en vårdgivare. Kalorier, makron, underhållsnivå och prognoser är uppskattningar räknade
          ur det du själv har loggat och ur publicerade referensvärden. De är inte
          ordinationer, och de tar inte hänsyn till din hälsa i övrigt.
        </P>
        <P>
          Coachen, när den finns, gissar inte i ditt ställe. Den svarar utifrån dina egna siffror och säger ifrån när en fråga är
          medicinsk. Den ersätter ingen läkare, dietist eller psykolog.
        </P>
        <P>
          Fråga vården vid tveksamhet. Särskilt vid sjukdom, medicinering, graviditet eller ätstörning. Vikt
          känner inte till något av det.
        </P>
      </Section>

      <Section title="Kontot">
        <P>
          Registrering sker med kod. Det håller installationen liten och är hela urvalet: det finns ingen
          annan spärr och ingen väntelista.
        </P>
        <P>
          Du kan sluta när du vill. Under Inställningar tar du ut allt du har loggat och raderar kontot själv.
          Ingen behöver kontaktas och ingenting behöver motiveras.
        </P>
        <P>
          Kontot kan stängas av ägaren. Det sker med besked i förväg, utom vid uppenbart missbruk av tjänsten,
          och du hinner exportera först.
        </P>
      </Section>

      <Section title="Om tjänsten läggs ned">
        <P>
          Du får besked i förväg. Både i appen och, om mejl är påslaget, med mejl. Beskedet kommer i god tid
          och inte samma dag som servern stängs av.
        </P>
        <P>
          Export finns alltid. Så länge tjänsten går att nå går det att ta ut allt du har loggat, i JSON
          och i CSV. Det är samma data som ligger i databasen.
        </P>
      </Section>

      <p className="mt-10 max-w-prose text-micro text-muted">
        Den här sidan är skriven av den som driver tjänsten, inte av en jurist. Den
        beskriver hur projektet faktiskt fungerar, och är inte juridisk rådgivning.
      </p>
    </PageShell>
  );
}

/**
 * A paragraph on one of the text pages.
 *
 * Plain, in Sten, with nothing bold in it (D111). It used to open on a bold
 * lead-in, and twenty of those down a page stop being emphasis: the eye reads
 * the bold line and skips the sentence it introduces, which on a privacy page
 * means skipping the part that says what actually happens. The lead-in sentence
 * is kept as the paragraph's first sentence, where it was doing the real work
 * anyway.
 */
function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>;
}
