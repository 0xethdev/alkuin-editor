/**
 * The mention-mail switch for one signed-in session. The switch shows what
 * the person last chose: the server's first answer only fills in a switch
 * nobody has touched yet, and a failed save only rolls back when it is the
 * latest choice, to the value the server last confirmed.
 */
export type MentionEmailControl = {
  /** The GET answered. */
  loaded(value: boolean): void;
  /** The person flipped the switch. */
  toggle(next: boolean): void;
  /** Signed out or unmounted. Late answers do nothing. */
  close(): void;
};

export function mentionEmailControl(
  show: (on: boolean) => void,
  save: (on: boolean) => Promise<unknown>,
): MentionEmailControl {
  let closed = false;
  let choices = 0;
  /** What the server last said, and for which choice (0 is the GET). */
  let confirmed: boolean | null = null;
  let confirmedAt = -1;
  return {
    loaded(value) {
      if (closed) return;
      if (confirmedAt < 0) {
        confirmed = value;
        confirmedAt = 0;
      }
      if (choices === 0) show(value);
    },
    toggle(next) {
      if (closed) return;
      choices += 1;
      const choice = choices;
      show(next);
      save(next).then(
        () => {
          if (closed || choice < confirmedAt) return;
          confirmed = next;
          confirmedAt = choice;
        },
        () => {
          if (closed || choice !== choices) return;
          show(confirmed ?? !next);
        },
      );
    },
    close() {
      closed = true;
    },
  };
}
