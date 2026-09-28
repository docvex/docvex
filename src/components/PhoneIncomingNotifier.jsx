// A file a phone sent while the Import window was closed ARRIVES — announced
// through the app's own notifications (`notify()`, the bottom-right toast stack
// the Activity items use): its thumbnail, "From your phone", name and size, and
// "Show in Files". The decision is made in the Files tab, where the file stands
// FADED in the folder it was sent to with a download mark — a click accepts it,
// the right-click menu accepts, previews or rejects it (ProjectFiles
// `incomingItems`, FilesWorkspace `item.incoming`).
//
// No UI of its own; it also starts the incoming store (lib/phoneUploadIncoming)
// once per window, which brings every project's kept address back.

import { useEffect } from 'react';
import { useNotify } from '../context/NotificationsContext';
import { useAuth } from '../context/AuthContext';
import { startIncoming, setIncomingOwner, onIncomingArrived, fmtBytes } from '../lib/phoneUploadIncoming';

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i;

export default function PhoneIncomingNotifier() {
  const { notify } = useNotify();
  const { session } = useAuth();
  const userId = session?.user?.id || null;
  // The waiting files and kept addresses are the SIGNED-IN account's.
  useEffect(() => { setIncomingOwner(userId); }, [userId]);
  useEffect(() => {
    startIncoming();
    return onIncomingArrived((p) => {
      const ext = (/\.([a-z0-9]{1,8})$/i.exec(p.name || '') || [])[1] || '';
      const folder = String(p.dir || '').split(/[\\/]/).filter(Boolean).pop();
      notify({
        category: 'file',
        variant: 'info',
        icon: 'upload',
        title: 'File arrived from your phone',
        body: `${p.name} · ${fmtBytes(p.size)}${folder ? ` — waiting in “${folder}”` : ''}`,
        dedupeKey: `phone-upload:${p.id}`,
        dedupeStrategy: 'replace',
        payload: {
          phoneUpload: { id: p.id },
          thumb: IMAGE.test(p.name || '') && p.path ? `localfile://local/${encodeURIComponent(p.path)}?thumb=96` : null,
          thumbExt: ext,
        },
      });
    });
  }, [notify]);
  return null;
}
