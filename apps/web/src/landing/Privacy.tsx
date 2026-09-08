import { PageShell, TextSection as Section } from "./PageShell.js";
import { operatorName, siteConfig } from "../lib/site-config.js";

/**
 * The privacy page (D106), at `/integritet`.
 *
 * ## What this is, and what it is not
 *
 * It is the owner's account of what this installation stores and why, written
 * in the app's own register: short sentences, a lead-in and then the point, no
 * clause that exists to be unreadable. It is **not legal advice**, it was not
 * written by a lawyer, and D106 says so in the same words.
 *
 * The text it replaces was a list under the invite form on the landing page,
 * which was true and covered about a third of what a service other people use
 * has to say. What was missing was everything that matters once somebody else's
 * data is on the server: who is responsible, what is stored, why weight and
 * measurements are treated as sensitive, who else ever sees anything, how long
 * it is kept, and what a person can actually do about it.
 *
 * **Every right names the thing in the app that fulfils it.** A page that says
 * "you have the right to erasure" and then makes you write an email is a page
 * that has described a right rather than given one. Where the app does it, the
 * page says which screen.
 *
 * It has to be reread when the coach chat ships (§6 phase 8b): chat history is
 * a new category of stored personal data, and this page will be wrong the day
 * that lands.
 */



export function Privacy() {
  const { contact } = siteConfig();
  const operator = operatorName();

  return (
    <PageShell title="Integritet" updated="6 september 2026">
      <Section title="Vem som ansvarar">
        <P>
          Den här installationen drivs av {operator}.{" "}
          {contact === "" ? null : <>Frågor, rättelser och radering går till {contact}. </>}
          Det är en privatperson och ett fritidsprojekt, inte ett företag med en
          supportavdelning, så svaret kommer när det kommer, men det kommer.
        </P>
        <P>
          Kör du din egen installation ansvarar du för den. Källkoden är öppen, och en självhostad Vikt skickar ingenting till den
          som skrev den eller till någon annan.
        </P>
      </Section>

      <Section title="Vad som lagras">
        <P>
          Kontot. Din mejladress, ditt namn, ett hashat lösenord och när kontot skapades.
          Lösenordet lagras med argon2id och går inte att läsa ut, inte heller av
          den som driftar servern.
        </P>
        <P>
          Det du loggar. Vikter, mått, mat och dryck, dagliga anteckningar om energi, humör, sömn,
          steg och alkohol, milstolpar och sparpott, samt foton om du lägger in
          några.
        </P>
        <P>
          Sådant som hör till driften. Inloggningar med tidpunkt, kön av utgående mejl, och din förfrågan om en
          inbjudningskod tills den är besvarad. Förfrågan innehåller namnet och adressen du
          skrev och raden om varför, om du skrev en.
        </P>
        <P>
          Aviseringar. Vilka meddelanden i appen du har läst, och om du vill ha nyhetsmejl.
          Underhållsmeddelanden får du oavsett, eftersom de handlar om tjänsten du
          använder.
        </P>
        <P>
          Om coachen slås på. Då sparas också dina samtal med den, per konto. Den funktionen finns inte
          än, och den här sidan skrivs om när den kommer.
        </P>
      </Section>

      <Section title="Varför, och varför vikt är känsligt">
        <P>
          För att appen ska fungera. Utan det du loggar finns ingen trendlinje, ingen underhållsnivå och inget
          att räkna på. Ingenting av det används till något annat.
        </P>
        <P>
          Vikt och kroppsmått räknas som känsliga uppgifter. De hanteras här för ett hälsosyfte, och då är de hälsouppgifter i
          dataskyddsförordningens mening. Därför frågar registreringen uttryckligen
          om ditt samtycke i stället för att anta det, och du kan ta tillbaka det när
          du vill genom att radera kontot.
        </P>
        <P>
          Ingen profilering, ingen försäljning, ingen annonsering. Din data jämförs aldrig med någon annans. Gruppfunktioner visar bara om
          någon har loggat, aldrig vad.
        </P>
      </Section>

      <Section title="Vem mer ser något">
        <P>
          Mejlleverantören ser din adress. Utgående mejl går genom en extern SMTP-server, som därmed ser adressen och
          innehållet i mejlet: en återställningslänk, en inbjudningskod eller ett
          driftmeddelande. Ingenting du loggar skickas med mejl.
        </P>
        <P>
          Ingenting annat lämnar servern. Ingen analys, ingen spårning, inga tredjepartsskript, inget nätverk av
          annonsörer. Livsmedelsdata hämtas från Open Food Facts och
          Livsmedelsverket när du söker, och de får då veta vad som söks, aldrig av
          vem.
        </P>
        <P>
          Slår du på AI-lagret kör det där du pekar det. Det är avstängt som standard, och när det är på går texten till den
          maskin du själv anger, inte till någon molntjänst.
        </P>
        <P>
          Kontrollen på formuläret är ingen tredje part. Den ber din webbläsare räkna ut ett tal, och svaret
          går hit och ingen annanstans. Ingen extern tjänst blandas in, ingen cookie
          sätts, och ingenting om din webbläsare sparas.
        </P>
      </Section>

      <Section title="Hur länge">
        <P>
          Så länge kontot finns. Raderar du kontot försvinner allt som hör till det, direkt, inklusive
          foton på disk.
        </P>
        <P>
          Backuper sparas i den tid som är inställd. Standard är trettio dagar. En backup som redan är tagen innehåller det
          som fanns då, och den försvinner när den åldras ut. Backuperna är
          krypterade.
        </P>
        <P>
          Nekas din förfrågan om kod raderas raden. Ingen kopia sparas, och inget mejl skickas. Det gäller namnet lika mycket som adressen.
        </P>
      </Section>

      <Section title="Vad du kan göra">
        <P>
          Se allt. Alla siffror finns i appen, dag för dag, under Data.
        </P>
        <P>
          Ta ut allt. Under Inställningar finns export: en JSON-fil med hela kontot och CSV per
          tabell, formaterade för svensk Excel. Det är samma data som ligger i
          databasen, inte ett sammandrag.
        </P>
        <P>
          Radera allt. Under Inställningar kan du ta bort kontot själv. Du får se exakt hur många
          rader det gäller innan du bekräftar, och det går inte att ångra.
        </P>
        <P>
          Rätta något, eller fråga. Det mesta ändrar du själv i appen. Går det inte, skriv till {contact}.
        </P>
        <P>
          Klaga. Är du inte nöjd med hur uppgifterna hanteras kan du vända dig till
          Integritetsskyddsmyndigheten.
        </P>
      </Section>

      <p className="mt-10 max-w-prose text-micro text-muted">
        Den här sidan är skriven av den som driver tjänsten, inte av en jurist. Den
        beskriver vad appen faktiskt gör, och är inte juridisk rådgivning.
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
