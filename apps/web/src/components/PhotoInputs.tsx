import type { ChangeEvent } from "react";
import { t } from "../i18n/index.js";

/**
 * Two ways to give a photo tool a picture: take one, or choose one (D200).
 *
 * The first input carries `capture="environment"`, which on Android opens the
 * camera and nothing else. That was the only way in, so a recipe on a web page,
 * a label someone had already photographed, or a plate from lunch could not be
 * used at all. The second has no `capture`, and opens the phone's gallery or
 * files. On a desktop both open the file picker, which is what a desktop has.
 *
 * Both hand the file to the tool's own handler, which sends it through
 * `preparePhoto`: resized and stripped of location and camera data in the
 * phone, the same size and format checks, and "photo.unreadable" for an image
 * the browser cannot decode. A screenshot is a PNG and goes the same way.
 *
 * Both are filled buttons side by side: each starts an action, and D134 keeps
 * one visual tier for actions.
 */
export function PhotoInputs({
  takeLabel,
  working,
  testId,
  onChosen,
  className = "",
}: {
  /** The tool's own camera label: "Ta ett foto", "Fotografera receptet". */
  takeLabel: string;
  working: boolean;
  /** The camera input's test id; the gallery input gets `${testId}-pick`. */
  testId: string;
  onChosen: (event: ChangeEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`} data-testid={`${testId}-ways`}>
      <label className="btn inline-flex w-auto cursor-pointer items-center px-4">
        {working ? t("photo.working") : takeLabel}
        <input
          type="file"
          accept="image/*"
          // The phone's own camera, not a viewfinder this app has to own.
          capture="environment"
          className="sr-only"
          data-testid={testId}
          aria-label={takeLabel}
          disabled={working}
          onChange={onChosen}
        />
      </label>
      <label className="btn inline-flex w-auto cursor-pointer items-center px-4">
        {t("photo.choose")}
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          data-testid={`${testId}-pick`}
          aria-label={t("photo.choose")}
          disabled={working}
          onChange={onChosen}
        />
      </label>
    </div>
  );
}
