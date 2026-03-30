/**
 * Generates an AI agent work protocol that teaches LLMs
 * how to explore code and self-verify before producing a plan.
 * Ported from PromptMaster's AgentProtocolService.cs
 */

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.cs', '.py', '.go',
  '.java', '.swift', '.kt', '.vue', '.svelte', '.rb',
])

export function generateProtocol(dependencyTree: string): string {
  const files = extractFilePaths(dependencyTree)
  const fileList = files.length > 0
    ? files.map(f => `- \`${f}\``).join('\n')
    : '- (all files listed in the dependency tree above)'

  return `## AI Agent Work Protocol

### Phase 1: Explore (MANDATORY - do NOT skip)
You MUST read and analyze the existing codebase before writing ANY code.
**Read each file listed below using your file-reading tools.** Do NOT skip any file. Do NOT guess file contents from their names.

**Files to read:**
${fileList}

**After reading EACH file, output a structured summary using EXACTLY this format:**

\`\`\`
📄 [filename]
- Imports: [list the actual import statements you found in the file]
- Exports: [list exported functions/components/constants]
- Key patterns: [error handling approach, state management, API call pattern]
- Styling: [how styles are applied — shared file? inline? StyleSheet?]
- Dependencies used: [which services from the tree does this file call]
\`\`\`

**IMPORTANT:**
- You MUST read each file before summarizing it. If you cannot read a file, say "⚠️ COULD NOT READ: [filename]" — do NOT guess its contents.
- If a file imports local files not listed in the tree — flag them: "🔗 Additional dependency found: [path]" and read those too.
- Do NOT write generic descriptions like "handles API calls" — cite the actual function names and patterns you found in the code.

### Phase 2: Plan with Verification
Write your implementation plan with CONCRETE details. For each file you will create or modify:

**Required plan format for EACH file:**
\`\`\`
📝 [filename] — [CREATE / MODIFY]
PURPOSE: [one sentence]
IMPORTS: [exact import lines you will use, copied from patterns found in Phase 1]
STATE: [list all state variables with types, if applicable]
FUNCTIONS: [list each function with signature and 2-3 line description]
API CALLS: [exact service + method from the dependency tree, or "⚠️ ENDPOINT TBD: [description]"]
UI STRUCTURE: [component hierarchy, if applicable]
STYLES: [which existing style keys you will reuse, or new keys to add to the shared styles file]
\`\`\`

**Verification checklist — mark each as ✅ or ❌ with explanation:**
- [ ] Import style matches reference files (show example from reference → your import)
- [ ] Uses ONLY existing services — no new service files created
- [ ] Error handling matches reference (show: reference pattern → your pattern)
- [ ] Naming conventions match (camelCase/PascalCase as found in codebase)
- [ ] Uses shared styles file — no inline StyleSheet.create()
- [ ] Uses existing logger — no console.log / console.error
- [ ] Uses existing auth/session service — no new auth logic
- [ ] All brackets closed, no duplicate exports, no missing imports

### Phase 3: Self-Review (MANDATORY before presenting)
Answer each question with EVIDENCE, not just "yes":

1. **"Did I analyze every file?"**
   → List each file and your status: ✅ analyzed / ⚠️ not provided / ❌ skipped
   → If any are ❌: go back and analyze them NOW.

2. **"Do my proposed patterns match the reference?"**
   → Show a SIDE-BY-SIDE comparison: reference code snippet → your code snippet
   → At minimum compare: one import block, one API call, one error handler

3. **"Did I reuse every relevant existing service?"**
   → For each service in the dependency tree, state: "USED in [my file]" or "NOT NEEDED because [reason]"
   → If you created anything new: justify why no existing service covers it.

4. **"Will this compile without errors?"**
   → Walk through each file: list all imports and confirm each import source exists.
   → Confirm: no duplicate function/variable names, all JSX tags closed, all callbacks defined.

If ANY answer reveals a problem — **fix it before presenting**.

### Rules
- NEVER guess what a file contains — READ it first using your tools
- NEVER reference files that are not in the dependency tree (do NOT invent filenames)
- NEVER create a new service/utility if one exists in the dependency tree
- NEVER use console.log/console.error if a logger service exists
- NEVER write inline styles if a shared styles file exists
- NEVER invent API endpoints — write "⚠️ ENDPOINT TBD" and describe what it should do
- ALWAYS show which files you analyzed and what patterns you found BEFORE presenting code
- ALWAYS use the structured formats defined above — free-form text is NOT acceptable for Phase 1 and Phase 2`
}

function extractFilePaths(tree: string): string[] {
  const paths: string[] = []

  for (const line of tree.split('\n')) {
    const trimmed = line.replace(/[│├└─\s]/g, ' ').trim()
    for (const ext of CODE_EXTENSIONS) {
      if (trimmed.includes(ext)) {
        const path = trimmed
          .replace(/├──\s*/g, '')
          .replace(/└──\s*/g, '')
          .replace(/│\s*/g, '')
          .replace(/\[\\?\]\s*/g, '')
          .trim()
        if (path && !paths.includes(path)) {
          paths.push(path)
        }
        break
      }
    }
  }

  return paths
}
