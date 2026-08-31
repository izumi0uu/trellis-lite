/**
 * Public surface for `trellis-lite-core/mem` — reusable retrieval and
 * dialogue-context extraction over persisted Codex and Oh My Pi sessions.
 *
 * This subpackage is intentionally NOT re-exported from the root
 * `trellis-lite-core` barrel. Import it explicitly:
 *
 *   import { searchMemSessions } from "trellis-lite-core/mem";
 *
 * v1 scope: persisted-session search and context extraction only. It does not
 * read channel / forum / thread event logs and has no cursor / pagination.
 */

export {
  listMemSessions,
  searchMemSessions,
  extractMemDialogue,
  MemSessionNotFoundError,
} from "./sessions.js";

export { readMemContext } from "./context.js";

export { listMemProjects } from "./projects.js";

export type {
  MemSourceKind,
  MemSourceFilter,
  MemPhase,
  DialogueRole,
  DialogueTurn,
  MemFilter,
  MemSessionInfo,
  SearchExcerpt,
  SearchHit,
  MemWarning,
  MemSearchMatch,
  MemSearchResult,
  MemContextTurn,
  MemContextResult,
  BrainstormWindow,
  MemDialogueGroup,
  MemExtractResult,
  MemProjectSummary,
  ListMemSessionsOptions,
  SearchMemSessionsOptions,
  ReadMemContextOptions,
  ExtractMemDialogueOptions,
  ListMemProjectsOptions,
} from "./types.js";
