/**
 * Swedish names for what an export contains (D167).
 *
 * One definition for both places a person meets these names: the sheet tabs
 * and column headers in the Excel workbook the API writes, and the list of CSV
 * files Inställningar offers. Two copies would drift, and the drift would show
 * up as a tab called one thing and a download called another.
 *
 * Keyed by the database's own names, because that is what the export reads.
 * `export-roundtrip.test.ts` fails if a column reaches the workbook with no
 * Swedish header, so a column added to an exported table has to be named here
 * before it can ship.
 */

/** Sheet tab and CSV list names. At most 31 characters, which is Excel's limit. */
export const EXPORT_TABLE_NAMES: Readonly<Record<string, string>> = {
  profiles: "Profil",
  plans: "Planer",
  weight_log: "Vägningar",
  measurement_log: "Mått",
  daily_log: "Dagen",
  activity_log: "Rörelse",
  manual_intake: "Manuellt intag",
  food_entries: "Matrader",
  food_portions: "Portioner",
  food_favourites: "Favoriter",
  meal_templates: "Måltider",
  meal_template_items: "Måltidsrader",
  milestones: "Milstolpar",
  savings_rules: "Sparregler",
  savings_events: "Sparhändelser",
  savings_offsets: "Sparundantag",
  pantry_staples: "Skafferi",
  saved_recipes: "Sparade recept",
  weekly_reviews: "Veckosammanfattningar",
  habits: "Vanor",
  habit_checks: "Avbockade vanor",
};

/**
 * Column headers, shared across tables where a column means the same thing
 * everywhere it appears (`local_date` is always the day it was filed under).
 */
export const EXPORT_COLUMN_NAMES: Readonly<Record<string, string>> = {
  id: "Id",
  user_id: "Konto",
  client_uuid: "Klientens id",
  local_date: "Datum",
  logged_at: "Loggad",
  created_at: "Skapad",
  updated_at: "Uppdaterad",
  note: "Anteckning",
  name: "Namn",
  label: "Etikett",
  status: "Status",
  source: "Källa",

  // weight_log
  weight_kg: "Vikt (kg)",
  body_fat_pct: "Kroppsfett (%)",

  // measurement_log
  waist_cm: "Midja (cm)",
  chest_cm: "Bröst (cm)",
  neck_cm: "Hals (cm)",
  hips_cm: "Höft (cm)",
  thigh_cm: "Lår (cm)",
  arm_cm: "Arm (cm)",

  // daily_log
  sweat: "Svettning",
  energy: "Energi",
  mood: "Humör",
  hunger: "Hunger",
  sleep_hours: "Sömn (timmar)",
  steps: "Steg",
  alcohol_units: "Alkohol (standardglas)",

  // activity_log
  activity_type: "Aktivitet",
  duration_min: "Minuter",
  intensity: "Intensitet",
  met_value: "MET-värde",
  kcal_estimate: "Uppskattade kalorier (kcal)",

  // intake and food
  kcal: "Kalorier (kcal)",
  protein_g: "Protein (g)",
  carbs_g: "Kolhydrater (g)",
  fat_g: "Fett (g)",
  fiber_g: "Fiber (g)",
  grams: "Gram",
  meal_slot: "Måltidstyp",
  food_item_id: "Livsmedel",
  freetext: "Fritext",
  confidence: "Säkerhet",
  confirmed: "Bekräftad",
  unit: "Enhet",
  unit_key: "Enhetens nyckel",
  default_meal_slot: "Förvald måltidstyp",
  use_count: "Antal gånger använd",
  last_used_at: "Senast använd",
  template_id: "Måltid",
  position: "Ordning",
  name_snapshot: "Namn när raden lades till",
  negligible: "Försumbar",

  // plans
  start_date: "Startdatum",
  end_date: "Slutdatum",
  start_weight_kg: "Startvikt (kg)",
  goal_weight_kg: "Målvikt (kg)",
  target_intake_kcal: "Kaloriemål (kcal)",
  target_rate_kg_week: "Takt (kg per vecka)",
  protein_floor_g: "Proteingolv (g)",
  intake_floor_kcal: "Kaloriegolv (kcal)",
  tdee_at_write: "Underhåll när planen skrevs (kcal)",
  tdee_source_at_write: "Underhållets källa när planen skrevs",

  // milestones and savings
  metric: "Mäter",
  target_value: "Mål",
  reward_text: "Belöning",
  reward_cost_sek: "Belöningens kostnad (kr)",
  sort_order: "Ordning",
  achieved_at: "Nådd",
  achieved_value: "Värde när den nåddes",
  reward_claimed_at: "Belöning uttagen",
  celebrated_at: "Firad",
  amount_sek: "Belopp (kr)",
  cadence: "Intervall",
  active: "Aktiv",
  milestone_id: "Milstolpe",
  rule_id: "Sparregel",

  // recipes and reviews
  title: "Titel",
  items: "Ingredienser",
  week_start: "Veckans måndag",
  stats: "Siffror",
  body: "Text",
  model: "Modell",
  dismissed_at: "Läst",

  // habits
  icon: "Ikon",
  remind: "Påminnelse",
  remind_minute: "Påminnelse, minut på dygnet",
  remind_weekend: "Påminnelse på helgen",
  remind_weekend_minute: "Påminnelse på helgen, minut på dygnet",
  archived_at: "Borttagen från listan",
  habit_id: "Vana",
  checked: "Avbockad",

  // profiles
  height_cm: "Längd (cm)",
  birth_date: "Födelsedatum",
  sex: "Kön",
  timezone: "Tidszon",
  locale: "Språk",
  activity_factor: "Aktivitetsfaktor",
  add_exercise_to_target: "Träning läggs till målet",
  sober_assume_unlogged_dry: "Ologgade dagar räknas som nyktra",
  last_drink_on: "Senaste drink",
  macro_protein_g: "Eget proteinmål (g)",
  macro_carbs_g: "Eget kolhydratmål (g)",
  macro_fat_g: "Eget fettmål (g)",
  macro_fiber_g: "Eget fibermål (g)",
  pantry_seeded_at: "Skafferiet ifyllt",
  news_mail: "Nyheter via mejl",
  theme: "Tema",
  request_mail: "Mejl om förfrågningar",
  remind_weigh: "Påminnelse att väga sig",
  remind_weigh_minute: "Påminnelse att väga sig, minut på dygnet",
  remind_weigh_weekend: "Påminnelse att väga sig på helgen",
  remind_weigh_weekend_minute: "Påminnelse att väga sig på helgen, minut på dygnet",
  remind_day: "Påminnelse att fylla i dagen",
  remind_day_minute: "Påminnelse att fylla i dagen, minut på dygnet",
  remind_day_weekend: "Påminnelse att fylla i dagen på helgen",
  remind_day_weekend_minute: "Påminnelse att fylla i dagen på helgen, minut på dygnet",
  coach_tone: "Coachens ton",
};

/** A header for a column, or null when nobody has named it yet. */
export function exportColumnName(column: string): string | null {
  return EXPORT_COLUMN_NAMES[column] ?? null;
}
