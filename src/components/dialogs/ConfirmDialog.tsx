interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  kind?: "brand" | "danger";
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmation for destructive or consequential actions. */
export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", kind = "brand", onConfirm, onCancel }: Props) {
  return (
    <calcite-dialog open={open || undefined} modal heading={title} width="s" kind={kind === "danger" ? "danger" : undefined} oncalciteDialogClose={onCancel}>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{message}</p>
      <calcite-button slot="footer-end" appearance="outline" kind="neutral" onClick={onCancel}>
        Cancel
      </calcite-button>
      <calcite-button slot="footer-end" kind={kind} onClick={onConfirm}>
        {confirmLabel}
      </calcite-button>
    </calcite-dialog>
  );
}
