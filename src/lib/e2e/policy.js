// Whether a write may go out UNENCRYPTED when this device can't get the key
// (no identity yet, no grant yet, migration 046 not applied). true = refuse
// and say why — the end-to-end promise holds. Flip only for a staged rollout
// where losing chat on such devices is worse than a plaintext message.
export const E2E_REQUIRED = true;

// Read path: queue async transforms of realtime payloads so events reach the
// caller in the order they arrived even though decrypting takes a moment.
export function orderedAsync(handler) {
  let chain = Promise.resolve();
  return (transform) => (payload) => {
    const out = transform(payload).catch(() => payload);
    chain = chain.then(() => out).then((p) => { try { handler(p); } catch { /* the caller's */ } }, () => {});
  };
}
