import { describe, expect, it } from 'vitest'
import { isRtlText } from '@/utils/textDirection'
import { CLINE_FREE_MODELS } from './backend-identity'
import { buildCodingAgentPrompt } from './conversation-context'
import type { CodingSession } from '@/stores/coding-agent-store'

describe('Transparent Model-Switch Auto-Continuation', () => {
  describe('Language and RTL detection for continuation prompt', () => {
    it('detects Hebrew in previous turns and selects Hebrew continuation prompt', () => {
      const hebrewLog = [
        'תבדוק את הקוד ותריץ בדיקות',
        'הרצתי את הבדיקות והכל עבר בהצלחה.',
      ].join(' ')

      expect(isRtlText(hebrewLog)).toBe(true)

      const continuationPrompt = isRtlText(hebrewLog)
        ? 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
        : 'Continue the conversation and task from this point with the newly selected model.'

      expect(continuationPrompt).toBe('המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.')
    })

    it('detects English in previous turns and selects English continuation prompt', () => {
      const englishLog = [
        'Please inspect the project structure and build files.',
        'Done! Found package.json and vite.config.ts.',
      ].join(' ')

      expect(isRtlText(englishLog)).toBe(false)

      const continuationPrompt = isRtlText(englishLog)
        ? 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
        : 'Continue the conversation and task from this point with the newly selected model.'

      expect(continuationPrompt).toBe('Continue the conversation and task from this point with the newly selected model.')
    })

    it('detects Hebrew when previous prompt was Hebrew but recent tool logs are English', () => {
      const sessionPrompt = 'תבדוק את הקוד ותריץ בדיקות'
      const englishToolLogs = [
        'python -m unittest discover',
        'Ran 12 tests in 0.45s',
        'OK',
      ]
      const combinedText = [sessionPrompt, ...englishToolLogs].filter(Boolean).join(' ')
      expect(isRtlText(combinedText)).toBe(true)
    })
  })

  describe('Model display name resolution', () => {
    it('resolves official Cline free model IDs to user-friendly display names', () => {
      const museSpark = CLINE_FREE_MODELS.find(
        (m) => m.id === 'cline-free/muse-spark-1.3-contributor'
      )
      expect(museSpark?.name).toBe('Muse Spark 1.3')

      const glm = CLINE_FREE_MODELS.find((m) => m.id === 'z-ai/glm-5.3-flash')
      expect(glm?.name).toBe('GLM 5.3 Flash')

      const deepseek = CLINE_FREE_MODELS.find(
        (m) => m.id === 'deepseek/deepseek-v4-flash'
      )
      expect(deepseek?.name).toBe('DeepSeek V4 Flash')

      // Unknown/fallback model returns the ID itself
      const unknownId = 'custom/unknown-model'
      const resolved =
        CLINE_FREE_MODELS.find((m) => m.id === unknownId)?.name ?? unknownId
      expect(resolved).toBe('custom/unknown-model')
    })
  })

  describe('Context preservation during continuation', () => {
    const activeSession: CodingSession = {
      id: 'session-123',
      prompt: 'בדוק את הקבצים בפרויקט',
      source: 'manual',
      backend: 'cline-acp',
      externalSessionId: 'acp-ext-456',
      projectDir: 'C:\\Develop\\traidAi',
      planText: 'תוכנית בדיקה',
      execLog: [
        { type: 'text_delta', content: 'בדקתי את קובץ ה-DB', timestamp: 100 },
        { type: 'text_delta', content: 'python -m taide.calibration', timestamp: 200 },
      ],
      pendingDiffs: [],
      timestamp: 100,
    }

    it('preserves Cline session continuity without duplicate prompt wrapping', () => {
      const prompt = 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
      const promptForAgent = buildCodingAgentPrompt({
        prompt,
        projectDir: 'C:\\Develop\\traidAi',
        sessions: [activeSession],
        activeSessionId: 'session-123',
        backend: 'cline-acp',
        source: 'manual',
        isContinuation: true,
        includeHistory: true,
        includeSummaryContext: true,
      })

      expect(promptForAgent).toBe(prompt)
    })

    it('injects full conversational history when switching models in Ollama backend', () => {
      const ollamaActiveSession: CodingSession = {
        ...activeSession,
        backend: 'direct-ollama',
        externalSessionId: undefined,
      }

      const prompt = 'המשך את השיחה והמשימה מאותה נקודה עם המודל החדש.'
      const promptForAgent = buildCodingAgentPrompt({
        prompt,
        projectDir: 'C:\\Develop\\traidAi',
        sessions: [ollamaActiveSession],
        activeSessionId: 'session-123',
        backend: 'direct-ollama',
        source: 'manual',
        isContinuation: false,
        includeHistory: true,
        includeSummaryContext: true,
      })

      expect(promptForAgent).toContain('בדקתי את קובץ ה-DB')
      expect(promptForAgent).toContain('Current request:')
      expect(promptForAgent).toContain(prompt)
    })
  })
})
