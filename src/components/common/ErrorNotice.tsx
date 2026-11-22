/** A danger notice for an error message (closable when `onClose` is given); nothing without a message. */
export function ErrorNotice({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <calcite-notice open kind="danger" scale="s" closable={onClose ? true : undefined} oncalciteNoticeClose={onClose}>
      <div slot="message">{message}</div>
    </calcite-notice>
  );
}
