/**
 * Stub for future social notifications via Supabase Realtime.
 *
 * When the `public.notifications` table + RLS lands, uncomment the body
 * below. The persistent-fields shape of our local Notification type already
 * mirrors a postgres row (`user_id`, `category`, `variant`, `title`, `body`,
 * `payload jsonb`, `created_at timestamptz`, `read_at timestamptz`,
 * `dedupe_key`), so `mapServerRow` is close to the identity function.
 *
 * @param {(payload: object) => string} notify
 * @param {string | null | undefined} userId
 * @param {{ ready: boolean }} [opts]
 */
// eslint-disable-next-line no-unused-vars
export function useSocialNotificationSource(notify, userId, { ready = true } = {}) {
  // v1: no-op. The hook still runs unconditionally inside the provider so
  // adding behaviour later doesn't change the call-site.

  // FUTURE — wire when public.notifications table + RLS lands:
  //
  // import { useEffect } from 'react';
  // import { supabase } from '../../lib/supabaseClient';
  //
  // useEffect(() => {
  //   if (!ready || !userId) return;
  //   const channel = supabase
  //     .channel(`user:${userId}`)
  //     .on(
  //       'postgres_changes',
  //       {
  //         event: 'INSERT',
  //         schema: 'public',
  //         table: 'notifications',
  //         filter: `user_id=eq.${userId}`,
  //       },
  //       (msg) => notify(mapServerRow(msg.new))
  //     )
  //     .subscribe();
  //   return () => { supabase.removeChannel(channel); };
  // }, [userId, ready, notify]);
  //
  // function mapServerRow(row) {
  //   return {
  //     category: row.category ?? 'social',
  //     variant: row.variant ?? 'info',
  //     title: row.title,
  //     body: row.body,
  //     payload: row.payload ?? {},
  //     dedupeKey: row.dedupe_key,
  //     dedupeStrategy: 'stack', // distinct social events should not collapse
  //     osLevel: true,           // escalate to OS notification when window hidden
  //   };
  // }
}
