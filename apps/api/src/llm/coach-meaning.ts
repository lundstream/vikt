/**
 * What each domain means for the goal, written by the app (D171).
 *
 * D155 added a rule asking the coach to say, for every area it raised, what
 * that area means for the person's goal, marked as general when it is general.
 * Six live replies later, the sentence had appeared in **one of them**. The rule
 * was a request, and a request is what a model does when it has room left.
 *
 * So the app writes the sentence instead. Every domain section of the sheet
 * carries a `Vad det betyder:` line chosen from the closed set below, by the
 * state that domain is actually in, and COACH_RULES tells the coach to convey
 * that line and add no interpretation of its own. The model still decides
 * whether an area belongs in this reply and in what words; what it no longer
 * does is invent the meaning.
 *
 * Every line here:
 *
 * - **carries a general marker in its own wording** (`i regel`, `för de flesta`,
 *   `oftast`, `brukar`), so a claim from general knowledge arrives marked as one
 *   wherever it ends up. The guard uses the same list: a sentence in a reply may
 *   say one thing affects another only while it carries one of these markers,
 *   which is exactly the shape of a sentence copied from here;
 * - **states no figure.** Numbers in the sheet come from `num()`, which
 *   registers them as quotable; a number typed into a fixed string would be
 *   quotable without being anybody's data. A test greps these for digits;
 * - **is about the data's meaning, not the person's conduct** (§3). None of them
 *   says what somebody should have done;
 * - **was reviewed once, here, rather than generated per reply.** That is the
 *   point of a closed set: it can be read in one sitting by somebody deciding
 *   whether the app should be saying it at all.
 */

/**
 * The words that mark a claim as general, and the only phrases that let a reply
 * say one thing affects another (D171).
 *
 * Shared with the guard on purpose. If these drift apart, the app starts
 * writing sentences its own check refuses.
 */
export const GENERAL_MARKERS = ["i regel", "för de flesta", "oftast", "brukar"] as const;

export type MeaningDomain =
  | "weight"
  | "intake"
  | "protein"
  | "fiber"
  | "alcohol"
  | "activity"
  | "steps"
  | "sleep"
  | "habits"
  | "measurements";

/**
 * The states each domain can be in, as the sheet can actually tell them apart.
 *
 * Deliberately few. A state the sheet cannot distinguish from its data is a
 * state nothing can choose, and a line nobody will ever see is a line nobody
 * reviews.
 */
export type MeaningState = "none" | "thin" | "low" | "steady" | "high";

type DomainLines = Partial<Record<MeaningState, string>> & { none: string };

