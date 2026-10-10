import { useEffect, useState } from "preact/hooks";
import type { Expense } from "../shared/expenses";
import { RECEIPT_MAX_BYTES, RECEIPT_MAX_SIDE, RECEIPT_QUALITY, receiptBase, receiptPath } from "../shared/receipts";
import { ApiError, api, apiUpload } from "./api";
import { ErrorMessage, useErrorText } from "./components";
import { useI18n } from "./i18n";

/**
 * A photo as it is sent: at most RECEIPT_MAX_SIDE pixels on its longest side, saved as a JPEG.
 * Drawing it on a canvas and saving that also leaves its EXIF (GPS position, camera) behind; the
 * browser turns it the right way up first. Throws ApiError "photo_unreadable" for a file it can't
 * read as an image.
 */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  // Kept until the photo is redrawn: some browsers still read from it while drawing.
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new ApiError("photo_unreadable", 0, "not an image this browser can read");
    }
    return await redraw(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function redraw(image: HTMLImageElement): Promise<Blob> {
  // An SVG without a size has none to draw at.
  if (!image.naturalWidth || !image.naturalHeight) throw new ApiError("photo_unreadable", 0, "no size");
  const scale = Math.min(1, RECEIPT_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new ApiError("photo_unreadable", 0, "no canvas");
  // A JPEG has no transparency: see-through parts of a PNG come out white, not black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Lower the quality for the rare photo that is still too big.
  for (const quality of [RECEIPT_QUALITY, 0.5, 0.3]) {
    // toBlob throws for a picture the browser won't let a page read back (some SVGs).
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob(resolve, "image/jpeg", quality);
      } catch {
        resolve(null);
      }
    });
    if (!blob) throw new ApiError("photo_unreadable", 0, "could not save as JPEG");
    if (blob.size <= RECEIPT_MAX_BYTES) return blob;
  }
  throw new ApiError("receipt_too_large", 0, "still too big");
}

/** A button that opens the camera or photo library (a label around a hidden file input). */
export function PhotoPicker({
  label,
  disabled,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  onPick: (file: File) => void;
}) {
  return (
    <label class={`button small secondary file-button${disabled ? " disabled" : ""}`}>
      <input
        type="file"
        accept="image/*"
        class="visually-hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          // Cleared so picking the same file again still counts as a change.
          e.currentTarget.value = "";
          if (file) onPick(file);
        }}
      />
      {label}
    </label>
  );
}

/**
 * An expense's receipt photo in the list, with buttons to add, replace or remove it. The photo is
 * only loaded while `open` (the expense's details are showing).
 */
export function ReceiptPanel({
  groupId,
  expense,
  open,
  onChange,
}: {
  groupId: string;
  expense: Expense;
  open: boolean;
  onChange: (receipt: string | null) => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The photo that failed to load: removed or replaced by someone else since the list loaded.
  const [broken, setBroken] = useState<string | null>(null);
  const base = receiptBase(groupId, expense.id);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const upload = (file: File) =>
    run(async () => (await apiUpload<{ receipt: string }>(base, await shrinkPhoto(file))).receipt);

  const remove = () => {
    if (!confirm(t("receipt.removeConfirm"))) return;
    run(async () => {
      await api(`${base}/delete`, {});
      return null;
    });
  };

  const src = expense.receipt && receiptPath(groupId, expense.id, expense.receipt);
  return (
    <div class="receipt">
      {src && open && (
        <a href={src} target="_blank" rel="noopener">
          <img
            class="receipt-photo"
            src={src}
            alt={t("receipt.alt", { description: expense.description })}
            onError={() => setBroken(src)}
          />
        </a>
      )}
      {src && open && broken === src && <ErrorMessage>{t("receipt.loadFailed")}</ErrorMessage>}
      <div class="actions">
        <PhotoPicker label={src ? t("receipt.replace") : t("receipt.add")} disabled={busy} onPick={upload} />
        {src && (
          <button type="button" class="button small secondary" disabled={busy} onClick={remove}>
            {t("receipt.remove")}
          </button>
        )}
      </div>
      {busy && <p class="muted small">{t("receipt.working")}</p>}
      {error !== null && <ErrorMessage>{errorText(error)}</ErrorMessage>}
    </div>
  );
}

/**
 * A photo picked in the add-expense form, shrunk at once so the form can show it and send it
 * after the expense is saved. `photo` is null until one is picked (and while it is shrinking).
 */
export function usePhotoDraft() {
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    setPhoto(null);
    try {
      setPhoto(await shrinkPhoto(file));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const clear = () => {
    setPhoto(null);
    setError(null);
  };
  return { photo, preview, busy, error, pick, clear };
}

/** The add-expense form's optional photo field. */
export function PhotoField({ draft, disabled }: { draft: ReturnType<typeof usePhotoDraft>; disabled?: boolean }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  return (
    <div class="field">
      <span>{t("expenseNew.receipt")}</span>
      {draft.preview && <img class="receipt-photo" src={draft.preview} alt={t("expenseNew.receiptPreview")} />}
      <div class="actions">
        <PhotoPicker
          label={draft.photo ? t("receipt.replace") : t("receipt.add")}
          disabled={draft.busy || disabled}
          onPick={draft.pick}
        />
        {(draft.photo || draft.error !== null) && (
          <button type="button" class="button small secondary" disabled={disabled} onClick={draft.clear}>
            {t("receipt.remove")}
          </button>
        )}
      </div>
      {draft.busy && <small class="muted">{t("receipt.working")}</small>}
      {draft.error !== null && <ErrorMessage>{errorText(draft.error)}</ErrorMessage>}
    </div>
  );
}
