import { useEffect, useId, useRef, type ReactNode } from "react";

export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();

    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();

        if (!busy) {
          onClose();
        }
      }}
    >
      <div className="modal-box max-w-2xl p-6 sm:p-8">
        <div className="mb-7 flex items-start justify-between gap-4">
          <h2 id={heading} className="text-2xl font-semibold tracking-tight">
            {title}
          </h2>
          <form
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              onClose();
            }}
          >
            <button className="btn btn-sm" disabled={busy} type="submit">
              Close
            </button>
          </form>
        </div>
        {children}
      </div>
    </dialog>
  );
}
