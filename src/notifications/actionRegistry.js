// Action registry — rebuilds the runtime `actions` array for a notification at
// render time. We can't persist function closures to localStorage, so each
// category that wants buttons registers a builder here. The builder receives
// the notification (with its `payload` blob) plus an ambient ctx object holding
// fresh closures from React context (navigate, installUpdate, etc.).
//
// Adding a new category with actions = drop in a new entry below. No need to
// touch the toast renderer or the storage layer.

const BUILDERS = {
  // Update notifications. dedupe_key disambiguates within the category:
  //   'update-available'   → View button (navigates to /updates)
  //   'update-downloaded'  → Restart & install button (calls installUpdate)
  //   'update-error'       → no action (informational)
  update(notification, ctx) {
    switch (notification.dedupe_key) {
      case 'update-available':
        return [
          {
            label: 'View',
            variant: 'secondary',
            onClick: () => ctx.navigate?.('/updates'),
          },
        ];
      case 'update-downloaded':
        return [
          {
            label: 'Restart & install',
            variant: 'primary',
            onClick: () => ctx.installUpdate?.(),
          },
        ];
      default:
        return [];
    }
  },

  // Auth and info categories have no actions today; sign-in/sign-out are
  // self-evident from the in-app state change.
  auth() { return []; },
  info() { return []; },
  system() { return []; },

  // FUTURE — social notifications (invites, messages):
  // social(notification, ctx) {
  //   if (notification.payload?.type === 'friend_request') {
  //     return [
  //       { label: 'Accept', variant: 'primary', onClick: () => ctx.acceptInvite?.(notification.payload.inviterId) },
  //       { label: 'Decline', variant: 'secondary', onClick: () => ctx.declineInvite?.(notification.payload.inviterId) },
  //     ];
  //   }
  //   if (notification.payload?.type === 'direct_message') {
  //     return [{ label: 'Open', variant: 'secondary', onClick: () => ctx.navigate?.(`/messages/${notification.payload.roomId}`) }];
  //   }
  //   return [];
  // },
};

export function buildActions(notification, ctx) {
  const builder = BUILDERS[notification.category];
  if (!builder) return [];
  try {
    return builder(notification, ctx) || [];
  } catch {
    // A broken builder shouldn't tank the toast — return no actions.
    return [];
  }
}
