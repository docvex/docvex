// RESEARCH'S CHATS AS TABS — the Advisor's chat store (lib/advisorChats
// `createChatStore`) for the Research page, so the page's rail and the APP
// SIDEBAR's Research dropdown read one list and behave as the Advisor's do.
// Research is not project work, so the chats are kept per USER
// (`docvex.research.v1.<user>.all`), whatever project is selected.
import { createChatStore } from './advisorChats';

export const RESEARCH_SCOPE = 'all';
export const researchStore = createChatStore({
  prefix: 'docvex.research.v1.',
  activePrefix: 'docvex.research.active.v1.',
  label: 'Research',
});
