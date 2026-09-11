/**
 * The interface, in Swedish. One language, no switcher — see DECISIONS.md D21.
 *
 * Keep the whole voice of the app readable in one file. Two rules from the
 * constitution govern the tone here:
 *
 *  - **there is no failure state** (§3). A missed day is a gap, never a scolding.
 *    "Inget loggat än" and not "Du har missat";
 *  - **the trend is the number** (D2). Copy about the raw reading is secondary
 *    and phrased as such.
 *
 * Placeholders are `{name}` and are substituted by `t()`.
 */
export const sv = {
  "app.loading": "Laddar…",

  // ---------------------------------------------------------------- auth
  "auth.signIn": "Logga in",
  "auth.signingIn": "Loggar in…",
  "auth.signOut": "Logga ut",
  "auth.email": "E-post",
  "auth.password": "Lösenord",
  "auth.passwordAgain": "Lösenord igen",
  "auth.passwordHint": "Minst 12 tecken.",
  "auth.name": "Namn",
  "auth.inviteCode": "Inbjudningskod",
  "auth.codeFromLink": "Ifylld från länken i mejlet.",
  "auth.height": "Längd (cm)",
  "auth.createAccount": "Skapa konto",

  /* --- consent, and leaving (D107) ----------------------------------------- */
  "auth.consentBefore": "Jag har läst",
  "auth.consentPrivacy": "hur uppgifterna hanteras",
  "auth.consentAnd": "och",
  "auth.consentTerms": "villkoren",
  "auth.consentAfter": ", och samtycker till att vikt och mått sparas här.",

  "consent.title": "En sak innan du fortsätter",
  "consent.leadWhat": "Det har kommit en sida om hur uppgifterna hanteras.",
  "consent.what":
    "Den beskriver vad som sparas, varför, vem som ser något och hur du tar ut eller raderar allt.",
  "consent.leadWhy": "Vikt och kroppsmått räknas som känsliga uppgifter.",
  "consent.why":
    "De hanteras här för ett hälsosyfte, och då ska samtycket vara uttryckligt i stället för underförstått. Därför den här frågan.",
  "consent.leadLeave": "Du kan ångra dig när du vill.",
  "consent.leave":
    "Under Inställningar tar du ut allt du loggat och raderar kontot själv, utan att fråga någon.",
  "consent.readPrivacy": "Läs om uppgifterna",
  "consent.readTerms": "Läs villkoren",
  "consent.accept": "Jag har läst och samtycker",
  "consent.failed": "Det gick inte att spara just nu. Försök igen.",
  "account.deleteHeading": "Radera kontot",
  "account.deleteWhat":
    "Allt som hör till kontot försvinner direkt, och det går inte att ångra.",
  "account.exportFirst": "Ta ut din data först",
  "account.exportHint":
    "Exporten innehåller allt: en JSON-fil med hela kontot och CSV per tabell.",
  "account.deleteStart": "Radera kontot",
  "account.deleteRows": "Det här tas bort",
  "account.deleteWeights": "{n} vägningar",
  "account.deleteFood": "{n} matrader",
  "account.deleteDays": "{n} dagar",
  "account.deletePhotos": "{n} foton",
  "account.passwordToConfirm": "Ditt lösenord",
  "account.typeEmailToConfirm": "Skriv din mejladress för att bekräfta",
  "admin.revokeConfirmBody":
    "Koden {code} slutar gälla direkt och går inte att använda för att registrera ett konto. Du kan skapa en ny när som helst.",
  "admin.disableConfirmBody":
    "{email} kan inte logga in förrän kontot slås på igen. Ingenting raderas, och alla sessioner avslutas.",
  "admin.typeEmailToConfirm": "Skriv kontots mejladress för att bekräfta",
  "account.passwordWhy":
    "Lösenordet krävs, för en öppen session ska inte räcka för att radera ett år av loggning.",
  "account.deleteConfirm": "Radera för alltid",
  "account.wrongPassword": "Lösenordet stämmer inte.",
  "account.deleteFailed": "Det gick inte att radera just nu. Försök igen.",
  "auth.creating": "Skapar…",
  "auth.haveInvite": "Har du en inbjudningskod?",
  "auth.alreadyHaveAccount": "Har du redan ett konto?",
  "auth.unreachable": "Kunde inte nå servern.",

  // ------------------------------------------------------------ dashboard
  "dash.trendWeight": "Trendvikt",
  "dash.startLine": "Logga en vikt så börjar linjen.",
  "dash.needMore": "En notering till så börjar trenden röra sig.",
  "dash.changeOver": "{amount} kg på {days} dagar",
  "dash.lastReading": "Senast vägd {weight} kg",
  "dash.loadingTrend": "Laddar trenden",
  "dash.nothingLogged": "Inget loggat än. Linjen börjar med din första vägning.",
  "dash.nothingInRange": "Inga noteringar i den här perioden.",
  "dash.trendOverTime": "Trendvikt över tid",

  // The smoothing note, shown only while the trend still leans on its seed.
  "dash.smoothedOver":
    "Utjämnad över {days} dagar, så den ligger efter dagens vägning med flit.",

  // stats
  "stat.readings": "Vägningar",
  "stat.today": "I dag",
  "stat.height": "Längd",
  "stat.notYet": "Inte än",

  /* --- onboarding is the empty state (D105) -------------------------------- */
  "welcome.title": "Kom igång",
  "welcome.what":
    "Tre saker gör siffrorna riktiga. Inget av dem behövs för att logga, bara för att räkna.",
  "welcome.weigh": "Väg dig första gången",
  "welcome.height": "Fyll i din längd, så går BMI och midja/längd att räkna",
  "welcome.goal": "Sätt ett mål, så går det att visa en prognos",
  "welcome.optional": "Du kan hoppa över allt det här och börja logga direkt.",
  "welcome.dismiss": "Dölj",
  "stat.loading": "Läser in",

  // the exercise-to-target switch (D31)
  "profile.exerciseTitle": "Träning och mål",
  "profile.exerciseToggle": "Lägg loggad träning till dagens mål",
  "profile.exerciseAdaptive":
    "Din underhållsnivå räknas fram ur din egen vikt- och intagshistorik. Träningen ligger " +
    "därmed redan i den siffran, och att lägga den ovanpå skulle räkna samma kalorier två " +
    "gånger. Inställningen är därför inte tillgänglig så länge nivån räknas fram på det sättet.",
  "profile.exerciseFormula":
    "Din underhållsnivå kommer från formeln, som är ett grundvärde utan kännedom om just i " +
    "dag. Då går det att lägga loggad träning ovanpå målet om du vill.",
  "profile.exerciseNoFigure":
    "Det finns ingen underhållsnivå att lägga träning ovanpå ännu.",
  "profile.exercisePreferenceKept":
    "Ditt tidigare val är sparat och börjar gälla igen om nivån går tillbaka till formeln.",

  // the /diagnostik page — a manual check for what a real phone supports
  "diag.title": "Vad den här webbläsaren klarar",
  "diag.intro":
    "Öppna den här sidan på telefonen över https för att se vilken streckkodsläsare " +
    "som faktiskt används där. Det går inte att testa automatiskt: ingen headless " +
    "webbläsare har BarcodeDetector, och kameran finns inte i en sådan.",
  "diag.secureContext": "Säker kontext",
  "diag.camera": "Kamera",
  "diag.native": "BarcodeDetector",
  "diag.engine": "Läsare som används",
  "diag.engineNative": "BarcodeDetector (inbyggd)",
  "diag.engineZxing": "ZXing (reserv)",
  "diag.engineNone": "Ingen. Kameran är inte tillgänglig här.",
  "diag.checkFormats": "Visa format",
  "diag.device": "Enhet",
  "diag.mode": "Läge",
  "diag.modeStandalone": "installerad app",
  "diag.modeBrowser": "webbläsarflik",
  "diag.language": "Språk",
  "diag.formats": "Format",
  "diag.cameraLabel": "Kameraetikett",
  "diag.serviceWorker": "Service worker",
  "diag.queue": "Kö",
  "diag.dateFormat": "Datumfältets format",
  "diag.notRun": "ej kört",
  "diag.checkServiceWorker": "Läs av service worker",
  "diag.checkQueue": "Läs av kön",
  "diag.nativeControls": "Systemets egna kontroller",
  "diag.nativeControlsHint":
    "Öppna var och en och skriv ner hur den ritas: hjul, panel eller lista. De ritas av operativsystemet och går inte att se härifrån.",
  "diag.controlSelect": "Rullgardin",
  "diag.controlDate": "Datumfält",
  "diag.controlCheckbox": "Kryssruta",
  "diag.tapTitle": "Varför gör Igen ingenting",
  "diag.tapHint":
    "Tryck en gång i den installerade appen. Kommer ingen rad som säger click är det tryckhanteringen. Kommer click men ingen fetch är det service workern. Kommer båda nådde skrivningen servern.",
  "diag.tapProbe": "Testa ett tryck",
  "diag.copyHint": "Kopiera hela rutan nedan och klistra in den i statusfilen.",
  "diag.checkCamera": "Testa kameran",
  "diag.yes": "Ja",
  "diag.no": "Nej",

  // ------------------------------------------------- editing and deleting
  "dash.recentReadings": "Senaste vägningarna",
  "delete.action": "Ta bort",
  "delete.confirm": "Ta bort?",
  "delete.aria": "Ta bort {what}",
  "delete.confirmAria": "Bekräfta borttagning av {what}",

  // the sober seed (D44)
  "profile.soberTitle": "Nykter tid",
  "profile.lastDrinkOn": "Senast drack",
  "profile.lastDrinkHint":
    "Har du varit nykter ett tag redan? Fyll i datumet så räknas det med, utan att du " +
    "behöver fylla i alla dagar bakåt. Loggar du alkohol senare än det datumet är det " +
    "loggningen som gäller.",
  "profile.soberRuleTitle": "Dagar utan loggning",
  "profile.soberRuleStrict":
    "Räknas som okända och avbryter räkningen. En dag du inte loggat vet vi inget om.",
  "profile.soberRuleAssume": "Räknas som nyktra.",
  "profile.soberRuleToggle": "Räkna dagar utan loggning som nyktra",
  "progress.soberSeeded": "Räknat från datumet du fyllt i under profilen.",

  // ------------------------------------------------------------ phase 6
  "nav.main": "Huvudmeny",
  "nav.settings": "Inställningar",

  // the sync indicator. Never a failure state: a pending entry is saved.
  "sync.pending": "{count} poster väntar på att skickas",
  "sync.pendingOne": "1 post väntar på att skickas",
  "sync.needsYou": "{count} poster behöver dig",
  "sync.needsYouOne": "1 post behöver dig",

  // settings and the queue inspector
  "settings.title": "Inställningar",
  "settings.queue": "Kö",
  "settings.queueClean": "Allt är skickat.",
  "settings.queueUnwritable":
    "Det går inte att spara lokalt i den här webbläsaren just nu. Allt du loggar skickas direkt till servern i stället, så loggningen fungerar, men den fungerar inte utan nät. Ladda om sidan för att prova igen, och rensa sidans lagringsdata om det inte hjälper.",
  "queue.chosenDate": "valt datum",

  "save.stalledQueue":
    "Enheten svarade inte när raden skulle sparas. Prova igen, och starta om appen om det händer flera gånger.",
  "save.stalledSend": "Servern svarade inte i tid. Raden sparades inte, prova igen.",
  "save.failed": "Raden sparades inte. Prova igen.",

  "diag.build": "Version",
  "diag.savePath": "Spara steg för steg",
  "diag.storage": "Lagring",
  "diag.storageNote":
    "Hur mycket utrymme webbläsaren ger den här sidan, och hur mycket som används. Går det inte att skriva en rad medan servern svarar är det här siffran som avgör om det är fullt eller om lagringen har hakat upp sig.",
  "diag.storageOf": "av",
  "diag.storagePersisted": "sparas permanent",
  "diag.storageBestEffort": "kan rensas av webbläsaren",
  "diag.storageUnsupported": "Webbläsaren kan inte svara på det.",
  "diag.storageUnknown": "Webbläsaren svarade utan siffror.",
  "diag.checkSavePath": "Testa sparandet",
  "diag.running": "Kör…",
  "diag.stepOpen": "1 öppna databasen",
  "diag.stepWrite": "2 skriv en rad",
  "diag.stepNetwork": "3 nå servern",
  "diag.wroteAndRemoved": "skrev och tog bort en rad",
  "settings.queueEmpty": "Inget väntar. Det du loggar sparas här först och skickas sedan.",
  "settings.sendNow": "Skicka nu",
  "settings.retry": "Försök igen",
  "settings.discard": "Kasta",
  "settings.conflicts": "Samma dag från två enheter",
  "settings.conflictsNote":
    "Den här dagen skrevs på en annan enhet innan din post hann fram. Vi har behållit " +
    "båda så att du kan välja, i stället för att skriva över något du inte sett.",
  "settings.conflictTheirs": "Sparad på servern",
  "settings.conflictMine": "Din väntande post",
  "settings.conflictKeepTheirs": "Behåll den som redan finns",
  "settings.conflictOther": "Okänd post",
  /* --- installera som app (D116) ------------------------------------------ */
  "install.title": "Installera som app",
  "install.what":
    "Installerad öppnas Vikt direkt från hemskärmen, utan adressfält, och startar snabbare. Det är samma app och samma data, bara utan webbläsaren runt.",
  "install.action": "Installera som app",
  "install.dismissed": "Du avbröt installationen. Knappen finns kvar om du ändrar dig.",
  "install.iosShare": "Tryck på Dela, ikonen med pilen uppåt.",
  "install.iosAdd": "Välj Lägg till på hemskärmen.",

  /* --- tema (D117) --------------------------------------------------------- */
  "theme.title": "Utseende",
  "theme.what":
    "Mörkt är gjort för morgnar innan lamporna är på. Följ systemet betyder att appen byter när telefonen eller datorn gör det. Valet följer kontot, så det är samma på alla enheter du loggar in på.",
  "theme.system": "Följ systemet",
  "theme.dark": "Mörkt",
  "theme.light": "Ljust",

  "settings.whatWorksOffline": "Vad som fungerar utan nät",
  "settings.offlineExplainer":
    "Allt du loggar fungerar: vikt, mat, dagen, mått och rörelse sparas på telefonen " +
    "direkt och skickas när det finns nät igen. Underhållsnivå, prognoser och samband " +
    "räknas fram på servern och visas därför inte förrän du är uppkopplad. Du får hellre " +
    "veta att en siffra saknas än en gammal siffra som ser aktuell ut.",

  "queue.kind.weight": "Vikt",
  "queue.kind.manual-intake": "Kalorier",
  "queue.kind.food-entry": "Mat",
  "queue.kind.daily": "Dagen",
  "queue.kind.measurement": "Mått",
  "queue.kind.activity": "Rörelse",
  "queue.kind.savings-offset": "Köpte ändå",

  "queue.status.pending": "Väntar",
  "queue.status.failed": "Nekad av servern",
  "queue.status.conflict": "Krockar med en annan enhet",
  "queue.attempts": "{n} försök",
  "queue.attemptOne": "1 försök",

  // what is not available without a network (D43)
  "offline.insights":
    "Underhållsnivå och prognoser räknas fram på servern och går inte att visa utan nät.",
  "offline.correlations": "Sambanden räknas fram på servern och går inte att visa utan nät.",
  "offline.progress": "Potten och milstolparna räknas fram på servern och behöver nät.",
  "offline.data": "Serierna hämtas från servern och går inte att visa utan nät.",
  "offline.loggingStillWorks": "Det du loggar sparas som vanligt och skickas när nätet är tillbaka.",

  // the update prompt
  "update.available": "En ny version finns.",
  "update.reload": "Ladda om",

  // ------------------------------------------------------------ phase 5
  "nav.progress": "Framsteg",

  // the pot
  "pot.balance": "I potten",
  "pot.chartLabel": "Potten över tid, just nu {amount}.",
  "pot.perWeek": "{amount} i veckan",
  "pot.negative":
    "Potten är back. Det händer när en belöning tas ut innan pengarna hunnit " +
    "samlas, och den fyller på sig själv i samma takt som förut.",
  "pot.noRulesYet":
    "Lägg till en regel så börjar potten fyllas. En regel är en sak du väljer bort " +
    "och pengarna den kostade.",
  // One day of history is a dot, not a line. Say that rather than claiming
  // there are no rules, which would be wrong the moment the first one is added.
  "pot.oneDayYet": "Kurvan ritas när potten har mer än en dag bakom sig.",
  "pot.addRule": "Ny sparregel",
  "pot.addRuleNote":
    "Vad du väljer bort, och vad det brukar kosta. Potten räknas fram från reglerna " +
    "varje gång sidan visas, så en ändring gäller bakåt också.",
  "pot.ruleLabel": "Vad",
  "pot.amount": "Kronor",
  "pot.cadence": "När",

  "cadence.every_day": "varje dag",
  "cadence.weekday": "vardagar",
  "cadence.weekend_day": "helger",
  "cadence.per_event": "per gång",

  // milestones
  "progress.title": "Framsteg",
  "progress.subtitle": "Milstolpar, belöningar och potten som betalar för dem.",
  "progress.milestones": "Milstolpar",
  "progress.noMilestones":
    "Inga milstolpar än. Sätt en siffra du är på väg mot, och gärna vad du unnar dig " +
    "när den är nådd.",
  "progress.label": "Namn",
  "progress.metric": "Mått",
  "progress.target": "Mål",
  "progress.reward": "Belöning",
  "progress.rewardCost": "Kostnad",
  "progress.addMilestone": "Lägg till milstolpe",
  "progress.saveMilestone": "Spara milstolpen",
  "progress.targetRange": "Rimligt mellan {min} och {max}.",
  "progress.targetOutOfRange": "Målet ska ligga mellan {min} och {max}{unit}.",
  "progress.claim": "Ta ut",
  "progress.claimed": "Uttagen",
  "progress.potCovers": "Potten räcker",
  "progress.potIn": "Potten räcker om {days} dagar",
  "progress.projected": "Beräknat {date}",
  "progress.achievedOn": "Nådd {date}",
  "progress.remaining": "{remaining} kvar",
  "progress.close": "{remaining} kvar, nära nu.",
  "progress.noDataYet": "Måttet saknar mätvärden att räkna avstånd från.",
  // D36: the lag is stated rather than left to look like a bug.
  "progress.rawReached":
    "Vågen har visat siffran. Milstolpen väntar på den utjämnade linjen, som ligger " +
    "ungefär nio dagar efter med flit, så att en enda uttorkad morgon inte räknas.",

  "metric.weight_kg": "Vikt",
  "metric.waist_cm": "Midja",
  "metric.chest_cm": "Bröst",
  "metric.whtr": "Midja/längd",
  "metric.log_streak_days": "Loggat i rad",
  "metric.sober_days": "Nykter",

  // streak and sobriety
  "progress.streak": "Loggat i rad",
  "progress.sober": "Utan alkohol",
  "progress.dayCount": "{days} dagar",
  "progress.dayCountOne": "1 dag",
  "progress.streakNote": "Räknar dagar du loggat något, inte hur dagen gick.",
  // D35: which rule is in force, always.
  "progress.soberStrict": "Räknat från din senaste registrerade dryck.",
  "progress.soberGap":
    "Räknat från den senaste dagen du loggade. Dagar utan loggning räknas inte som " +
    "nyktra, för det vet vi inget om.",
  "progress.soberAssume":
    "Dagar utan loggning räknas som nyktra, enligt din inställning.",
  "progress.soberNoData": "Logga alkohol en dag så börjar räkningen.",

  // offsets, folded into the daily screen
  "offset.title": "Sparat i dag",
  "offset.note":
    "Bara reglerna som gällde i dag. Tryck på en om du köpte saken ändå, så dras den " +
    "från potten.",
  "offset.markBought": "Köpte ändå",
  "offset.bought": "Köpt",

  // the celebration
  "celebrate.reached": "Du är framme.",
  "celebrate.atValue": "Vid {value}",
  "celebrate.earned": "Du har tjänat ihop",
  "celebrate.potCovers": "Potten räcker till de {cost} den kostar.",
  "celebrate.potShort": "Den kostar {cost}. Potten är inte där än.",
  "celebrate.dismiss": "Tack",

  // ------------------------------------------------------------ phase 4
  "nav.dashboard": "Översikt",
  "nav.daily": "Dagen",
  "nav.more": "Mer",

  /* --- announcements (D108) ------------------------------------------------ */
  "news.title": "Nyheter",
  "news.empty": "Inget att berätta än.",
  "news.new": "Ny",
  "news.unread": "Något oläst",

  "announce.dismiss": "Uppfattat",
  "announce.defaultBody":
    "Vikt är nere för underhåll {weekday} {date} kl {from} till {to}. Du kan logga som vanligt under tiden, det sparas på telefonen och skickas när appen är tillbaka.",

  /* ---------------------------------------------------------------- coachen */

  "coach.title": "Coach",
  "coach.name": "Bengt",
  "coach.what":
    "{name} svarar på frågor om hur det går, utifrån dina egna siffror. Inga nya siffror räknas fram, och ingenting ändras.",
  "coach.reviewTitle": "Veckans sammanfattning",
  "coach.writeReview": "Skriv veckans",
  "coach.writing": "Skriver…",
  "coach.noReviews": "Ingen sammanfattning än. Be om veckans, så skriver han en.",
  "coach.reviewRefused":
    "Sammanfattningen innehöll en siffra som inte kommer ur dina uppgifter, så den sparades inte.",
  "coach.weekOf": "Veckan från {date}",
  "coach.readAll": "Läs hela",
  "coach.dismiss": "Tack, läst",
  "coach.nameNeutral": "Coachen",
  "coach.limits":
    "Siffrorna i svaren kontrolleras mot dina egna uppgifter, men orden runt dem gör det inte: coachen kan ha fel om hur appen fungerar. Det som står på de andra skärmarna är det som gäller.",
  "coach.toneTitle": "Tonläge",
  "coach.toneTorr": "Torr",
  "coach.tonePeppig": "Peppig",
  "coach.toneSaklig": "Saklig",
  "coach.toneTorrWhat": "Kort och underdriven, och roligare när det går bra än när det går trögt.",
  "coach.tonePeppigWhat": "Varmare och gladare när det går bra, lika lugn när det går trögt.",
  "coach.toneSakligWhat": "Ingen personlighet alls. Siffrorna och vad de betyder.",
  "coach.toneBoth": "Gäller både sammanfattningen och chatten.",
  "coach.chatTitle": "Fråga {name}",
  "coach.empty":
    "Fråga något om hur det går. Till exempel hur veckan sett ut, eller varför underhållsnivån rört sig.",
  "coach.ask": "Din fråga",
  "coach.placeholder": "Hur har veckan sett ut?",
  "coach.send": "Fråga",
  "coach.thinking": "Tänker…",
  "coach.you": "Du",
  "coach.newConversation": "Nytt samtal",
  "coach.refusedNote": "Svaret stoppades av appens spärrar, och det du ser är appens egen text.",
  "coach.busy": "Coachen är upptagen just nu. Försök igen om en stund.",
  "coach.unreachable":
    "Coachen går inte att nå just nu. Den kör på en dator hemma som inte alltid är igång, och frågan sparas inte.",
  "coach.limited": "Du har frågat många gånger den här timmen. Prova igen om en stund.",
  "coach.readsOnly":
    "{name} kan bara läsa. Ingenting loggas och ingen plan ändras: det gör du själv under",
  "coach.historyTitle": "Tidigare samtal",
  "coach.historyWhat":
    "Samtalen sparas på ditt konto, visas bara för dig och används inte till något annat. De följer med i exporten och försvinner med kontot.",
  "coach.noHistory": "Inga samtal än.",
  "coach.turns": "{count} rader, senast {date}",
  "coach.forget": "Ta bort",
  "coach.forgetAll": "Ta bort alla samtal",
  "coach.forgetAllTitle": "Ta bort alla samtal?",
  "coach.forgetAllBody":
    "Allt du har frågat och allt Bengt har svarat försvinner. Det går inte att ångra.",

  /* ---------------------------------------------------------------- vanor */

  "habit.title": "Vanor",
  "habit.empty":
    "En egen checklista. Skriv det du vill göra varje dag, och bocka av när det är gjort.",
  "habit.examplesLead": "Tre vanliga, om du vill börja där:",
  "habit.exampleWater": "Två liter vatten",
  "habit.exampleVitamins": "Vitaminer",
  "habit.exampleStretch": "Stretching",
  "habit.add": "Lägg till vana",
  "habit.edit": "Ändra listan",
  "habit.editTitle": "Ändra listan",
  "habit.name": "Namn",
  "habit.namePlaceholder": "D-vitamin",
  "habit.icon": "Ikon",
  "habit.iconNone": "Ingen",
  "habit.icon.droppe": "Droppe",
  "habit.icon.tablett": "Tablett",
  "habit.icon.stretch": "Stretching",
  "habit.icon.promenad": "Promenad",
  "habit.icon.somn": "Sömn",
  "habit.icon.bok": "Bok",
  "habit.icon.tand": "Tandborste",
  "habit.icon.sol": "Dagsljus",
  "habit.icon.andning": "Andning",
  "habit.icon.penna": "Penna",
  "habit.change": "Ändra",
  "habit.moveUp": "Flytta upp",
  "habit.moveDown": "Flytta ner",
  "habit.remove": "Ta bort",
  "habit.removeTitle": "Ta bort {name}?",
  "habit.removeKeepBody":
    "Vanan försvinner från listan. Dagarna du redan bockat av finns kvar, och de följer med i exporten.",
  "habit.removeAllBody":
    "Vill du bli av med historiken också, ta bort allt. Det går inte att ångra.",
  "habit.removeKeep": "Ta bort, behåll historiken",
  "habit.removeAll": "Ta bort allt",
  "habit.reminder": "Påminnelse",
  "habit.reminderWhat":
    "En notis med vanans namn. Den hoppas över om du redan bockat av den den dagen.",
  "habit.streakDays": "{days} dagar i rad",
  "habit.streakOne": "1 dag i rad",
  "habit.rule":
    "Dagar i rad räknas från de dagar du fyllt i listan. En dag du inte var här alls är okänd, inte missad, och räkningen börjar då om från senaste dagen du fyllde i.",
  "habit.saveFailed": "Det gick inte att spara just nu.",

  "push.title": "Påminnelser",
  "push.what":
    "Två påminnelser, var och en med en tid för vardagar och en för helgen. Varje tid har en egen på- och avknapp, och alla är avstängda tills du slår på dem.",
  "push.where":
    "Push fungerar i webbläsaren på Android. På iPhone och iPad fungerar det bara när appen är installerad på hemskärmen.",
  "push.unsupported": "Den här webbläsaren kan inte ta emot push. Påminnelserna går inte att slå på här.",
  "push.notAsked": "Webbläsaren har inte frågat än. Tryck nedan, så frågar den.",
  "push.denied":
    "Du har nekat notiser för den här sidan, och webbläsaren frågar inte igen. Slå på notiser för sidan i webbläsarens inställningar, så fungerar knapparna här.",
  "push.granted": "Den här enheten är ansluten och kan ta emot påminnelser.",
  "push.allow": "Tillåt notiser",
  "push.weighLabel": "Påminn mig att väga mig",
  "push.dayLabel": "Påminn mig att fylla i dagen",
  "push.weekdays": "Vardagar",
  "push.weekend": "Helg",
  "push.timeWeekdays": "Tid på vardagar",
  "push.timeWeekend": "Tid på helgen",
  "push.test": "Skicka en testnotis",
  "push.testing": "Skickar…",
  "push.testSent": "Skickad till {count} enhet. Kommer den inte fram är det enheten som blockerar den.",
  "push.testNone": "Ingen enhet tog emot den. Anslut den här enheten först.",
  "push.testFailed": "Det gick inte att skicka just nu.",
  "push.forget": "Ta bort",
  "push.thisDevice": "den här enheten",
  "push.unnamedDevice": "Enhet utan namn",
  "push.lastSeen": "Senast nådd {date}",
  "push.preview": "Notisen säger: {text}",
  "push.notifyWeigh": "Dags att väga dig",
  "push.notifyDay": "Dags att fylla i dagen",
  "push.notifyHabit": "Kom ihåg: {name}",
  "settings.requestMail": "Mejla mig när någon ber om en kod",
  "settings.requestMailHint":
    "Gäller bara dig som administrerar. Förfrågan hamnar i listan under Administration oavsett, och pricken vid Administration visas också oavsett. Det här handlar bara om mejlet.",
  "settings.newsMail": "Mejla mig när något nytt kommer",
  "settings.newsMailHint":
    "Gäller nyheter. Driftmeddelanden mejlas oavsett, eftersom de handlar om tjänsten du använder.",

  /* --- announcements, in admin --------------------------------------------- */
  "admin.tabAnnouncements": "Meddelanden",
  "admin.announceNone": "Inga meddelanden än.",
  "admin.announceKind": "Sort",
  "admin.announceMaintenance": "Underhåll",
  "admin.announceNews": "Nyhet",
  "admin.announceNotice": "Meddelande",
  "admin.announceTitle": "Rubrik",
  "admin.announceBody": "Text",
  "admin.announceBodyHint":
    "Lämna tomt för underhåll, så skrivs texten ut från tiderna i läsarens egen tidszon.",
  "admin.announceFormatHint":
    "Du kan använda ## rubrik, ### underrubrik, **fet**, punktlistor med -, numrerade listor och [länktext](adress). Annan formatering skrivs ut som den står.",
  "admin.announcePreview": "Så här ser den ut",
  "admin.announcePreviewEmpty": "Skriv något i rutan ovanför så visas det här.",
  "admin.announceFrom": "Från",
  "admin.announceTo": "Till",
  "admin.announceLead": "Visa banner i förväg (minuter)",
  "admin.announcePublished": "Publicerad",
  "admin.announceSendMail": "Skicka även som mejl",
  "admin.announceMailed": "Mejlat {date}",
  "admin.announceDraft": "Utkast",
  "admin.announceSaved": "Sparat.",
  "admin.announceEdit": "Ändra",
  "admin.announceDelete": "Ta bort",

  "reset.title": "Glömt lösenordet",
  "reset.subtitle": "Skriv din adress så skickas en länk.",
  "reset.send": "Skicka länk",
  "reset.sending": "Skickar…",
  "reset.sentSubtitle": "Kolla mejlen",
  "reset.sent":
    "Finns det ett konto med den adressen är en länk på väg. Den fungerar en gång och gäller i en timme. Hittar du inget mejl, titta i skräpposten.",
  "reset.problem": "Det gick inte just nu. Försök igen om en stund.",
  "reset.newTitle": "Välj ett nytt lösenord",
  "reset.newSubtitle": "Du loggas ut från alla enheter när du sparar.",
  "reset.save": "Spara lösenordet",
  "reset.doneTitle": "Klart",
  "reset.doneSubtitle": "Lösenordet är bytt",
  "reset.done": "Alla inloggningar är avslutade. Logga in med det nya lösenordet.",
  "reset.forgot": "Glömt lösenordet?",

  "admin.title": "Administration",
  "admin.notYours": "Den här sidan finns inte.",
  "admin.pending": "Väntar på svar",
  "admin.nonePending": "Inga förfrågningar just nu.",
  "admin.decided": "Besvarade",
  "admin.approve": "Godkänn",
  "admin.reject": "Neka",
  "admin.codeIs": "Kod: {code}. Skicka den själv, mejl är inte påslaget.",
  "admin.mailOff":
    "Mejl är inte konfigurerat. Godkända förfrågningar visar koden här i stället, att skicka för hand.",
  "admin.noMail": "Inget i kön.",
  "admin.mail.pending": "Väntar",
  "admin.mail.sent": "Skickat",
  "admin.mail.failed": "Gick inte att skicka",

  /* --- admin: the tabs (D100) -------------------------------------------- */
  "admin.tabRequests": "Förfrågningar",
  "admin.tabUsers": "Konton",
  "admin.tabInvites": "Koder",
  "admin.tabMail": "Mejl",
  "admin.tabLog": "Logg",

  /* --- admin: accounts ---------------------------------------------------- */
  "admin.noUsers": "Inga konton än.",
  "admin.userCreated": "Skapad {date}",
  "admin.userLastSeen": "Senast inloggad {date}",
  "admin.userNeverSeen": "Har aldrig loggat in",
  "admin.userDisabled": "Avstängt",
  "admin.userIsAdmin": "Administratör",
  "admin.disable": "Stäng av",
  "admin.enable": "Slå på igen",
  "admin.disableHint": "Sessioner avslutas direkt.",
  "admin.resetFor": "Skicka återställning",
  "admin.resetSent": "Länk skickad till {email}.",
  "admin.resetNoMail": "Länk skapad. Mejl är avstängt, så be personen använda glömt lösenord.",
  "admin.deleteUser": "Ta bort konto",
  "admin.deleteWhat": "Det här tas bort för {email}",
  "admin.deleteWeights": "{n} vägningar",
  "admin.deleteFood": "{n} matrader",
  "admin.deleteDays": "{n} dagar",
  "admin.deletePhotos": "{n} foton",
  "admin.deleteConfirm": "Ta bort för alltid",
  "admin.deleteDone": "{email} är borttaget.",
  "admin.adminCannotDeleteSelf": "Du kan inte ta bort ditt eget konto här.",

  /* --- admin: invite codes ------------------------------------------------ */
  "admin.noInvites": "Inga koder än.",
  "admin.mintInvite": "Skapa kod",
  "admin.inviteUsed": "Använd {date}",
  "admin.inviteUnused": "Oanvänd",
  "admin.inviteExpires": "Går ut {date}",
  "admin.revoke": "Återkalla",
  "admin.revokeUsedHint": "En använd kod går inte att återkalla, den förklarar ett konto som finns.",
  "admin.newCode": "Ny kod: {code}",

  /* --- admin: mail -------------------------------------------------------- */
  "admin.retry": "Försök igen",
  "admin.workerLastTick": "Kön kollades senast",
  "admin.workerSent": "Skickade sedan starten",
  "admin.workerStalled":
    "Ingenting tömmer kön just nu, och {n} meddelanden väntar. Kontrollera att API:t kör och att MAIL_WORKER_IN_PROCESS inte är avstängt.",

  /* --- admin: the audit log ----------------------------------------------- */
  "admin.noLog": "Inget loggat än.",
  "admin.logWhat": "Varje åtgärd här skrivs med vem som gjorde den.",
  /*
    Keyed by the exact action string the service writes, so a new action shows
    up as a missing key rather than as a blank row.
  */
  "admin.action.user.disable": "stängde av kontot",
  "admin.action.user.enable": "slog på kontot igen",
  "admin.action.user.delete": "tog bort kontot",
  "admin.action.user.reset": "skickade en återställningslänk",
  "admin.action.invite.mint": "skapade en kod",
  "admin.action.invite.revoke": "återkallade en kod",
  "admin.action.mail.retry": "lade ett mejl i kön igen",
  "admin.action.mail.configure": "ställde in mejlservern",
  "admin.action.mail.update": "ändrade mejlservern",
  "admin.action.backup.configure": "ändrade backupinställningarna",
  "admin.action.backup.run": "körde en backup",
  "admin.action.backup.download": "hämtade en backupfil",

  /* --- admin: the mail server (D102) -------------------------------------- */
  "admin.tabMailSettings": "Mejlserver",
  "mail.what":
    "Utgående mejl går genom den här servern: lösenordsåterställningar och inbjudningskoder. Lösenordet lagras krypterat och visas aldrig här igen.",
  "mail.host": "Server",
  "mail.port": "Port",
  "mail.security": "Kryptering",
  "mail.starttls": "STARTTLS (oftast 587)",
  "mail.tls": "TLS direkt (oftast 465)",
  "mail.none": "Ingen",
  "mail.username": "Användarnamn",
  "mail.password": "Lösenord",
  "mail.passwordStored": "Nytt lösenord",
  "mail.passwordKeep": "Lämna tomt för att behålla det som finns",
  "mail.passwordClear": "Ta bort det sparade lösenordet",
  "mail.fromAddress": "Avsändaradress",
  "mail.fromName": "Avsändarnamn",
  "mail.saved": "Sparat. Nästa mejl går genom den här servern.",
  "mail.sendTest": "Skicka testmejl till mig",
  "mail.testSent": "Testmejl skickat till {email}.",
  "mail.testFailed": "Testmejlet gick inte iväg.",
  "mail.changedBy": "Senast ändrat av {email}.",
  "mail.changedByImport": "Importerat från miljövariabler vid uppstart.",
  "mail.noKey":
    "SECRET_KEY är inte satt, så inget lösenord kan sparas krypterat. Sätt SECRET_KEY eller SECRET_KEY_FILE och starta om.",
  "mail.keyChanged":
    "Det finns ett sparat lösenord som inte går att läsa. SECRET_KEY saknas eller har ändrats, så mejl kommer inte fram förrän du sparar lösenordet igen.",
  "mail.baseUrl": "Länkar i mejlen byggs från",
  "mail.baseUrlMissing": "ingenting, så inga länkar kan skickas",
  "mail.baseUrlLocal":
    "Det är en lokal adress. Den fungerar på den här maskinen och för ingen annan, så en mottagare får en länk som inte öppnar något. Sätt PUBLIC_BASE_URL till adressen installationen nås på utifrån.",

  /* --- admin: backups (D103) ---------------------------------------------- */
  "admin.tabBackup": "Backup",
  "backup.what":
    "En backup är en krypterad kopia av hela databasen. Den skrivs dit du väljer nedan och krypteras innan den lämnar processen, så filen går inte att läsa utan SECRET_KEY.",
  "backup.lastRun": "Senaste körning",
  "backup.nextRun": "Nästa körning",
  "backup.noSchedule": "Ingen schemalagd",
  "backup.destination": "Skrivs till",
  "backup.runNow": "Kör nu",
  "backup.running": "Kör…",
  "backup.failed": "Misslyckades",
  "backup.download": "Hämta senaste",
  "backup.ranOk": "Klart. Filen är {size}.",
  "backup.runFailed": "Backupen gick inte att köra.",
  "backup.saved": "Sparat.",
  "backup.path": "Katalog att skriva till",
  "backup.pathHelp":
    "En katalog på maskinen, till exempel /var/backups/vikt. Peka den på något som inte dör med servern: en monterad NFS- eller SMB-resurs fungerar, eftersom den ser ut som en vanlig katalog.",
  "backup.pathExamples":
    "Lokalt: /var/backups/vikt. Monterad resurs: /mnt/nas/vikt, om värden redan monterar den. S3: ännu inte implementerat och sparas inte.",
  "backup.kind": "Var backupen hamnar",
  "backup.kindLocal": "Katalog på maskinen",
  "backup.kindS3": "S3-hink",
  "backup.s3Endpoint": "Adress",
  "backup.s3EndpointHint": "Lämna tomt för AWS. För MinIO, en NAS eller Backblaze: hela adressen, till exempel http://nas.local:9000.",
  "backup.s3Region": "Region",
  "backup.s3Bucket": "Hink",
  "backup.s3Prefix": "Mapp i hinken",
  "backup.s3Key": "Åtkomstnyckel",
  "backup.s3Secret": "Hemlig nyckel",
  "backup.s3SecretSet": "En hemlig nyckel är sparad. Lämna fältet tomt för att behålla den.",
  "backup.s3SecretClear": "Ta bort den sparade nyckeln",
  "backup.s3PathStyle": "Adressera hinken i sökvägen",
  "backup.s3PathStyleHint": "På för MinIO, NAS och de flesta andra. Av för AWS, som lägger hinken i värdnamnet.",
  "backup.s3Help":
    "Dumpen krypteras innan den lämnar maskinen, så det som skickas går inte att läsa utan SECRET_KEY. Nyckeln behöver få skriva, lista och ta bort i hinken.",
  "backup.smbGone":
    "Att skriva till en Windows-utdelning direkt går inte: de bibliotek som finns talar NTLMv1, som dagens servrar nekar. Montera utdelningen på värden och välj Katalog på maskinen i stället.",
  "backup.test": "Testa anslutningen",
  "backup.testing": "Testar…",
  "backup.testOk": "Det gick bra. En liten fil skrevs och togs bort igen.",
  "backup.testFailed": "Det gick inte.",
  "backup.pathUnwritable":
    "Går katalogen inte att skriva till skapas den om den saknas, och annars misslyckas körningen med felet från filsystemet. Den raden syns här och ingen halv fil blir kvar.",
  "backup.time": "Tid på dygnet",
  "backup.retain": "Spara i dagar",
  "backup.timeHint": "Lämna tiden tom för att stänga av schemat. Gamla filer tas bort efter antalet dagar, räknat på filens ålder.",
  "backup.bySchedule": "schemalagd",
  "backup.noKey":
    "SECRET_KEY är inte satt. Ingen backup skrivs, för en okrypterad kopia av allas data ska inte lämna maskinen av misstag.",
  "backup.restoreHint":
    "Återställning är ett kommando, inte en knapp: se docs/backup.md. Det är den enda åtgärden som förstör en databas genom att lyckas, och den ska kräva att någon skriver den.",
  "nav.data": "Data",

  // the daily screen
  "daily.title": "Dagen",
  "daily.subtitle": "Allt om i dag på ett ställe. Hoppa över det du inte vill svara på.",
  "daily.energy": "Energi",
  "daily.energyLow": "Trött",
  "daily.energyHigh": "Pigg",
  "daily.mood": "Humör",
  "daily.moodLow": "Tungt",
  "daily.moodHigh": "Lätt",
  "daily.sweat": "Svettning",
  "daily.sweatLow": "Ingen",
  "daily.sweatHigh": "Genomsvettig",
  "daily.hunger": "Hunger",
  "daily.hungerLow": "Mätt",
  "daily.hungerHigh": "Hungrig",
  "daily.sleep": "Sömn (h)",
  "daily.steps": "Steg",
  "daily.alcohol": "Alkohol (std)",
  "daily.note": "Anteckning",
  "daily.save": "Spara dagen",
  "daily.saving": "Sparar…",
  "daily.saved": "Sparat.",

  // measurements
  "measure.title": "Mått",
  "measure.show": "Visa",
  "measure.hide": "Dölj",
  "measure.waist": "Midja (cm)",
  "measure.chest": "Bröst (cm)",
  "measure.neck": "Hals (cm)",
  "measure.hips": "Höft (cm)",
  "measure.thigh": "Lår (cm)",
  "measure.arm": "Arm (cm)",
  "measure.save": "Spara mått",
  "measure.saved": "Sparat.",
  // Why the chart shows a smoothed line rather than the numbers just entered.
  "measure.smoothingNote":
    "Ett måttband för hand slinter en centimeter hit eller dit, vilket är mer än en " +
    "månads verklig förändring. Därför visas måtten utjämnade på samma sätt som vikten, " +
    "med de enskilda mätningarna bakom.",

  // activity
  "activity.title": "Rörelse",
  "activity.type": "Typ",
  "activity.duration": "Minuter",
  "activity.intensity": "Ansträngning",
  "activity.intensityLow": "Lätt",
  "activity.intensityHigh": "Hårt",
  "activity.add": "Lägg till",
  "activity.remove": "Ta bort",
  "activity.approxKcal": "≈ {kcal} kcal",
  "activity.noEstimate": "Ingen uppskattning",
  "activity.dayTotal": "≈ {kcal} kcal i dag",
  // D33, in the words the decision asks for.
  "activity.estimateNote":
    "Kalorierna är grova uppskattningar ur en MET-tabell. De är en anteckning om vad du " +
    "gjort, inte ett underlag för räkningen: de påverkar varken din underhållsnivå eller " +
    "prognoserna.",
  // D31, which case is in force.
  "activity.adaptiveIncludes":
    "Din underhållsnivå räknas fram ur din egen historik, så träningen ligger redan i den " +
    "siffran. Därför läggs den inte till ovanpå ditt mål.",
  "activity.addedToTarget":
    "Din underhållsnivå kommer från formeln just nu, och träningen läggs till ditt mål.",
  "activity.notAddedToTarget":
    "Träningen läggs inte till ditt mål. Det kan slås på i profilen så länge underhållsnivån " +
    "kommer från formeln.",

  "activity.type.walk": "Promenad",
  "activity.type.run": "Löpning",
  "activity.type.cycle": "Cykel",
  "activity.type.swim": "Simning",
  "activity.type.strength": "Styrka",
  "activity.type.row": "Rodd",
  "activity.type.ski": "Skidor",
  "activity.type.football": "Fotboll",
  "activity.type.padel": "Padel",
  "activity.type.garden": "Trädgård",
  "activity.type.housework": "Hushållsarbete",
  "activity.type.other": "Annat",

  // waist-to-height on the trend chart
  "chart.whtr": "Midja/längd",
  "chart.whtrReading": "Uppmätt midja",
  "chart.showWhtr": "Visa midja/längd",
  "chart.whtrValue": "Midja/längd {value}",

  // the correlation view
  // ------------------------------------------------------------ the data view
  "data.title": "Data",
  "data.subtitle":
    "Allt du loggat, dag för dag. Här visas siffrorna som de är, utan uträkningar ovanpå.",
  "data.window": "{from} till {to}, {days} dagar",
  "data.coverage": "{days} av {total} dagar",
  "data.noneInRange": "Inget loggat i perioden.",
  "data.notLogged": "Inte loggat",
  "data.chartLabel": "{name}, {days} dagar med värden",
  "data.openLink": "Se all data",
  "data.pickSeries": "Vilken serie",
  "data.views": "Vyer",
  "data.tabSeries": "Serier",
  "data.tabCorrelations": "Samband",
  "data.sleep": "Sömn",
  "data.steps": "Steg",
  "data.stepsUnit": "steg",
  "data.hoursUnit": "h",
  "data.cmUnit": "cm",
  "data.kcalUnit": "kcal",
  "data.alcohol": "Alkohol",
  "data.alcoholUnit": "standardglas",
  "data.activity": "Rörelse",
  "data.activityUnit": "minuter",
  "data.waist": "Midja",
  "data.intake": "Kalorier",
  "data.footer":
    "Serierna ligger bredvid varandra för att du ska kunna titta på dem, inte för att något av dem förklarar något annat. Skattningarna 1 till 5 är dina egna ord om dagen, ritade som punkter: de sitter inte på en skala som går att räkna på. Dagar utan loggning är tomma, inte nollor.",

  "corr.title": "Samband",
  "corr.subtitle":
    "Dina egna dagar, ställda mot varandra. Läs dem som anteckningar, inte som bevis.",
  "corr.against": "mot",
  "corr.chartLabel": "Punktdiagram: {y} mot {x}, {count} dagar.",
  "corr.sleepHours": "Sömn (h)",
  "corr.energy": "Energi",
  "corr.activityMinutes": "Rörelse (min)",
  "corr.sweat": "Svettning",
  "corr.meanIntake": "Snittintag (kcal)",
  "corr.trendChange": "Trendförändring (kg)",
  "corr.sleepEnergyCaption": "En punkt per dag där både sömn och energi är ifyllda.",
  "corr.activitySweatCaption": "Dagens minuter i rörelse mot hur svettig dagen kändes.",
  "corr.intakeTrendCaption":
    "Snittintag den senaste veckan mot hur mycket trendvikten rört sig under samma vecka.",
  "corr.sampleSize": "Antal dagar",
  "corr.range": "Period",
  "corr.rangeValue": "{from} till {to}",
  "corr.unpaired": "Halvloggade dagar",
  "corr.noneYet": "Inga dagar med båda värdena än.",
  // Swedish has no plural engine here (D21 keeps the layer at thirty lines), so
  // the one place a count of 1 actually occurs gets its own string.
  "corr.someYet": "{have} dagar av {need}.",
  "corr.oneYet": "1 dag av {need}.",
  "corr.moreDays": "{days} dagar till innan det är värt att titta på.",
  "corr.oneMoreDay": "En dag till innan det är värt att titta på.",
  "corr.halfLogged": "{days} dagar har bara det ena värdet och räknas inte med.",
  "corr.startLogging": "Börja med att fylla i dagen, så byggs det här upp av sig självt.",
  // The standing caveat. Not a warning about these charts; a statement of what
  // any chart of this kind can and cannot show.
  "corr.caveat":
    "Punkterna visar vad du loggat, ingenting annat. Det finns ingen uträknad " +
    "korrelation och ingen anpassad linje här, för med några veckors egna " +
    "skattningar går det inte att skilja ett mönster från slumpen, och två saker " +
    "som rör sig tillsammans behöver inte ha något med varandra att göra. Titta på " +
    "punkterna, antalet dagar och perioden, och dra dina egna slutsatser.",

  // ---------------------------------------------------------------- chart
  "chart.trend": "Trend",
  "chart.reading": "Daglig vägning",
  "chart.imported": "Importerad",
  "chart.trendValue": "Trend {value} kg",
  "chart.readValue": "Vägd {value} kg",
  "chart.importedValue": "Importerad {value} kg",
  "chart.noReading": "Ingen vägning den dagen",
  "chart.summary": "Trendlinje: {from} kg till {to} kg över {days} dagar.",
  "chart.emptyLabel": "Trendlinje utan data än.",

  // ------------------------------------------------------------ time range
  "range.label": "Tidsperiod",
  "range.30": "30 d",
  "range.90": "90 d",
  "range.365": "1 år",
  "range.all": "Allt",

  // -------------------------------------------------------------- insights
  "insights.section": "Underhåll och prognoser",
  "insights.maintenance": "Underhåll",
  "insights.maintenanceHelp": "Var underhållssiffran kommer ifrån",
  "insights.maintenanceTooltip":
    "När du har ungefär fyra veckor av vikt och kalorier loggade räknas den här bakvägen ur vad som faktiskt hänt, alltså dina loggade kalorier mot förändringen i trendlinjen, i stället för ur en formel. Den korrigerar sig själv efterhand. Fram till dess är siffran en uppskattning ur en formel, och den byts ut i ett steg i stället för att växa fram.",
  "insights.fromYourData": "Ur dina egna siffror: {days} dagar, {percent} % loggat.",
  "insights.fromFormula":
    "Uppskattad ur längd, vikt, ålder och kön. Fortsätt logga så blir det en riktig siffra.",
  "insights.notYet": "Inte än",
  "insights.startLogging":
    "Logga några dagars vikt och kalorier så dyker en underhållssiffra upp här.",
  "insights.daysLeft":
    "Ungefär {days} {dayWord} till av loggning, så blir det här en riktig siffra räknad ur dina egna uppgifter.",
  "insights.coverageShort":
    "{percent} % av de senaste {days} dagarna har kalorier loggade. Lite till så byter den här siffran till dina egna uppgifter.",
  "insights.dayOne": "dag",
  "insights.dayMany": "dagar",
  "insights.ofDays": "{have} av {need} dagar",
  "insights.couldEstimate":
    "Så länge kan vi uppskatta den, men det kräver {fields}.",
  "insights.addOne": "Fyll i det",
  "insights.addMany": "Fyll i dem",
  "insights.orSkip":
    "eller strunta i det, för loggning ger dig en bättre siffra än formeln gör.",

  "insights.confidenceTooltip":
    "Tillförlitligheten är en ordning, inte en sannolikhet: den säger om siffran vilar på lång historik och hög täckning eller på lite av båda. Den används aldrig i någon uträkning, bara för att visa hur mycket siffran är värd.",
  "insights.confidence": "Tillförlitlighet: {level}",
  "insights.confidenceLabel": "{level} tillförlitlighet",
  "confidence.rough": "Grov",
  "confidence.early": "Tidig",
  "confidence.fair": "Hyfsad",
  "confidence.strong": "God",

  "insights.dailyTarget": "Dagligt mål",
  "insights.dailyTargetHelp": "Vad det dagliga målet betyder",
  "insights.dailyTargetTooltip":
    "Kalorierna din plan siktar på. Den kommer ur planen du satt, inte ur underhållsuppskattningen, och en dag under målet för aldrig med sig någon skuld till morgondagen.",
  "insights.noPlan": "Ingen plan än. Underhållssiffran är värd att följa ändå.",
  "insights.belowMaintenance": "{amount} kcal om dagen under underhåll.",
  "insights.atOrAbove": "På eller över din uppskattade underhållsnivå.",

  "insights.reaching": "Vägen till {goal}",
  "insights.yourGoal": "ditt mål",
  "insights.projectionHelp": "Hur prognoserna räknas fram",
  "insights.projectionTooltip":
    "Båda datumen utgår från ungefär 7 700 kcal per kilo kroppsmassa. Det är en approximation: kroppar varierar, och en del av en tidig förändring är vatten. Se dem som riktningar snarare än bokade tider.",
  "insights.setGoal": "Sätt en målvikt i din plan så dyker båda prognoserna upp här.",
  "insights.onPlan": "Enligt plan",
  "insights.onPlanHint": "Om du äter ditt mål varje dag.",
  "insights.atCurrentPace": "I nuvarande takt",
  "insights.atCurrentPaceHint": "Ur de senaste 28 dagarnas trendlinje.",
  "insights.needsMaintenance": "Kräver en underhållssiffra först.",
  "insights.noDeficit":
    "Ditt mål ligger på eller över underhåll, så den här planen når inte fram.",
  "insights.noMovement": "Trendlinjen har inte rört sig tillräckligt för att räkna fram en takt.",
  "insights.alreadyThere": "Redan framme.",
  "insights.daysCount": "{days} dagar",

  // ---------------------------------------------------------- plan review
  "review.title": "Din plan bygger på en siffra som ändrats",
  "review.sourceImproved":
    "När du satte planen fanns ingen uppmätt underhållssiffra. Nu finns det en: {current} kcal.",
  "review.tdeeMoved":
    "Underhållssiffran har gått från {previous} till {current} kcal sedan du satte planen.",
  "review.impliedRate":
    "Med ditt mål på {target} kcal innebär planen nu {implied} kg i veckan.",
  "review.plannedRate": "Du planerade för {planned} kg i veckan.",
  "review.stillFine": "Planen är fortfarande tillåten, men den gör inte riktigt det du tänkte.",
  "review.nowBreaks": "Planen skulle inte längre godkännas som den är:",
  "review.openPlan": "Se över planen",
  "review.dismiss": "Låt den vara",

  // ------------------------------------------------------------------ food
  "food.title": "Logga mat",
  "food.dayTotal": "{kcal} kcal {day}",
  // Absent is not zero. An empty day says so rather than claiming 0 kcal.
  "food.dayNothingYet": "Inget loggat {day} än",
  "food.dayLoading": "Läser in dagen",
  "food.dayThis": "den dagen",
  // ------------------------------------------------ the optional LLM layer
  "llm.title": "Skriv vad du åt",
  "llm.placeholder": "två ägg, en skiva rågbröd med smör och kaffe",
  "llm.read": "Tolka",
  "llm.reading": "Tolkar…",
  "llm.checkBeforeSaving":
    "Kolla mängderna innan du sparar. Kalorierna kommer från livsmedelsdatabasen, inte från tolkningen.",
  "llm.matched": "{kcal} kcal enligt databasen",
  "llm.noMatch": "Ingen träff i databasen, sparas utan energivärde",
  "llm.include": "Ta med {name}",
  "llm.saveRows": "Spara {count} rader",
  "llm.nothingFound": "Hittade ingen mat i texten. Skriv om den, eller sök upp maten själv.",
  "llm.unavailableNow": "Tolkningen är inte igång just nu. Sök upp maten själv så länge.",
  "llm.logged": "{count} rader loggade",

  "recipe.title": "Vad kan jag laga?",
  "recipe.intro":
    "Skriv vad du har hemma. Förslaget räknas om mot det som finns kvar av dagen, och alla energivärden kommer från livsmedelsdatabasen.",
  "recipe.have": "Det här har jag hemma",
  "recipe.placeholder": "ägg, spenat, fetaost, tomat, rågbröd",
  "recipe.generate": "Föreslå",
  "recipe.thinking": "Lagar ihop…",
  "recipe.again": "Ge ett annat förslag",
  "recipe.elapsed": "{seconds} sekunder. Första förslaget efter en paus tar längre tid.",
  "recipe.budget": "Kvar av dagen: {kcal} kcal.",
  "recipe.budgetProtein": "Kvar av dagen: {kcal} kcal och {protein} g protein.",
  "recipe.budgetAtMost": "Kvar av dagen: högst {kcal} kcal.",
  "recipe.budgetProteinAtMost": "Kvar av dagen: högst {kcal} kcal och {protein} g protein.",
  "recipe.budgetReached": "Dagens mål är redan nått, så förslaget är något litet.",
  "recipe.noBudget": "Ingen dagsbudget att räkna mot, så det här är en vanlig portion.",
  "recipe.total": "{kcal} kcal enligt databasen.",
  "recipe.noTotal": "Ingen av råvarorna finns i databasen, så rätten har ingen summa.",
  "recipe.log": "Logga rätten",
  "recipe.loggedOne": "1 rad loggad",
  "recipe.logged": "{count} rader loggade",
  "recipe.unavailableNow": "Inget förslag den här gången. Försök igen.",
  "recipe.incomplete":
    "Modellen fick inte ihop ett recept som går att laga efter. Försök igen, eller skriv vad du har på ett annat sätt.",
  "recipe.totalAtLeast": "Minst {kcal} kcal enligt databasen.",
  "recipe.missingNamed": "Utanför summan: {names}. Sätt ett värde på raden innan du loggar.",
  "recipe.keep": "Spara receptet",
  "recipe.kept": "Receptet är sparat, och finns nu som en måltid att logga igen.",
  "recipe.saved": "Sparade recept",
  "recipe.noneSaved": "Inga sparade recept än. Spara ett förslag så hamnar det här.",
  "recipe.cookAgain": "Laga igen",
  "recipe.itemCountOne": "1 råvara",
  "recipe.itemCount": "{count} råvaror",
  "recipe.steps": "Gör så här",
  "recipe.stepsHint": "Ett steg per rad.",

  "portion.estimated": "Uppskattad vikt",
  "portion.fromHint": "Vikt från portionen",
  "portion.from.last": "Samma mängd som du loggade senast.",
  "portion.from.user_hint": "Din egen portion för den här varan.",
  "portion.from.hint": "Portionen som står på förpackningen.",
  "portion.from.household": "Vanligt hushållsmått, ändra om det inte stämmer.",
  "portion.from.fallback": "Ingen portion känd för den här varan, så 100 g som utgångspunkt.",
  "portion.oneIs": "1 {unit} = {grams} g",
  "portion.define": "Spara {grams} g som en portion",
  "portion.unitName": "Vad heter portionen?",
  "portion.unitPlaceholder": "skiva",

  "llm.needsValue": "Sätt ett värde på {name} först, eller markera den som obetydlig.",
  "llm.valueFor": "Energi för {name}",
  "llm.negligible": "Räkna som noll",

  "pantry.title": "Skafferi",
  "pantry.intro":
    "Det här förutsätts finnas hemma. Kryddor räknas inte in i maten, resten hamnar i ingredienslistan och i dagens intag.",
  "pantry.empty": "Skafferiet är tomt. Lägg till det du alltid har hemma.",
  "pantry.add": "Lägg till",
  "pantry.addPlaceholder": "sesamolja",
  "pantry.negligible": "Räknas inte in",
  "pantry.counted": "Räknas in i maten",
  "pantry.countedAt": "Räknas in, {kcal} kcal per 100 g",
  "pantry.makeNegligible": "Räkna inte in",
  "pantry.makeCounted": "Räkna in",
  "pantry.countedNote": "{count} av dem hamnar i ingredienslistan när de används.",

  "food.recent": "Senast loggat",
  /*
    "Igen" logs to the day being viewed; these log to today. The labels have to
    carry that difference on their own, because the two sit on the same screen
    (D124).
  */
  "food.sourceTyped": "inskrivet",
  "food.sourceDatabase": "ur matdatabasen",
  "food.entryAmount": "{grams} g, {kcal} kcal",
  "food.copyToToday": "Logga i dag",
  "food.copyDayToToday": "Logga hela dagen i dag",
  "food.copyingDay": "Loggar…",
  "food.copiedToToday": "{name} loggad i dag.",
  "food.copiedDay": "{n} rader loggade i dag.",
  "food.copiedDayPartial": "{n} av {total} rader loggades i dag. Resten ligger kvar på dagen du tittar på.",
  "food.again": "Igen",
  "food.meals": "Sparade måltider",
  "food.itemOne": "1 rad",
  "food.itemMany": "{count} rader",
  "food.find": "Hitta mat",
  "food.ways": "Sätt att lägga till mat",
  "food.searchPlaceholder": "Sök på namn",
  "food.searchAction": "Sök",
  "food.today": "I dag",
  "food.dayOn": "Gäller {date}",
  "food.saveAsMeal": "Spara rader som en måltid",
  "food.mealPickRows": "{count} av {total} rader tas med.",
  "food.mealInclude": "Ta med {name}",
  "food.editMeal": "Byt namn",
  "food.mealNameNew": "Nytt namn",
  "food.mealName": "Namn på måltiden",
  "food.mealSaved": "Måltiden sparad",
  "food.logged": "{name} loggad",
  "food.loggedMeal": "{name} loggad",
  "food.grams": "Gram",
  "food.logIt": "Logga",
  "food.barcodeMiss": "Streckkoden finns inte i databasen. Sök på namn i stället.",
  "food.cameraView": "Kameravy för streckkodsläsning",
  "food.scanHint": "Rikta kameran mot streckkoden",
  "food.cameraStarting": "Startar kameran…",
  "food.cameraInsecure":
    "Kameran kräver en säker anslutning (https). Öppna appen över https, så fungerar skanningen.",
  "food.cameraDenied":
    "Appen fick inte använda kameran. Tillåt kameraåtkomst i webbläsarens inställningar och försök igen.",
  "food.cameraMissing": "Den här enheten har ingen kamera som går att använda. Sök på namn i stället.",
  "food.cameraFailed": "Kameran gick inte att starta. Sök på namn i stället.",
  "nav.food": "Mat",

  // --------------------------------------------------------------- profile
  "profile.title": "Profil",
  "profile.back": "Tillbaka",
  "profile.intro":
    "Behövs bara för den uppskattade underhållssiffran, och bara tills du har ungefär fyra veckor loggade. Sedan kommer siffran ur dina egna uppgifter och inget av det här spelar roll.",
  "profile.sex": "Kön",
  "profile.sexHint":
    "Mifflin-St Jeor-formeln räknar olika för kvinnor och män. Skillnaden är 166 kcal.",
  "profile.sexUnspecified": "Vill inte ange",
  "profile.sexFemale": "Kvinna",
  "profile.sexMale": "Man",
  "profile.birthDate": "Födelsedatum",
  "profile.birthDateHint":
    "Bara året spelar egentligen roll: formeln drar av fem kcal per levnadsår.",
  "profile.save": "Spara",
  "profile.saving": "Sparar…",
  "profile.saved": "Sparat",

  "field.sex": "ditt kön",
  "field.birthDate": "ditt födelsedatum",
  "field.heightCm": "din längd",
  "field.weightKg": "en vägning",

  // ------------------------------------------------------------------ plan
  "plan.title": "Din plan",
  "plan.intro":
    "Målet och det dagliga kalorimålet. Båda prognoserna på översikten behöver en målvikt.",
  "plan.goalWeight": "Målvikt (kg)",
  "plan.goalWeightHint":
    "Båda prognoserna behöver den. Lämna tom om du hellre slipper sätta ett mål.",
  "plan.targetIntake": "Dagligt mål (kcal)",
  "plan.floor": "Golv (kcal)",
  "plan.floorHint":
    "Din egen undre gräns. Den kan bara höja spärren: servern släpper aldrig igenom ett mål under {system} kcal oavsett vad som står här.",
  "plan.rate": "Planerad takt (kg per vecka)",
  "plan.rateHint":
    "Frivilligt. Mer än 1 % av din kroppsvikt i veckan avvisas, eftersom snabbare viktnedgång till största delen är vatten och muskler.",
  "plan.create": "Skapa plan",
  "plan.update": "Uppdatera plan",

  // -------------------------------------------------------------- quick log
  "quick.title": "Logga vikt",
  "quick.cancel": "Avbryt",
  "quick.weight": "Vikt (kg)",
  "quick.calories": "Kalorier i dag (frivilligt)",
  "quick.caloriesHint": "En siffra för hela dagen. Matloggning kommer senare.",
  "quick.numberInvalid": "Skriv ett tal, med komma eller punkt som decimaltecken.",
  "quick.numberAmbiguous":
    "Går inte att tolka entydigt: {value} kan betyda två olika tal. Skriv om det med decimalkomma.",
  "quick.day": "Dag",
  "dateSelector.previous": "Föregående dag",
  "dateSelector.next": "Nästa dag",
  "dateSelector.backToToday": "Till i dag",
  "dateSelector.dayLabel": "Vilken dag",
  "dateSelector.notToday": "Du fyller i en tidigare dag. Det du sparar hamnar på {date}.",
  "quick.today": "I dag",
  "quick.yesterday": "I går",
  "quick.save": "Spara",
  "quick.saving": "Sparar…",
  "quick.saved": "Sparat",
  "quick.clearCaloriesLabel": "dagens kalorisiffra",
  "quick.clearCaloriesNote":
    "Tar bort siffran du skrivit in, så dagen räknas ur maten du loggat i stället. Kräver nät.",
  "quick.caloriesInvalid": "Kalorier måste vara ett positivt tal, eller lämnas tomt.",
  "quick.unreachable": "Kunde inte nå servern. Din vägning är inte sparad än.",

  // ---------------------------------------------------------- quick actions
  "action.section": "Snabbval",
  "action.logWeight": "Väg dig",
  "action.scan": "Skanna",
  "action.logFood": "Logga mat",

  // ------------------------------------------------------------- open/close
  "common.expand": "Visa",
  "common.collapse": "Dölj",
  "common.edit": "Ändra",
  "common.cancel": "Avbryt",

  // ---------------------------------------------------------- the day card
  "day.section": "I dag",
  "day.eaten": "Ätit i dag",
  "day.nothingLogged": "Inget loggat än i dag.",
  "day.logFirst": "Logga något",
  "day.noTarget": "Ingen plan än, så det finns inget dagsmål att räkna mot.",
  "day.remaining": "{amount} kvar av {target} kcal",
  "day.over": "{amount} kcal över {target}",

  // --------------------------------------------------------------- macros
  "macro.heading": "Fördelning",
  "macro.help": "Var fördelningsmålen kommer ifrån",
  "macro.tooltip":
    "Målen räknas fram ur ditt dagliga kalorimål enligt Nordiska näringsrekommendationerna 2023, som Livsmedelsverket ger ut. Rekommendationerna gäller genomsnittet över minst en vecka, så stapeln följer sjudagarssnittet och en enskild dag visas bara som en siffra.",
  "macro.proteinRaised":
    "Proteinmålet är höjt till 0,83 g per kilo kroppsvikt, eftersom andelen protein bör öka när energiintaget ligger under 8 MJ om dagen.",
  "macro.groupLevel":
    "Rekommendationerna är satta för grupper och går inte att översätta rakt av till en enskild person. Läs siffrorna som en riktning, inte som ett facit.",
  "macro.protein": "Protein",
  "macro.carbs": "Kolhydrat",
  "macro.fat": "Fett",
  "macro.fiber": "Fiber",
  "macro.yourOwn": "eget mål",
  "macro.gramsOfTarget": "{amount} av {target} g",
  "macro.atLeastOfTarget": "minst {amount} av {target} g",
  "macro.weekly": "{name}: {amount} g i snitt mot {target} g, över {days} dagar",
  "macro.daily": "{name}: {amount} g i dag mot {target} g",
  "macro.noneYet": "{name}: inget att visa än",
  "macro.viewLabel": "Period",
  "macro.viewToday": "I dag",
  "macro.viewWeek": "7 dagar",
  "macro.noDaysLogged": "Inget loggat den här veckan.",
  "macro.tooFewComplete":
    "För få dagar med {name}uppgifter: {days} av {logged} loggade dagar har fullständiga uppgifter, det behövs {needed}.",
  "macro.overDays": "snitt över {days} dagar",
  "macro.weekIsTheVerdict":
    "Sjudagarssnittet är det som jämförs med rekommendationen, eftersom värdena gäller genomsnittet över minst en vecka.",
  "macro.todayIsAnIndication":
    "Så här ligger dagen till mot samma mål. Rekommendationen gäller genomsnittet över minst en vecka, så en enskild dag säger inget i sig.",
  "macro.needMoreDays": "Veckosnittet visas när några dagar är loggade.",
  "macro.partial": "{percent} % av dagens mat har uppgifter",

  // ------------------------------------------------------ macro overrides
  "macro.ownTargets": "Egna fördelningsmål",
  "macro.ownTargetsNote":
    "Fälten står tomma så länge målen räknas fram ur planen. Skriv en egen siffra om du hellre vill det, och töm fältet för att gå tillbaka.",
  "macro.derivedIs": "Framräknat: {amount} g",
  "macro.noPlanYet":
    "Målen räknas fram ur planens dagsmål, så de dyker upp när du satt en plan.",
  "macro.saveTargets": "Spara fördelningsmål",

  // ------------------------------------------------------------------- bmi
  "stat.bmi": "BMI",
  "stat.bmiHelp": "Vad BMI säger och inte säger",
  "stat.bmiTooltip":
    "Vikt delat med längden i kvadrat, räknat på trendvikten och inte på morgonens vägning. Referensintervallet går från 18,5 till 25, och det är satt för grupper: det skiljer inte muskler från fett och säger ingenting om var på kroppen vikten sitter. Midja delat med längd, som ligger i kurvan ovanför, är det bättre måttet av de två.",
  "stat.bmiWhere": "Din siffra ligger {band}.",
  "bmi.underweight": "under referensintervallet",
  "bmi.normal": "inom referensintervallet",
  "bmi.overweight": "över referensintervallet",
  "bmi.obese": "klart över referensintervallet",

  // ------------------------------------------------ savings rules, editing
  "pot.startDate": "Från",
  "pot.ruleSummary": "{amount} {cadence} · {days} dagar",
  "pot.reviewChange": "Granska ändringen",
  "pot.deleteRule": "Ta bort regeln",
  "pot.confirmEditTitle": "Så här ändras potten",
  "pot.confirmDeleteTitle": "Så här ändras potten om regeln tas bort",
  "pot.potMovesTo": "Potten går från {from} till {to}, en skillnad på {delta}.",
  "pot.potUnchanged": "Potten står kvar på {balance}.",
  "pot.daysChange": "{from} dagar räknas i dag, {to} dagar efter ändringen.",
  "pot.rewardOutOfReach":
    "En belöning som potten täcker i dag kommer inte att täckas efteråt.",
  "pot.confirmEdit": "Spara ändringen",
  "pot.confirmDelete": "Ta bort regeln",
  "pot.rules": "Sparregler",
  "pot.retroactiveNote":
    "Potten räknas fram ur reglerna varje gång den visas, så en ändring gäller bakåt i tiden också. Du får se vad den gör innan den sparas.",

  // ----------------------------------------------------- the steady header
  "progress.summary": "Läget just nu",
  "progress.reached": "Nådda milstolpar",
  "progress.ofCount": "av {total}",
  "progress.markers": "{done} av {total} milstolpar nådda",
  "progress.towardReward": "På väg mot {reward}",
  "progress.remainingUnit": "{remaining}{unit} kvar",
  "progress.noProjection": "Serien rör sig för lite för ett datum",
  "progress.ifItHolds": "Om serien håller.",

  "estimate.title": "Skriv in maten själv",
  "estimate.intro":
    "För mat som inte finns i någon databas. Skriv vad du åt och ungefär vad det var värt, så sparas det som en egen rad du kan använda igen.",
  "estimate.name": "Vad åt du?",
  "estimate.namePlaceholder": "kebabpizza",
  "estimate.place": "Var? (frivilligt)",
  "estimate.placePlaceholder": "Pizzeria Roma",
  "estimate.kcal": "Kalorier i portionen",
  "estimate.grams": "Ungefär hur många gram",
  "estimate.basis": "Vad bygger siffran på? (frivilligt)",
  "estimate.basisPlaceholder": "stor pizza, åt hela",
  "estimate.save": "Spara uppskattningen",
  "estimate.askModel": "Låt modellen föreslå en siffra",
  "estimate.asking": "Räknar…",
  "estimate.askHint":
    "Modellen gissar bara när ingen databas har rätten. Du ser intervallet den utgår ifrån och kan ändra siffran innan du sparar.",
  "estimate.range": "Modellen anger {low} till {high} kcal.",
  "estimate.modelUnavailable": "Ingen siffra den här gången. Skriv en själv.",
  "estimate.badge": "Uppskattad",
  "estimate.saved": "Uppskattningen är sparad",
  "llm.notRight": "Det här stämmer inte",
  "llm.tryEstimate":
    "Går rätten inte att dela upp? Skriv en uppskattning i stället, så sparas den som en egen rad.",
  /*
    "Uppskatta" also reads as "appreciate", and "registrera" is heavier than
    this app's register, which says "logga" and "väg dig". The helper line says
    when to reach for it, which the old label never did.
  */
  "estimate.open": "Skriv in själv",
  "food.favourites": "Sparade favoriter",
  "food.star": "Spara som favorit",
  "food.unstar": "Ta bort favorit",
  "insights.estimateShare":
    "{percent} % av maten i perioden är uppskattad, så säkerheten är lägre.",
  "progress.allReached": "Alla milstolpar är nådda. Lägg till en ny när du vill ha nästa.",
  "progress.potOfCost": "{balance} av {cost}",
} as const;

export type TranslationKey = keyof typeof sv;
