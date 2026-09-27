// S5-4: the one way a workstation is locked.
//
// Locking is deliberately two steps in this order — clear the session locally
// first, tell the server second — because the local half must never depend on the
// network. If the server is unreachable, slow, or crashes mid-request, the screen
// is already locked and the token is already gone from this machine.

import { lockSession as requestServerLock } from "./api-client";
import { useAuthStore } from "../stores/auth.store";

/**
 * Covers the workstation and ends the credential behind it.
 *
 * The server call revokes the token, so the lock is not a drawing: the client
 * holds no usable credential until the password is verified again, and a reload, a
 * second window or a script at the keyboard cannot get behind the overlay.
 */
export function lockWorkstation(): void {
  const { token, lockSession } = useAuthStore.getState();

  lockSession();

  if (token !== null) {
    // Best effort, and deliberately not awaited: a failed revocation leaves the
    // workstation locked anyway, and the token is no longer anywhere on this PC.
    void requestServerLock(token).catch(() => undefined);
  }
}
