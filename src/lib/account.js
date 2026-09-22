// The signed-in account as the app shows it — read by the account menu
// (components/AccountMenu) and the Sidebar's account row.

// Display-name resolution — same precedence used across the app.
export function getDisplayName(user) {
  const meta = user?.user_metadata;
  if (meta?.full_name) return meta.full_name;
  if (meta?.name) return meta.name;
  if (user?.email) {
    const at = user.email.indexOf('@');
    return at > 0 ? user.email.slice(0, at) : user.email;
  }
  return 'Account';
}

// { name, email, avatarUrl, initial } for a session's user.
export function accountIdentity(session) {
  const user = session?.user || null;
  return {
    name: getDisplayName(user),
    email: user?.email || '',
    avatarUrl: user?.user_metadata?.avatar_url || null,
    initial: (user?.email || '?').charAt(0).toUpperCase(),
  };
}