export const INTERPRETATIONS: Record<MeaningDomain, DomainLines> = {
  weight: {
    none: "Vikten säger i regel ingenting förrän det finns flera vägningar: en enstaka dag rör sig mest med vatten och mat i kroppen.",
    thin: "Med få vägningar är trenden i regel osäker, för en enstaka dag rör sig mest med vatten och mat i kroppen.",
    low: "En trend som går ner betyder i regel att energin under perioden legat under det kroppen gjort av med.",
    steady: "En trend som ligger still betyder i regel att energin ungefär motsvarat det kroppen gjort av med.",
    high: "En trend som går upp betyder i regel att energin under perioden legat över det kroppen gjort av med.",
  },
  intake: {
    none: "Utan loggat intag går det i regel inte att säga varför vikten rör sig som den gör.",
    thin: "Med få loggade dagar är snittet i regel osäkert, för de dagar som saknas kan ligga var som helst.",
    low: "Ett snitt under underhållsnivån ger i regel en nedgång över tid, och storleken på skillnaden avgör takten.",
    steady: "Ett snitt kring underhållsnivån håller i regel vikten där den är.",
    high: "Ett snitt över underhållsnivån ger i regel en uppgång över tid.",
  },
  protein: {
    none: "Utan uppgift om protein går det i regel inte att säga något om det.",
    thin: "Med få dagar som har uppgift om protein är snittet i regel osäkert.",
    low: "Protein hjälper i regel de flesta att behålla muskler när vikten går ner, och att hålla sig mätt längre.",
    steady: "Protein hjälper i regel de flesta att behålla muskler när vikten går ner, och att hålla sig mätt längre.",
  },
  fiber: {
    none: "Utan uppgift om fiber går det i regel inte att säga något om det.",
    thin: "Med få dagar som har uppgift om fiber är snittet i regel osäkert.",
    low: "Fiber gör i regel att maten mättar längre, och de flesta får i sig mindre av den än rekommendationerna föreslår.",
    steady: "Fiber gör i regel att maten mättar längre.",
  },
  alcohol: {
    none: "Alkohol räknas med i energin när den fylls i, och utan uppgift står den i regel utanför.",
    thin: "Med få ifyllda dagar säger alkoholen i regel mer om de dagarna än om perioden.",
    low: "Alkohol bidrar i regel med energi utan att mätta, och nyktra dagar syns oftast i veckans snitt.",
    steady: "Alkohol bidrar i regel med energi utan att mätta, och nyktra dagar syns oftast i veckans snitt.",
    high: "Alkohol bidrar i regel med energi utan att mätta, och den energin ligger oftast utöver det som loggas som mat.",
  },
  activity: {
    none: "Rörelse som inte loggas står i regel utanför både energin och sammanställningen här.",
    thin: "Med få loggade pass säger siffran i regel mer om de passen än om perioden.",
    low: "Rörelse bidrar i regel mindre till energin än maten gör, och mer till hur kroppen mår och orkar.",
    steady: "Rörelse bidrar i regel mindre till energin än maten gör, och mer till hur kroppen mår och orkar.",
    high: "Rörelse bidrar i regel mindre till energin än maten gör, och mer till hur kroppen mår och orkar.",
  },
  steps: {
    none: "Steg som inte fylls i står i regel utanför sammanställningen här.",
    thin: "Med få ifyllda dagar säger stegen i regel mer om de dagarna än om perioden.",
    low: "Steg är i regel den vardagsrörelse som rör sig mest mellan veckor, och den syns sällan som träning.",
    steady: "Steg är i regel den vardagsrörelse som rör sig mest mellan veckor, och den syns sällan som träning.",
  },
  sleep: {
    none: "Utan ifylld sömn går det i regel inte att säga något om den.",
    thin: "Med få ifyllda nätter säger snittet i regel mer om de nätterna än om perioden.",
    low: "Kort sömn gör det i regel tyngre att orka med både mat och rörelse dagen efter.",
    steady: "Jämn sömn gör det i regel lättare att orka med både mat och rörelse.",
  },
  habits: {
    none: "Vanor som inte är upplagda syns i regel inte här.",
    thin: "En vana som nyss lagts upp säger i regel mer om veckan som kommer än om den som gått.",
    steady: "Vanor är i regel lättare att hålla när de är få och konkreta, och strecket räknar dagar med loggning, inte dagar då någon skött sig.",
  },
  measurements: {
    /**
     * "som vågen missar" was the first wording, and the reply guard refused it:
     * `missar` is one of the words BLAME treats as a reproach whatever its
     * subject is. The guard is deliberately blunt there, and the app's own copy
     * is the cheaper thing to change (D171).
     */
    none: "Utan mått går det i regel inte att se förändringar som inte syns på vågen.",
    thin: "Med få mätningar är förändringen i regel osäker, för måttbandet hamnar sällan exakt likadant två gånger.",
    low: "Ett mått som minskar medan vikten står still betyder i regel att något rört sig ändå.",
    steady: "Mått rör sig i regel långsammare än vikten, och de visar oftast det som inte syns på vågen.",
  },
};

/**
 * The line for a domain in a state, or the domain's `none` line.
 *
 * Falling back to `none` rather than to silence: a domain with no line at all
 * would leave the model to supply the meaning, which is the thing this exists
 * to stop.
 */
export function meaningLine(domain: MeaningDomain, state: MeaningState): string {
  const lines = INTERPRETATIONS[domain];
  return lines[state] ?? lines.none;
}

/** How the sheet labels it, so the prompt and the tests name one thing. */
export const MEANING_PREFIX = "Vad det betyder:";

/** The sheet's own line for a domain, ready to `say()`. */
export function meaningFor(domain: MeaningDomain, state: MeaningState): string {
  return `${MEANING_PREFIX} ${meaningLine(domain, state)}`;
}

/** Whether a sentence carries one of the markers that make a claim general. */
export function isMarkedGeneral(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return GENERAL_MARKERS.some((marker) => lower.includes(marker));
}
