/**
 * Composes enriched prompts for AI plan generation.
 * Assembles: system prompt + project DNA + dependency tree + agent protocol + user query.
 * Ported from PromptMaster's AiAssistantViewModel plan composition logic.
 */

import { buildAiContext } from './project-dna'
import { generateProtocol } from './agent-protocol'
import type { DependencyNode, ProjectDna } from '@/types/pm/dependency-tree'

export const DEFAULT_SYSTEM_PROMPT = `You are a Lead Software Strategist and Planning Agent. Your primary role is that of an architect, NOT an implementer.
Your task is to stop, think deeply, and formulate a comprehensive, code-grounded implementation strategy.

ABSOLUTE CONSTRAINTS:
- You MUST NOT write, modify, or execute any code. Your sole function is to investigate and plan.
- The user message contains ACTUAL CODE from the project under '## Project Context'. This is the ground truth — use ONLY real file paths, function names, patterns, and services shown there.
- NEVER invent file paths, API endpoints, class names, or function signatures that don't exist in the context.
- Follow the project's existing patterns exactly: if Login.js uses accountUtil + httpService, the new screen must too.
- Reference actual code with file:line format (e.g., components/Login.js:42).
- If critical architectural context is missing, list your open questions explicitly.

OUTPUT FORMAT (Strict Markdown structure):

## 1. Understanding the Goal
Restate the user's request in your own words to confirm understanding.

## 2. Investigation & Analysis
- Files analyzed and key findings per file (with file:line references)
- Existing patterns, services, and utilities discovered
- **Open Questions** — critical unknowns that could affect the plan

## 3. Proposed Strategic Approach
- **Files to change/create** — exact relative paths from the project
- **What to change** — specific functions/components, referencing actual code shown in context
- **Before/after snippets** — show the exact change based on real code
- **Order of changes** — which file first and why (dependency order)
- **Reuse** — list existing services, elements, styles, and hooks to reuse (from the context)
- **Edge cases and risks**

## 4. Self-Review Checklist
- [ ] Did I analyze every relevant file from the context?
- [ ] Do my proposed patterns match the project's existing conventions?
- [ ] Did I reuse existing services instead of creating new ones?
- [ ] Will the proposed changes compile without import/syntax errors?

Be concrete. Respond in the same language as the user's request.`

export interface PlanComposerInput {
  userQuery: string
  projectDna: ProjectDna | null
  dependencyTree: DependencyNode | null
  treeDisplay: string
  systemPrompt?: string
}

export interface ComposedPlan {
  systemPrompt: string
  userMessage: string
}

/**
 * Composes the full enriched prompt for plan generation.
 * Returns a system prompt + user message pair that can be sent
 * to any OpenAI-compatible model through Atomic Chat's inference.
 */
export function composePlan(input: PlanComposerInput): ComposedPlan {
  const {
    userQuery,
    projectDna,
    dependencyTree,
    treeDisplay,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = input

  const contextParts: string[] = []

  // 1. Project DNA
  if (projectDna) {
    contextParts.push(buildAiContext(projectDna))
  }

  // 2. Dependency tree
  if (dependencyTree && treeDisplay) {
    contextParts.push('=== DEPENDENCY TREE ===')
    contextParts.push(treeDisplay)
  }

  // 3. Agent Protocol (only if tree exists)
  if (treeDisplay) {
    contextParts.push(generateProtocol(treeDisplay))
  }

  // Assemble user message
  const userMessage = contextParts.length > 0
    ? `## Project Context\n\n${contextParts.join('\n\n')}\n\n## User Request\n\n${userQuery}`
    : userQuery

  return { systemPrompt, userMessage }
}

/**
 * Returns a formatted markdown block from a plan result
 * suitable for export.
 */
export function formatPlanForExport(
  userQuery: string,
  planResult: string,
  projectRoot?: string
): string {
  const lines: string[] = []
  lines.push(`# Implementation Plan`)
  lines.push(`> Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
  if (projectRoot) {
    lines.push(`> Project: \`${projectRoot}\``)
  }
  lines.push('')
  lines.push(`## Request`)
  lines.push(userQuery)
  lines.push('')
  lines.push(`## Plan`)
  lines.push(planResult)
  return lines.join('\n')
}
