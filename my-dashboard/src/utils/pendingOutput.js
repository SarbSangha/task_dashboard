// Credit Report "Open output" links clicked while signed out are parked here
// by OpenOutputPage and reopened by the sidebar once the user is signed in.

export const PENDING_OUTPUT_KEY = 'creditReport.pendingOutputRef';

export function savePendingOutput(ref) {
  try {
    sessionStorage.setItem(PENDING_OUTPUT_KEY, ref);
  } catch {
    // Private mode: the user simply clicks the link again after login.
  }
}

export function resumePendingOutput(navigate) {
  let ref = null;
  try {
    ref = sessionStorage.getItem(PENDING_OUTPUT_KEY);
    if (ref) sessionStorage.removeItem(PENDING_OUTPUT_KEY);
  } catch {
    ref = null;
  }
  if (ref) navigate(`/open-output?ref=${encodeURIComponent(ref)}`, { replace: true });
}
