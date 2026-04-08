import { join, normalize, sep } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  buildMemoryPrompt,
  ENTRYPOINT_NAME,
  ensureMemoryDirExists,
  truncateEntrypointContent,
} from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'

// Persistent agent memory scope: 'user' (~/.claude/agent-memory/), 'project' (.claude/agent-memory/), 'local' (.claude/agent-memory-local/), or 'shared' (.claude/agent-memory-shared/)
export type AgentMemoryScope = 'user' | 'project' | 'local' | 'shared'

/**
 * Returns the project-wide shared agent memory directory.
 * All memory-enabled agents can read from and write to this pool,
 * allowing knowledge to compound across agent boundaries.
 * Path: <cwd>/.claude/agent-memory-shared/
 */
export function getProjectSharedMemoryDir(): string {
  return join(getCwd(), '.claude', 'agent-memory-shared') + sep
}

/**
 * Sanitize an agent type name for use as a directory name.
 * Replaces colons (invalid on Windows, used in plugin-namespaced agent
 * types like "my-plugin:my-agent") with dashes.
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * Returns the local agent memory directory, which is project-specific and not checked into VCS.
 * When CLAUDE_CODE_REMOTE_MEMORY_DIR is set, persists to the mount with project namespacing.
 * Otherwise, uses <cwd>/.claude/agent-memory-local/<agentType>/.
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), '.claude', 'agent-memory-local', dirName) + sep
}

/**
 * Returns the agent memory directory for a given agent type and scope.
 * - 'user' scope: <memoryBase>/agent-memory/<agentType>/
 * - 'project' scope: <cwd>/.claude/agent-memory/<agentType>/
 * - 'local' scope: see getLocalAgentMemoryDir()
 * - 'shared' scope: <cwd>/.claude/agent-memory-shared/<agentType>/ (readable by all agents)
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), '.claude', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
    case 'shared':
      return join(getCwd(), '.claude', 'agent-memory-shared', dirName) + sep
  }
}

// Check if file is within an agent memory directory (any scope).
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // User scope: check memory base (may be custom dir or config home)
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // Project scope: always cwd-based (not redirected)
  if (
    normalizedPath.startsWith(join(getCwd(), '.claude', 'agent-memory') + sep)
  ) {
    return true
  }

  // Shared scope: project-wide pool accessible to all memory-enabled agents
  if (
    normalizedPath.startsWith(
      join(getCwd(), '.claude', 'agent-memory-shared') + sep,
    )
  ) {
    return true
  }

  // Local scope: persisted to mount when CLAUDE_CODE_REMOTE_MEMORY_DIR is set, otherwise cwd-based
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(getCwd(), '.claude', 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}

/**
 * Returns the agent memory file path for a given agent type and scope.
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), 'agent-memory')}/)`
    case 'project':
      return 'Project (.claude/agent-memory/)'
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    case 'shared':
      return 'Shared (.claude/agent-memory-shared/) — readable by all agents'
    default:
      return 'None'
  }
}

/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 * For all scopes, also injects the project-wide shared memory pool (if populated)
 * so knowledge learned by one agent can benefit all agents.
 *
 * @param agentType The agent's type name (used as directory name)
 * @param scope 'user' for ~/.claude/agent-memory/, 'project' for .claude/agent-memory/,
 *              'local' for .claude/agent-memory-local/, or 'shared' for .claude/agent-memory-shared/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
    case 'shared':
      scopeNote =
        '- Since this memory is shared-scope, it is readable by ALL agents in this project — save learnings that are broadly applicable across agent types. Memories here amplify every agent in the project.'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // Fire-and-forget: this runs at agent-spawn time inside a sync
  // getSystemPrompt() callback (called from React render in AgentDetail.tsx,
  // so it cannot be async). The spawned agent won't try to Write until after
  // a full API round-trip, by which time mkdir will have completed. Even if
  // it hasn't, FileWriteTool does its own mkdir of the parent directory.
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const agentMemoryPrompt = buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })

  // For non-shared scopes, also inject the project-wide shared pool so that
  // knowledge saved by any shared-scope agent is available to all agents.
  // This is the cross-agent amplification layer.
  if (scope !== 'shared') {
    const sharedPoolPrompt = loadSharedPoolPrompt(agentType)
    if (sharedPoolPrompt) {
      return agentMemoryPrompt + '\n\n' + sharedPoolPrompt
    }
  }

  return agentMemoryPrompt
}

/**
 * Load the project-wide shared memory pool for cross-agent knowledge injection.
 * Scans .claude/agent-memory-shared/ for any agent subdirectories and builds
 * a compact summary. Returns null if the shared pool is empty or missing.
 *
 * This is what allows knowledge from one agent to amplify all other agents:
 * any agent with memory enabled automatically receives shared-scope memories
 * written by any other agent in the project.
 *
 * @param excludeAgentType - The calling agent's own type. Its shared-scope
 *   directory (if any) is excluded to avoid loading memories twice — the
 *   agent's own shared directory is already included via buildMemoryPrompt().
 */
export function loadSharedPoolPrompt(excludeAgentType?: string): string | null {
  const sharedBase = getProjectSharedMemoryDir()
  const fs = getFsImplementation()

  let agentDirs: string[]
  try {
    const excludeName = excludeAgentType
      ? sanitizeAgentTypeForPath(excludeAgentType)
      : undefined
    // eslint-disable-next-line custom-rules/no-sync-fs
    const dirents = fs.readdirSync(sharedBase)
    agentDirs = dirents
      .filter(d => d.isDirectory() && d.name !== excludeName)
      .map(d => d.name)
  } catch {
    // Shared pool directory does not exist yet — nothing to inject
    return null
  }

  if (agentDirs.length === 0) {
    return null
  }

  const sections: string[] = []
  for (const dir of agentDirs) {
    const entrypoint = join(sharedBase, dir, ENTRYPOINT_NAME)
    let content = ''
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs
      content = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
    } catch {
      continue
    }
    if (!content.trim()) continue
    const t = truncateEntrypointContent(content)
    sections.push(`### From agent: ${dir}\n\n${t.content}`)
  }

  if (sections.length === 0) {
    return null
  }

  return [
    '# Cross-Agent Shared Knowledge',
    '',
    `The following memories were saved by other agents in this project to the shared pool at \`${sharedBase}\`. Use them as additional context — they represent learnings that benefit all agents.`,
    '',
    '**To contribute to this shared pool:** any agent whose agent definition file specifies `memory: shared` saves its memories here instead of a private directory. Those memories then automatically appear in the context of every other memory-enabled agent in this project.',
    '',
    ...sections,
  ].join('\n')
}
