import { useState, type ChangeEvent } from "react";
import type { FoodMatch } from "shared";
import { PHOTO_CONFIDENCE } from "shared";
import { useConfirmParsedFood, useParseFoodPhoto } from "../lib/food.js";
import { preparePhoto } from "../lib/photo.js";
import { ParsedProposal } from "./ParsedProposal.js";
import { t } from "../i18n/index.js";

/**
 * Logging a meal by photographing it (D143).
 *
 * The same bargain as the text parse, with a different input: **the model names
 * what it sees, the database prices it, and a person confirms before anything
 * is written.** A photograph is a richer sentence, not a new authority; the
 * probe that preceded this watched a model look at a plate and produce a carrot
 * that was not on it.
 *
 * Three things about the transport are deliberate and none of them is an
 * implementation detail:
 *
 * **A file input with `capture="environment"`, not `getUserMedia`.** The camera
 * API means asking for a permission that persists, drawing a viewfinder, and
 * owning the shutter, and the phone already has all three and does them better.
 * The file input opens the camera on a phone and the picker on a desktop, which
 * is the right behaviour in both places without a line of code choosing between
 * them.
 *
 * **The image is resized here, before it is sent.** Not to save bandwidth: to
 * make the wait a wait somebody will accept, and to strip the coordinates,
 * timestamp and phone model the photograph is carrying. See `lib/photo.ts`.
 *
 * **The image is never stored anywhere.** Not in the offline queue, not in
 * local storage, not in a form that survives this component unmounting. It is
 * read, sent, and dropped. That is why the queue's ordinary rule — anything
 * that fails offline is kept and retried — does not apply here, and the note
 * says the picture has to be taken again rather than pretending it was kept.
 *
 * The optional line beside it is the fix for what a photograph cannot say. A
 * kebab pizza came back from the model as "Pizza (1 st)": the picture shows one
 * round thing, and which round thing it is, is the part the person knows.
 */
export function FoodPhotoEntry({
  localDate,
  onLogged,
}: {
  localDate: string;
  onLogged: (message: string) => void;
}) {
  const parse = useParseFoodPhoto();
  const confirm = useConfirmParsedFood();

  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [proposal, setProposal] = useState<FoodMatch[] | null>(null);
  /** True while the browser is resizing, which is before the request starts. */
  const [preparing, setPreparing] = useState(false);

  const working = preparing || parse.isPending;

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    /**
     * Cleared immediately, so photographing the same plate twice fires a second
     * change event, and so the input is not left holding a reference to the
     * file after it has been read.
     */
    event.target.value = "";
    if (!file) return;

    setMessage(null);
    setProposal(null);
    setPreparing(true);

    const prepared = await preparePhoto(file);
    setPreparing(false);

    if (!prepared.ok) {
      setMessage(
        prepared.reason === "too_large" ? t("photo.tooLarge") : t("photo.unreadable"),
      );
      return;
    }

    const trimmed = note.trim();
    const result = await parse.mutateAsync({
      image: prepared.base64,
      ...(trimmed === "" ? {} : { note: trimmed }),
    });

    if (!result.available) {
      setMessage(
        result.reason === "rate_limited"
          ? t("photo.rateLimited")
          : t("photo.unavailableNow"),
      );
      return;
    }

    if (result.items.length === 0) {
      setMessage(t("photo.nothingFound"));
      return;
    }

    setProposal(result.items);
  }

  return (
    <div>
      <label className="mb-1 block text-micro text-muted" htmlFor="photo-note">
        {t("photo.noteLabel")}
      </label>
      <input
        id="photo-note"
        className="field mb-3"
        value={note}
        placeholder={t("photo.notePlaceholder")}
        onChange={(event) => setNote(event.target.value)}
        disabled={working}
      />

      <label className="btn inline-flex w-auto cursor-pointer items-center px-4">
        {working ? t("photo.working") : t("photo.shutter")}
        <input
          type="file"
          accept="image/*"
          // The phone's own camera, not a viewfinder this app has to own.
          capture="environment"
          className="sr-only"
          data-testid="photo-input"
          aria-label={t("photo.shutter")}
          disabled={working}
          onChange={(event) => void chosen(event)}
        />
      </label>

      {working ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {t("photo.waiting")}
        </p>
      ) : null}

      {message ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {message}
        </p>
      ) : null}

      {proposal ? (
        <ParsedProposal
          items={proposal}
          /*
            Every row from a photograph is an estimate by origin, so the whole
            list is marked rather than the odd row: the uncertainty is in where
            it came from, not in which food it happened to be.
          */
          uncertain
          intro={t("photo.checkBeforeSaving")}
          saving={confirm.isPending}
          onConfirm={async (rows) => {
            await confirm.mutateAsync({
              localDate,
              mealSlot: "snack",
              items: rows,
              // Lowered, never excluded (D55). The database priced these, so
              // the coverage counts them; what is less certain is the naming.
              confidence: PHOTO_CONFIDENCE,
            });
            onLogged(t("llm.logged", { count: rows.length }));
          }}
          onCancel={() => setProposal(null)}
        />
      ) : null}
    </div>
  );
}
